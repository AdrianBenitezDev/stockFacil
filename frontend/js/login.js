import { openDatabase } from "./db.js";
import {
  ensureCurrentUserProfile,
  signInWithCredentials,
  signInWithGoogle,
  signOutUser
} from "./auth.js";
import { ensureFirebaseAuth } from "../config.js";

const registerBtn = document.getElementById("register-business-btn");
const employerBtn = document.getElementById("login-employer-btn");
const employeeForm = document.getElementById("employee-login-form");
const employeeEmailInput = document.getElementById("employee-email");
const employeePasswordInput = document.getElementById("employee-password");
const employeeLoginBtn = document.getElementById("employee-login-btn");
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

  registerBtn?.addEventListener("click", () => {
    window.location.href = "registro.html";
  });
  employerBtn?.addEventListener("click", handleEmployerGoogleLogin);
  employeeForm?.addEventListener("submit", handleEmployeeLogin);
}

async function handleEmployerGoogleLogin() {
  setUiDisabled(true);
  loginFeedback.textContent = "";
  try {
    await signInWithGoogle();
    const profileResult = await ensureCurrentUserProfile();
    if (!profileResult.ok || !profileResult.user) {
      loginFeedback.textContent = profileResult.error || "No se pudo cargar tu perfil.";
      await signOutUser();
      return;
    }

    const role = normalizeRole(profileResult.user.tipo || profileResult.user.role);
    const estado = String(profileResult.user.estado || "").trim().toLowerCase();
    if (role !== "empleador" || estado !== "activo") {
      loginFeedback.textContent = "Esta cuenta no tiene permisos de empleador.";
      await signOutUser();
      return;
    }

    redirectToPanel();
  } catch (error) {
    console.error(error);
    loginFeedback.textContent = "No se pudo iniciar sesion con Google.";
  } finally {
    setUiDisabled(false);
  }
}

async function handleEmployeeLogin(event) {
  event.preventDefault();
  setUiDisabled(true);
  loginFeedback.textContent = "";

  const email = String(employeeEmailInput.value || "").trim().toLowerCase();
  const password = String(employeePasswordInput.value || "");

  try {
    const signInResult = await signInWithCredentials({ email, password });
    if (!signInResult.ok) {
      loginFeedback.textContent = signInResult.error;
      return;
    }

    const profileResult = await ensureCurrentUserProfile();
    if (!profileResult.ok || !profileResult.user) {
      loginFeedback.textContent = profileResult.error || "No se pudo cargar tu perfil.";
      await signOutUser();
      return;
    }

    const role = normalizeRole(profileResult.user.tipo || profileResult.user.role);
    const estado = String(profileResult.user.estado || "").trim().toLowerCase();
    const kioscoId = String(profileResult.user.kioscoId || profileResult.user.tenantId || "").trim();
    if (role !== "empleado" || estado !== "activo" || !kioscoId) {
      loginFeedback.textContent = "No tienes permisos para acceder como empleado.";
      await signOutUser();
      return;
    }

    redirectToPanel();
  } catch (error) {
    console.error(error);
    loginFeedback.textContent = "No se pudo iniciar sesion.";
  } finally {
    setUiDisabled(false);
  }
}

function setUiDisabled(disabled) {
  registerBtn.disabled = disabled;
  employerBtn.disabled = disabled;
  employeeEmailInput.disabled = disabled;
  employeePasswordInput.disabled = disabled;
  employeeLoginBtn.disabled = disabled;
}

function normalizeRole(roleValue) {
  const role = String(roleValue || "").trim().toLowerCase();
  if (role === "dueno") return "empleador";
  return role;
}

function redirectToPanel() {
  window.location.href = "panel.html";
}
