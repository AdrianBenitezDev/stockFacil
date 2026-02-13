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
        ganaciaReal: sale.ganaciaReal,
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
  const ganaciaReal = Number(rawSale?.ganaciaReal || 0);
  const itemsCount = Number(rawSale?.itemsCount || 0);
  const createdAtInput = rawSale?.createdAt;
  const productos = Array.isArray(rawSale?.productos) ? rawSale.productos : [];

  if (!idVenta) {
    throw new HttpsError("invalid-argument", "Venta invalida: falta idVenta.");
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): total.`);
  }
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): totalCost.`);
  }
  if (!Number.isFinite(ganaciaReal)) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): ganaciaReal.`);
  }
  if (!Number.isFinite(itemsCount) || itemsCount < 0) {
    throw new HttpsError("invalid-argument", `Venta invalida (${idVenta}): itemsCount.`);
  }

  return {
    idVenta,
    total: round2(total),
    totalCost: round2(totalCost),
    ganaciaReal: round2(ganaciaReal),
    itemsCount: Math.trunc(itemsCount),
    productos: productos.map(normalizeSaleItem),
    createdAt: normalizeCreatedAt(createdAtInput)
  };
}

function normalizeSaleItem(rawItem) {
  const codigo = String(rawItem?.codigo || "").trim();
  const nombre = String(rawItem?.nombre || "").trim();
  const cantidad = Number(rawItem?.cantidad || 0);
  const precioUnitario = Number(rawItem?.precioUnitario || 0);
  const precioCompraUnitario = Number(rawItem?.precioCompraUnitario || 0);
  const subtotal = Number(rawItem?.subtotal || 0);
  const subtotalCosto = Number(rawItem?.subtotalCosto || 0);
  const ganaciaRealVenta = Number(rawItem?.ganaciaRealVenta || 0);

  if (!codigo) {
    throw new HttpsError("invalid-argument", "Item de venta invalido: falta codigo.");
  }
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw new HttpsError("invalid-argument", `Item invalido (${codigo}): cantidad.`);
  }

  return {
    codigo,
    nombre: nombre || codigo,
    cantidad: Math.trunc(cantidad),
    precioUnitario: round2(precioUnitario),
    precioCompraUnitario: round2(precioCompraUnitario),
    subtotal: round2(subtotal),
    subtotalCosto: round2(subtotalCosto),
    ganaciaRealVenta: round2(ganaciaRealVenta)
  };
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

module.exports = {
  syncSales
};
