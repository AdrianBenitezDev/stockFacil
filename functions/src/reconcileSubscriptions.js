const { onSchedule } = require("firebase-functions/v2/scheduler");
const { Timestamp, db } = require("./shared/context");
const { finalizeEmployerRegistration } = require("./registerEmployerProfile");
const {
  mapSubscriptionStatus,
  fetchMercadoPagoJson,
  fetchLatestApprovedPayment,
  extractCurrentPeriodStart,
  extractCurrentPeriodEnd,
  maybeSendSubscriptionStatusEmail
} = require("./mercadoPagoWebhook");

const RECONCILE_SCAN_STATUSES = [
  "checkout_created",
  "awaiting_webhook",
  "activated",
  "failed",
  "expired"
];
const RECONCILE_ACTIVE_STATUSES = new Set(["checkout_created", "awaiting_webhook"]);
const TERMINAL_EMAIL_RETRY_STATUSES = new Set(["activated", "failed", "expired"]);
const MAX_DOCS_PER_STATUS = 40;
const RECONCILE_TIME_ZONE = "America/Argentina/Buenos_Aires";
const MERCADO_PAGO_PROVIDER = "mercadopago";

const reconcileSubscriptions = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: RECONCILE_TIME_ZONE,
    secrets: ["MERCADOPAGO_ACCESS_TOKEN", "RESEND_API_KEY"]
  },
  async () => {
    const startedAt = Date.now();
    const now = Timestamp.now();
    const docs = await loadCandidatePendingRegistrations();
    const stats = {
      scanned: docs.length,
      processed: 0,
      updated: 0,
      activated: 0,
      skipped: 0,
      emailSent: 0,
      emailErrors: 0,
      errors: 0
    };

    for (const docSnap of docs) {
      try {
        const result = await reconcilePendingRegistration({ docSnap, now });
        stats.processed += 1;
        stats.updated += result.updated ? 1 : 0;
        stats.activated += result.activated ? 1 : 0;
        stats.skipped += result.skipped ? 1 : 0;
        stats.emailSent += result.emailSent ? 1 : 0;
        stats.emailErrors += result.emailError ? 1 : 0;
      } catch (error) {
        stats.errors += 1;
        const registrationId = String(docSnap?.id || "").trim();
        console.error("reconcileSubscriptions: error procesando pending_registration", {
          registrationId,
          error: error?.message || error
        });
      }
    }

    console.info("reconcileSubscriptions finalizado", {
      ...stats,
      durationMs: Date.now() - startedAt
    });
  }
);

async function loadCandidatePendingRegistrations() {
  const docMap = new Map();
  for (const status of RECONCILE_SCAN_STATUSES) {
    const snap = await db
      .collection("pending_registrations")
      .where("registrationStatus", "==", status)
      .limit(MAX_DOCS_PER_STATUS)
      .get();
    for (const docSnap of snap.docs) {
      docMap.set(docSnap.id, docSnap);
    }
  }
  return Array.from(docMap.values());
}

