async function sendSubscriptionStatusEmail({
  to,
  registrationId,
  planId,
  registrationStatus,
  subscriptionStatus,
  errorReason = "",
  adminCopy = "admin@stockfacil.com.ar",
  businessName = ""
}) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient) {
    throw new Error("Falta destinatario para email de suscripcion.");
  }

  const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!resendApiKey) {
    throw new Error("Falta RESEND_API_KEY en variables de entorno.");
  }

  const from = String(process.env.RESEND_FROM || "admin@stockfacil.com.ar").trim();
  const uniqueRecipients = [...new Set([recipient, String(adminCopy || "").trim().toLowerCase()].filter(Boolean))];
  const normalizedRegistrationStatus = String(registrationStatus || "").trim().toLowerCase();
  const normalizedSubscriptionStatus = String(subscriptionStatus || "").trim().toLowerCase();

  const { subject, title, body } = buildEmailContent({
    registrationStatus: normalizedRegistrationStatus,
    subscriptionStatus: normalizedSubscriptionStatus,
    errorReason
  });

  const payload = {
    from,
    to: uniqueRecipients,
    subject,
    html: buildEmailHtml({
      title,
      body,
      registrationId,
      planId,
      businessName,
      registrationStatus: normalizedRegistrationStatus,
      subscriptionStatus: normalizedSubscriptionStatus
    })
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
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Resend error ${response.status}: ${bodyText}`);
  }

  const responseBody = await response.text().catch(() => "");
  const parsedBody = safeParseJson(responseBody);
  return {
    messageId: String(parsedBody?.id || "").trim(),
    to: uniqueRecipients
  };
}

function buildEmailContent({ registrationStatus, subscriptionStatus, errorReason }) {
  if (registrationStatus === "checkout_created") {
    return {
      subject: "StockFacil: Suscripcion iniciada",
      title: "Suscripcion iniciada",
      body: "Creamos tu solicitud de suscripcion. Te vamos a avisar cuando el estado cambie."
    };
  }
  if (registrationStatus === "awaiting_webhook" && subscriptionStatus === "pending_authorization") {
    return {
      subject: "StockFacil: Autoriza tu suscripcion",
      title: "Autoriza tu suscripcion",
      body: "Estamos esperando la confirmacion final de Mercado Pago para activar tu cuenta."
    };
  }
  if (subscriptionStatus === "active" || registrationStatus === "activated") {
    return {
      subject: "StockFacil: Suscripcion activa",
      title: "Suscripcion activa",
      body: "Tu suscripcion fue confirmada y el alta del negocio ya esta activa."
    };
  }
  if (subscriptionStatus === "payment_rejected") {
    return {
      subject: "StockFacil: Pago rechazado",
      title: "Pago rechazado",
      body: errorReason || "No pudimos confirmar el pago de la suscripcion. Puedes volver a intentarlo."
    };
  }
  if (subscriptionStatus === "cancelled") {
    return {
      subject: "StockFacil: Suscripcion cancelada",
      title: "Suscripcion cancelada",
      body: errorReason || "La suscripcion fue cancelada."
    };
  }
  if (subscriptionStatus === "paused") {
    return {
      subject: "StockFacil: Suscripcion pausada",
      title: "Suscripcion pausada",
      body: errorReason || "La suscripcion esta pausada hasta nuevo aviso."
    };
  }
  if (registrationStatus === "failed" || registrationStatus === "expired") {
    return {
      subject: "StockFacil: No se pudo completar la suscripcion",
      title: "Suscripcion con incidencia",
      body: errorReason || "No se pudo finalizar el proceso de suscripcion."
    };
  }
  return {
    subject: "StockFacil: Suscripcion en proceso",
    title: "Suscripcion en proceso",
    body: "Estamos esperando confirmacion final de Mercado Pago."
  };
}

function buildEmailHtml({
  title,
  body,
  registrationId,
  planId,
  businessName,
  registrationStatus,
  subscriptionStatus
}) {
  const safeRegistrationId = escapeHtml(String(registrationId || "").trim());
  const safePlanId = escapeHtml(String(planId || "").trim());
  const safeRegistrationStatus = escapeHtml(String(registrationStatus || "").trim());
  const safeSubscriptionStatus = escapeHtml(String(subscriptionStatus || "").trim());
  const safeBusinessName = escapeHtml(String(businessName || "").trim());
  const safeTitle = escapeHtml(String(title || "").trim());
  const safeBody = escapeHtml(String(body || "").trim());

  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:580px;margin:0 auto;padding:20px;">
      <h2 style="margin:0 0 12px;">${safeTitle}</h2>
      <p style="margin:0 0 12px;">${safeBody}</p>
      <div style="margin:0 0 12px;padding:10px;border:1px solid #dbe3ef;border-radius:10px;background:#f8fafc;">
        <p style="margin:0 0 6px;"><strong>Registro:</strong> ${safeRegistrationId || "-"}</p>
        <p style="margin:0 0 6px;"><strong>Negocio:</strong> ${safeBusinessName || "-"}</p>
        <p style="margin:0 0 6px;"><strong>Plan:</strong> ${safePlanId || "-"}</p>
        <p style="margin:0 0 6px;"><strong>Estado alta:</strong> ${safeRegistrationStatus || "-"}</p>
        <p style="margin:0;"><strong>Estado suscripcion:</strong> ${safeSubscriptionStatus || "-"}</p>
      </div>
      <p style="margin:0;color:#64748b;font-size:13px;">
        Mensaje automatico de stockfacil.com.ar
      </p>
    </div>
  `;
}

function safeParseJson(valueLike) {
  try {
    return JSON.parse(String(valueLike || ""));
  } catch (_) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  sendSubscriptionStatusEmail
};
