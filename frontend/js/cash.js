import { getCurrentSession } from "./auth.js";
import {
  getCashClosuresByKioscoAndDateRange,
  getCashClosureByKey,
  getSalesByKioscoAndDateRange,
  getSalesByKioscoUserAndDateRange,
  putCashClosure
} from "./db.js";
import { syncCashClosureToFirestore } from "./firebase_sync.js";

export async function getCashSnapshotForToday() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const { startIso, endIso, dateKey } = getTodayRangeIso();
  const sales = await loadScopedSales(session, startIso, endIso);
  const orderedSales = sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const sales = await loadScopedSales(session, startIso, endIso);
  const summary = summarizeSales(sales);
  if (summary.salesCount === 0) {
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

  const closure = {
    id: crypto.randomUUID(),
    closureKey,
    kioscoId: session.tenantId,
    userId: session.userId,
    role: session.role,
    username: session.username,
    dateKey,
    totalAmount: summary.totalAmount,
    totalCost: summary.totalCost,
    profitAmount: summary.profitAmount,
    salesCount: summary.salesCount,
    itemsCount: summary.itemsCount,
    createdAt: new Date().toISOString()
  };

  await putCashClosure(closure);
  await syncCashClosureToFirestore(closure);

  return {
    ok: true,
    summary
  };
}

function summarizeSales(sales) {
  const salesCount = sales.length;
  const itemsCount = sales.reduce((acc, sale) => acc + Number(sale.itemsCount || 0), 0);
  const totalAmount = Number(
    sales.reduce((acc, sale) => acc + Number(sale.total || 0), 0).toFixed(2)
  );
  const totalCost = Number(
    sales.reduce((acc, sale) => acc + Number(sale.totalCost || 0), 0).toFixed(2)
  );
  const profitAmount = Number((totalAmount - totalCost).toFixed(2));

  return { salesCount, itemsCount, totalAmount, totalCost, profitAmount };
}

async function listRecentClosures(session, scopeKey) {
  const { startIso, endIso } = getRecentDaysRangeIso(30);
  const closures = await getCashClosuresByKioscoAndDateRange(session.tenantId, startIso, endIso);
  return closures
    .filter((closure) => closure.closureKey === buildClosureKey(session.tenantId, closure.dateKey, scopeKey))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
}

async function loadScopedSales(session, startIso, endIso) {
  if (session.role === "empleador") {
    return getSalesByKioscoAndDateRange(session.tenantId, startIso, endIso);
  }
  return getSalesByKioscoUserAndDateRange(session.tenantId, session.userId, startIso, endIso);
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
