const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const closeCashbox = onCall(async (request) => {
  const { uid, tenantId } = await requireTenantMemberContext(request);

  const turnoId = String(request.data?.turnoId || "").trim();
  const idCaja = turnoId ? `CAJA-${turnoId}-${Date.now()}` : `CAJA-${Date.now()}`;

  const salesSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("ventas")
    .where("cajaId", "==", null)
    .where("usuarioUid", "==", uid)
    .get();

  if (salesSnap.empty) {
    throw new HttpsError("failed-precondition", "No hay ventas pendientes para cerrar caja.");
  }

  const ventasIncluidas = [];
  let totalCaja = 0;
  let totalGananciaRealCaja = 0;
  let fechaApertura = null;
  const fechaCierre = Timestamp.now();

  salesSnap.docs.forEach((docSnap) => {
    const sale = docSnap.data() || {};
    ventasIncluidas.push(docSnap.id);
    totalCaja += Number(sale.total || 0);
    totalGananciaRealCaja += Number(sale.ganaciaReal ?? sale.profit ?? 0);

    const saleCreatedAt = normalizeToDate(sale.createdAt);
    if (saleCreatedAt && (!fechaApertura || saleCreatedAt < fechaApertura)) {
      fechaApertura = saleCreatedAt;
    }
  });

  totalCaja = round2(totalCaja);
  totalGananciaRealCaja = round2(totalGananciaRealCaja);

  const cajaRef = db.collection("tenants").doc(tenantId).collection("cajas").doc(idCaja);
  const batch = db.batch();

  batch.set(cajaRef, {
    idCaja,
    tenantId,
    total: totalCaja,
    GanaciaRealCaja: totalGananciaRealCaja,
    totalGananciaRealCaja,
    usuarioUid: uid,
    fechaApertura: fechaApertura ? Timestamp.fromDate(fechaApertura) : fechaCierre,
    fechaCierre,
    ventasIncluidas,
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
    ventasIncluidas
  };
});

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
