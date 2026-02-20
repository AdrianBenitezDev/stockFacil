import { openDatabase } from "./db.js";
import { reload } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  ensureCurrentUserProfile,
  signInWithCredentials,
  signInWithGoogle,
  signOutUser
} from "./auth.js";
import { ensureFirebaseAuth, firebaseAuth } from "../config.js";

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
    const role = normalizeRole(result.user?.tipo || result.user?.role);
    if (result.user?.correoVerificado !== true && role === "empleador") {
      const email = encodeURIComponent(String(result.user?.email || firebaseAuth.currentUser?.email || ""));
      window.location.href = `verificar-correo.html?email=${email}`;
      return;
    }
    if (result.user?.correoVerificado !== true && role === "empleado") {
      await signOutUser();
      loginFeedback.textContent = "Debes verificar tu correo antes de ingresar.";
      return;
    }
    redirectToPanel();
    return;
  }

  registerBtn?.addEventListener("click", handleRegisterBusinessStart);
  employerBtn?.addEventListener("click", handleEmployerGoogleLogin);
  employeeForm?.addEventListener("submit", handleEmployeeLogin);
}

async function handleRegisterBusinessStart() {
  window.location.href = "registro.html";
}

async function handleEmployerGoogleLogin() {
  setUiDisabled(true);
  setButtonLoading(employerBtn, true);
  loginFeedback.textContent = "";
  try {
    await signInWithGoogle();
    const profileResult = await ensureCurrentUserProfile();
    if (!profileResult.ok || !profileResult.user) {
      const errorMsg = String(profileResult.error || "");
      if (errorMsg.toLowerCase().includes("no existe perfil")) {
        const email = encodeURIComponent(String(firebaseAuth.currentUser?.email || ""));
        window.location.href = `registro.html?email=${email}`;
        return;
      }
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
    if (profileResult.user.correoVerificado !== true) {
      const email = encodeURIComponent(String(profileResult.user.email || firebaseAuth.currentUser?.email || ""));
      window.location.href = `verificar-correo.html?email=${email}`;
      return;
    }

    redirectToPanel();
  } catch (error) {
    console.error(error);
    loginFeedback.textContent = "No se pudo iniciar sesion con Google.";
  } finally {
    setButtonLoading(employerBtn, false);
    setUiDisabled(false);
  }
}

async function handleEmployeeLogin(event) {
  event.preventDefault();
  setUiDisabled(true);
  setButtonLoading(employeeLoginBtn, true);
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
    if (firebaseAuth.currentUser) {
      await reload(firebaseAuth.currentUser);
    }
    if (firebaseAuth.currentUser?.emailVerified !== true || profileResult.user.correoVerificado !== true) {
      loginFeedback.textContent = "Debes verificar tu correo antes de ingresar.";
      await signOutUser();
      return;
    }

    redirectToPanel();
  } catch (error) {
    console.error(error);
    loginFeedback.textContent = "No se pudo iniciar sesion.";
  } finally {
    setButtonLoading(employeeLoginBtn, false);
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

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("btn-loading", loading);
}

function normalizeRole(roleValue) {
  const role = String(roleValue || "").trim().toLowerCase();
  return role;
}

function redirectToPanel() {
  window.location.href = "panel.html";
}
