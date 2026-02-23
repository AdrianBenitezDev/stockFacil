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
const getRecentCashClosuresCallable = httpsCallable(functions, "getRecentCashClosures");

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

export async function closeTodayShift({ scope = "all" } = {}) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const effectiveScope = resolveEffectiveCloseScope(session, scope);
  const { dateKey } = getTodayRangeIso();
  const scopeKey = getScopeKey(session, effectiveScope);
  const closureKey = buildClosureKey(session.tenantId, dateKey, scopeKey);
  const canUseBackend = navigator.onLine && (await hasFirebaseSession());

  if (!canUseBackend) {
    const localResult = await loadScopedOpenSales(session, { scope: effectiveScope });
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

  const localSales = await loadScopedOpenSalesFromLocal(session, { scope: effectiveScope });
  const localSummary = summarizeSales(localSales);

  const syncResult = await syncPendingSales();
  if (!syncResult.ok) {
    return { ok: false, error: syncResult.error };
  }

  try {
    const response = await closeCashboxCallable({
      tenantId: session.tenantId,
      usuarioUid: session.userId,
      turnoId: dateKey,
      scope: effectiveScope
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
      ventasIncluidas: Array.isArray(data.ventasIncluidas) ? data.ventasIncluidas : [],
      productosIncluidos: Array.isArray(data.productosIncluidos) ? data.productosIncluidos : []
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

function buildLocalClosure({
  session,
  dateKey,
  closureKey,
  summary,
  synced,
  id = null,
  ventasIncluidas = [],
  productosIncluidos = []
}) {
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
    productosIncluidos,
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
  await syncRecentClosuresFromCloud(session);
  const { startIso, endIso } = getRecentDaysRangeIso(30);
  const closures = await getCashClosuresByKioscoAndDateRange(session.tenantId, startIso, endIso);
  const isOwner = String(session?.role || "").trim().toLowerCase() === "empleador";
  return closures
    .filter((closure) => {
      if (isOwner) return true;
      const closureScope = String(closure.scopeKey || "").trim();
      if (closureScope) return closureScope === scopeKey;
      return String(closure.closureKey || "").includes(`::${scopeKey}`);
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 10);
}

async function syncRecentClosuresFromCloud(session) {
  const canUseCloud = navigator.onLine && (await hasFirebaseSession());
  if (!canUseCloud) return;

  try {
    const response = await getRecentCashClosuresCallable({ daysBack: 30, limit: 80 });
    const data = response?.data || {};
    const rows = Array.isArray(data.closures) ? data.closures : [];
    if (rows.length === 0) return;

    const normalized = rows
      .map((closure) => normalizeCallableClosure(session, closure))
      .filter(Boolean);
    for (const closure of normalized) {
      await putCashClosure(closure);
    }
  } catch (error) {
    console.warn("No se pudo sincronizar cierres de caja desde backend:", error?.message || error);
  }
}

async function loadScopedOpenSales(session, { scope = "all" } = {}) {
  const canUseCloud = navigator.onLine && (await hasFirebaseSession());
  let cloudError = null;
  const effectiveScope = resolveEffectiveCloseScope(session, scope);
  if (canUseCloud) {
    try {
      const cloudSales = await loadScopedOpenSalesFromCallable({
        scope: effectiveScope,
        sessionRole: session?.role
      });
      if (cloudSales.length > 0) return { sales: cloudSales };
    } catch (error) {
      cloudError = error;
    }
  }
  const localSales = await loadScopedOpenSalesFromLocal(session, { scope: effectiveScope });
  if (localSales.length === 0 && cloudError) {
    return { sales: [], loadError: mapOpenCashSalesError(cloudError) };
  }
  return { sales: localSales };
}

async function loadScopedOpenSalesFromCallable({ scope = "all", sessionRole = "" } = {}) {
  const response = await getOpenCashSalesCallable({
    scope: String(sessionRole || "").trim().toLowerCase() === "empleador" ? scope : "mine"
  });
  const data = response?.data || {};
  const rows = Array.isArray(data.sales) ? data.sales : [];
  return rows.map((sale) => normalizeCallableSale(sale));
}

async function loadScopedOpenSalesFromLocal(session, { scope = "all" } = {}) {
  const effectiveScope = resolveEffectiveCloseScope(session, scope);
  const rows = await getSalesByKiosco(session.tenantId);
  return rows.filter((sale) => {
    if (sale?.cajaCerrada === true) return false;
    if (effectiveScope === "all") return true;
    const saleUserId = String(sale.userId || sale.usuarioUid || "");
    const sessionUserId = String(session.userId || "");
    if (effectiveScope === "others") return saleUserId !== sessionUserId;
    return saleUserId === sessionUserId;
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

function normalizeCallableClosure(session, closure) {
  const id = String(closure?.id || "").trim();
  if (!id) return null;

  const createdAt = normalizeDateToIso(closure?.createdAt);
  const dateKey = String(closure?.dateKey || "").trim() || isoToDateKey(createdAt);
  const userId = String(closure?.userId || "").trim();
  const scopeKey = String(closure?.scopeKey || "").trim() || userId || "all";
  const closureKey =
    String(closure?.closureKey || "").trim() ||
    buildClosureKey(session.tenantId, dateKey || isoToDateKey(new Date().toISOString()), scopeKey);

  return {
    id,
    closureKey,
    scopeKey,
    kioscoId: session.tenantId,
    userId,
    role: String(closure?.role || "").trim() || "empleado",
    username: String(closure?.username || "-"),
    dateKey,
    totalAmount: Number(closure?.totalAmount || 0),
    totalCost: Number(closure?.totalCost || 0),
    profitAmount: Number(closure?.profitAmount || 0),
    GanaciaRealCaja: Number(closure?.profitAmount || 0),
    salesCount: Number(closure?.salesCount || 0),
    itemsCount: Number(closure?.itemsCount || 0),
    ventasIncluidas: Array.isArray(closure?.ventasIncluidas) ? closure.ventasIncluidas : [],
    productosIncluidos: Array.isArray(closure?.productosIncluidos) ? closure.productosIncluidos : [],
    synced: true,
    createdAt
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

function getScopeKey(session, scope = "all") {
  const effectiveScope = resolveEffectiveCloseScope(session, scope);
  if (effectiveScope === "all") return "all";
  if (effectiveScope === "others") return "others";
  return session.userId;
}

function resolveEffectiveCloseScope(session, scope) {
  const isOwner = String(session?.role || "").trim().toLowerCase() === "empleador";
  if (!isOwner) return "mine";
  if (scope === "others") return "others";
  return scope === "mine" ? "mine" : "all";
}

function buildClosureKey(kioscoId, dateKey, scopeKey) {
  return `${kioscoId}::${dateKey}::${scopeKey}`;
}

function isoToDateKey(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}
