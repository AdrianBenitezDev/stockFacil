const crypto = require("crypto");
const { onRequest, Timestamp, db } = require("./shared/context");
const { finalizeEmployerRegistration } = require("./registerEmployerProfile");
const { sendSubscriptionStatusEmail } = require("./sendSubscriptionStatusEmail");

const MERCADO_PAGO_PROVIDER = "mercadopago";

const mercadoPagoWebhook = onRequest(
  { secrets: ["MERCADOPAGO_ACCESS_TOKEN", "MERCADOPAGO_WEBHOOK_SECRET", "RESEND_API_KEY"] },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Metodo no permitido." });
      return;
    }

    try {
      const notification = resolveWebhookNotification(req);
      if (!notification.resourceType || !notification.resourceId) {
        res.status(200).json({ ok: true, ignored: true, reason: "Notificacion sin recurso util." });
        return;
      }

      const signatureResult = verifyWebhookSignature(req, notification);
      if (!signatureResult.ok) {
        res.status(401).json({ ok: false, error: signatureResult.error || "Firma webhook invalida." });
        return;
      }

      const resource = await loadWebhookResource(notification);
      if (!resource.preapprovalId && !resource.externalReference) {
        res.status(200).json({ ok: true, ignored: true, reason: "No se pudo vincular la suscripcion." });
        return;
      }

      const pending = await findPendingRegistration({
        externalReference: resource.externalReference,
        preapprovalId: resource.preapprovalId
      });
      if (!pending) {
        res.status(200).json({ ok: true, ignored: true, reason: "No hay pending_registration vinculada." });
        return;
      }

      if (notification.eventId && notification.eventId === String(pending.lastEventId || "").trim()) {
        res.status(200).json({ ok: true, duplicate: true, registrationId: pending.id });
        return;
      }

      const approvedPayment =
        resource.payment && String(resource.payment.status || "").toLowerCase() === "approved"
          ? resource.payment
          : await fetchLatestApprovedPayment(resource.preapprovalId);
      const hasApprovedPayment = Boolean(approvedPayment?.id);

      const preapprovalStatus = String(resource.preapproval?.status || "").trim().toLowerCase();
      let subscriptionStatus = mapSubscriptionStatus({
        preapprovalStatus,
        paymentStatus: String(resource.payment?.status || "").trim().toLowerCase(),
        hasApprovedPayment
      });
      let registrationStatus = String(pending.registrationStatus || "awaiting_webhook").trim().toLowerCase();

      const now = Timestamp.now();
      const updatePayload = {
        provider: MERCADO_PAGO_PROVIDER,
        preapprovalId: resource.preapprovalId || String(pending.preapprovalId || "").trim(),
        externalReference: resource.externalReference || String(pending.externalReference || "").trim(),
        mpTopic: notification.topic,
        mpResourceType: notification.resourceType,
        mpResourceId: notification.resourceId,
        mpPreapprovalStatus: preapprovalStatus,
        mpPaymentStatus: String(resource.payment?.status || "").trim().toLowerCase(),
        lastEventId: notification.eventId || `${notification.resourceType}:${notification.resourceId}`,
        lastWebhookAt: now,
        subscriptionStatus,
        updatedAt: now
      };

      if (hasApprovedPayment && registrationStatus !== "activated") {
        if (!pending.uid || !pending.payload) {
          registrationStatus = "failed";
          subscriptionStatus = "payment_rejected";
          updatePayload.registrationStatus = registrationStatus;
          updatePayload.subscriptionStatus = subscriptionStatus;
          updatePayload.errorReason = "pending_registration sin uid/payload para finalizar alta.";
        } else {
          const finalizeResult = await finalizeEmployerRegistration({
            uid: String(pending.uid || "").trim(),
            payloadData: pending.payload,
            subscription: {
              provider: MERCADO_PAGO_PROVIDER,
              status: "active",
              preapprovalId: resource.preapprovalId || String(pending.preapprovalId || "").trim(),
              lastPaymentStatus: String(approvedPayment.status || "").trim().toLowerCase(),
              lastPaymentId: String(approvedPayment.id || "").trim(),
              currentPeriodStart: extractCurrentPeriodStart(resource.preapproval),
              currentPeriodEnd: extractCurrentPeriodEnd(resource.preapproval)
            }
          });

          registrationStatus = "activated";
          subscriptionStatus = "active";
          updatePayload.registrationStatus = registrationStatus;
          updatePayload.subscriptionStatus = subscriptionStatus;
          updatePayload.firstPaymentApprovedAt = now;
          updatePayload.activatedTenantId = String(finalizeResult.kioscoId || "").trim();
          updatePayload.errorReason = "";
        }
      } else if (registrationStatus !== "activated") {
        if (subscriptionStatus === "cancelled" || subscriptionStatus === "payment_rejected") {
          registrationStatus = "failed";
        } else {
          registrationStatus = "awaiting_webhook";
        }
        updatePayload.registrationStatus = registrationStatus;
      }

      await db.collection("pending_registrations").doc(pending.id).set(updatePayload, { merge: true });

      const emailReason = String(updatePayload.errorReason || pending.errorReason || "").trim();
      const emailResult = await maybeSendSubscriptionStatusEmail({
        pending,
        registrationId: pending.id,
        registrationStatus,
        subscriptionStatus,
        errorReason: emailReason
      });
      if (emailResult.sent) {
        await db
          .collection("pending_registrations")
          .doc(pending.id)
          .set(
            {
              lastEmailEventKey: emailResult.eventKey,
              lastEmailSentAt: Timestamp.now(),
              lastEmailError: "",
              lastEmailMessageId: emailResult.messageId || "",
              updatedAt: Timestamp.now()
            },
            { merge: true }
          );
      } else if (emailResult.error) {
        await db
          .collection("pending_registrations")
          .doc(pending.id)
          .set(
            {
              lastEmailAttemptAt: Timestamp.now(),
              lastEmailError: String(emailResult.error?.message || "email_error"),
              updatedAt: Timestamp.now()
            },
            { merge: true }
          );
      }

      res.status(200).json({
        ok: true,
        registrationId: pending.id,
        registrationStatus,
        subscriptionStatus,
        preapprovalId: resource.preapprovalId || String(pending.preapprovalId || "").trim(),
        paymentId: String(approvedPayment?.id || resource.payment?.id || "").trim()
      });
    } catch (error) {
      console.error("mercadoPagoWebhook fallo:", error);
      res.status(500).json({ ok: false, error: "No se pudo procesar webhook." });
    }
  }
);

