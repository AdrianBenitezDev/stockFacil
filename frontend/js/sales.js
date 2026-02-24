import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { getCurrentSession } from "./auth.js";
import {
  getSaleItemsBySaleId,
  getUnsyncedSalesByKioscoAndUser,
  markSalesAsSyncedByIds,
  openDatabase
} from "./db.js";
import { STORES } from "./config.js";

const functions = getFunctions(firebaseApp);
const createSaleCallable = httpsCallable(functions, "createSale");
const syncSalesCallable = httpsCallable(functions, "syncSales");

export async function chargeSale(cartItems, paymentDetails = null) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { ok: false, error: "No hay productos para cobrar." };
  }
  const normalizedPayment = normalizePaymentDetails(paymentDetails, cartItems);
  if (!normalizedPayment.ok) {
    return { ok: false, error: normalizedPayment.error };
  }

  const backendAttempt = await tryCreateSaleInBackend(cartItems, session, normalizedPayment.value);
  if (backendAttempt.ok) {
    return finalizeSaleLocally(cartItems, session, { authoritative: backendAttempt.data, paymentDetails: normalizedPayment.value });
  }
  if (!backendAttempt.canFallbackToOffline) {
    return { ok: false, error: backendAttempt.error || "No se pudo cobrar la venta." };
  }

  return finalizeSaleLocally(cartItems, session, { authoritative: null, paymentDetails: normalizedPayment.value });
}

export async function syncPendingSales() {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const pendingSales = await getUnsyncedSalesByKioscoAndUser(session.tenantId, session.userId);
  if (pendingSales.length === 0) {
    return { ok: true, syncedCount: 0, saleIds: [] };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser || !navigator.onLine) {
    return { ok: false, error: "No hay conexion para sincronizar ventas pendientes." };
  }

  const payloadSales = [];
  for (const sale of pendingSales) {
    const items = await getSaleItemsBySaleId(sale.id);
    payloadSales.push({
      idVenta: String(sale.id || "").trim(),
      total: Number(sale.total || 0),
      totalCost: Number(sale.totalCost || 0),
      gananciaReal: Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0),
      itemsCount: Number(sale.itemsCount || 0),
      tipoPago: String(sale.tipoPago || "efectivo"),
      pagoEfectivo: Number(sale.pagoEfectivo || 0),
      pagoVirtual: Number(sale.pagoVirtual || 0),
      createdAt: sale.createdAt || null,
      productos: (items || []).map((item) => ({
        codigo: String(item.barcode || "").trim(),
        nombre: String(item.name || "").trim(),
        cantidad: Number(item.quantity || 0),
        precioUnitario: Number(item.unitPrice || 0),
        precioCompraUnitario: Number(item.unitProviderCost || 0),
        subtotal: Number(item.subtotal || 0),
        subtotalCosto: Number(item.subtotalCost || 0),
        gananciaRealVenta: Number(item.gananciaRealVenta ?? item.ganaciaRealVenta ?? 0)
      }))
    });
  }

  try {
    const response = await syncSalesCallable({ ventas: payloadSales });
    const syncedIds = Array.isArray(response?.data?.syncedIds) ? response.data.syncedIds : [];
    const updated = await markSalesAsSyncedByIds(syncedIds);
    return { ok: true, syncedCount: updated, saleIds: syncedIds };
  } catch (error) {
    return { ok: false, error: mapCreateSaleError(String(error?.code || ""), String(error?.message || "")) };
  }
}

