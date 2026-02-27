const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");
const { getEmployeeShiftStatusCached } = require("./shared/employeeShift");

const createSale = onCall(async (request) => {
  const { uid, tenantId, caller } = await requireTenantMemberContext(request);
  const normalizedRole = String(caller?.role || "").trim().toLowerCase();

  if (normalizedRole === "empleado") {
    const shiftStatus = await getEmployeeShiftStatusCached(uid, tenantId);
    if (!shiftStatus.ok || shiftStatus.active !== true) {
      throw new HttpsError("failed-precondition", "el empleador no inicio tu turno!");
    }
  }

  const payload = request.data || {};
  const requestedId = String(payload.idVenta || "").trim();
  const idVenta = requestedId || `V-${Date.now()}`;
  const rawItems = Array.isArray(payload.productos) ? payload.productos : [];
  if (rawItems.length === 0) {
    throw new HttpsError("invalid-argument", "No hay productos para cobrar.");
  }
  if (rawItems.length > 200) {
    throw new HttpsError("invalid-argument", "Maximo 200 items por venta.");
  }

  const grouped = new Map();
  for (const row of rawItems) {
    const codigo = String(row?.codigo || "").trim();
    const cantidad = Number(row?.cantidad || 0);
    if (!codigo) {
      throw new HttpsError("invalid-argument", "Cada item debe incluir codigo.");
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new HttpsError("invalid-argument", `Cantidad invalida para ${codigo}.`);
    }
    grouped.set(codigo, (grouped.get(codigo) || 0) + Math.trunc(cantidad));
  }

  const now = Timestamp.now();
  const saleItems = [];
  let total = 0;
  let totalCosto = 0;
  let gananciaReal = 0;
  let itemsCount = 0;

  const batch = db.batch();

  for (const [codigo, cantidad] of grouped.entries()) {
    const productRef = db.collection("tenants").doc(tenantId).collection("productos").doc(codigo);
    const productSnap = await productRef.get();
    if (!productSnap.exists) {
      throw new HttpsError("failed-precondition", `Producto no encontrado: ${codigo}.`);
    }

    const product = productSnap.data() || {};
    const stock = Number(product.stock || 0);
    if (stock < cantidad) {
      throw new HttpsError("failed-precondition", `Stock insuficiente para ${codigo}. Disponible: ${stock}.`);
    }

    const precioVenta = Number(product.precioVenta ?? product.precio ?? 0);
    const precioCompra = Number(product.precioCompra ?? product.costoProveedor ?? 0);
    if (!Number.isFinite(precioVenta) || precioVenta < 0) {
      throw new HttpsError("failed-precondition", `Precio de venta invalido en ${codigo}.`);
    }
    if (!Number.isFinite(precioCompra) || precioCompra < 0) {
      throw new HttpsError("failed-precondition", `Precio de compra invalido en ${codigo}.`);
    }

    const subtotal = round2(precioVenta * cantidad);
    const subtotalCosto = round2(precioCompra * cantidad);
    const gananciaRealVenta = round2((precioVenta - precioCompra) * cantidad);

    saleItems.push({
      codigo,
      nombre: String(product.nombre || "-"),
      cantidad,
      precioUnitario: round2(precioVenta),
      precioCompraUnitario: round2(precioCompra),
      subtotal,
      subtotalCosto,
      gananciaRealVenta
    });

    total += subtotal;
    totalCosto += subtotalCosto;
    gananciaReal += gananciaRealVenta;
    itemsCount += cantidad;

    batch.update(productRef, {
      stock: stock - cantidad,
      updatedAt: now
    });
  }

  total = round2(total);
  totalCosto = round2(totalCosto);
  gananciaReal = round2(gananciaReal);
  const paymentDetails = normalizePaymentPayload({
    tipoPago: payload.tipoPago,
    pagoEfectivo: payload.pagoEfectivo,
    pagoVirtual: payload.pagoVirtual,
    total
  });

  const saleRef = db.collection("tenants").doc(tenantId).collection("ventas").doc(idVenta);
  batch.set(saleRef, {
    idVenta,
    tenantId,
    productos: saleItems,
    total,
    totalCosto,
    gananciaReal,
    usuarioUid: uid,
    usuarioNombre: String(caller.username || caller.displayName || "usuario"),
    tipoPago: paymentDetails.tipoPago,
    pagoEfectivo: paymentDetails.pagoEfectivo,
    pagoVirtual: paymentDetails.pagoVirtual,
    auditRequired: false,
    auditReason: "",
    auditNote: "",
    auditSource: "online",
    cajaCerrada: false,
    backups: true,
    itemsCount,
    createdAt: now
  });

  await batch.commit();

  return {
    success: true,
    idVenta,
    totalCalculado: total,
    totalCosto,
    gananciaReal,
    tipoPago: paymentDetails.tipoPago,
    pagoEfectivo: paymentDetails.pagoEfectivo,
    pagoVirtual: paymentDetails.pagoVirtual,
    itemsCount,
    productos: saleItems
  };
});

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizePaymentPayload({ tipoPago, pagoEfectivo, pagoVirtual, total }) {
  const normalizedTotal = round2(total);
  const normalizedType = String(tipoPago || "").trim().toLowerCase() || "efectivo";

  if (normalizedType === "virtual") {
    return {
      tipoPago: "virtual",
      pagoEfectivo: 0,
      pagoVirtual: normalizedTotal
    };
  }
  if (normalizedType === "mixto") {
    const cash = round2(Number(pagoEfectivo || 0));
    const virtual = round2(Number(pagoVirtual ?? normalizedTotal - cash));
    const sum = round2(cash + virtual);
    if (!Number.isFinite(cash) || !Number.isFinite(virtual) || cash < 0 || virtual < 0 || sum !== normalizedTotal) {
      throw new HttpsError("invalid-argument", "Pago mixto invalido.");
    }
    return {
      tipoPago: "mixto",
      pagoEfectivo: cash,
      pagoVirtual: virtual
    };
  }
  return {
    tipoPago: "efectivo",
    pagoEfectivo: normalizedTotal,
    pagoVirtual: 0
  };
}

module.exports = {
  createSale
};
