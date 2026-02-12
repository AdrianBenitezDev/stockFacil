let html5QrCode = null;
let scanning = false;
let activeElementId = null;
let lastCode = "";
let lastCodeAt = 0;

export function isScannerReady() {
  return Boolean(window.Html5Qrcode);
}

export async function startScanner({ elementId, onCode }) {
  if (!isScannerReady()) {
    throw new Error("No se pudo cargar la libreria de escaneo.");
  }

  if (scanning && activeElementId !== elementId) {
    await stopScanner();
  }

  if (scanning && activeElementId === elementId) {
    return;
  }

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
  activeElementId = elementId;
}

export async function stopScanner() {
  if (!html5QrCode || !scanning) return;
  await html5QrCode.stop();
  await html5QrCode.clear();
  html5QrCode = null;
  scanning = false;
  activeElementId = null;
}

export function isScannerRunning() {
  return scanning;
}

//pitido para confirmar lectura de codigo
export function playBeep() {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = 1000; // frecuencia del beep
  gainNode.gain.value = 0.1; // volumen

  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  oscillator.start();
  setTimeout(() => {
    oscillator.stop();
    audioCtx.close();
  }, 100); // duración en ms
}