async function tryCreateSaleInBackend(cartItems, session, paymentDetails) {
  if (!navigator.onLine) {
    return { ok: false, canFallbackToOffline: true };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, canFallbackToOffline: true };
  }

  const grouped = new Map();
  for (const item of cartItems) {
    const codigo = String(item?.barcode || "").trim();
    const cantidad = Number(item?.quantity || 0);
    if (!codigo || !Number.isFinite(cantidad) || cantidad <= 0) {
      return { ok: false, canFallbackToOffline: false, error: "Hay items invalidos en la venta." };
    }
    grouped.set(codigo, (grouped.get(codigo) || 0) + Math.trunc(cantidad));
  }

  const payload = {
    idVenta: `V-${Date.now()}`,
    tenantId: session.tenantId,
    tipoPago: paymentDetails.tipoPago,
    pagoEfectivo: paymentDetails.pagoEfectivo,
    pagoVirtual: paymentDetails.pagoVirtual,
    productos: Array.from(grouped.entries()).map(([codigo, cantidad]) => ({ codigo, cantidad }))
  };

  try {
    const response = await createSaleCallable(payload);
    const data = response?.data || {};
    if (!data?.success || !data?.idVenta) {
      return { ok: false, canFallbackToOffline: false, error: "Respuesta invalida del backend de ventas." };
    }
    return { ok: true, data };
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    const canFallbackToOffline =
      code.includes("unavailable") || code.includes("deadline-exceeded") || code.includes("cancelled");

    return {
      ok: false,
      canFallbackToOffline,
      error: mapCreateSaleError(code, message)
    };
  }
}

async function finalizeSaleLocally(cartItems, session, { authoritative, paymentDetails }) {
  const db = await openDatabase();
  const nowIso = new Date().toISOString();
  const saleId = String(authoritative?.idVenta || crypto.randomUUID());
  const authoritativeByCode = new Map();
  for (const item of authoritative?.productos || []) {
    authoritativeByCode.set(String(item.codigo || "").trim(), item);
  }

  let itemsCount = 0;
  let total = 0;
  let totalCost = 0;
  let gananciaReal = 0;
  let salePayload = null;

  try {
    await runWriteTransaction(db, [STORES.products, STORES.sales, STORES.saleItems], async (tx) => {
      const productsStore = tx.objectStore(STORES.products);
      const salesStore = tx.objectStore(STORES.sales);
      const saleItemsStore = tx.objectStore(STORES.saleItems);

      for (const cartItem of cartItems) {
        const product = await reqToPromise(productsStore.get(cartItem.productId));
        if (!product || product.kioscoId !== session.tenantId) {
          throw new Error(`Producto no disponible: ${cartItem.name}.`);
        }

        const requestedQty = Number(cartItem.quantity || 0);
        if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
          throw new Error(`Cantidad invalida para ${cartItem.name}.`);
        }

        if (Number(product.stock || 0) < requestedQty) {
          throw new Error(`Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`);
        }

        product.stock = Number(product.stock || 0) - requestedQty;
        productsStore.put(product);

        const code = String(product.barcode || cartItem.barcode || "").trim();
        const serverItem = authoritativeByCode.get(code);
        const unitPrice = round2(serverItem ? Number(serverItem.precioUnitario || 0) : Number(cartItem.price || 0));
        const unitProviderCost = round2(
          serverItem ? Number(serverItem.precioCompraUnitario || 0) : Number(product.providerCost || 0)
        );
        const subtotal = round2(unitPrice * requestedQty);
        const subtotalCost = round2(unitProviderCost * requestedQty);
        const gananciaRealVenta = round2((unitPrice - unitProviderCost) * requestedQty);

        total += subtotal;
        totalCost += subtotalCost;
        gananciaReal += gananciaRealVenta;
        itemsCount += requestedQty;

        saleItemsStore.put({
          id: crypto.randomUUID(),
          saleId,
          kioscoId: session.tenantId,
          userId: session.userId,
          productId: product.id,
          barcode: code,
          name: product.name,
          quantity: requestedQty,
          unitPrice,
          subtotal,
          unitProviderCost,
          subtotalCost,
          gananciaRealVenta,
          createdAt: nowIso
        });
      }

      const saleTotal = round2(authoritative ? Number(authoritative.totalCalculado || 0) : total);
      const saleCost = round2(authoritative ? Number(authoritative.totalCosto || 0) : totalCost);
      const saleGananciaReal = round2(
        authoritative ? Number(authoritative.gananciaReal ?? authoritative.ganaciaReal ?? 0) : gananciaReal
      );

      salePayload = {
        id: saleId,
        kioscoId: session.tenantId,
        userId: session.userId,
        username: session.username,
        role: session.role,
        total: saleTotal,
        totalCost: saleCost,
        gananciaReal: saleGananciaReal,
        profit: saleGananciaReal,
        tipoPago: String(authoritative?.tipoPago || paymentDetails?.tipoPago || "efectivo"),
        pagoEfectivo: round2(Number(authoritative?.pagoEfectivo ?? paymentDetails?.pagoEfectivo ?? saleTotal)),
        pagoVirtual: round2(Number(authoritative?.pagoVirtual ?? paymentDetails?.pagoVirtual ?? 0)),
        synced: Boolean(authoritative),
        backups: Boolean(authoritative),
        cajaCerrada: false,
        cajaId: null,
        itemsCount,
        createdAt: nowIso
      };
      salesStore.put(salePayload);
    });
  } catch (error) {
    return { ok: false, error: error.message || "No se pudo cobrar la venta." };
  }

  return {
    ok: true,
    saleId,
    total: round2(salePayload?.total || total),
    totalCost: round2(salePayload?.totalCost || totalCost),
    gananciaReal: round2(salePayload?.gananciaReal ?? salePayload?.ganaciaReal ?? gananciaReal),
    profit: round2(salePayload?.gananciaReal ?? salePayload?.ganaciaReal ?? gananciaReal),
    itemsCount
  };
}

