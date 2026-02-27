const { HttpsError, onCall, db } = require("./shared/context");
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
  await employeeRef.collection("turno").doc(turnoDocId).set(
    {
      ...nextTurno,
      cerradoPorUid: uid
    },
    { merge: true }
  );
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

module.exports = {
  startEmployeeShift,
  endEmployeeShift
};
