const { onRequest, Timestamp, adminAuth, db } = require("./shared/context");
const { normalizeRegistrationPayload } = require("./registerEmployerProfile");
const { sendSubscriptionStatusEmail } = require("./sendSubscriptionStatusEmail");

const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const REGISTRATION_TTL_HOURS = 48;
const ACTIVE_PENDING_STATUSES = new Set(["checkout_created", "awaiting_webhook"]);

const createSubscriptionCheckout = onRequest(
  { secrets: ["MERCADOPAGO_ACCESS_TOKEN", "RESEND_API_KEY"] },
  async (req, res) => {
    let registrationRef = null;
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

      const authUser = await adminAuth.getUser(uid);
      const payloadResult = await normalizeRegistrationPayload(req.body || {}, authUser.email || "");
      if (!payloadResult.ok) {
        res.status(400).json({
          ok: false,
          error: payloadResult.error,
          fieldErrors: payloadResult.fieldErrors || {}
        });
        return;
      }

      const payload = payloadResult.data;
      const authEmail = String(authUser.email || "").trim().toLowerCase();
      if (!authEmail || payload.email !== authEmail) {
        res.status(400).json({
          ok: false,
          error: "El email debe coincidir con la cuenta autenticada.",
          fieldErrors: { email: "Debe coincidir con la cuenta Google autenticada." }
        });
        return;
      }

      if (payload.plan === "prueba") {
        res.status(400).json({
          ok: false,
          error: "El plan prueba no requiere checkout de suscripcion."
        });
        return;
      }

      await assertUserNotRegistered({ uid, email: payload.email });

      const planConfig = await loadPlanForSubscription(payload.plan);
      const existingPending = await findActivePendingRegistration({ uid, planId: payload.plan });
      if (existingPending) {
        res.status(409).json({
          ok: false,
          error: "Ya existe una suscripcion pendiente para este plan.",
          registrationId: existingPending.id,
          initPoint: existingPending.subscriptionInitPoint || ""
        });
        return;
      }

      registrationRef = db.collection("pending_registrations").doc();
      const registrationId = registrationRef.id;
      const now = Timestamp.now();
      const expiresAt = Timestamp.fromDate(
        new Date(Date.now() + REGISTRATION_TTL_HOURS * 60 * 60 * 1000)
      );

      const appBaseUrl = normalizeAppBaseUrl(req.body?.appBaseUrl);
      const webhookUrl = buildWebhookUrl();
      const preapprovalPayload = {
        payer_email: payload.email,
        reason: buildSubscriptionReason(payload.nombreKiosco, planConfig.titulo),
        external_reference: registrationId,
        back_url: `${appBaseUrl}/registro.html`,
        notification_url: webhookUrl,
        auto_recurring: {
          frequency: planConfig.intervaloCantidad,
          frequency_type: planConfig.intervalo,
          transaction_amount: planConfig.precioMensual,
          currency_id: planConfig.moneda
        }
      };

      await registrationRef.set({
        uid,
        email: payload.email,
        payload,
        planId: payload.plan,
        amount: planConfig.precioMensual,
        currency: planConfig.moneda,
        provider: "mercadopago",
        registrationStatus: "checkout_created",
        subscriptionStatus: "pending_authorization",
        externalReference: registrationId,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt
      });

      const preapproval = await createMercadoPagoPreapproval({
        payload: preapprovalPayload,
        idempotencyKey: registrationId
      });

      const preapprovalId = String(preapproval?.id || "").trim();
      const initPoint = String(preapproval?.init_point || preapproval?.sandbox_init_point || "").trim();
      if (!initPoint) {
        throw {
          status: 502,
          message: "Mercado Pago no devolvio un init_point valido."
        };
      }

      const registrationStatus = "awaiting_webhook";
      const subscriptionStatus = "pending_authorization";
      const eventKey = buildStatusEventKey(registrationStatus, subscriptionStatus);
      const updatePayload = {
        preapprovalId,
        subscriptionInitPoint: initPoint,
        mpPreapprovalStatus: String(preapproval?.status || "pending_authorization"),
        registrationStatus,
        subscriptionStatus,
        updatedAt: Timestamp.now()
      };

      try {
        const notification = await sendSubscriptionStatusEmail({
          to: payload.email,
          registrationId,
          planId: payload.plan,
          businessName: payload.nombreKiosco,
          registrationStatus,
          subscriptionStatus
        });
        updatePayload.lastEmailEventKey = eventKey;
        updatePayload.lastEmailSentAt = Timestamp.now();
        updatePayload.lastEmailError = "";
        updatePayload.lastEmailMessageId = String(notification?.messageId || "").trim();
      } catch (emailError) {
        console.warn("createSubscriptionCheckout: no se pudo enviar email inicial", emailError?.message || emailError);
        updatePayload.lastEmailAttemptAt = Timestamp.now();
        updatePayload.lastEmailError = String(emailError?.message || "email_error");
      }

      await registrationRef.set(updatePayload, { merge: true });

      res.status(200).json({
        ok: true,
        registrationId,
        preapprovalId,
        initPoint,
        registrationStatus,
        subscriptionStatus
      });
    } catch (error) {
      console.error("createSubscriptionCheckout fallo:", error);
      if (registrationRef) {
        await registrationRef
          .set(
            {
              registrationStatus: "failed",
              errorReason: String(error?.message || "checkout_error"),
              updatedAt: Timestamp.now()
            },
            { merge: true }
          )
          .catch(() => null);
      }
      const status = Number(error?.status || 500);
      res.status(status).json({ ok: false, error: error?.message || "No se pudo crear el checkout." });
    }
  }
);

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

