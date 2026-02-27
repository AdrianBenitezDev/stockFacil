const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const registerSalesAuditEvent = onCall(async (request) => {
  const { uid, tenantId, role, caller } = await requireTenantMemberContext(request);
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole !== "empleado") {
    throw new HttpsError("permission-denied", "Solo empleados pueden registrar eventos de auditoria de ventas.");
  }

  const tipo = String(request.data?.tipo || "").trim() || "intento_venta_sin_turno";
  const detalle = String(request.data?.detalle || "").trim() || "Intento de venta bloqueado por turno no habilitado.";
  const source = String(request.data?.source || "").trim() || "online_validation";

  const eventRef = db.collection("tenants").doc(tenantId).collection("auditoria_turnos").doc();
  await eventRef.set({
    id: eventRef.id,
    tenantId,
    empleadoUid: uid,
    empleadoNombre: String(caller?.displayName || caller?.username || caller?.email || uid),
    tipo,
    detalle,
    source,
    auditRequired: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  });

  return {
    success: true,
    id: eventRef.id
  };
});

module.exports = {
  registerSalesAuditEvent
};
