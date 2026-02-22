const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const closeCashbox = onCall(async (request) => {
  const { uid, tenantId, role, caller } = await requireTenantMemberContext(request);

  const turnoId = String(request.data?.turnoId || "").trim();
  const idCaja = turnoId ? `CAJA-${turnoId}-${Date.now()}` : `CAJA-${Date.now()}`;
  const usuarioNombre = String(caller?.displayName || caller?.username || caller?.email || uid).trim();

  const salesSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("ventas")
    .where("cajaCerrada", "==", false)
    .where("usuarioUid", "==", uid)
    .get();

  if (salesSnap.empty) {
    throw new HttpsError("failed-precondition", "No hay ventas pendientes para cerrar caja.");
  }

  const ventasIncluidas = [];
  const productosIncluidosMap = new Map();
  let totalCaja = 0;
  let totalGananciaRealCaja = 0;
  let fechaApertura = null;
  const fechaCierre = Timestamp.now();

  salesSnap.docs.forEach((docSnap) => {
    const sale = docSnap.data() || {};
    ventasIncluidas.push(docSnap.id);
    totalCaja += Number(sale.total || 0);
    totalGananciaRealCaja += Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0);
    collectSaleProducts(sale, productosIncluidosMap);

    const saleCreatedAt = normalizeToDate(sale.createdAt);
    if (saleCreatedAt && (!fechaApertura || saleCreatedAt < fechaApertura)) {
      fechaApertura = saleCreatedAt;
    }
  });

  totalCaja = round2(totalCaja);
  totalGananciaRealCaja = round2(totalGananciaRealCaja);
  const productosIncluidos = Array.from(productosIncluidosMap.values()).sort((a, b) =>
    String(a.idProducto || "").localeCompare(String(b.idProducto || ""))
  );

  const cajaRef = db.collection("tenants").doc(tenantId).collection("cajas").doc(idCaja);
  const batch = db.batch();

  batch.set(cajaRef, {
    idCaja,
    tenantId,
    dateKey: turnoId || null,
    scopeKey: String(uid),
    total: totalCaja,
    GanaciaRealCaja: totalGananciaRealCaja,
    totalGananciaRealCaja,
    usuarioUid: uid,
    usuarioNombre,
    role: String(role || "empleado"),
    fechaApertura: fechaApertura ? Timestamp.fromDate(fechaApertura) : fechaCierre,
    fechaCierre,
    ventasIncluidas,
    productosIncluidos,
    createdAt: Timestamp.now()
  });

  salesSnap.docs.forEach((docSnap) => {
    batch.update(docSnap.ref, {
      cajaId: idCaja,
      cajaCerrada: true,
      updatedAt: fechaCierre
    });
  });

  await batch.commit();

  return {
    success: true,
    idCaja,
    totalCaja,
    totalGananciaRealCaja,
    ventasIncluidas,
    productosIncluidos
  };
});

function collectSaleProducts(sale, targetMap) {
  const items = Array.isArray(sale?.productos) ? sale.productos : [];
  items.forEach((item) => {
    const idProducto = String(
      item?.idProducto || item?.codigo || item?.productId || item?.barcode || ""
    ).trim();
    if (!idProducto) return;

    const cantidad = Number(item?.cantidad ?? item?.quantity ?? 0);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return;

    const precioVenta = round2(Number(item?.precioUnitario ?? item?.unitPrice ?? 0));
    const precioCompra = round2(Number(item?.precioCompraUnitario ?? item?.unitProviderCost ?? 0));

    const key = `${idProducto}::${precioVenta}::${precioCompra}`;
    const current = targetMap.get(key);
    if (!current) {
      targetMap.set(key, {
        idProducto,
        cantidadVendido: round2(cantidad),
        precioVenta,
        precioCompra
      });
      return;
    }

    current.cantidadVendido = round2(Number(current.cantidadVendido || 0) + cantidad);
  });
}

function normalizeToDate(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (typeof value?.toDate === "function") return value.toDate();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

module.exports = {
  closeCashbox
};
