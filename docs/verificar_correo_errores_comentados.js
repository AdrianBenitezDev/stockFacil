// COPIA COMENTADA DE: frontend/js/verificar_correo.js
// Estado actual del problema (actualizado):

//
// ERROR #3 - applyActionCode USA TOKEN EQUIVOCADO
// applyActionCode(auth, code) espera un oobCode de Firebase Auth.
// Aqui le pasas tokenCorreoVerificacionUrl (token propio guardado en Firestore),
// que NO es oobCode.
// Resultado: "invalid action code" / enlace invalido.
//
// ERROR #4 - FALTA RETURN EN VALIDACION
// En syncVerifiedEmailStatus():
//   if (!tokenCorreoVerificacionUrl) { statusNode.textContent = "..."; }
// Falta "return", entonces igual sigue y llama a markEmployerEmailVerified.
//
// ERROR #5 - FLUJOS MEZCLADOS
// Hay dos estrategias mezcladas:
//   A) Verificacion Firebase (mode=verifyEmail + oobCode + applyActionCode)
//   B) Verificacion por token propio (tokenCorreoVerificacion)
// Actualmente estan combinadas y eso rompe el flujo.
//
// Recomendacion:
// Elegir UNA sola estrategia y alinear frontend + backend al mismo contrato.

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
  const tokenCorreoVerificacionUrl = String(params.get("tokenCorreoVerificacionUrl") || "").trim();

  targetNode.innerHTML = `<strong>Correo:</strong> ${escapeHtml(email || "-")}`;

  if (mode === "verifyEmail" && tokenCorreoVerificacionUrl) {
    await applyEmailVerificationCode(tokenCorreoVerificacionUrl);
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

async function applyEmailVerificationCode(tokenCorreoVerificacionUrl) {
  try {
    await applyActionCode(firebaseAuth, tokenCorreoVerificacionUrl);
    statusNode.textContent = "Correo verificado en Firebase. Actualizando tu perfil...";
    await syncVerifiedEmailStatus(tokenCorreoVerificacionUrl);
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

async function syncVerifiedEmailStatus(tokenCorreoVerificacionUrl) {
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

    if (!tokenCorreoVerificacionUrl) {
      statusNode.textContent = "Falta token de verificacion de correo en la URL.";
      // ERROR ACTUAL: falta return aqui
    }

    const idToken = await authUser.getIdToken(true);
    const response = await fetch(getMarkVerifiedEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({ tokenCorreoVerificacion: tokenCorreoVerificacionUrl })
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