function resolveWebhookNotification(req) {
  const query = req.query || {};
  const body = req.body && typeof req.body === "object" ? req.body : {};

  const topic = String(
    query.topic ||
      query.type ||
      body.topic ||
      body.type ||
      body.action ||
      body.event_type ||
      ""
  )
    .trim()
    .toLowerCase();

  const resourceId = String(
    body?.data?.id ||
      query["data.id"] ||
      body?.resource?.id ||
      query.resource_id ||
      query.id ||
      ""
  ).trim();

  const resourceType = inferResourceType(topic, body);
  const eventId = String(body?.id || req.headers?.["x-request-id"] || "").trim();

  return {
    topic,
    resourceType,
    resourceId,
    eventId
  };
}

function inferResourceType(topic, body) {
  const rawTopic = String(topic || "").toLowerCase();
  if (rawTopic.includes("preapproval") || rawTopic.includes("subscription")) {
    return "preapproval";
  }
  if (rawTopic.includes("payment")) {
    return "payment";
  }

  const resourceType = String(body?.data?.type || body?.resource?.type || "").toLowerCase();
  if (resourceType.includes("preapproval")) return "preapproval";
  if (resourceType.includes("payment")) return "payment";
  return "";
}

function verifyWebhookSignature(req, notification) {
  const secret = String(process.env.MERCADOPAGO_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return { ok: true };
  }

  const signatureHeader = String(req.headers?.["x-signature"] || "").trim();
  if (!signatureHeader) {
    return { ok: false, error: "Falta x-signature." };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed.v1) {
    return { ok: false, error: "x-signature sin hash v1." };
  }

  const requestId = String(req.headers?.["x-request-id"] || "").trim();
  const dataId = String(notification.resourceId || "").trim();
  const ts = String(parsed.ts || "").trim();
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const manifestHash = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  if (timingSafeEquals(parsed.v1, manifestHash)) {
    return { ok: true };
  }

  const rawBodyBuffer = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
  const rawBodyHash = crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("hex");
  if (timingSafeEquals(parsed.v1, rawBodyHash)) {
    return { ok: true };
  }

  return { ok: false, error: "Firma webhook invalida." };
}

