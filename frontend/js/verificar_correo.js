import { applyActionCode, reload } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { ensureFirebaseAuth, firebaseAuth, firebaseConfig } from "../config.js";

const targetNode = document.getElementById("verify-email-target");
const statusNode = document.getElementById("verify-status");
const resendBtn = document.getElementById("verify-resend-btn");
const loginBtn = document.getElementById("verify-login-btn");

init().catch((error) => {
  console.error(error);
  statusNode.textContent = "No se pudo iniciar la verificacion.";
});

async function init() {
  await ensureFirebaseAuth();

  const params = new URLSearchParams(window.location.search);
  const email = String(params.get("email") || firebaseAuth.currentUser?.email || "").trim();
  const sent = String(params.get("sent") || "").trim();
  const mode = String(params.get("mode") || "").trim();
  const oobCode = String(params.get("oobCode") || "").trim();

  targetNode.innerHTML = `<strong>Correo:</strong> ${escapeHtml(email || "-")}`;

  if (mode === "verifyEmail" && oobCode) {
    await applyEmailVerificationCode(oobCode);
  } else {
    if (sent === "1") {
      statusNode.textContent = "Correo enviado. Revisa tu bandeja y haz click en el enlace.";
    } else {
      statusNode.textContent = "Reenvia el correo de verificacion si no lo recibiste.";
    }
  }

  resendBtn?.addEventListener("click", async () => {
    await sendVerificationEmail();
  });
  loginBtn?.addEventListener("click", () => {
    window.location.href = "index.html";
  });
}

async function applyEmailVerificationCode(oobCode) {
  try {
    await applyActionCode(firebaseAuth, oobCode);
    statusNode.textContent = "Correo verificado en Firebase. Actualizando tu perfil...";
    await syncVerifiedEmailStatus();
  } catch (error) {
    console.error(error);
    statusNode.textContent = "El enlace de verificacion no es valido o ya expiro.";
  }
}

async function sendVerificationEmail() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    statusNode.textContent = "Debes iniciar sesion para enviar el correo de verificacion.";
    return;
  }

  try {
    const idToken = await authUser.getIdToken(true);
    const response = await fetch(getSendVerificationEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ appBaseUrl: window.location.origin })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result?.error || "No se pudo enviar el correo.");
    }
    statusNode.textContent = "Correo enviado. Revisa tu bandeja y haz click en el enlace.";
  } catch (error) {
    console.error(error);
    statusNode.textContent = "No se pudo enviar el correo. Intenta reenviar nuevamente.";
  }
}

async function syncVerifiedEmailStatus() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    statusNode.textContent = "Inicia sesion para completar la verificacion del perfil.";
    return;
  }

  try {
    await reload(authUser);
    if (!authUser.emailVerified) {
      statusNode.textContent = "Tu correo aun no figura verificado. Revisa el enlace del email.";
      return;
    }

    const idToken = await authUser.getIdToken(true);
    const response = await fetch(getMarkVerifiedEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      statusNode.textContent = result?.error || "No se pudo actualizar el estado de verificacion.";
      return;
    }

    statusNode.textContent = "Correo verificado correctamente. redirigiendo al panel principal";
    setTimeout(() => {
      window.location.href = "index.html";
    }, 2000);
  } catch (error) {
    console.error(error);
    statusNode.textContent = "Fallo la validacion de correo. Intenta nuevamente.";
  }
}

function getMarkVerifiedEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/markEmployerEmailVerified`;
}

function getSendVerificationEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/sendEmployerVerificationEmail`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
