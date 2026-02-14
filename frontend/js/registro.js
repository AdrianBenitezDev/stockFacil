import { openDatabase } from "./db.js";
import { ensureCurrentUserProfile, registerBusinessOwner } from "./auth.js";
import { ensureFirebaseAuth } from "../config.js";

const registerForm = document.getElementById("register-form");
const registerEmailInput = document.getElementById("register-email");
const registerPasswordInput = document.getElementById("register-password");
const registerSubmitBtn = document.getElementById("register-submit-btn");
const backLoginBtn = document.getElementById("back-login-btn");
const registerFeedback = document.getElementById("register-feedback");

init().catch((error) => {
  console.error(error);
  registerFeedback.textContent = "No se pudo iniciar el registro.";
});

async function init() {
  await ensureFirebaseAuth();
  await openDatabase();

  const result = await ensureCurrentUserProfile();
  if (result.ok) {
    window.location.href = "panel.html";
    return;
  }

  registerForm?.addEventListener("submit", handleRegisterSubmit);
  backLoginBtn?.addEventListener("click", () => {
    window.location.href = "index.html";
  });
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  setDisabled(true);
  registerFeedback.textContent = "";

  const email = String(registerEmailInput.value || "").trim().toLowerCase();
  const password = String(registerPasswordInput.value || "");
  const result = await registerBusinessOwner({ email, password });
  if (!result.ok) {
    registerFeedback.textContent = result.error;
    setDisabled(false);
    return;
  }

  registerFeedback.textContent = "Negocio registrado correctamente.";
  window.location.href = "panel.html";
}

function setDisabled(disabled) {
  registerEmailInput.disabled = disabled;
  registerPasswordInput.disabled = disabled;
  registerSubmitBtn.disabled = disabled;
  backLoginBtn.disabled = disabled;
}