async function assertUserNotRegistered({ uid, email }) {
  const existingByUid = await db.collection("usuarios").doc(uid).get();
  if (existingByUid.exists) {
    throw { status: 409, message: "Este usuario ya esta registrado." };
  }

  const existingByEmail = await db.collection("usuarios").where("email", "==", email).limit(1).get();
  if (!existingByEmail.empty) {
    throw { status: 409, message: "Este usuario ya esta registrado." };
  }
}

async function loadPlanForSubscription(planIdLike) {
  const planId = String(planIdLike || "").trim().toLowerCase();
  const planRef = db.collection("planes").doc(planId);
  const planSnap = await planRef.get();
  if (!planSnap.exists) {
    throw { status: 400, message: "Plan invalido para suscripcion." };
  }

  const plan = planSnap.data() || {};
  if (plan.activo === false) {
    throw { status: 400, message: "El plan seleccionado no esta activo." };
  }

  const precioMensual = toNonNegativeAmount(plan.precioMensual, plan.precio);
  const moneda = normalizeCurrency(plan.moneda || plan.currency || "ARS");
  const intervalo = normalizeInterval(plan.intervalo || plan.interval || "months");
  const intervaloCantidad = toPositiveInteger(plan.intervaloCantidad ?? plan.intervalCount ?? 1) || 1;
  const titulo = String(plan.titulo || plan.nombre || planId).trim() || planId;

  if (precioMensual <= 0) {
    throw { status: 400, message: "El plan seleccionado no tiene un precioMensual valido." };
  }

  return { planId, titulo, precioMensual, moneda, intervalo, intervaloCantidad };
}

async function findActivePendingRegistration({ uid, planId }) {
  const snap = await db
    .collection("pending_registrations")
    .where("uid", "==", uid)
    .where("planId", "==", planId)
    .limit(20)
    .get();

  if (snap.empty) return null;

  const nowMs = Date.now();
  const candidates = snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .filter((row) => ACTIVE_PENDING_STATUSES.has(String(row.registrationStatus || "").trim()))
    .filter((row) => {
      const expiresAtMs = Number(row?.expiresAt?.toMillis?.() || 0);
      return !expiresAtMs || expiresAtMs > nowMs;
    })
    .sort((a, b) => {
      const aMs = Number(a?.updatedAt?.toMillis?.() || 0);
      const bMs = Number(b?.updatedAt?.toMillis?.() || 0);
      return bMs - aMs;
    });

  return candidates[0] || null;
}

