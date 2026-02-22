import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { getCurrentSession } from "./auth.js";
import {
  assignCashboxToSalesByIds,
  getCashClosuresByKioscoAndDateRange,
  getSalesByKiosco,
  putCashClosure
} from "./db.js";
import { syncPendingSales } from "./sales.js";

const functions = getFunctions(firebaseApp);
const closeCashboxCallable = httpsCallable(functions, "closeCashbox");
const getOpenCashSalesCallable = httpsCallable(functions, "getOpenCashSales");

export async function getCashSnapshotForToday() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const { dateKey } = getTodayRangeIso();
  const salesResult = await loadScopedOpenSales(session);
  if (salesResult.loadError) {
    return { ok: false, error: salesResult.loadError };
  }
  const sales = salesResult.sales;
  const orderedSales = sales.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const summary = summarizeSales(orderedSales);
  const scopeKey = getScopeKey(session);
  const recentClosures = await listRecentClosures(session, scopeKey);
  const todayClosure = recentClosures.find((closure) => String(closure.dateKey || "") === dateKey) || null;
  const scopeLabel =
    session.role === "empleador"
      ? "Vista: ventas pendientes del kiosco"
      : "Vista: tus ventas pendientes (caja abierta)";

  return {
    ok: true,
    sales: orderedSales,
    summary,
    dateKey,
    scopeLabel,
    todayClosure,
    recentClosures
  };
}

export async function closeTodayShift() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const { dateKey } = getTodayRangeIso();
  const scopeKey = getScopeKey(session);
  const closureKey = buildClosureKey(session.tenantId, dateKey, scopeKey);
  const canUseBackend = navigator.onLine && (await hasFirebaseSession());

  if (!canUseBackend) {
    const localResult = await loadScopedOpenSales(session);
    if (localResult.loadError) {
      return { ok: false, error: localResult.loadError };
    }
    const localSales = localResult.sales;
    const localSummary = summarizeSales(localSales);
    if (localSummary.salesCount === 0) {
      return { ok: false, error: "No hay ventas pendientes para cerrar caja." };
    }

    const provisional = buildLocalClosure({
      session,
      dateKey,
      closureKey,
      summary: localSummary,
      synced: false
    });
    await putCashClosure(provisional);
    return { ok: true, summary: localSummary, provisional: true };
  }

  const localSales = await loadScopedOpenSalesFromLocal(session);
  const localSummary = summarizeSales(localSales);

  const syncResult = await syncPendingSales();
  if (!syncResult.ok) {
    return { ok: false, error: syncResult.error };
  }

  try {
    const response = await closeCashboxCallable({
      tenantId: session.tenantId,
      usuarioUid: session.userId,
      turnoId: dateKey
    });
    const data = response?.data || {};
    if (!data.success || !data.idCaja) {
      return { ok: false, error: "Respuesta invalida al cerrar caja." };
    }

    const authoritativeSummary = {
      salesCount: Array.isArray(data.ventasIncluidas) ? data.ventasIncluidas.length : localSummary.salesCount,
      itemsCount: localSummary.itemsCount,
      totalAmount: Number(data.totalCaja || 0),
      totalCost: localSummary.totalCost,
      profitAmount: Number(data.totalGananciaRealCaja || 0)
    };

    const closure = buildLocalClosure({
      session,
      dateKey,
      closureKey,
      summary: authoritativeSummary,
      synced: true,
      id: String(data.idCaja),
      ventasIncluidas: Array.isArray(data.ventasIncluidas) ? data.ventasIncluidas : []
    });
    closure.GanaciaRealCaja = Number(data.totalGananciaRealCaja || 0);

    await putCashClosure(closure);
    if (Array.isArray(data.ventasIncluidas) && data.ventasIncluidas.length > 0) {
      await assignCashboxToSalesByIds(data.ventasIncluidas, String(data.idCaja));
    }

    return { ok: true, summary: authoritativeSummary, provisional: false };
  } catch (error) {
    return { ok: false, error: mapCloseCashboxError(error) };
  }
}

function buildLocalClosure({ session, dateKey, closureKey, summary, synced, id = null, ventasIncluidas = [] }) {
  return {
    id: id || `LOCAL-CAJA-${Date.now()}`,
    closureKey: `${closureKey}::${Date.now()}`,
    scopeKey: getScopeKey(session),
    kioscoId: session.tenantId,
    userId: session.userId,
    role: session.role,
    username: session.username,
    dateKey,
    totalAmount: Number(summary.totalAmount || 0),
    totalCost: Number(summary.totalCost || 0),
    profitAmount: Number(summary.profitAmount || 0),
    GanaciaRealCaja: Number(summary.profitAmount || 0),
    salesCount: Number(summary.salesCount || 0),
    itemsCount: Number(summary.itemsCount || 0),
    ventasIncluidas,
    synced,
    createdAt: new Date().toISOString()
  };
}

