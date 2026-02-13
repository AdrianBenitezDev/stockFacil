import { PRODUCT_CATEGORIES } from "./config.js";
import { ensureCurrentUserProfile, signOutUser } from "./auth.js";
import { openDatabase } from "./db.js";
import { ensureFirebaseAuth } from "../config.js";
import { dom } from "./dom.js";
import {
  createProduct,
  findProductByBarcodeForCurrentKiosco,
  syncPendingProducts,
  listProductsForCurrentKiosco,
  updateProductStock
} from "./products.js";
import { isScannerReady, isScannerRunning, startScanner, stopScanner } from "./scanner.js";
import { createKeyboardScanner } from "./keyboard_scanner.js";
import { chargeSale } from "./sales.js";
import { closeTodayShift, getCashSnapshotForToday } from "./cash.js";
import {
  clearAddScanFeedback,
  clearCashFeedback,
  clearEmployeeFeedback,
  clearScanFeedback,
  clearProductFeedback,
  clearStockFeedback,
  renderCashClosuresTable,
  renderCashClosureStatus,
  renderCashSalesTable,
  renderCashScopeLabel,
  renderCashSummary,
  renderCategoryOptions,
  renderCurrentSale,
  renderStockDetail,
  renderStockCategoryOptions,
  renderStockTable,
  setAddScanFeedback,
  setCashFeedback,
  setEmployeeFeedback,
  setScanFeedback,
  setStockFeedback,
  setMode,
  setProductFeedbackError,
  setProductFeedbackSuccess,
  showAppShell
} from "./ui.js";
import { createEmployeeViaCallable } from "./employees.js";

const currentSaleItems = [];
let scannerMode = null;
let currentUser = null;
let allStockProducts = [];
let selectedStockProductId = null;
const UI_MODE_STORAGE_KEY = "kioscoStockUiMode";
const autoDetectedMobile = detectMobileDevice();
let forcedUiMode = loadUiModePreference();
const keyboardScanner = createKeyboardScanner(handleKeyboardBarcode);

init().catch((error) => {
  console.error(error);
  redirectToLogin();
});

async function init() {
  await ensureFirebaseAuth();
  await openDatabase();
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok || !profileResult.user) {
    redirectToLogin();
    return;
  }
  currentUser = profileResult.user;

  showAppShell(currentUser);
  dom.syncProductsBtn?.classList.toggle("hidden", !isEmployerRole(currentUser.role));
  renderCategoryOptions(PRODUCT_CATEGORIES);
  renderStockCategoryOptions(PRODUCT_CATEGORIES);
  setupDeviceSpecificUI();
  focusBarcodeInputIfDesktop();
  renderCurrentSale(currentSaleItems);
  await refreshStock();
  await refreshCashPanel();
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
  dom.cashModeBtn.addEventListener("click", async () => {
    await switchMode("cash");
    await refreshCashPanel();
  });
  dom.addProductForm.addEventListener("submit", handleAddProductSubmit);
  dom.syncProductsBtn?.addEventListener("click", handleManualProductsSync);
  dom.createEmployeeForm?.addEventListener("submit", handleCreateEmployeeSubmit);
  dom.uiModeToggle.addEventListener("click", () => {
    handleToggleUiMode().catch((error) => console.error(error));
  });
  dom.barcodeInput.addEventListener("keydown", handleBarcodeEnterOnAddProduct);
  dom.stockSearchInput.addEventListener("input", applyStockFilters);
  dom.stockCategoryFilter.addEventListener("change", applyStockFilters);
  dom.startAddScanBtn.addEventListener("click", handleStartAddBarcodeScanner);
  dom.stopAddScanBtn.addEventListener("click", handleStopAddBarcodeScanner);
  dom.startScanBtn.addEventListener("click", handleStartScanner);
  dom.stopScanBtn.addEventListener("click", handleStopScanner);
  dom.startStockScanBtn.addEventListener("click", handleStartStockScanner);
  dom.stopStockScanBtn.addEventListener("click", handleStopStockScanner);
  dom.clearSaleBtn.addEventListener("click", handleClearSale);
  dom.checkoutSaleBtn.addEventListener("click", handleCheckoutSale);
  dom.closeShiftBtn.addEventListener("click", handleCloseShift);
  dom.refreshCashBtn.addEventListener("click", refreshCashPanel);
  window.addEventListener("online", handleOnlineProductsSync);
}

