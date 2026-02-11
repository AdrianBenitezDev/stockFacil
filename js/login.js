import { openDatabase } from "./db.js";
import { authenticate, getUserFromSession, seedInitialUsers } from "./auth.js";

const loginForm = document.getElementById("login-form");
const loginFeedback = document.getElementById("login-feedback");

init().catch((error) => {
  console.error(error);
  loginFeedback.textContent = "No se pudo iniciar la app.";
});

async function init() {
  await openDatabase();
  await seedInitialUsers();

  const user = await getUserFromSession();
  if (user) {
    redirectToPanel();
    return;
  }

  loginForm.addEventListener("submit", handleLoginSubmit);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  loginFeedback.textContent = "";

  const formData = new FormData(loginForm);
  const result = await authenticate(formData.get("username"), formData.get("password"));
  if (!result.ok) {
    loginFeedback.textContent = result.error;
    return;
  }

  loginForm.reset();
  redirectToPanel();
}

function redirectToPanel() {
  window.location.href = "panel.html";
}
