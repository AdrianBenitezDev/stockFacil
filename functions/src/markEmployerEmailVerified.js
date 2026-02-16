const { onRequest, Timestamp, adminAuth, db } = require("./shared/context");

const markEmployerEmailVerified = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Falta token de autenticacion." });
      return;
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = String(decoded.uid || "").trim();
    if (!uid) {
      res.status(401).json({ ok: false, error: "Token invalido." });
      return;
    }

    const authUser = await adminAuth.getUser(uid);
    if (!authUser.emailVerified) {
      res.status(409).json({ ok: false, error: "El correo todavia no fue verificado en Firebase Auth." });
      return;
    }

    const userRef = db.collection("usuarios").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      res.status(404).json({ ok: false, error: "No existe perfil de usuario." });
      return;
    }

    
     let tokenCorreoVerificacionUrl = String(req.body?.tokenCorreoVerificacion || "").trim();
     if(!tokenCorreoVerificacionUrl){
      res.status(400).json({ ok: false, error: "Falta token de verificacion de correo." });
      return;
    }



    const profile = userSnap.data() || {};
    const tokenCorreoVerificacion = profile.tokenCorreoVerificacion;
    
    if(tokenCorreoVerificacion!== tokenCorreoVerificacionUrl){
      res.status(409).json({ ok: false, error: "El token de verificacion no coincide." });
      return;
    }

    await userRef.set(
      {
        correoVerificado: true,
        tokenCorreoVerificacion: null,
        updatedAt: Timestamp.now()
      },
      { merge: true }
    );

    res.status(200).json({ ok: true, correoVerificado: true });
  } catch (error) {
    console.error("markEmployerEmailVerified fallo:", error);
    res.status(500).json({ ok: false, error: "No se pudo actualizar la verificacion de correo." });
  }
});

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

module.exports = {
  markEmployerEmailVerified
};