async function handleLogout() {
  await stopAnyScanner();
  keyboardScanner.setEnabled(false);
  await signOutUser();
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
  focusBarcodeInputIfDesktop();
  await refreshStock();
}

async function handleManualProductsSync() {
  clearProductFeedback();
  const result = await syncPendingProducts({ force: true });
  if (!result.ok) {
    setProductFeedbackError(result.error);
    if (result.requiresLogin) {
      redirectToLogin();
    }
    return;
  }
  setProductFeedbackSuccess(result.message);
  await refreshStock();
}

async function handleOnlineProductsSync() {
  const result = await syncPendingProducts({ force: true });
  if (!result.ok || result.syncedCount <= 0) return;
  setProductFeedbackSuccess(result.message);
  await refreshStock();
}

async function handleCreateEmployeeSubmit(event) {
  event.preventDefault();
  clearEmployeeFeedback();

  if (!currentUser || currentUser.role !== "empleador") {
    setEmployeeFeedback("Solo el empleador puede crear empleados.");
    return;
  }

  const formData = new FormData(dom.createEmployeeForm);
  const result = await createEmployeeViaCallable({
    displayName: formData.get("displayName"),
    username: formData.get("username"),
    email: formData.get("email"),
    password: formData.get("password")
  });

  if (!result.ok) {
    setEmployeeFeedback(result.error);
    return;
  }

  dom.createEmployeeForm.reset();
  setEmployeeFeedback("Empleado creado en Firebase correctamente.", "success");
}

async function handleBarcodeEnterOnAddProduct(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();

  const barcode = String(dom.barcodeInput.value || "").trim();
  if (!barcode) return;

  const existing = await findProductByBarcodeForCurrentKiosco(barcode);
  if (existing) {
    setProductFeedbackError("Ese codigo ya existe. Usa otro para alta o edita en stock.");
    dom.barcodeInput.focus({ preventScroll: true });
    dom.barcodeInput.select();
    return;
  }

  setProductFeedbackSuccess("Codigo disponible. Completa nombre y datos del producto.");
  dom.productNameInput.focus({ preventScroll: true });
}

async function refreshStock() {
  allStockProducts = await listProductsForCurrentKiosco();
  applyStockFilters();
}

function applyStockFilters() {
  const search = String(dom.stockSearchInput.value || "").trim().toLowerCase();
  const selectedCategory = String(dom.stockCategoryFilter.value || "").trim();

  const filtered = allStockProducts.filter((product) => {
    const matchCategory = !selectedCategory || product.category === selectedCategory;
    const haystack = `${product.barcode || ""} ${product.name || ""}`.toLowerCase();
    const matchSearch = !search || haystack.includes(search);
    return matchCategory && matchSearch;
  });

  renderStockTable(filtered, { canEditStock: currentUser?.role === "empleador" });
  wireStockRowEvents();

  const selectedInFiltered = filtered.find((p) => p.id === selectedStockProductId);
  if (selectedInFiltered) {
    renderStockDetail(selectedInFiltered);
  } else {
    selectedStockProductId = null;
    renderStockDetail(null);
  }
}

async function switchMode(mode) {
  if (mode !== "sell" && mode !== "add" && mode !== "stock") {
    await stopAnyScanner();
  }
  if (mode === "add" && scannerMode === "sell") {
    await stopAnyScanner();
  }
  if (mode === "add" && scannerMode === "stock") {
    await stopAnyScanner();
  }
  if (mode === "sell" && scannerMode === "add") {
    await stopAnyScanner();
  }
  if (mode === "sell" && scannerMode === "stock") {
    await stopAnyScanner();
  }
  if (mode === "stock" && scannerMode === "sell") {
    await stopAnyScanner();
  }
  if (mode === "stock" && scannerMode === "add") {
    await stopAnyScanner();
  }
  setMode(mode);
  keyboardScanner.setEnabled(shouldEnableKeyboardScanner(mode));
  if (mode === "add") {
    focusBarcodeInputIfDesktop();
  }
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
    dom.saleScannerReader.style.position = "absolute";
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
    dom.addScannerReader.style.position = "absolute";
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
  await processSaleBarcode(barcode);
}

