let deferredInstallPrompt = null;
let installButton = null;

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIos() {
  const ua = window.navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(ua);
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
  if (isStandaloneMode()) {
    button.classList.add("hidden");
    return;
  }
  button.classList.remove("hidden");
}

function showManualInstallHelp() {
  if (isIos()) {
    window.alert("Para instalar en iPhone: toca Compartir y luego 'Agregar a pantalla de inicio'.");
    return;
  }
  window.alert("Para instalar: abre el menu del navegador y elige 'Instalar app' o 'Agregar a pantalla de inicio'.");
}

async function handleInstallClick() {
  if (!deferredInstallPrompt) {
    showManualInstallHelp();
    return;
  }

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
