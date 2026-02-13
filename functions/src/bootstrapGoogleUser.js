const { HttpsError, onCall, Timestamp, adminAuth, db } = require("./shared/context");

const bootstrapGoogleUser = onCall(async (request) => {
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

module.exports = {
  bootstrapGoogleUser
};