async function processSaleBarcode(barcode) {
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
    `Venta cobrada. Items: ${result.itemsCount}. Total: $${result.total.toFixed(2)}. Ganancia: $${result.profit.toFixed(2)}.`,
    "success"
  );
  await refreshStock();
  await refreshCashPanel();
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
    if (scannerMode === "stock") {
      dom.stockScannerReader.classList.add("hidden");
      if (showMessage) setStockFeedback("Camara detenida.", "success");
    }

    scannerMode = null;
  } catch (error) {
    console.error(error);
    if (targetMode === "add" || scannerMode === "add") {
      setAddScanFeedback("No se pudo detener la camara.");
    } else if (targetMode === "stock" || scannerMode === "stock") {
      setStockFeedback("No se pudo detener la camara.");
    } else {
      setScanFeedback("No se pudo detener la camara.");
    }
  }
}

async function handleStartStockScanner() {
  clearStockFeedback();
  if (!isScannerReady()) {
    setStockFeedback("No se pudo cargar la libreria de escaneo.");
    return;
  }
  try {
    await stopAnyScanner();
    dom.stockScannerReader.classList.remove("hidden");
    await startScanner({
      elementId: "stock-scanner-reader",
      onCode: handleDetectedStockCode
    });
    scannerMode = "stock";
    setStockFeedback("Camara iniciada. Escanea para buscar producto.", "success");
  } catch (error) {
    console.error(error);
    setStockFeedback("No se pudo iniciar la camara.");
  }
}

async function handleStopStockScanner() {
  await stopAnyScanner({ targetMode: "stock", showMessage: true });
}

async function handleDetectedStockCode(barcode) {
  dom.stockSearchInput.value = barcode;
  applyStockFilters();
  setStockFeedback(`Busqueda por codigo: ${barcode}`, "success");
  await stopAnyScanner({ targetMode: "stock" });
}

async function refreshCashPanel() {
  clearCashFeedback();
  dom.closeShiftBtn.disabled = false;
  const snapshot = await getCashSnapshotForToday();
  if (!snapshot.ok) {
    if (snapshot.requiresLogin) {
      redirectToLogin();
      return;
    }
    setCashFeedback(snapshot.error);
    return;
  }

  renderCashScopeLabel(snapshot.scopeLabel);
  renderCashSummary(snapshot.summary);
  renderCashSalesTable(snapshot.sales);
  renderCashClosureStatus(snapshot.todayClosure);
  renderCashClosuresTable(snapshot.recentClosures);
  dom.closeShiftBtn.disabled = Boolean(snapshot.todayClosure);
}

async function handleCloseShift() {
  const result = await closeTodayShift();
  if (!result.ok) {
    if (result.requiresLogin) {
      redirectToLogin();
      return;
    }
    setCashFeedback(result.error);
    return;
  }

  setCashFeedback(
    `Turno cerrado. Debes entregar $${result.summary.totalAmount.toFixed(2)}. Ganancia del dia: $${result.summary.profitAmount.toFixed(2)}.`,
    "success"
  );
  await refreshCashPanel();
}