function parseSignatureHeader(value) {
  const map = {};
  String(value || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [key, rawVal] = entry.split("=");
      if (!key) return;
      map[String(key || "").trim().toLowerCase()] = String(rawVal || "").trim();
    });
  return map;
}

function timingSafeEquals(a, b) {
  const x = String(a || "").trim().toLowerCase();
  const y = String(b || "").trim().toLowerCase();
  if (!x || !y || x.length !== y.length) return false;
  const xBuffer = Buffer.from(x, "utf8");
  const yBuffer = Buffer.from(y, "utf8");
  return crypto.timingSafeEqual(xBuffer, yBuffer);
}

async function loadWebhookResource(notification) {
  if (notification.resourceType === "preapproval") {
    const preapproval = await fetchMercadoPagoJson(`/preapproval/${encodeURIComponent(notification.resourceId)}`);
    return {
      preapproval,
      payment: null,
      preapprovalId: String(preapproval?.id || "").trim(),
      externalReference: String(preapproval?.external_reference || "").trim()
    };
  }

  if (notification.resourceType === "payment") {
    const payment = await fetchMercadoPagoJson(`/v1/payments/${encodeURIComponent(notification.resourceId)}`);
    const preapprovalId = String(
      payment?.preapproval_id || payment?.metadata?.preapproval_id || payment?.subscription_id || ""
    ).trim();
    const preapproval = preapprovalId
      ? await fetchMercadoPagoJson(`/preapproval/${encodeURIComponent(preapprovalId)}`).catch(() => null)
      : null;

    return {
      preapproval,
      payment,
      preapprovalId: preapprovalId || String(preapproval?.id || "").trim(),
      externalReference: String(
        payment?.external_reference || preapproval?.external_reference || payment?.metadata?.external_reference || ""
      ).trim()
    };
  }

  return {
    preapproval: null,
    payment: null,
    preapprovalId: "",
    externalReference: ""
  };
}

async function fetchLatestApprovedPayment(preapprovalIdLike) {
  const preapprovalId = String(preapprovalIdLike || "").trim();
  if (!preapprovalId) return null;

  const query = new URLSearchParams({
    preapproval_id: preapprovalId,
    status: "approved",
    limit: "1",
    sort: "date_created",
    criteria: "desc"
  });
  const result = await fetchMercadoPagoJson(`/v1/payments/search?${query.toString()}`).catch(() => null);
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (!rows.length) return null;
  return rows[0] || null;
}

async function findPendingRegistration({ externalReference, preapprovalId }) {
  const refId = String(externalReference || "").trim();
  if (refId) {
    const byId = await db.collection("pending_registrations").doc(refId).get();
    if (byId.exists) {
      return { id: byId.id, ...(byId.data() || {}) };
    }
  }

  const byPreapprovalId = String(preapprovalId || "").trim();
  if (!byPreapprovalId) return null;

  const snap = await db
    .collection("pending_registrations")
    .where("preapprovalId", "==", byPreapprovalId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...(docSnap.data() || {}) };
}

