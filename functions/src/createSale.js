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
    const tipoVenta = normalizeSaleType(row?.tipoVenta);
    const cantidad = Number(row?.cantidad || 0);
    const cantidadGramos = Number(row?.cantidadGramos || 0);
    const gramosPorUnidad = Math.max(1, Math.trunc(Number(row?.gramosPorUnidad || 1000)));
    if (!codigo) {
      throw new HttpsError("invalid-argument", "Cada item debe incluir codigo.");
    }
    if (tipoVenta === "gramos") {
      if (!Number.isFinite(cantidadGramos) || cantidadGramos <= 0) {
        throw new HttpsError("invalid-argument", `Cantidad de gramos invalida para ${codigo}.`);
      }
      const existing = grouped.get(codigo) || { tipoVenta: "gramos", cantidad: 0, cantidadGramos: 0, gramosPorUnidad };
      if (existing.tipoVenta === "unidad") {
        throw new HttpsError("invalid-argument", `No puedes mezclar unidad y gramos para ${codigo}.`);
      }
      existing.tipoVenta = "gramos";
      existing.cantidadGramos = Number(existing.cantidadGramos || 0) + cantidadGramos;
      existing.gramosPorUnidad = gramosPorUnidad;
      grouped.set(codigo, existing);
      continue;
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new HttpsError("invalid-argument", `Cantidad invalida para ${codigo}.`);
    }
    const existing = grouped.get(codigo) || { tipoVenta: "unidad", cantidad: 0, cantidadGramos: 0, gramosPorUnidad: 0 };
    if (existing.tipoVenta === "gramos") {
      throw new HttpsError("invalid-argument", `No puedes mezclar unidad y gramos para ${codigo}.`);
    }
    existing.tipoVenta = "unidad";
    existing.cantidad = Number(existing.cantidad || 0) + Math.trunc(cantidad);
    grouped.set(codigo, existing);
  }

  const now = Timestamp.now();
  const saleItems = [];
  let total = 0;
  let totalCosto = 0;
  let gananciaReal = 0;
  let itemsCount = 0;

  await db.runTransaction(async (tx) => {
    const productRefs = new Map();
    const productsByCode = new Map();

    for (const [codigo, row] of grouped.entries()) {
      const productRef = db.collection("tenants").doc(tenantId).collection("productos").doc(codigo);
      productRefs.set(codigo, productRef);
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists) {
        throw new HttpsError("failed-precondition", `Producto no encontrado: ${codigo}.`);
      }
      productsByCode.set(codigo, productSnap.data() || {});
    }

    for (const [codigo, row] of grouped.entries()) {
      const productRef = productRefs.get(codigo);
      const product = productsByCode.get(codigo) || {};
      const stock = Number(product.stock || 0);
      const precioVenta = Number(product.precioVenta ?? product.precio ?? 0);
      const precioCompra = Number(product.precioCompra ?? product.costoProveedor ?? 0);
      if (!Number.isFinite(precioVenta) || precioVenta < 0) {
        throw new HttpsError("failed-precondition", `Precio de venta invalido en ${codigo}.`);
      }
      if (!Number.isFinite(precioCompra) || precioCompra < 0) {
        throw new HttpsError("failed-precondition", `Precio de compra invalido en ${codigo}.`);
      }

      const saleType = normalizeSaleType(row?.tipoVenta ?? product?.tipoVenta);
      if (saleType === "gramos") {
        const gramsRequested = Number(row?.cantidadGramos || 0);
        const gramsPerUnit = Math.max(
          1,
          Math.trunc(Number(row?.gramosPorUnidad || product?.gramosPorUnidad || product?.gramsPerUnit || 1000))
        );
        const gramsPendingBefore = Number(product.gramosAcumuladosPendientes ?? product.gramsPending ?? 0);
        const totalGrams = gramsPendingBefore + gramsRequested;
        const unitsToDiscount = Math.trunc(totalGrams / gramsPerUnit);
        const gramsPendingAfter = totalGrams % gramsPerUnit;
        if (stock < unitsToDiscount) {
          throw new HttpsError("failed-precondition", `Stock insuficiente para ${codigo}. Disponible: ${stock}.`);
        }

        const subtotal = round2((precioVenta * gramsRequested) / 1000);
        const subtotalCosto = round2((precioCompra * gramsRequested) / 1000);
        const gananciaRealVenta = round2(subtotal - subtotalCosto);

        saleItems.push({
          codigo,
          nombre: String(product.nombre || "-"),
          tipoVenta: "gramos",
          cantidad: 0,
          cantidadGramos: gramsRequested,
          gramosPorUnidad: gramsPerUnit,
          precioUnitario: round2(precioVenta),
          precioCompraUnitario: round2(precioCompra),
          subtotal,
          subtotalCosto,
          gananciaRealVenta
        });

        total += subtotal;
        totalCosto += subtotalCosto;
        gananciaReal += gananciaRealVenta;
        itemsCount += 1;

        tx.update(productRef, {
          stock: stock - unitsToDiscount,
          tipoVenta: "gramos",
          unidadMedida: "g",
          gramosPorUnidad: gramsPerUnit,
          gramsPerUnit: gramsPerUnit,
          gramosAcumuladosPendientes: gramsPendingAfter,
          gramsPending: gramsPendingAfter,
          updatedAt: now
        });
      } else {
        const cantidad = Number(row?.cantidad || 0);
        if (stock < cantidad) {
          throw new HttpsError("failed-precondition", `Stock insuficiente para ${codigo}. Disponible: ${stock}.`);
        }
        const subtotal = round2(precioVenta * cantidad);
        const subtotalCosto = round2(precioCompra * cantidad);
        const gananciaRealVenta = round2((precioVenta - precioCompra) * cantidad);

        saleItems.push({
          codigo,
          nombre: String(product.nombre || "-"),
          tipoVenta: "unidad",
          cantidad,
          cantidadGramos: 0,
          gramosPorUnidad: 0,
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

        tx.update(productRef, {
          stock: stock - cantidad,
          updatedAt: now
        });
      }
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
    tx.set(saleRef, {
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
  });

  const paymentDetails = normalizePaymentPayload({
    tipoPago: payload.tipoPago,
    pagoEfectivo: payload.pagoEfectivo,
    pagoVirtual: payload.pagoVirtual,
    total
  });

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

function normalizeSaleType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "gramos" || normalized === "g") return "gramos";
  return "unidad";
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
