const crypto = require("crypto");
const { onRequest, adminAuth, db, Timestamp } = require("./shared/context");
const TOKEN_EXPIRY_HOURS = 24;
const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const sendEmployerVerificationEmail = onRequest( { secrets: ["RESEND_API_KEY"] },async (req, res) => {
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

    const userSnap = await db.collection("usuarios").doc(uid).get();
    if (!userSnap.exists) {
      res.status(404).json({ ok: false, error: "No existe perfil de usuario." });
      return;
    }
    const profile = userSnap.data() || {};
    const email = String(profile.email || "").trim().toLowerCase();
    if (!email) {
      res.status(400).json({ ok: false, error: "El usuario no tiene email valido." });
      return;
    }

    
    //creamos el token de verificacion y lo guardamos en el perfil del usuario para luego compararlo al momento de marcar el correo como verificado
    const tokenCorreoVerificacion = crypto.randomBytes(32).toString("hex");
    const appBaseUrl = normalizeAppBaseUrl(req.body?.appBaseUrl);

    const url = `${appBaseUrl}/verificar-correo.html?email=${encodeURIComponent(email)}`;

    const verificationLink = `${url}&tokenCorreoVerificacion=${encodeURIComponent(tokenCorreoVerificacion)}`;

    await db.collection("usuarios").doc(uid).set(
      {
        correoVerificado: false,
        tokenCorreoVerificacion,
        tokenCorreoVerificacionCreatedAt: Timestamp.now(),
        tokenCorreoVerificacionExpiresAt: Timestamp.fromDate(
          new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)
        ),
        updatedAt: Timestamp.now()
      },
      { merge: true }
    );

    //enviamos el correo de verificacion
    await sendResendEmail({
      to: email,
      verificationLink
    });

    res.status(200).json({ ok: true, email });
  } catch (error) {
    console.error("sendEmployerVerificationEmail fallo:", error);
    res.status(500).json({ ok: false, error: "No se pudo enviar el correo de verificacion.",detalle: error.message || error.toString() });
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

function normalizeAppBaseUrl(input) {
  const fallback = "https://stockfacil.com.ar";
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!/^https?:\/\//i.test(raw)) return fallback;
  return raw.replace(/\/+$/, "");
}

async function sendResendEmail({ to, verificationLink }) {
  const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!resendApiKey) {
    throw new Error("Falta RESEND_API_KEY en variables de entorno.");
  }

  const from = String(process.env.RESEND_FROM || "onboarding@resend.dev").trim();
  const payload = {
    from,
    to: [to],
    subject: "Verifica tu correo en stockfacil.com.ar",
    html: buildEmailHtml({ verificationLink })
  };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend error ${response.status}: ${body}`);
  }
}

function buildEmailHtml({ verificationLink }) {
  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
      <h2 style="margin:0 0 12px;">Verifica tu correo</h2>
      <p style="margin:0 0 10px;">
        Tu correo fue registrado en <strong>stockfacil.com.ar</strong>.
      </p>
      <p style="margin:0 0 16px;">
        Para completar tu alta, haz click en el siguiente enlace:
      </p>
      <p style="margin:0 0 16px;">
        <a href="${verificationLink}" style="display:inline-block;padding:10px 14px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none;">
          Verificar correo
        </a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px;">
        Si no solicitaste esta accion, puedes ignorar este mensaje.
      </p>
    </div>
  `;
}

module.exports = {
  sendEmployerVerificationEmail
};