async function fetchMercadoPagoJson(pathWithQuery) {
  const accessToken = String(process.env.MERCADOPAGO_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    throw new Error("Falta MERCADOPAGO_ACCESS_TOKEN.");
  }

  const response = await fetch(`https://api.mercadopago.com${pathWithQuery}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const text = await response.text().catch(() => "");
  const data = safeParseJson(text);
  if (!response.ok) {
    const message = String(data?.message || data?.error || text || `HTTP ${response.status}`).trim();
    throw new Error(`Mercado Pago API error (${pathWithQuery}): ${message}`);
  }
  return data || {};
}

function safeParseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch (_) {
    return null;
  }
}

function mapSubscriptionStatus({ preapprovalStatus, paymentStatus, hasApprovedPayment }) {
  const payment = String(paymentStatus || "").trim().toLowerCase();
  if (payment === "rejected") return "payment_rejected";
  if (payment === "cancelled") return "cancelled";
  if (hasApprovedPayment) return "active";

  const preapproval = String(preapprovalStatus || "").trim().toLowerCase();
  if (preapproval === "cancelled") return "cancelled";
  if (preapproval === "paused") return "paused";
  if (preapproval === "authorized" || preapproval === "pending") return "pending_authorization";
  return "pending_authorization";
}

function extractCurrentPeriodStart(preapproval) {
  return String(
    preapproval?.auto_recurring?.start_date ||
      preapproval?.date_created ||
      ""
  ).trim();
}

function extractCurrentPeriodEnd(preapproval) {
  return String(preapproval?.next_payment_date || preapproval?.auto_recurring?.end_date || "").trim();
}

function buildStatusEventKey(registrationStatus, subscriptionStatus) {
  const reg = String(registrationStatus || "").trim().toLowerCase() || "unknown_reg";
  const sub = String(subscriptionStatus || "").trim().toLowerCase() || "unknown_sub";
  return `${reg}:${sub}`;
}

async function maybeSendSubscriptionStatusEmail({
  pending,
  registrationId,
  registrationStatus,
  subscriptionStatus,
  errorReason
}) {
  const nextEventKey = buildStatusEventKey(registrationStatus, subscriptionStatus);
  const lastEmailEventKey = String(pending.lastEmailEventKey || "").trim().toLowerCase();
  const lastEmailError = String(pending.lastEmailError || "").trim();

  const shouldRetryFailedEmail = Boolean(lastEmailError) && lastEmailEventKey === nextEventKey;
  const hasNotifiedThisState = lastEmailEventKey === nextEventKey;
  if (hasNotifiedThisState && !shouldRetryFailedEmail) {
    return { sent: false, skipped: true, eventKey: nextEventKey };
  }

  const ownerEmail = String(pending.email || pending?.payload?.email || "").trim().toLowerCase();
  if (!ownerEmail) {
    return {
      sent: false,
      eventKey: nextEventKey,
      error: new Error("No hay email de destinatario en pending_registration.")
    };
  }

  try {
    const sendResult = await sendSubscriptionStatusEmail({
      to: ownerEmail,
      registrationId,
      planId: String(pending.planId || pending?.payload?.plan || "").trim().toLowerCase(),
      businessName: String(pending?.payload?.nombreKiosco || "").trim(),
      registrationStatus,
      subscriptionStatus,
      errorReason
    });
    return {
      sent: true,
      eventKey: nextEventKey,
      messageId: String(sendResult?.messageId || "").trim()
    };
  } catch (error) {
    console.error("mercadoPagoWebhook: fallo envio email de estado", {
      registrationId,
      eventKey: nextEventKey,
      error: error?.message || error
    });
    return { sent: false, eventKey: nextEventKey, error };
  }
}

module.exports = {
  mercadoPagoWebhook,
  mapSubscriptionStatus,
  fetchMercadoPagoJson,
  fetchLatestApprovedPayment,
  extractCurrentPeriodStart,
  extractCurrentPeriodEnd,
  maybeSendSubscriptionStatusEmail
};
