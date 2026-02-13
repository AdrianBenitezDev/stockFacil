const { HttpsError, db } = require("./context");

async function requireAuthenticated(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
  }
  return uid;
}

async function requireEmployerContext(request, { requireOwner = false } = {}) {
  const uid = await requireAuthenticated(request);
  const token = request.auth?.token || {};
  const tenantId = String(token.tenantId || "").trim();
  const role = String(token.role || "").trim();
  if (!tenantId || role !== "empleador") {
    throw new HttpsError("permission-denied", "Solo el empleador puede ejecutar esta accion.");
  }

  const callerDoc = await db.collection("usuarios").doc(uid).get();
  if (!callerDoc.exists) {
    throw new HttpsError("permission-denied", "Tu usuario no existe en la base.");
  }
  const caller = callerDoc.data() || {};
  if (caller.role !== "empleador" || caller.tenantId !== tenantId) {
    throw new HttpsError("permission-denied", "Claims y perfil no coinciden.");
  }

  if (requireOwner) {
    const tenantDoc = await db.collection("tenants").doc(tenantId).get();
    if (!tenantDoc.exists) {
      throw new HttpsError("permission-denied", "Tenant no existe.");
    }
    if (tenantDoc.data()?.ownerUid !== uid) {
      throw new HttpsError("permission-denied", "No eres dueno de este tenant.");
    }
  }

  return { uid, tenantId, role, caller };
}

module.exports = {
  requireAuthenticated,
  requireEmployerContext
};