async function createMercadoPagoPreapproval({ payload, idempotencyKey }) {
  const accessToken = String(process.env.MERCADOPAGO_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    throw { status: 500, message: "Falta MERCADOPAGO_ACCESS_TOKEN en la configuracion." };
  }

  const response = await fetch("https://api.mercadopago.com/preapproval", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": String(idempotencyKey || "")
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text().catch(() => "");
  const responseJson = safeParseJson(responseText);
  if (!response.ok) {
    const detail =
      String(responseJson?.message || responseJson?.error || responseText || "").trim() ||
      `HTTP ${response.status}`;
    throw { status: 502, message: `Mercado Pago rechazo el checkout: ${detail}` };
  }

  return responseJson || {};
}

function safeParseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch (_) {
    return null;
  }
}

function normalizeAppBaseUrl(input) {
  const fallback = "https://stockfacil.com.ar";
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!/^https?:\/\//i.test(raw)) return fallback;
  return raw.replace(/\/+$/, "");
}

function buildWebhookUrl() {
  const projectId = resolveProjectId();
  if (!projectId) {
    throw { status: 500, message: "No se pudo resolver projectId para notification_url." };
  }
  return `https://us-central1-${projectId}.cloudfunctions.net/mercadoPagoWebhook`;
}

function resolveProjectId() {
  const direct = String(
    process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.PROJECT_ID || ""
  ).trim();
  if (direct) return direct;

  const firebaseConfigRaw = String(process.env.FIREBASE_CONFIG || "").trim();
  if (!firebaseConfigRaw) return "";

  try {
    const parsed = JSON.parse(firebaseConfigRaw);
    return String(parsed?.projectId || "").trim();
  } catch (_) {
    return "";
  }
}

function buildSubscriptionReason(nombreKiosco, planTitulo) {
  const negocio = String(nombreKiosco || "").trim();
  const plan = String(planTitulo || "").trim();
  if (negocio && plan) return `Suscripcion StockFacil ${plan} - ${negocio}`;
  if (plan) return `Suscripcion StockFacil ${plan}`;
  return "Suscripcion StockFacil";
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function toNonNegativeAmount(value, fallback) {
  const direct = parseAmount(value);
  if (Number.isFinite(direct) && direct >= 0) {
    return roundCurrency(direct);
  }
  const fromFallback = parseAmount(fallback);
  if (Number.isFinite(fromFallback) && fromFallback >= 0) {
    return roundCurrency(fromFallback);
  }
  return 0;
}

function parseAmount(valueLike) {
  if (typeof valueLike === "number") {
    return Number.isFinite(valueLike) ? valueLike : Number.NaN;
  }

  const raw = String(valueLike || "").trim();
  if (!raw) return Number.NaN;

  let normalized = raw.replace(/[^\d,.\-]/g, "");
  if (!normalized) return Number.NaN;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = normalized.replaceAll(".", "").replace(",", ".");
    } else {
      normalized = normalized.replaceAll(",", "");
    }
  } else if (hasComma) {
    const parts = normalized.split(",");
    const decimalPart = parts[parts.length - 1] || "";
    if (decimalPart.length <= 2) {
      normalized = parts.slice(0, -1).join("") + "." + decimalPart;
    } else {
      normalized = parts.join("");
    }
  } else if (hasDot) {
    const parts = normalized.split(".");
    const decimalPart = parts[parts.length - 1] || "";
    if (decimalPart.length > 2) {
      normalized = parts.join("");
    }
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return parsed;
}

function roundCurrency(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeCurrency(valueLike) {
  const value = String(valueLike || "").trim().toUpperCase();
  if (!value) return "ARS";
  return value.slice(0, 3);
}

function normalizeInterval(valueLike) {
  const value = String(valueLike || "").trim().toLowerCase();
  if (value === "day" || value === "days") return "days";
  if (value === "month" || value === "months") return "months";
  return "months";
}

function buildStatusEventKey(registrationStatus, subscriptionStatus) {
  const reg = String(registrationStatus || "").trim().toLowerCase() || "unknown_reg";
  const sub = String(subscriptionStatus || "").trim().toLowerCase() || "unknown_sub";
  return `${reg}:${sub}`;
}

module.exports = {
  createSubscriptionCheckout
};