function summarizeSales(sales) {
  const salesCount = sales.length;
  const itemsCount = sales.reduce((acc, sale) => acc + Number(sale.itemsCount || 0), 0);
  const totalAmount = Number(sales.reduce((acc, sale) => acc + Number(sale.total || 0), 0).toFixed(2));
  const totalCost = Number(sales.reduce((acc, sale) => acc + Number(sale.totalCost || 0), 0).toFixed(2));
  const profitAmount = Number(
    sales
      .reduce((acc, sale) => acc + Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0), 0)
      .toFixed(2)
  );

  return { salesCount, itemsCount, totalAmount, totalCost, profitAmount };
}

async function listRecentClosures(session, scopeKey) {
  const { startIso, endIso } = getRecentDaysRangeIso(30);
  const closures = await getCashClosuresByKioscoAndDateRange(session.tenantId, startIso, endIso);
  return closures
    .filter((closure) => {
      const closureScope = String(closure.scopeKey || "").trim();
      if (closureScope) return closureScope === scopeKey;
      return String(closure.closureKey || "").includes(`::${scopeKey}`);
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 10);
}

async function loadScopedOpenSales(session) {
  const canUseCloud = navigator.onLine && (await hasFirebaseSession());
  let cloudError = null;
  if (canUseCloud) {
    try {
      const cloudSales = await loadScopedOpenSalesFromCallable();
      if (cloudSales.length > 0) return { sales: cloudSales };
    } catch (error) {
      cloudError = error;
    }
  }
  const localSales = await loadScopedOpenSalesFromLocal(session);
  if (localSales.length === 0 && cloudError) {
    return { sales: [], loadError: mapOpenCashSalesError(cloudError) };
  }
  return { sales: localSales };
}

async function loadScopedOpenSalesFromCallable() {
  const response = await getOpenCashSalesCallable();
  const data = response?.data || {};
  const rows = Array.isArray(data.sales) ? data.sales : [];
  return rows.map((sale) => normalizeCallableSale(sale));
}

async function loadScopedOpenSalesFromLocal(session) {
  const rows = await getSalesByKiosco(session.tenantId);
  return rows.filter((sale) => {
    if (sale?.cajaCerrada === true) return false;
    if (session.role === "empleador") return true;
    return String(sale.userId || sale.usuarioUid || "") === String(session.userId || "");
  });
}

function normalizeCallableSale(sale) {
  return {
    id: String(sale.idVenta || sale.id || ""),
    userId: String(sale.usuarioUid || sale.userId || ""),
    username: String(sale.usuarioNombre || sale.username || "-"),
    itemsCount: Number(sale.itemsCount || 0),
    total: Number(sale.total || 0),
    totalCost: Number(sale.totalCost || sale.totalCosto || 0),
    gananciaReal: Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0),
    profit: Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0),
    cajaCerrada: sale.cajaCerrada === true,
    createdAt: normalizeDateToIso(sale.createdAt)
  };
}

function normalizeDateToIso(value) {
  if (!value) return "";
  if (typeof value?.toDate === "function") {
    return value.toDate().toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return "";
}

function mapOpenCashSalesError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code.includes("not-found")) {
    return "Caja no disponible en backend: falta desplegar la funcion getOpenCashSales.";
  }
  if (code.includes("permission-denied")) {
    return "Sin permisos para leer ventas abiertas de caja.";
  }
  if (code.includes("unauthenticated")) {
    return "Sesion invalida para consultar caja.";
  }
  return message || "No se pudieron cargar las ventas abiertas de caja.";
}

async function hasFirebaseSession() {
  await ensureFirebaseAuth();
  return Boolean(firebaseAuth.currentUser);
}

function mapCloseCashboxError(error) {
  const message = String(error?.message || "");
  if (message) return message;

  const code = String(error?.code || "");
  if (code.includes("failed-precondition")) return "No hay ventas pendientes para cerrar caja.";
  if (code.includes("permission-denied")) return "No tienes permisos para cerrar caja.";
  if (code.includes("unauthenticated")) return "Sesion invalida para cierre de caja.";
  return "No se pudo cerrar caja.";
}

function getTodayRangeIso() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateKey
  };
}

function getRecentDaysRangeIso(daysBack) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function getScopeKey(session) {
  return session.role === "empleador" ? "all" : session.userId;
}

function buildClosureKey(kioscoId, dateKey, scopeKey) {
  return `${kioscoId}::${dateKey}::${scopeKey}`;
}
