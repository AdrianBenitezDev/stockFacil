const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

initializeApp();
const adminAuth = getAuth();
const db = getFirestore();

exports.bootstrapGoogleUser = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
  }

  const authUser = await adminAuth.getUser(uid);
  const email = String(authUser.email || "").trim().toLowerCase();
  const displayName = String(authUser.displayName || email || "Usuario").trim();

  const userRef = db.collection("usuarios").doc(uid);
  const userSnap = await userRef.get();

  if (userSnap.exists) {
    const existing = userSnap.data() || {};
    const tenantId = String(existing.tenantId || "").trim();
    const role = String(existing.role || "empleado").trim();

    if (!tenantId) {
      throw new HttpsError("failed-precondition", "Usuario sin tenantId valido.");
    }

    await userRef.set(
      {
        uid,
        email,
        displayName,
        updatedAt: Timestamp.now()
      },
      { merge: true }
    );

    await adminAuth.setCustomUserClaims(uid, { tenantId, role });
    return { ok: true, created: false, tenantId, role };
  }

  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;
  const role = "empleador";
  const now = Timestamp.now();

  await tenantRef.set({
    tenantId,
    name: `Kiosco de ${displayName}`,
    ownerUid: uid,
    activo: true,
    createdAt: now,
    updatedAt: now
  });

  await userRef.set({
    uid,
    email,
    displayName,
    tenantId,
    role,
    activo: true,
    createdAt: now,
    updatedAt: now
  });

  await adminAuth.setCustomUserClaims(uid, { tenantId, role });
  return { ok: true, created: true, tenantId, role };
});

exports.crearEmpleado = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
  }

  const token = request.auth?.token || {};
  const claimTenantId = String(token.tenantId || "").trim();
  const claimRole = String(token.role || "").trim();
  if (!claimTenantId || claimRole !== "empleador") {
    throw new HttpsError("permission-denied", "Solo el empleador puede crear empleados.");
  }

  const callerDoc = await db.collection("usuarios").doc(callerUid).get();
  if (!callerDoc.exists) {
    throw new HttpsError("permission-denied", "Tu usuario no existe en la base.");
  }
  const caller = callerDoc.data() || {};
  if (caller.role !== "empleador" || caller.tenantId !== claimTenantId) {
    throw new HttpsError("permission-denied", "Claims y perfil no coinciden.");
  }

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
    .where("tenantId", "==", claimTenantId)
    .where("role", "==", "empleado")
    .where("activo", "==", true)
    .get();
  if (employeesSnap.size >= 2) {
    throw new HttpsError("failed-precondition", "No puedes crear mas de 2 empleados.");
  }

  const duplicatedUsername = await db
    .collection("usuarios")
    .where("usernameKey", "==", `${claimTenantId}::${username}`)
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
      usernameKey: `${claimTenantId}::${username}`,
      tenantId: claimTenantId,
      role: "empleado",
      activo: true,
      createdAt: now,
      updatedAt: now,
      createdBy: callerUid
    });

    await adminAuth.setCustomUserClaims(createdUser.uid, {
      tenantId: claimTenantId,
      role: "empleado"
    });

    return {
      ok: true,
      uid: createdUser.uid,
      tenantId: claimTenantId,
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