async function reconcilePendingRegistration({ docSnap, now }) {
  const pending = { id: docSnap.id, ...(docSnap.data() || {}) };
  const docRef = db.collection("pending_registrations").doc(pending.id);

  const previousRegistrationStatus = normalizeStatus(pending.registrationStatus, "checkout_created");
  const previousSubscriptionStatus = normalizeStatus(pending.subscriptionStatus, "pending_authorization");
  const hasEmailError = Boolean(String(pending.lastEmailError || "").trim());

  const shouldProcessAsActive = RECONCILE_ACTIVE_STATUSES.has(previousRegistrationStatus);
  const shouldRetryTerminalEmail =
    TERMINAL_EMAIL_RETRY_STATUSES.has(previousRegistrationStatus) && hasEmailError;

  if (!shouldProcessAsActive && !shouldRetryTerminalEmail) {
    return { updated: false, activated: false, skipped: true, emailSent: false, emailError: false };
  }

  let registrationStatus = previousRegistrationStatus;
  let subscriptionStatus = previousSubscriptionStatus;
  let activated = false;
  const updatePayload = {
    provider: String(pending.provider || MERCADO_PAGO_PROVIDER).trim().toLowerCase(),
    lastReconciledAt: now,
    updatedAt: now
  };

  if (shouldProcessAsActive) {
    const expiresAtMs = toMillis(pending.expiresAt);
    if (expiresAtMs && expiresAtMs <= Date.now()) {
      registrationStatus = "expired";
      updatePayload.registrationStatus = registrationStatus;
      updatePayload.errorReason = "La solicitud de suscripcion expiro por tiempo de espera.";
    } else {
      const preapprovalId = String(pending.preapprovalId || "").trim();
      if (!preapprovalId) {
        registrationStatus = "failed";
        updatePayload.registrationStatus = registrationStatus;
        updatePayload.errorReason = "No existe preapprovalId para reconciliar la suscripcion.";
      } else {
        const syncResult = await syncSubscriptionFromMercadoPago({
          pending,
          preapprovalId
        });

        registrationStatus = syncResult.registrationStatus;
        subscriptionStatus = syncResult.subscriptionStatus;
        activated = syncResult.activated;

        Object.assign(updatePayload, syncResult.updatePayload);
      }
    }
  } else {
    updatePayload.registrationStatus = previousRegistrationStatus;
    updatePayload.subscriptionStatus = previousSubscriptionStatus;
  }

  await docRef.set(updatePayload, { merge: true });

  const emailReason = String(updatePayload.errorReason || pending.errorReason || "").trim();
  const emailResult = await maybeSendSubscriptionStatusEmail({
    pending,
    registrationId: pending.id,
    registrationStatus,
    subscriptionStatus,
    errorReason: emailReason
  });

  if (emailResult.sent) {
    await docRef.set(
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
    await docRef.set(
      {
        lastEmailAttemptAt: Timestamp.now(),
        lastEmailError: String(emailResult.error?.message || "email_error"),
        updatedAt: Timestamp.now()
      },
      { merge: true }
    );
  }

  return {
    updated: true,
    activated,
    skipped: false,
    emailSent: Boolean(emailResult.sent),
    emailError: Boolean(emailResult.error)
  };
}

async function syncSubscriptionFromMercadoPago({ pending, preapprovalId }) {
  const preapproval = await fetchMercadoPagoJson(`/preapproval/${encodeURIComponent(preapprovalId)}`);
  const latestPayment = await fetchLatestPayment(preapprovalId);
  const approvedPayment =
    normalizeStatus(latestPayment?.status, "") === "approved"
      ? latestPayment
      : await fetchLatestApprovedPayment(preapprovalId);
  const hasApprovedPayment = Boolean(approvedPayment?.id);

  const preapprovalStatus = normalizeStatus(preapproval?.status, "");
  const paymentStatus = normalizeStatus(latestPayment?.status, "");
  let subscriptionStatus = mapSubscriptionStatus({
    preapprovalStatus,
    paymentStatus,
    hasApprovedPayment
  });
  let registrationStatus = normalizeStatus(pending.registrationStatus, "awaiting_webhook");
  const updatePayload = {
    preapprovalId,
    externalReference:
      String(preapproval?.external_reference || pending.externalReference || "").trim(),
    mpPreapprovalStatus: preapprovalStatus,
    mpPaymentStatus: paymentStatus,
    subscriptionStatus,
    updatedAt: Timestamp.now()
  };

  let activated = false;
  if (hasApprovedPayment && registrationStatus !== "activated") {
    if (!pending.uid || !pending.payload) {
      registrationStatus = "failed";
      subscriptionStatus = "payment_rejected";
      updatePayload.errorReason = "pending_registration sin uid/payload para finalizar alta.";
    } else {
      try {
        const finalizeResult = await finalizeEmployerRegistration({
          uid: String(pending.uid || "").trim(),
          payloadData: pending.payload,
          subscription: {
            provider: MERCADO_PAGO_PROVIDER,
            status: "active",
            preapprovalId,
            lastPaymentStatus: String(approvedPayment?.status || "approved").trim().toLowerCase(),
            lastPaymentId: String(approvedPayment?.id || "").trim(),
            currentPeriodStart: extractCurrentPeriodStart(preapproval),
            currentPeriodEnd: extractCurrentPeriodEnd(preapproval)
          }
        });

        registrationStatus = "activated";
        subscriptionStatus = "active";
        activated = true;
        updatePayload.firstPaymentApprovedAt = Timestamp.now();
        updatePayload.activatedTenantId = String(finalizeResult?.kioscoId || "").trim();
        updatePayload.errorReason = "";
      } catch (activationError) {
        registrationStatus = "awaiting_webhook";
        subscriptionStatus = "active";
        updatePayload.errorReason = `Pago aprobado, reintentando activacion: ${
          activationError?.message || "activation_error"
        }`;
      }
    }
  } else if (registrationStatus !== "activated") {
    if (subscriptionStatus === "cancelled" || subscriptionStatus === "payment_rejected") {
      registrationStatus = "failed";
    } else {
      registrationStatus = "awaiting_webhook";
    }
  }

  updatePayload.registrationStatus = registrationStatus;
  updatePayload.subscriptionStatus = subscriptionStatus;
  return { registrationStatus, subscriptionStatus, activated, updatePayload };
}

function normalizeStatus(valueLike, fallback) {
  const value = String(valueLike || "").trim().toLowerCase();
  return value || String(fallback || "").trim().toLowerCase();
}

function toMillis(timestampLike) {
  return Number(timestampLike?.toMillis?.() || 0);
}

async function fetchLatestPayment(preapprovalIdLike) {
  const preapprovalId = String(preapprovalIdLike || "").trim();
  if (!preapprovalId) return null;

  const query = new URLSearchParams({
    preapproval_id: preapprovalId,
    limit: "1",
    sort: "date_created",
    criteria: "desc"
  });

  const result = await fetchMercadoPagoJson(`/v1/payments/search?${query.toString()}`).catch(() => null);
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (!rows.length) return null;
  return rows[0] || null;
}

module.exports = {
  reconcileSubscriptions
};
