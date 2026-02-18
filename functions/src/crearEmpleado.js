const { HttpsError, onCall, Timestamp, adminAuth, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const crearEmpleado = onCall({ secrets: ["RESEND_API_KEY"] }, async (request) => {
  const { uid: callerUid, tenantId, caller } = await requireEmployerContext(request);

  const payload = request.data || {};
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");
  const displayName = String(payload.displayName || "").trim();
  const username = normalizeUsername(displayName);
  const appBaseUrl = normalizeAppBaseUrl(payload.appBaseUrl);

  if (!email || !password || !displayName) {
    throw new HttpsError("invalid-argument", "Completa email, password y nombre.");
  }
  if (password.length < 6) {
    throw new HttpsError("invalid-argument", "La password debe tener al menos 6 caracteres.");
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new HttpsError(
      "invalid-argument",
      "Nombre visible invalido para generar usuario interno. Usa 3-40 caracteres alfanumericos."
    );
  }

  const employerEmail = String(caller.email || "").trim().toLowerCase();
  if (!employerEmail) {
    throw new HttpsError("failed-precondition", "No se pudo resolver el email del empleador.");
  }

  const { maxEmployees } = await resolveEmployeeLimitForTenant(tenantId, caller);
  const activeEmployeesCount = await countActiveEmployeesForTenant(tenantId);
  if (activeEmployeesCount >= maxEmployees) {
    throw new HttpsError(
      "failed-precondition",
      `No puedes crear mas empleados. Tu plan permite hasta ${maxEmployees}.`
    );
  }

  const usernameKey = `${tenantId}::${username}`;
  const usernameTaken = await isUsernameTaken(tenantId, usernameKey);
  if (usernameTaken) {
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
    await db.collection("empleados").doc(createdUser.uid).set({
      uid: createdUser.uid,
      role: "empleado",
      comercioId: tenantId,
      email,
      displayName,
      username,
      usernameKey,
      emailEmpleador: employerEmail,
      createdAt: now,
      createdBy: callerUid,
      emailVerified: false
    });

    let verificationEmailSent = false;
    let verificationEmailError = "";
    try {
      const verificationLink = await generateEmployeeVerificationLink(email, appBaseUrl);
      await sendEmployeeVerificationEmail({ to: email, displayName, verificationLink });
      verificationEmailSent = true;
    } catch (emailError) {
      console.error("No se pudo enviar correo de verificacion de empleado:", emailError);
      verificationEmailError = getErrorMessage(emailError);
    }

    await adminAuth.setCustomUserClaims(createdUser.uid, {
      tenantId,
      role: "empleado"
    });

    return {
      ok: true,
      uid: createdUser.uid,
      tenantId,
      role: "empleado",
      verificationEmailSent,
      verificationEmailError
    };
  } catch (error) {
    if (createdUser?.uid) {
      try {
        await adminAuth.deleteUser(createdUser.uid);
      } catch (rollbackError) {
        console.error("No se pudo revertir createUser tras error en Firestore", rollbackError);
      }
      try {
        await db.collection("empleados").doc(createdUser.uid).delete();
      } catch (rollbackError) {
        console.error("No se pudo revertir documento de empleado tras error", rollbackError);
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

async function resolveEmployeeLimitForTenant(tenantId, caller) {
  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  const tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};
  const planId = String(tenant.plan || caller.plan || "").trim().toLowerCase();
  if (!planId) {
    throw new HttpsError("failed-precondition", "No hay plan asociado al tenant.");
  }

  const planSnap = await db.collection("planes").doc(planId).get();
  if (!planSnap.exists) {
    throw new HttpsError("failed-precondition", "No se encontro configuracion del plan actual.");
  }

  const plan = planSnap.data() || {};
  const maxEmployees = Number(
    plan.maxEmpleados ?? plan.maxEmployees ?? plan.empleadosMax ?? plan.limiteEmpleados ?? 0
  );
  if (!Number.isFinite(maxEmployees) || maxEmployees <= 0) {
    throw new HttpsError("failed-precondition", "El plan no tiene un limite de empleados valido.");
  }

  return {
    planId,
    maxEmployees: Math.trunc(maxEmployees)
  };
}

async function countActiveEmployeesForTenant(tenantId) {
  const [employeesSnap, legacySnap] = await Promise.all([
    db.collection("empleados").where("comercioId", "==", tenantId).get(),
    db
      .collection("usuarios")
      .where("tenantId", "==", tenantId)
      .where("role", "==", "empleado")
      .where("activo", "==", true)
      .get()
  ]);

  const ids = new Set();
  employeesSnap.docs.forEach((doc) => ids.add(doc.id));
  legacySnap.docs.forEach((doc) => ids.add(doc.id));
  return ids.size;
}

async function isUsernameTaken(tenantId, usernameKey) {
  const [inEmployees, inUsuarios] = await Promise.all([
    db.collection("empleados").where("usernameKey", "==", usernameKey).limit(1).get(),
    db.collection("usuarios").where("usernameKey", "==", usernameKey).limit(1).get()
  ]);

  if (!inEmployees.empty || !inUsuarios.empty) return true;

  const duplicateInTenant = await db
    .collection("empleados")
    .where("comercioId", "==", tenantId)
    .where("username", "==", String(usernameKey.split("::")[1] || "").trim())
    .limit(1)
    .get();

  return !duplicateInTenant.empty;
}

function normalizeAppBaseUrl(input) {
  const fallback = "https://stockfacil.com.ar";
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  if (!/^https?:\/\//i.test(raw)) return fallback;
  return raw.replace(/\/+$/, "");
}

async function sendEmployeeVerificationEmail({ to, displayName, verificationLink }) {
  const resendApiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!resendApiKey) {
    throw new Error("Falta RESEND_API_KEY en variables de entorno.");
  }

  const from = String(process.env.RESEND_FROM || "onboarding@resend.dev").trim();
  const payload = {
    from,
    to: [to],
    subject: "Verifica tu correo de empleado",
    html: buildEmployeeVerificationHtml({ displayName, verificationLink })
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

async function generateEmployeeVerificationLink(email, appBaseUrl) {
  const preferredUrl = `${appBaseUrl}/index.html`;
  try {
    return await adminAuth.generateEmailVerificationLink(email, { url: preferredUrl });
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    const canRetryWithoutUrl =
      message.includes("continue url") ||
      message.includes("continue_uri") ||
      message.includes("authorized domain") ||
      message.includes("invalid-continue-uri");
    if (!canRetryWithoutUrl) {
      throw error;
    }
    return adminAuth.generateEmailVerificationLink(email);
  }
}

function buildEmployeeVerificationHtml({ displayName, verificationLink }) {
  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
      <h2 style="margin:0 0 12px;">Activa tu cuenta de empleado</h2>
      <p style="margin:0 0 10px;">Hola ${escapeHtml(displayName || "equipo")},</p>
      <p style="margin:0 0 16px;">
        Para ingresar al sistema debes verificar tu correo primero.
      </p>
      <p style="margin:0 0 16px;">
        <a href="${verificationLink}" style="display:inline-block;padding:10px 14px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none;">
          Verificar correo
        </a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px;">
        Si no solicitaste esta cuenta, ignora este mensaje.
      </p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeUsername(displayName) {
  const base = String(displayName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (base.length >= 3) return base.slice(0, 40);
  if (base.length > 0) return `${base}_emp`;
  return "empleado";
}

function getErrorMessage(error) {
  return String(error?.message || error?.details || error?.code || "Error desconocido.");
}

module.exports = {
  crearEmpleado
};