function normalizePaymentDetails(paymentDetails, cartItems) {
  const total = round2(
    (cartItems || []).reduce((acc, item) => acc + Number(item?.subtotal || Number(item?.price || 0) * Number(item?.quantity || 0)), 0)
  );
  const tipoPago = String(paymentDetails?.tipoPago || "efectivo").trim().toLowerCase();
  if (!["efectivo", "virtual", "mixto"].includes(tipoPago)) {
    return { ok: false, error: "Forma de pago invalida." };
  }

  if (tipoPago === "efectivo") {
    return { ok: true, value: { tipoPago, pagoEfectivo: total, pagoVirtual: 0 } };
  }
  if (tipoPago === "virtual") {
    return { ok: true, value: { tipoPago, pagoEfectivo: 0, pagoVirtual: total } };
  }

  const pagoEfectivo = round2(Number(paymentDetails?.pagoEfectivo || 0));
  const pagoVirtual = round2(total - pagoEfectivo);
  if (!Number.isFinite(pagoEfectivo) || pagoEfectivo < 0 || pagoEfectivo > total) {
    return { ok: false, error: "Pago efectivo invalido para venta mixta." };
  }
  if (!Number.isFinite(pagoVirtual) || pagoVirtual < 0) {
    return { ok: false, error: "Pago virtual invalido para venta mixta." };
  }
  return { ok: true, value: { tipoPago, pagoEfectivo, pagoVirtual } };
}

function mapCreateSaleError(code, message) {
  if (message) return message;
  if (code.includes("unauthenticated")) return "Sesion invalida para cobrar.";
  if (code.includes("permission-denied")) return "No tienes permisos para cobrar esta venta.";
  if (code.includes("failed-precondition")) return "No se pudo cobrar: revisa stock y productos.";
  if (code.includes("invalid-argument")) return "Datos invalidos en la venta.";
  return "No se pudo cobrar la venta.";
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Error de IndexedDB."));
  });
}

function runWriteTransaction(db, storeNames, executor) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    let settled = false;

    tx.oncomplete = () => {
      if (!settled) resolve();
    };
    tx.onerror = () => {
      if (!settled) reject(tx.error || new Error("No se pudo completar la transaccion."));
    };
    tx.onabort = () => {
      if (!settled) reject(tx.error || new Error("La transaccion fue cancelada."));
    };

    Promise.resolve()
      .then(() => executor(tx))
      .catch((error) => {
        settled = true;
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}
