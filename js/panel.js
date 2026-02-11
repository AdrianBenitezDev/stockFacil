import { PRODUCT_CATEGORIES } from "./config.js";
import { clearSession, getUserFromSession, seedInitialUsers } from "./auth.js";
import { openDatabase } from "./db.js";
import { dom } from "./dom.js";
import {
  createProduct,
  findProductByBarcodeForCurrentKiosco,
  listProductsForCurrentKiosco
} from "./products.js";
import { isScannerReady, isScannerRunning, startScanner, stopScanner } from "./scanner.js";
import { chargeSale } from "./sales.js";
import {
  clearAddScanFeedback,
  clearScanFeedback,
  clearProductFeedback,
  renderCategoryOptions,
  renderCurrentSale,
  renderStockTable,
  setAddScanFeedback,
  setScanFeedback,
  setMode,
  setProductFeedbackError,
  setProductFeedbackSuccess,
  showAppShell
} from "./ui.js";

const currentSaleItems = [];
let scannerMode = null;

init().catch((error) => {
  console.error(error);
  redirectToLogin();
});

async function init() {
  await openDatabase();
  await seedInitialUsers();

  const user = await getUserFromSession();
  if (!user) {
    redirectToLogin();
    return;
  }

  showAppShell(user);
  renderCategoryOptions(PRODUCT_CATEGORIES);
  renderCurrentSale(currentSaleItems);
  await refreshStock();
  wireEvents();
}

function wireEvents() {
  dom.logoutBtn.addEventListener("click", handleLogout);
  dom.addModeBtn.addEventListener("click", () => switchMode("add"));
  dom.sellModeBtn.addEventListener("click", () => switchMode("sell"));
  dom.stockModeBtn.addEventListener("click", async () => {
    await switchMode("stock");
    await refreshStock();
  });
  dom.cashModeBtn.addEventListener("click", () => switchMode("cash"));
  dom.addProductForm.addEventListener("submit", handleAddProductSubmit);
  dom.startAddScanBtn.addEventListener("click", handleStartAddBarcodeScanner);
  dom.stopAddScanBtn.addEventListener("click", handleStopAddBarcodeScanner);
  dom.startScanBtn.addEventListener("click", handleStartScanner);
  dom.stopScanBtn.addEventListener("click", handleStopScanner);
  dom.clearSaleBtn.addEventListener("click", handleClearSale);
  dom.checkoutSaleBtn.addEventListener("click", handleCheckoutSale);
}

async function handleLogout() {
  await stopAnyScanner();
  clearSession();
  redirectToLogin();
}

async function handleAddProductSubmit(event) {
  event.preventDefault();
  clearProductFeedback();

  const result = await createProduct(new FormData(dom.addProductForm));
  if (!result.ok) {
    setProductFeedbackError(result.error);
    if (result.requiresLogin) {
      redirectToLogin();
    }
    return;
  }

  dom.addProductForm.reset();
  renderCategoryOptions(PRODUCT_CATEGORIES);
  setProductFeedbackSuccess(result.message);
  await refreshStock();
}

async function refreshStock() {
  const products = await listProductsForCurrentKiosco();
  renderStockTable(products);
}

async function switchMode(mode) {
  if (mode !== "sell" && mode !== "add") {
    await stopAnyScanner();
  }
  if (mode === "add" && scannerMode === "sell") {
    await stopAnyScanner();
  }
  if (mode === "sell" && scannerMode === "add") {
    await stopAnyScanner();
  }
  setMode(mode);
}

async function handleStartScanner() {
  clearScanFeedback();
  if (!isScannerReady()) {
    setScanFeedback("No se pudo cargar la libreria de escaneo.");
    return;
  }

  try {
    await stopAnyScanner();
    await startScanner({
      elementId: "scanner-reader",
      onCode: handleDetectedCode
    });
    scannerMode = "sell";
    setScanFeedback("Camara iniciada. Escanea un codigo.", "success");
  } catch (error) {
    console.error(error);
    setScanFeedback("No se pudo iniciar la camara. Verifica permisos.");
  }
}

async function handleStopScanner() {
  await stopAnyScanner({ targetMode: "sell", showMessage: true });
}

function handleClearSale() {
  currentSaleItems.length = 0;
  renderCurrentSale(currentSaleItems);
  setScanFeedback("Venta actual limpiada.", "success");
}

async function handleStartAddBarcodeScanner() {
  clearAddScanFeedback();
  if (!isScannerReady()) {
    setAddScanFeedback("No se pudo cargar la libreria de escaneo.");
    return;
  }

  try {
    await stopAnyScanner();
    dom.addScannerReader.classList.remove("hidden");
    await startScanner({
      elementId: "add-scanner-reader",
      onCode: handleDetectedAddBarcode
    });
    scannerMode = "add";
    setAddScanFeedback("Camara iniciada. Escanea el codigo del producto.", "success");
  } catch (error) {
    console.error(error);
    setAddScanFeedback("No se pudo iniciar la camara.");
  }
}

async function handleStopAddBarcodeScanner() {
  await stopAnyScanner({ targetMode: "add", showMessage: true });
}

async function handleDetectedCode(barcode) {
  const product = await findProductByBarcodeForCurrentKiosco(barcode);
  if (!product) {
    setScanFeedback(`Codigo ${barcode} no encontrado en stock.`);
    return;
  }

  const existing = currentSaleItems.find((item) => item.productId === product.id);
  const nextQuantity = existing ? existing.quantity + 1 : 1;
  if (nextQuantity > Number(product.stock || 0)) {
    setScanFeedback(`Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`);
    return;
  }

  if (existing) {
    existing.quantity = nextQuantity;
    existing.subtotal = existing.quantity * existing.price;
  } else {
    currentSaleItems.push({
      productId: product.id,
      barcode: product.barcode,
      name: product.name,
      quantity: 1,
      price: Number(product.price || 0),
      subtotal: Number(product.price || 0)
    });
  }

  renderCurrentSale(currentSaleItems);
  setScanFeedback(`Escaneado: ${product.name}`, "success");
}

async function handleCheckoutSale() {
  const result = await chargeSale(currentSaleItems);
  if (!result.ok) {
    setScanFeedback(result.error);
    if (result.requiresLogin) {
      redirectToLogin();
    }
    return;
  }

  currentSaleItems.length = 0;
  renderCurrentSale(currentSaleItems);
  setScanFeedback(
    `Venta cobrada. Items: ${result.itemsCount}. Total: $${result.total.toFixed(2)}.`,
    "success"
  );
  await refreshStock();
}

async function handleDetectedAddBarcode(barcode) {
  dom.barcodeInput.value = barcode;
  setAddScanFeedback(`Codigo capturado: ${barcode}`, "success");
  await stopAnyScanner({ targetMode: "add" });
}

async function stopAnyScanner({ targetMode = null, showMessage = false } = {}) {
  if (!isScannerRunning()) return;
  if (targetMode && scannerMode !== targetMode) return;

  try {
    await stopScanner();

    if (scannerMode === "add") {
      dom.addScannerReader.classList.add("hidden");
      if (showMessage) setAddScanFeedback("Camara detenida.", "success");
    }

    if (scannerMode === "sell" && showMessage) {
      setScanFeedback("Camara detenida.", "success");
    }

    scannerMode = null;
  } catch (error) {
    console.error(error);
    if (targetMode === "add" || scannerMode === "add") {
      setAddScanFeedback("No se pudo detener la camara.");
    } else {
      setScanFeedback("No se pudo detener la camara.");
    }
  }
}

function redirectToLogin() {
  window.location.href = "index.html";
}
