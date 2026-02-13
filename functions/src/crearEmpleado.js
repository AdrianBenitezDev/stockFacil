const { HttpsError, onCall, Timestamp, adminAuth, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const crearEmpleado = onCall(async (request) => {
  const { uid: callerUid, tenantId } = await requireEmployerContext(request);

  const payload = request.data || {};
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");
  const displayName = String(payload.displayName || "").trim();
  const username = String(payload.username || "").trim().toLowerCase();

  if (!email || !password || !displayName || !username) {
    throw new HttpsError("invalid-argument", "Completa email, username, password y nombre.");
  }
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "La password debe tener al menos 6 caracteres.");
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new HttpsError("invalid-argument", "Username invalido. Usa 3-40 caracteres [a-z0-9._-].");
  }

  const employeesSnap = await db
    .collection("usuarios")
    .where("tenantId", "==", tenantId)
    .where("role", "==", "empleado")
    .where("activo", "==", true)
    .get();
  if (employeesSnap.size >= 2) {
    throw new HttpsError("failed-precondition", "No puedes crear mas de 2 empleados.");
  }

  const duplicatedUsername = await db
    .collection("usuarios")
    .where("usernameKey", "==", `${tenantId}::${username}`)
    .limit(1)
    .get();
  if (!duplicatedUsername.empty) {
    throw new HttpsError("already-exists", "Ese username ya existe en este tenant.");
  }

  let createdUser = null;
  try {
    createdUser = await adminAuth.createUser({
      email,
      password,
      displayName
    });

    const now = Timestamp.now();
    await db.collection("usuarios").doc(createdUser.uid).set({
      uid: createdUser.uid,
      email,
      displayName,
      username,
      usernameKey: `${tenantId}::${username}`,
      tenantId,
      role: "empleado",
      activo: true,
      createdAt: now,
      updatedAt: now,
      createdBy: callerUid
    });

    await adminAuth.setCustomUserClaims(createdUser.uid, {
      tenantId,
      role: "empleado"
    });

    return {
      ok: true,
      uid: createdUser.uid,
      tenantId,
      role: "empleado"
    };
  } catch (error) {
    if (createdUser?.uid) {
      try {
        await adminAuth.deleteUser(createdUser.uid);
      } catch (rollbackError) {
        console.error("No se pudo revertir createUser tras error en Firestore", rollbackError);
      }
    }

    const message = String(error?.message || "");
    if (message.includes("EMAIL_EXISTS") || message.includes("email-already-exists")) {
      throw new HttpsError("already-exists", "El email ya esta registrado.");
    }
    if (message.includes("Ese username ya existe")) {
      throw new HttpsError("already-exists", "Ese username ya existe en este tenant.");
    }
    throw new HttpsError("internal", "No se pudo crear el empleado.");
  }
});

module.exports = {
  crearEmpleado
};