function wireStockRowEvents() {
  const rows = document.querySelectorAll("[data-stock-row-id]");
  rows.forEach((row) => {
    row.addEventListener("click", () => {
      const productId = row.getAttribute("data-stock-row-id");
      selectedStockProductId = productId;
      const product = allStockProducts.find((item) => item.id === productId) || null;
      renderStockDetail(product);
    });
  });

  const buttons = document.querySelectorAll("[data-save-stock-id]");
  buttons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const productId = button.getAttribute("data-save-stock-id");
      const input = document.querySelector(`[data-stock-input-id="${productId}"]`);
      if (!input) return;

      const result = await updateProductStock(productId, input.value);
      if (!result.ok) {
        setStockFeedback(result.error);
        if (result.requiresLogin) {
          redirectToLogin();
        }
        return;
      }

      setStockFeedback(result.message, "success");
      await refreshStock();
    });
  });

  const inputs = document.querySelectorAll("[data-stock-input-id]");
  inputs.forEach((input) => {
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
}

function setupDeviceSpecificUI() {
  const showCameraControls = isMobileMode();
  document.body.classList.toggle("ui-mode-mobile", showCameraControls);
  document.body.classList.toggle("ui-mode-pc", !showCameraControls);
  dom.addCameraControls.classList.toggle("hidden", !showCameraControls);
  dom.addScanFeedback.classList.toggle("hidden", !showCameraControls);
  dom.addScannerReader.classList.toggle("hidden", !showCameraControls);
  dom.startScanBtn.classList.toggle("hidden", !showCameraControls);
  dom.stopScanBtn.classList.toggle("hidden", !showCameraControls);
  dom.stockCameraControls.classList.toggle("hidden", !showCameraControls);
  dom.saleScannerReader.classList.toggle("hidden", !showCameraControls);
  dom.saleDeviceHint.classList.toggle("hidden", showCameraControls);
  forceCameraControlsDisplay(showCameraControls);
  renderUiModeToggleLabel();
}

async function handleKeyboardBarcode(barcode) {
  if (dom.sellPanel && !dom.sellPanel.classList.contains("hidden")) {
    await processSaleBarcode(barcode);
    return;
  }
  if (dom.stockPanel && !dom.stockPanel.classList.contains("hidden")) {
    dom.stockSearchInput.value = barcode;
    applyStockFilters();
    setStockFeedback(`Busqueda por codigo: ${barcode}`, "success");
  }
}

function redirectToLogin() {
  window.location.href = "index.html";
}

function focusBarcodeInputIfDesktop() {
  if (isMobileMode()) return;
  if (!dom.barcodeInput) return;
  requestAnimationFrame(() => {
    dom.barcodeInput.focus({ preventScroll: true });
  });
}

function detectMobileDevice() {
  const ua = navigator.userAgent || "";
  const byUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const byViewport = window.innerWidth <= 820;
  return byUserAgent || byViewport;
}

function isMobileMode() {
  if (forcedUiMode === "mobile") return true;
  if (forcedUiMode === "pc") return false;
  return autoDetectedMobile;
}

async function handleToggleUiMode() {
  await stopAnyScanner();
  const nextMode = isMobileMode() ? "pc" : "mobile";
  forcedUiMode = nextMode;
  persistUiModePreference(nextMode);
  setupDeviceSpecificUI();
  const currentMode = getCurrentMode();
  keyboardScanner.setEnabled(shouldEnableKeyboardScanner(currentMode));
  if (currentMode === "add") {
    focusBarcodeInputIfDesktop();
  }
}

function renderUiModeToggleLabel() {
  dom.uiModeToggle.textContent = isMobileMode() ? "Modo: Celular" : "Modo: PC";
}

function getCurrentMode() {
  if (!dom.sellPanel.classList.contains("hidden")) return "sell";
  if (!dom.stockPanel.classList.contains("hidden")) return "stock";
  if (!dom.cashPanel.classList.contains("hidden")) return "cash";
  return "add";
}

function shouldEnableKeyboardScanner(mode) {
  if (isMobileMode()) return false;
  return mode === "sell" || mode === "stock";
}

function isEmployerRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized === "empleador" || normalized === "dueno";
}

function loadUiModePreference() {
  const value = localStorage.getItem(UI_MODE_STORAGE_KEY);
  if (value === "mobile" || value === "pc") return value;
  return "auto";
}

function persistUiModePreference(mode) {
  localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
}

function forceCameraControlsDisplay(showCameraControls) {
  const displayValue = showCameraControls ? "" : "none";
  dom.addCameraControls.style.display = displayValue;
  dom.addScanFeedback.style.display = displayValue;
  dom.addScannerReader.style.display = displayValue;
  dom.stockCameraControls.style.display = displayValue;
  dom.stockFeedback.style.display = displayValue;
  dom.stockScannerReader.style.display = displayValue;
  dom.startScanBtn.style.display = displayValue;
  dom.stopScanBtn.style.display = displayValue;
  dom.saleScannerReader.style.display = displayValue;
}
