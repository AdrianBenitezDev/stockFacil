let deferredInstallPrompt = null;
let installButton = null;

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function ensureInstallButton() {
  if (installButton) return installButton;
  installButton = document.createElement("button");
  installButton.id = "install-app-btn";
  installButton.type = "button";
  installButton.className = "install-app-btn hidden";
  installButton.textContent = "Instalar app";
  installButton.addEventListener("click", handleInstallClick);
  document.body.appendChild(installButton);
  return installButton;
}

function updateInstallButtonVisibility() {
  const button = ensureInstallButton();
  const canShow = Boolean(deferredInstallPrompt) && !isStandaloneMode();
  button.classList.toggle("hidden", !canShow);
}

async function handleInstallClick() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try {
    await deferredInstallPrompt.userChoice;
  } catch (_) {
    // Ignore user dismissal/abort errors.
  }
  deferredInstallPrompt = null;
  updateInstallButtonVisibility();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    } catch (error) {
      console.error("No se pudo registrar el service worker:", error);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  ensureInstallButton();
  updateInstallButtonVisibility();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButtonVisibility();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallButtonVisibility();
});

registerServiceWorker();
