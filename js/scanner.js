let html5QrCode = null;
let scanning = false;
let lastCode = "";
let lastCodeAt = 0;

export function isScannerReady() {
  return Boolean(window.Html5Qrcode);
}

export async function startScanner({ elementId, onCode }) {
  if (!isScannerReady()) {
    throw new Error("No se pudo cargar la libreria de escaneo.");
  }

  if (scanning) return;
  if (!html5QrCode) {
    html5QrCode = new window.Html5Qrcode(elementId);
  }

  const formats = window.Html5QrcodeSupportedFormats
    ? [
        window.Html5QrcodeSupportedFormats.EAN_13,
        window.Html5QrcodeSupportedFormats.EAN_8,
        window.Html5QrcodeSupportedFormats.UPC_A,
        window.Html5QrcodeSupportedFormats.UPC_E,
        window.Html5QrcodeSupportedFormats.CODE_128,
        window.Html5QrcodeSupportedFormats.CODE_39,
        window.Html5QrcodeSupportedFormats.ITF
      ]
    : undefined;

  await html5QrCode.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: { width: 280, height: 140 },
      formatsToSupport: formats
    },
    (decodedText) => {
      const code = String(decodedText || "").trim();
      if (!code) return;

      const now = Date.now();
      if (code === lastCode && now - lastCodeAt < 1200) return;
      lastCode = code;
      lastCodeAt = now;
      onCode(code);
    },
    () => {
      // Ignoramos errores de frame para no ensuciar la UI.
    }
  );

  scanning = true;
}

export async function stopScanner() {
  if (!html5QrCode || !scanning) return;
  await html5QrCode.stop();
  await html5QrCode.clear();
  html5QrCode = null;
  scanning = false;
}

export function isScannerRunning() {
  return scanning;
}
