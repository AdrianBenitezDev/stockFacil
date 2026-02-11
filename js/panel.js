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
import {
  clearScanFeedback,
  clearProductFeedback,
  renderCategoryOptions,
  renderCurrentSale,
  renderStockTable,
  setScanFeedback,
  setMode,
  setProductFeedbackError,
  setProductFeedbackSuccess,
  showAppShell
} from "./ui.js";

const currentSaleItems = [];

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
  dom.startScanBtn.addEventListener("click", handleStartScanner);
  dom.stopScanBtn.addEventListener("click", handleStopScanner);
  dom.clearSaleBtn.addEventListener("click", handleClearSale);
}

async function handleLogout() {
  await handleStopScanner();
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
  if (mode !== "sell") {
    await handleStopScanner();
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
    await startScanner({
      elementId: "scanner-reader",
      onCode: handleDetectedCode
    });
    setScanFeedback("Camara iniciada. Escanea un codigo.", "success");
  } catch (error) {
    console.error(error);
    setScanFeedback("No se pudo iniciar la camara. Verifica permisos.");
  }
}

async function handleStopScanner() {
  if (!isScannerRunning()) return;

  try {
    await stopScanner();
    setScanFeedback("Camara detenida.", "success");
  } catch (error) {
    console.error(error);
    setScanFeedback("No se pudo detener la camara.");
  }
}

function handleClearSale() {
  currentSaleItems.length = 0;
  renderCurrentSale(currentSaleItems);
  setScanFeedback("Venta actual limpiada.", "success");
}

async function handleDetectedCode(barcode) {
  const product = await findProductByBarcodeForCurrentKiosco(barcode);
  if (!product) {
    setScanFeedback(`Codigo ${barcode} no encontrado en stock.`);
    return;
  }

  const existing = currentSaleItems.find((item) => item.productId === product.id);
  if (existing) {
    existing.quantity += 1;
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

function redirectToLogin() {
  window.location.href = "index.html";
}
