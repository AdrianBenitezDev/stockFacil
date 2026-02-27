const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");
const {
  getLatestEmployeeShift,
  invalidateEmployeeShiftCache,
  buildTurnoPayload,
  closeTurnoPayload
} = require("./shared/employeeShift");

const startEmployeeShift = onCall(async (request) => {
  const { tenantId, uid } = await requireEmployerContext(request);

  const employeeUid = String(request.data?.employeeUid || "").trim();
  const inicioCaja = Number(request.data?.inicioCaja);
  if (!employeeUid) {
    throw new HttpsError("invalid-argument", "Debes seleccionar un empleado.");
  }
  if (!Number.isFinite(inicioCaja) || inicioCaja < 0) {
    throw new HttpsError("invalid-argument", "El inicio de caja es invalido.");
  }

  const employeeRef = db.collection("empleados").doc(employeeUid);
  const employeeSnap = await employeeRef.get();
  if (!employeeSnap.exists) {
    throw new HttpsError("not-found", "El empleado no existe.");
  }
  const employee = employeeSnap.data() || {};
  const employeeTenantId = String(employee.comercioId || employee.tenantId || "").trim();
  if (!employeeTenantId || employeeTenantId !== tenantId) {
    throw new HttpsError("permission-denied", "No puedes iniciar turno para empleados de otro comercio.");
  }

  const latest = await getLatestEmployeeShift(employeeUid);
  if (latest?.turnoIniciado === true && latest?.turnoCerrado !== true) {
    throw new HttpsError("failed-precondition", "El empleado ya tiene un turno activo.");
  }

  const nowDate = new Date();
  const idTurno = `TURNO-${employeeUid}-${Date.now()}`;
  const turnoRef = employeeRef.collection("turno").doc(idTurno);
  const payload = buildTurnoPayload({
    idTurno,
    tenantId,
    employeeUid,
    nowDate,
    inicioCaja
  });

  await turnoRef.set({
    ...payload,
    creadoPorUid: uid
  });
  invalidateEmployeeShiftCache(employeeUid);

  return {
    success: true,
    turno: {
      idTurno,
      empleadoUid: employeeUid,
      tenantId,
      fechaInicio: payload.fechaInicio,
      horaInicio: payload.horaInicio,
      inicioCaja: payload.inicioCaja,
      turnoIniciado: true,
      turnoCerrado: false
    }
  };
});

