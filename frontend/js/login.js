import { openDatabase } from "./db.js";
import { ensureCurrentUserProfile, signInWithGoogle } from "./auth.js";
import { ensureFirebaseAuth } from "../config.js";

const googleLoginBtn = document.getElementById("google-login-btn");
const loginFeedback = document.getElementById("login-feedback");

init().catch((error) => {
  console.error(error);
  loginFeedback.textContent = "No se pudo iniciar la app.";
});

async function init() {
  await ensureFirebaseAuth();
  await openDatabase();

  const result = await ensureCurrentUserProfile();
  if (result.ok) {
    redirectToPanel();
    return;
  }

  googleLoginBtn.addEventListener("click", handleGoogleSignIn);
}

async function handleGoogleSignIn() {
  googleLoginBtn.disabled = true;
  loginFeedback.textContent = "";

  try {
    await signInWithGoogle();
    const profileResult = await ensureCurrentUserProfile();
    if (!profileResult.ok) {
      loginFeedback.textContent = profileResult.error || "No se pudo cargar tu perfil.";
      return;
    }
    redirectToPanel();
  } catch (error) {
    console.error(error);
    loginFeedback.textContent = "No se pudo iniciar sesion con Google.";
  } finally {
    googleLoginBtn.disabled = false;
  }
}

function redirectToPanel() {
  window.location.href = "panel.html";
}
