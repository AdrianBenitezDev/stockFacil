const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const syncSales = onCall(async (request) => {
  const { uid, tenantId, caller } = await requireTenantMemberContext(request);

  const ventas = Array.isArray(request.data?.ventas) ? request.data.ventas : [];
  if (ventas.length === 0) {
    return { success: true, syncedIds: [] };
  }
  if (ventas.length > 200) {
    throw new HttpsError("invalid-argument", "Maximo 200 ventas por sincronizacion.");
  }

  const syncedIds = [];
  let batch = db.batch();
  let writes = 0;

  for (const rawSale of ventas) {
    const sale = normalizeSale(rawSale);
    const saleRef = db.collection("tenants").doc(tenantId).collection("ventas").doc(sale.idVenta);

    batch.set(
      saleRef,
      {
        idVenta: sale.idVenta,
        tenantId,
        productos: sale.productos,
        total: sale.total,
        totalCost: sale.totalCost,
        gananciaReal: sale.gananciaReal,
        tipoPago: sale.tipoPago,
        pagoEfectivo: sale.pagoEfectivo,
        pagoVirtual: sale.pagoVirtual,
        auditRequired: sale.auditRequired === true,
        auditReason: String(sale.auditReason || ""),
        auditNote: String(sale.auditNote || ""),
        auditSource: String(sale.auditSource || ""),
        usuarioUid: uid,
        usuarioNombre: String(caller.username || caller.displayName || "usuario"),
        cajaCerrada: false,
        cajaId: null,
        backups: true,
        synced: true,
        itemsCount: sale.itemsCount,
        createdAt: sale.createdAt,
        syncedAt: Timestamp.now()
      },
      { merge: true }
    );

    syncedIds.push(sale.idVenta);
    writes += 1;
    if (writes >= 400) {
      await batch.commit();
      batch = db.batch();
      writes = 0;
    }
  }

  if (writes > 0) {
    await batch.commit();
  }

  return { success: true, syncedIds };
});

function normalizeSale(rawSale) {
  const idVenta = String(rawSale?.idVenta || "").trim();
  const total = Number(rawSale?.total || 0);
  const totalCost = Number(rawSale?.totalCost || 0);
  const gananciaReal = Number(rawSale?.gananciaReal ?? rawSale?.ganaciaReal ?? 0);
  const itemsCount = Number(rawSale?.itemsCount || 0);
  const createdAtInput = rawSale?.createdAt;
  const auditRequired = rawSale?.auditRequired === true;
  const auditReason = String(rawSale?.auditReason || "").trim();
  const auditNote = String(rawSale?.auditNote || "").trim();
  const auditSource = String(rawSale?.auditSource || "").trim();
  const productos = Array.isArray(rawSale?.productos) ? rawSale.productos : [];
  const payment = normalizePayment(rawSale);

  if (!idVenta) {
    throw new HttpsError("invalid-argument", "Venta invalida: falta idVenta.");
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): total.`);
  }
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): totalCost.`);
  }
  if (!Number.isFinite(gananciaReal)) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): gananciaReal.`);
  }
  if (!Number.isFinite(itemsCount) || itemsCount < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): itemsCount.`);
  }

  return {
    idVenta,
    total: round2(total),
    totalCost: round2(totalCost),
    gananciaReal: round2(gananciaReal),
    tipoPago: payment.tipoPago,
    pagoEfectivo: payment.pagoEfectivo,
    pagoVirtual: payment.pagoVirtual,
    itemsCount: Math.trunc(itemsCount),
    auditRequired,
    auditReason,
    auditNote,
    auditSource,
    productos: productos.map(normalizeSaleItem),
    createdAt: normalizeCreatedAt(createdAtInput)
  };
}

function normalizeSaleItem(rawItem) {
  const codigo = String(rawItem?.codigo || "").trim();
  const nombre = String(rawItem?.nombre || "").trim();
  const tipoVenta = normalizeSaleType(rawItem?.tipoVenta);
  const cantidad = Number(rawItem?.cantidad || 0);
  const cantidadGramos = Number(rawItem?.cantidadGramos || 0);
  const gramosPorUnidad = Math.trunc(Number(rawItem?.gramosPorUnidad || 0));
  const precioUnitario = Number(rawItem?.precioUnitario || 0);
  const precioCompraUnitario = Number(rawItem?.precioCompraUnitario || 0);
  const subtotal = Number(rawItem?.subtotal || 0);
  const subtotalCosto = Number(rawItem?.subtotalCosto || 0);
  const gananciaRealVenta = Number(rawItem?.gananciaRealVenta ?? rawItem?.ganaciaRealVenta ?? 0);

  if (!codigo) {
    throw new HttpsError("invalid-argument", "Item de venta invalido: falta codigo.");
  }
  if (tipoVenta === "gramos") {
    if (!Number.isFinite(cantidadGramos) || cantidadGramos <= 0) {
      throw new HttpsError("invalid-argument", `Item invalido (${codigo}): cantidadGramos.`);
    }
  } else if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new HttpsError("invalid-argument", `Item invalido (${codigo}): cantidad.`);
  }

  return {
    codigo,
    nombre: nombre || codigo,
    tipoVenta,
    cantidad: tipoVenta === "gramos" ? 0 : Math.trunc(cantidad),
    cantidadGramos: tipoVenta === "gramos" ? Number(cantidadGramos) : 0,
    gramosPorUnidad: tipoVenta === "gramos" ? Math.max(1, gramsOrDefault(gramosPorUnidad)) : 0,
    precioUnitario: round2(precioUnitario),
    precioCompraUnitario: round2(precioCompraUnitario),
    subtotal: round2(subtotal),
    subtotalCosto: round2(subtotalCosto),
    gananciaRealVenta: round2(gananciaRealVenta)
  };
}

function normalizeSaleType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "gramos" || normalized === "g") return "gramos";
  return "unidad";
}

function gramsOrDefault(value) {
  if (!Number.isFinite(value) || value <= 0) return 1000;
  return Math.trunc(value);
}

function normalizeCreatedAt(input) {
  if (input && typeof input === "string") {
    const date = new Date(input);
    if (!Number.isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }
  return Timestamp.now();
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizePayment(rawSale) {
  const tipoPago = String(rawSale?.tipoPago || "").trim().toLowerCase() || "efectivo";
  const total = round2(Number(rawSale?.total || 0));

  if (tipoPago === "virtual") {
    return { tipoPago, pagoEfectivo: 0, pagoVirtual: total };
  }
  if (tipoPago === "mixto") {
    const pagoEfectivo = round2(Number(rawSale?.pagoEfectivo || 0));
    const pagoVirtual = round2(Number(rawSale?.pagoVirtual || 0));
    if (
      !Number.isFinite(pagoEfectivo) ||
      !Number.isFinite(pagoVirtual) ||
      pagoEfectivo < 0 ||
      pagoVirtual < 0 ||
      round2(pagoEfectivo + pagoVirtual) !== total
    ) {
      throw new HttpsError("invalid-argument", `Venta invalida (${String(rawSale?.idVenta || "")}): pago mixto.`);
    }
    return { tipoPago, pagoEfectivo, pagoVirtual };
  }
  return { tipoPago: "efectivo", pagoEfectivo: total, pagoVirtual: 0 };
}

module.exports = {
  syncSales
};
