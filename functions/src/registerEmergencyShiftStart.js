const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const registerEmergencyShiftStart = onCall(async (request) => {
  const { uid, tenantId, role, caller } = await requireTenantMemberContext(request);
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole !== "empleado") {
    throw new HttpsError("permission-denied", "Solo empleados pueden registrar inicio offline de emergencia.");
  }

  const idTurno = String(request.data?.idTurno || "").trim() || `OFFLINE-${Date.now()}`;
  const inicioCaja = Number(request.data?.inicioCaja);
  const source = String(request.data?.source || "offline_emergency").trim();
  if (!Number.isFinite(inicioCaja) || inicioCaja < 0) {
    throw new HttpsError("invalid-argument", "Inicio de caja invalido.");
  }

  const auditRef = db.collection("tenants").doc(tenantId).collection("auditoria_turnos").doc(idTurno);
  await auditRef.set(
    {
      idTurno,
      tenantId,
      empleadoUid: uid,
      empleadoNombre: String(caller?.displayName || caller?.username || caller?.email || uid),
      inicioCaja: round2(inicioCaja),
      source,
      auditRequired: true,
      tipo: "inicio_turno_offline_emergencia",
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    },
    { merge: true }
  );

  return {
    success: true,
    idTurno,
    inicioCaja: round2(inicioCaja)
  };
});

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

module.exports = {
  registerEmergencyShiftStart
};