const endEmployeeShift = onCall(async (request) => {
  const { tenantId, uid } = await requireEmployerContext(request);

  const employeeUid = String(request.data?.employeeUid || "").trim();
  if (!employeeUid) {
    throw new HttpsError("invalid-argument", "Debes seleccionar un empleado.");
  }

  const employeeRef = db.collection("empleados").doc(employeeUid);
  const employeeSnap = await employeeRef.get();
  if (!employeeSnap.exists) {
    throw new HttpsError("not-found", "El empleado no existe.");
  }
  const employee = employeeSnap.data() || {};
  const employeeTenantId = String(employee.comercioId || employee.tenantId || "").trim();
  if (!employeeTenantId || employeeTenantId !== tenantId) {
    throw new HttpsError("permission-denied", "No puedes cerrar turno para empleados de otro comercio.");
  }

  const latest = await getLatestEmployeeShift(employeeUid);
  if (!latest) {
    throw new HttpsError("failed-precondition", "El empleado no tiene turnos registrados.");
  }
  if (latest.turnoIniciado !== true || latest.turnoCerrado === true) {
    throw new HttpsError("failed-precondition", "El empleado no tiene un turno activo para cerrar.");
  }

  const salesSnap = await db
    .collection("tenants")
    .doc(tenantId)
    .collection("ventas")
    .where("cajaCerrada", "==", false)
    .where("usuarioUid", "==", employeeUid)
    .get();

  let totalEfectivo = 0;
  let totalVirtual = 0;
  salesSnap.docs.forEach((docSnap) => {
    const sale = docSnap.data() || {};
    const payment = resolveSalePaymentBreakdown(sale);
    totalEfectivo += Number(payment.pagoEfectivo || 0);
    totalVirtual += Number(payment.pagoVirtual || 0);
  });
  totalEfectivo = round2(totalEfectivo);
  totalVirtual = round2(totalVirtual);
  const inicioCaja = round2(Number(latest.inicioCaja || 0));
  const montoCierreCaja = round2(inicioCaja + totalEfectivo + totalVirtual);
  const efectivoEntregar = round2(totalEfectivo + inicioCaja);
  const virtualEntregar = round2(totalVirtual);
  const totalGananciaRealCaja = round2(
    salesSnap.docs.reduce((acc, docSnap) => {
      const sale = docSnap.data() || {};
      return acc + Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0);
    }, 0)
  );
  const productosIncluidosMap = new Map();
  let fechaApertura = null;
  salesSnap.docs.forEach((docSnap) => {
    const sale = docSnap.data() || {};
    collectSaleProducts(sale, productosIncluidosMap);
    const createdAt = normalizeToDate(sale.createdAt);
    if (createdAt && (!fechaApertura || createdAt < fechaApertura)) {
      fechaApertura = createdAt;
    }
  });
  const productosIncluidos = Array.from(productosIncluidosMap.values()).sort((a, b) =>
    String(a.idProducto || "").localeCompare(String(b.idProducto || ""))
  );

  const nowDate = new Date();
  const nextTurno = closeTurnoPayload({
    previous: latest,
    nowDate,
    montoCierreCaja
  });
  const turnoDocId = String(latest.idTurno || latest.id || "").trim();
  if (!turnoDocId) {
    throw new HttpsError("internal", "No se pudo identificar el turno activo.");
  }
  const idCaja = `CAJA-${turnoDocId}-${sanitizeIdPart(employeeUid)}-${nowDate.getTime()}`;
  const closureDateKey = String(nextTurno.fechaCierre || nextTurno.fechaInicio || "").trim();
  const fechaCierre = Timestamp.now();
  const usuarioNombre = String(employee.displayName || employee.username || employee.email || employeeUid).trim();
  const cajaRef = db.collection("tenants").doc(tenantId).collection("cajas").doc(idCaja);
  const batch = db.batch();
  batch.set(
    employeeRef.collection("turno").doc(turnoDocId),
    {
      ...nextTurno,
      cerradoPorUid: uid
    },
    { merge: true }
  );
  batch.set(cajaRef, {
    idCaja,
    tenantId,
    dateKey: closureDateKey || null,
    scopeKey: employeeUid,
    total: montoCierreCaja,
    totalCaja: montoCierreCaja,
    inicioCaja,
    efectivoVentas: totalEfectivo,
    efectivoEntregar,
    virtualEntregar,
    GanaciaRealCaja: totalGananciaRealCaja,
    totalGananciaRealCaja,
    usuarioUid: employeeUid,
    usuarioNombre,
    role: "empleado",
    fechaApertura: fechaApertura ? Timestamp.fromDate(fechaApertura) : fechaCierre,
    fechaCierre,
    productosIncluidos,
    salesCount: Number(salesSnap.size || 0),
    closedByUid: uid,
    closedByName: String(request.auth?.token?.name || request.auth?.token?.email || uid).trim(),
    createdAt: Timestamp.now()
  });
  salesSnap.docs.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });
  await batch.commit();
  invalidateEmployeeShiftCache(employeeUid);

  return {
    success: true,
    turno: {
      idTurno: turnoDocId,
      empleadoUid: employeeUid,
      tenantId,
      fechaInicio: String(nextTurno.fechaInicio || ""),
      horaInicio: String(nextTurno.horaInicio || ""),
      fechaCierre: String(nextTurno.fechaCierre || ""),
      horaCierre: String(nextTurno.horaCierre || ""),
      inicioCaja,
      totalEfectivo,
      totalVirtual,
      montoCierreCaja,
      turnoIniciado: false,
      turnoCerrado: true
    },
    caja: {
      idCaja,
      tenantId,
      usuarioUid: employeeUid,
      usuarioNombre,
      inicioCaja,
      totalEfectivo,
      totalVirtual,
      efectivoEntregar,
      virtualEntregar,
      totalCaja: montoCierreCaja,
      salesCount: Number(salesSnap.size || 0)
    }
  };
});

function resolveSalePaymentBreakdown(sale) {
  const total = round2(Number(sale?.total || 0));
  const tipoPago = String(sale?.tipoPago || "").trim().toLowerCase();

  if (tipoPago === "virtual") {
    return { pagoEfectivo: 0, pagoVirtual: total };
  }
  if (tipoPago === "mixto") {
    const pagoEfectivo = round2(Number(sale?.pagoEfectivo || 0));
    const pagoVirtual = round2(Number(sale?.pagoVirtual || total - pagoEfectivo));
    if (
      Number.isFinite(pagoEfectivo) &&
      Number.isFinite(pagoVirtual) &&
      pagoEfectivo >= 0 &&
      pagoVirtual >= 0 &&
      round2(pagoEfectivo + pagoVirtual) === total
    ) {
      return { pagoEfectivo, pagoVirtual };
    }
  }

  const explicitCash = round2(Number(sale?.pagoEfectivo || 0));
  const explicitVirtual = round2(Number(sale?.pagoVirtual || 0));
  if (explicitCash > 0 || explicitVirtual > 0) {
    const normalizedVirtual = round2(total - explicitCash);
    if (normalizedVirtual >= 0) {
      return { pagoEfectivo: explicitCash, pagoVirtual: normalizedVirtual };
    }
  }

  return { pagoEfectivo: total, pagoVirtual: 0 };
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sanitizeIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48) || "sin-usuario";
}

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

module.exports = {
  startEmployeeShift,
  endEmployeeShift
};
