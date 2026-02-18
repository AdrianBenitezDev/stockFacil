import { reload } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
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
  const tokenCorreoVerificacion = String(params.get("tokenCorreoVerificacion") || "").trim();

  targetNode.innerHTML = `<strong>Correo:</strong> ${escapeHtml(email || "-")}`;

  if (tokenCorreoVerificacion) {
    await applyEmailVerificationCode(tokenCorreoVerificacion);
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

async function applyEmailVerificationCode(tokenCorreoVerificacion) {
  try {
    statusNode.textContent = "Validando token de verificacion...";
    await syncVerifiedEmailStatus(tokenCorreoVerificacion);
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

  setButtonLoading(resendBtn, true);
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
  } finally {
    setButtonLoading(resendBtn, false);
  }
}

async function syncVerifiedEmailStatus(tokenCorreoVerificacion) {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    statusNode.textContent = "Inicia sesion para completar la verificacion del perfil.";
    return;
  }

  try {
    await reload(authUser);
    if (!tokenCorreoVerificacion) {
      statusNode.textContent = "Falta token de verificacion de correo en la URL."; 
      return;
    }

    const idToken = await authUser.getIdToken(true);
    const response = await fetch(getMarkVerifiedEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ tokenCorreoVerificacion })
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

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("btn-loading", loading);
  button.disabled = loading;
}
