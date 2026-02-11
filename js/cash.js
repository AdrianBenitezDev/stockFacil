import { getCurrentSession } from "./auth.js";
import {
  getCashClosureByKey,
  getSalesByKioscoAndDateRange,
  getSalesByKioscoUserAndDateRange,
  putCashClosure
} from "./db.js";

export async function getCashSnapshotForToday() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const { startIso, endIso, dateKey } = getTodayRangeIso();
  const sales = await loadScopedSales(session, startIso, endIso);
  const orderedSales = sales.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summary = summarizeSales(orderedSales);
  const scopeLabel = session.role === "dueno" ? "Vista: todo el kiosco" : "Vista: solo tus ventas";

  return {
    ok: true,
    sales: orderedSales,
    summary,
    dateKey,
    scopeLabel
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

  const scopeKey = session.role === "dueno" ? "all" : session.userId;
  const closureKey = `${session.kioscoId}::${dateKey}::${scopeKey}`;
  const existing = await getCashClosureByKey(closureKey);
  if (existing) {
    return {
      ok: false,
      error: `El turno de hoy ya fue cerrado. Monto registrado: $${Number(existing.totalAmount || 0).toFixed(2)}.`
    };
  }

  await putCashClosure({
    id: crypto.randomUUID(),
    closureKey,
    kioscoId: session.kioscoId,
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
  });

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

async function loadScopedSales(session, startIso, endIso) {
  if (session.role === "dueno") {
    return getSalesByKioscoAndDateRange(session.kioscoId, startIso, endIso);
  }
  return getSalesByKioscoUserAndDateRange(session.kioscoId, session.userId, startIso, endIso);
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
