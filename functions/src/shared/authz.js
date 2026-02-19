const { HttpsError, db } = require("./context");

async function requireAuthenticated(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
  }
  return uid;
}

async function requireTenantMemberContext(request) {
  const uid = await requireAuthenticated(request);
  const token = request.auth?.token || {};

  const caller = await resolveCallerProfile(uid);
  if (!caller) {
    throw new HttpsError("permission-denied", "Tu usuario no existe en la base.");
  }
  const tokenTenantId = String(token.tenantId || "").trim();
  const callerTenantId = String(caller.tenantId || "").trim();
  const tenantId = tokenTenantId || callerTenantId;
  if (!tenantId) {
    throw new HttpsError("permission-denied", "Tu sesion no tiene tenant valido.");
  }
  if (tokenTenantId && callerTenantId && tokenTenantId !== callerTenantId) {
    throw new HttpsError("permission-denied", "Tu tenant no coincide con el perfil.");
  }

  return {
    uid,
    tenantId,
    role: normalizeRole(caller.role || token.role || "empleado"),
    caller
  };
}

async function resolveCallerProfile(uid) {
  const userDoc = await db.collection("usuarios").doc(uid).get();
  if (userDoc.exists) {
    const data = userDoc.data() || {};
    return {
      ...data,
      tenantId: String(data.tenantId || data.kioscoId || "").trim()
    };
  }

  const employeeDoc = await db.collection("empleados").doc(uid).get();
  if (!employeeDoc.exists) return null;

  const data = employeeDoc.data() || {};
  return {
    ...data,
    tenantId: String(data.comercioId || data.tenantId || "").trim(),
    role: String(data.role || "empleado").trim(),
    activo: true,
    estado: "activo"
  };
}

async function requireEmployerContext(request, { requireOwner = false } = {}) {
  const uid = await requireAuthenticated(request);
  const token = request.auth?.token || {};
  const callerDoc = await db.collection("usuarios").doc(uid).get();
  if (!callerDoc.exists) {
    throw new HttpsError("permission-denied", "Tu usuario no existe en la base.");
  }
  const caller = callerDoc.data() || {};
  const tokenTenantId = String(token.tenantId || "").trim();
  const callerTenantId = String(caller.tenantId || caller.kioscoId || "").trim();
  const tenantId = tokenTenantId || callerTenantId;
  const effectiveRole = normalizeRole(token.role || caller.role || "");
  const callerRole = normalizeRole(caller.role || "");
  if (!tenantId || effectiveRole !== "empleador" || callerRole !== "empleador") {
    throw new HttpsError("permission-denied", "Solo el empleador puede ejecutar esta accion.");
  }
  if (tokenTenantId && callerTenantId && tokenTenantId !== callerTenantId) {
    throw new HttpsError("permission-denied", "Claims y perfil no coinciden.");
  }

  if (requireOwner) {
    const tenantDoc = await db.collection("tenants").doc(tenantId).get();
    if (!tenantDoc.exists) {
      throw new HttpsError("permission-denied", "Tenant no existe.");
    }
    if (tenantDoc.data()?.ownerUid !== uid) {
      throw new HttpsError("permission-denied", "No eres el empleador de este tenant.");
    }
  }

  return { uid, tenantId, role: "empleador", caller };
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "dueno" ? "empleador" : role;
}

module.exports = {
  requireAuthenticated,
  requireTenantMemberContext,
  requireEmployerContext
};
