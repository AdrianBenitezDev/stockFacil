const { onRequest, adminAuth, db } = require("./shared/context");

const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const getSubscriptionStatus = onRequest(async (req, res) => {
  if (!setCors(req, res)) {
    res.status(403).json({ ok: false, error: "Origen no permitido." });
    return;
  }
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

    const registrationId = String(req.body?.registrationId || req.body?.registration_id || "").trim();
    if (!registrationId) {
      res.status(400).json({ ok: false, error: "registrationId es obligatorio." });
      return;
    }

    const docSnap = await db.collection("pending_registrations").doc(registrationId).get();
    if (!docSnap.exists) {
      res.status(404).json({ ok: false, error: "No se encontro la suscripcion pendiente." });
      return;
    }

    const row = docSnap.data() || {};
    const rowUid = String(row.uid || "").trim();
    const rowEmail = String(row.email || "").trim().toLowerCase();
    const callerEmail = String(decoded.email || "").trim().toLowerCase();
    if (rowUid !== uid && (!callerEmail || rowEmail !== callerEmail)) {
      res.status(403).json({ ok: false, error: "No tienes permisos para consultar este registro." });
      return;
    }

    const registrationStatus = String(row.registrationStatus || "awaiting_webhook").trim().toLowerCase();
    const subscriptionStatus = String(row.subscriptionStatus || "pending_authorization").trim().toLowerCase();
    const message = buildStatusMessage(registrationStatus, subscriptionStatus, row);

    res.status(200).json({
      ok: true,
      registrationId,
      registrationStatus,
      subscriptionStatus,
      message,
      preapprovalId: String(row.preapprovalId || "").trim(),
      planId: String(row.planId || "").trim().toLowerCase(),
      updatedAt: row?.updatedAt || null
    });
  } catch (error) {
    console.error("getSubscriptionStatus fallo:", error);
    res.status(500).json({ ok: false, error: "No se pudo consultar estado de suscripcion." });
  }
});

function setCors(req, res) {
  const origin = String(req.headers?.origin || "").trim();
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return false;
  }
  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return true;
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildStatusMessage(registrationStatus, subscriptionStatus, row) {
  const reg = String(registrationStatus || "").trim().toLowerCase();
  const sub = String(subscriptionStatus || "").trim().toLowerCase();
  const reason = String(row?.errorReason || "").trim();

  if (reg === "activated" || sub === "active") {
    return "Suscripcion activa. Ya puedes continuar con tu alta.";
  }
  if (sub === "payment_rejected") {
    return reason || "El pago de suscripcion fue rechazado. Puedes reintentar.";
  }
  if (sub === "cancelled") {
    return reason || "La suscripcion fue cancelada.";
  }
  if (sub === "paused") {
    return reason || "La suscripcion se encuentra pausada.";
  }
  if (reg === "failed") {
    return reason || "No se pudo completar el alta de suscripcion.";
  }
  if (reg === "expired") {
    return reason || "La solicitud de suscripcion expiro.";
  }
  return "Suscripcion en proceso. Esperando confirmacion de Mercado Pago.";
}

module.exports = {
  getSubscriptionStatus
};

