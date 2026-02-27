const { onCall } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");
const { getLatestEmployeeShift } = require("./shared/employeeShift");

const getMyShiftStatus = onCall(async (request) => {
  const { uid, tenantId, role } = await requireTenantMemberContext(request);
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole !== "empleado") {
    return {
      success: true,
      active: false,
      idTurno: "",
      inicioCaja: 0
    };
  }

  const latest = await getLatestEmployeeShift(uid);
  const latestTenantId = String(latest?.tenantId || latest?.comercioId || "").trim();
  const active = Boolean(
    latest && latestTenantId === String(tenantId || "").trim() && latest.turnoIniciado === true && latest.turnoCerrado !== true
  );
  return {
    success: true,
    active,
    idTurno: active ? String(latest?.idTurno || latest?.id || "").trim() : "",
    inicioCaja: active ? Number(latest?.inicioCaja || 0) : 0
  };
});

module.exports = {
  getMyShiftStatus
};
