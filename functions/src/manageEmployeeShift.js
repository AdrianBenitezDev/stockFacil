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
  const montoCierreCaja = Number(request.data?.montoCierreCaja);
  if (!employeeUid) {
    throw new HttpsError("invalid-argument", "Debes seleccionar un empleado.");
  }
  if (!Number.isFinite(montoCierreCaja) || montoCierreCaja < 0) {
    throw new HttpsError("invalid-argument", "El monto de cierre de caja es invalido.");
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
      inicioCaja: Number(nextTurno.inicioCaja || 0),
      montoCierreCaja: Number(nextTurno.montoCierreCaja || 0),
      turnoIniciado: false,
      turnoCerrado: true
    }
  };
});

module.exports = {
  startEmployeeShift,
  endEmployeeShift
};
