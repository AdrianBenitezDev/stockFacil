import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { getCurrentSession } from "./auth.js";
import {
  assignCashboxToSalesByIds,
  getCashClosuresByKioscoAndDateRange,
  getCashClosureByKey,
  getSalesByKioscoAndDateRange,
  getSalesByKioscoUserAndDateRange,
  putCashClosure
} from "./db.js";
import { syncPendingSales } from "./sales.js";

const functions = getFunctions(firebaseApp);
const closeCashboxCallable = httpsCallable(functions, "closeCashbox");

export async function getCashSnapshotForToday() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const { startIso, endIso, dateKey } = getTodayRangeIso();
  const sales = await loadScopedSales(session, startIso, endIso);
  const orderedSales = sales.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const summary = summarizeSales(orderedSales);
  const scopeKey = getScopeKey(session);
  const closureKey = buildClosureKey(session.tenantId, dateKey, scopeKey);
  const todayClosure = await getCashClosureByKey(closureKey);
  const recentClosures = await listRecentClosures(session, scopeKey);
  const scopeLabel = session.role === "empleador" ? "Vista: todo el kiosco" : "Vista: solo tus ventas";

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

  const { startIso, endIso, dateKey } = getTodayRangeIso();
  const localSales = await loadScopedSales(session, startIso, endIso);
  const localSummary = summarizeSales(localSales);
  if (localSummary.salesCount === 0) {
    return { ok: false, error: "No hay ventas hoy para cerrar turno." };
  }

  const scopeKey = getScopeKey(session);
  const closureKey = buildClosureKey(session.tenantId, dateKey, scopeKey);
  const existing = await getCashClosureByKey(closureKey);
  if (existing) {
    return {
      ok: false,
      error: `El turno de hoy ya fue cerrado. Monto registrado: $${Number(existing.totalAmount || 0).toFixed(2)}.`
    };
  }

  const canUseBackend = navigator.onLine && (await hasFirebaseSession());
  if (!canUseBackend) {
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
    closureKey,
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
    sales.reduce((acc, sale) => acc + Number(sale.ganaciaReal ?? sale.profit ?? 0), 0).toFixed(2)
  );

  return { salesCount, itemsCount, totalAmount, totalCost, profitAmount };
}

async function listRecentClosures(session, scopeKey) {
  const { startIso, endIso } = getRecentDaysRangeIso(30);
  const closures = await getCashClosuresByKioscoAndDateRange(session.tenantId, startIso, endIso);
  return closures
    .filter((closure) => closure.closureKey === buildClosureKey(session.tenantId, closure.dateKey, scopeKey))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 10);
}

async function loadScopedSales(session, startIso, endIso) {
  if (session.role === "empleador") {
    return getSalesByKioscoAndDateRange(session.tenantId, startIso, endIso);
  }
  return getSalesByKioscoUserAndDateRange(session.tenantId, session.userId, startIso, endIso);
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
