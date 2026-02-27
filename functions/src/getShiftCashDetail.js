const { onCall, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");
const { getLatestEmployeeShift } = require("./shared/employeeShift");

const getShiftCashDetail = onCall(async (request) => {
  const { uid, tenantId, role } = await requireTenantMemberContext(request);
  const normalizedRole = String(role || "").trim().toLowerCase();
  const requestedScope = String(request.data?.scope || "").trim().toLowerCase();
  const effectiveScope = normalizedRole === "empleador" ? "all" : "mine";

  if (effectiveScope === "mine") {
    const latest = await getLatestEmployeeShift(uid);
    const active = isActiveShift(latest, tenantId);
    const startCashAmount = active ? Number(latest.inicioCaja || 0) : 0;
    return {
      success: true,
      scope: "mine",
      startCashAmount: round2(startCashAmount),
      activeShiftCount: active ? 1 : 0
    };
  }

  const employeesSnap = await db.collection("empleados").where("comercioId", "==", tenantId).get();
  const employeeUids = employeesSnap.docs.map((docSnap) => String(docSnap.id || "").trim()).filter(Boolean);
  let startCashAmount = 0;
  let activeShiftCount = 0;

  for (const employeeUid of employeeUids) {
    const latest = await getLatestEmployeeShift(employeeUid);
    if (!isActiveShift(latest, tenantId)) continue;
    startCashAmount += Number(latest.inicioCaja || 0);
    activeShiftCount += 1;
  }

  return {
    success: true,
    scope: "all",
    startCashAmount: round2(startCashAmount),
    activeShiftCount
  };
});

function isActiveShift(shift, expectedTenantId) {
  if (!shift) return false;
  const shiftTenantId = String(shift.tenantId || shift.comercioId || "").trim();
  if (!shiftTenantId || shiftTenantId !== String(expectedTenantId || "").trim()) return false;
  return shift.turnoIniciado === true && shift.turnoCerrado !== true;
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

module.exports = {
  getShiftCashDetail
};
