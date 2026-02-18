import { PRODUCT_CATEGORIES } from "./config.js";
import {
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { ensureCurrentUserProfile, signOutUser } from "./auth.js";
import { openDatabase } from "./db.js";
import { ensureFirebaseAuth, firestoreDb } from "../config.js";
import { dom } from "./dom.js";
import {
  createProduct,
  deleteProduct,
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
import { createEmployeeViaCallable, deleteEmployeeViaCallable } from "./employees.js";

const currentSaleItems = [];
let scannerMode = null;
let currentUser = null;
let allStockProducts = [];
let selectedStockProductId = null;
const UI_MODE_STORAGE_KEY = "kioscoStockUiMode";
const autoDetectedMobile = detectMobileDevice();
let forcedUiMode = loadUiModePreference();
let saleUseScannerMode = true;
let saleSearchMatches = [];
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
  initSaleModeSwitch();
  focusBarcodeInputIfDesktop();
  renderCurrentSale(currentSaleItems);
  await refreshStock();
  await refreshCashPanel();
  await refreshEmployeesPanel();
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
  dom.configModeBtn?.addEventListener("click", async () => {
    await switchMode("config");
    await refreshEmployeesPanel();
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
  dom.saleScanInput?.addEventListener("input", handleSaleScanInputChange);
  dom.saleScanInput?.addEventListener("keydown", handleSaleScanInputKeydown);
  dom.saleModeScannerSwitch?.addEventListener("change", handleSaleModeSwitchChange);
  dom.saleSearchSuggestions?.addEventListener("click", handleSaleSuggestionClick);
  dom.saleSearchSuggestions?.addEventListener("keydown", handleSaleSuggestionKeydown);
  dom.saleTableBody.addEventListener("click", handleRemoveCurrentSaleItem);
  dom.closeShiftBtn.addEventListener("click", handleCloseShift);
  dom.refreshCashBtn.addEventListener("click", refreshCashPanel);
  dom.employeeListTableBody?.addEventListener("click", handleDeleteEmployeeClick);
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
    email: formData.get("email"),
    password: formData.get("password")
  });

  if (!result.ok) {
    setEmployeeFeedback(result.error);
    return;
  }

  dom.createEmployeeForm.reset();
  setEmployeeFeedback(
    result?.data?.verificationEmailSent === false
      ? "Empleado creado, pero no se pudo enviar correo de verificacion. Revisa configuracion de Resend."
      : "Empleado creado en Firebase y correo de verificacion enviado.",
    result?.data?.verificationEmailSent === false ? "error" : "success"
  );
  await refreshEmployeesPanel();
}

async function refreshEmployeesPanel() {
  if (!dom.employeeListTableBody) return;
  if (!currentUser || currentUser.role !== "empleador") return;

  dom.employeeListTableBody.innerHTML = '<tr><td colspan="5">Cargando empleados...</td></tr>';
  try {
    const q = query(
      collection(firestoreDb, "empleados"),
      where("comercioId", "==", String(currentUser.tenantId || "").trim())
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    rows.sort((a, b) => formatDateValue(b.createdAt) - formatDateValue(a.createdAt));

    if (!rows.length) {
      dom.employeeListTableBody.innerHTML = '<tr><td colspan="5">No hay empleados registrados.</td></tr>';
      return;
    }

    dom.employeeListTableBody.innerHTML = rows
      .map((employee) => {
        const name = escapeHtml(employee.displayName || employee.username || employee.uid || "-");
        const email = escapeHtml(employee.email || "-");
        const verified = employee.emailVerified === true ? "Si" : "No";
        const created = escapeHtml(formatDateForTable(employee.createdAt));
        const uid = escapeHtml(employee.uid || employee.id || "");
        return [
          "<tr>",
          `<td>${name}</td>`,
          `<td>${email}</td>`,
          `<td>${verified}</td>`,
          `<td>${created}</td>`,
          `<td><button type="button" class="stock-delete-btn" data-delete-employee-id="${uid}" title="Eliminar empleado" aria-label="Eliminar empleado">🗑</button></td>`,
          "</tr>"
        ].join("");
      })
      .join("");
  } catch (error) {
    console.error("No se pudo cargar listado de empleados:", error);
    dom.employeeListTableBody.innerHTML =
      '<tr><td colspan="5">No se pudo cargar empleados. Verifica permisos y reglas.</td></tr>';
  }
}

async function handleDeleteEmployeeClick(event) {
  const button = event.target.closest("[data-delete-employee-id]");
  if (!button) return;

  const uidEmpleado = String(button.getAttribute("data-delete-employee-id") || "").trim();
  if (!uidEmpleado) return;

  const row = button.closest("tr");
  const name = String(row?.children?.[0]?.textContent || "este empleado").trim();
  const confirmed = window.confirm(
    `¿Eliminar a ${name}? Esta accion borrara el usuario en Authentication y su documento en la base de datos.`
  );
  if (!confirmed) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "...";
  clearEmployeeFeedback();

  try {
    const result = await deleteEmployeeViaCallable(uidEmpleado);
    if (!result.ok) {
      setEmployeeFeedback(result.error);
      return;
    }
    setEmployeeFeedback("Empleado eliminado correctamente.", "success");
    await refreshEmployeesPanel();
  } finally {
    button.disabled = false;
    button.textContent = originalText || "🗑";
  }
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

  renderStockTable(filtered, { canEditStock: isEmployerRole(currentUser?.role) });
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
  if (saleUseScannerMode) {
    setScanFeedback("Desactiva 'Modo scanner' para usar la camara en ventas.");
    return;
  }
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
  clearSaleSuggestions();
  if (dom.saleScanInput) dom.saleScanInput.value = "";
  setScanFeedback("Venta actual limpiada.", "success");
}

function handleRemoveCurrentSaleItem(event) {
  const button = event.target.closest("[data-remove-sale-id]");
  if (!button) return;

  const productId = String(button.getAttribute("data-remove-sale-id") || "").trim();
  if (!productId) return;

  const index = currentSaleItems.findIndex((item) => item.productId === productId);
  if (index === -1) return;

  const item = currentSaleItems[index];
  if (item.quantity > 1) {
    item.quantity -= 1;
    item.subtotal = Number((item.quantity * item.price).toFixed(2));
  } else {
    currentSaleItems.splice(index, 1);
  }

  renderCurrentSale(currentSaleItems);
  setScanFeedback("Producto quitado de la venta actual.", "success");
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
  if (dom.saleScanInput) dom.saleScanInput.value = barcode;
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
  clearSaleSuggestions();
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

  const deleteButtons = document.querySelectorAll("[data-delete-stock-id]");
  deleteButtons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const productId = button.getAttribute("data-delete-stock-id");
      if (!productId) return;

      const product = allStockProducts.find((item) => item.id === productId) || null;
      const label = product?.name || "este producto";
      const confirmed = window.confirm(`¿Eliminar ${label}? Esta accion no se puede deshacer.`);
      if (!confirmed) return;

      const originalLabel = button.textContent;
      button.disabled = true;
      button.classList.add("is-loading");
      button.textContent = "Eliminando...";
      setStockFeedback("Eliminando producto...", "success");

      try {
        const result = await deleteProduct(productId);
        if (!result.ok) {
          setStockFeedback(result.error);
          if (result.requiresLogin) {
            redirectToLogin();
            return;
          }
          await refreshStock();
          return;
        }

        setStockFeedback(result.message, "success");
        await refreshStock();
      } finally {
        button.disabled = false;
        button.classList.remove("is-loading");
        button.textContent = originalLabel || "🗑️ Eliminar";
      }
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
  if (showCameraControls && saleUseScannerMode) {
    saleUseScannerMode = false;
    if (dom.saleModeScannerSwitch) dom.saleModeScannerSwitch.checked = false;
  }
  document.body.classList.toggle("ui-mode-mobile", showCameraControls);
  document.body.classList.toggle("ui-mode-pc", !showCameraControls);
  dom.addCameraControls.classList.toggle("hidden", !showCameraControls);
  dom.addScanFeedback.classList.toggle("hidden", !showCameraControls);
  dom.addScannerReader.classList.toggle("hidden", !showCameraControls);
  dom.stockCameraControls.classList.toggle("hidden", !showCameraControls);
  dom.saleDeviceHint.classList.toggle("hidden", showCameraControls || !saleUseScannerMode);
  forceCameraControlsDisplay(showCameraControls);
  applySellModeUI();
  renderUiModeToggleLabel();
}

async function handleKeyboardBarcode(barcode) {
  if (dom.sellPanel && !dom.sellPanel.classList.contains("hidden") && saleUseScannerMode) {
    if (dom.saleScanInput) dom.saleScanInput.value = barcode;
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
  if (!dom.configPanel.classList.contains("hidden")) return "config";
  return "add";
}

function shouldEnableKeyboardScanner(mode) {
  if (isMobileMode()) return false;
  if (mode === "sell") return saleUseScannerMode;
  return mode === "stock";
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
  dom.startScanBtn.style.display = "";
  dom.stopScanBtn.style.display = "";
  dom.saleScannerReader.style.display = "";
}

function initSaleModeSwitch() {
  saleUseScannerMode = !isMobileMode();
  if (dom.saleModeScannerSwitch) {
    dom.saleModeScannerSwitch.checked = saleUseScannerMode;
  }
  applySellModeUI();
}

async function handleSaleModeSwitchChange() {
  saleUseScannerMode = Boolean(dom.saleModeScannerSwitch?.checked);
  if (isMobileMode() && saleUseScannerMode) {
    saleUseScannerMode = false;
    if (dom.saleModeScannerSwitch) dom.saleModeScannerSwitch.checked = false;
    setScanFeedback("En celular usa modo ingreso/busqueda manual.", "success");
  }
  applySellModeUI();
  keyboardScanner.setEnabled(shouldEnableKeyboardScanner(getCurrentMode()));

  if (saleUseScannerMode) {
    clearSaleSuggestions();
    if (dom.saleScanInput) dom.saleScanInput.value = "";
    await stopAnyScanner({ targetMode: "sell", showMessage: false });
    setScanFeedback("Modo scanner activo. La busqueda manual se deshabilito.", "success");
  } else {
    setScanFeedback("Modo busqueda manual activo. Puedes usar camara o escribir codigo/nombre.", "success");
  }
}

function applySellModeUI() {
  if (dom.saleModeSwitchLabel) {
    dom.saleModeSwitchLabel.textContent = saleUseScannerMode ? "Modo scanner" : "Modo ingreso/busqueda manual";
  }
  if (dom.saleScanInput) {
    dom.saleScanInput.disabled = saleUseScannerMode;
    dom.saleScanInput.placeholder = saleUseScannerMode
      ? "Codigo escaneado (modo scanner)"
      : "Escribe codigo o nombre de producto";
  }
  if (dom.saleModeScannerSwitch) {
    dom.saleModeScannerSwitch.disabled = isMobileMode();
  }
  document.body.classList.toggle("sell-manual-mode", !saleUseScannerMode);
  document.body.classList.toggle("sell-scanner-mode", saleUseScannerMode);
  dom.saleDeviceHint.classList.toggle("hidden", isMobileMode() || !saleUseScannerMode);
}

function handleSaleScanInputKeydown(event) {
  if (saleUseScannerMode) return;
  if (event.key !== "Enter") return;
  event.preventDefault();
  addFromSaleSearch(true).catch((error) => console.error(error));
}

function handleSaleScanInputChange() {
  if (saleUseScannerMode) return;
  renderSaleSuggestions();
}

function handleSaleSuggestionClick(event) {
  const button = event.target.closest("[data-sale-suggestion-id]");
  if (!button) return;

  const productId = String(button.getAttribute("data-sale-suggestion-id") || "").trim();
  if (!productId) return;
  const product = allStockProducts.find((item) => item.id === productId);
  if (!product) return;

  addProductToCurrentSale(product);
  if (dom.saleScanInput) {
    dom.saleScanInput.value = "";
    dom.saleScanInput.focus({ preventScroll: true });
  }
  clearSaleSuggestions();
}

function handleSaleSuggestionKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") return;
  const pill = event.target.closest("[data-sale-suggestion-id]");
  if (!pill) return;
  event.preventDefault();
  pill.click();
}

function renderSaleSuggestions() {
  if (!dom.saleSearchSuggestions || !dom.saleScanInput) return;
  const query = String(dom.saleScanInput.value || "").trim().toLowerCase();
  if (!query) {
    clearSaleSuggestions();
    return;
  }

  saleSearchMatches = allStockProducts
    .filter((product) => {
      const barcode = String(product.barcode || "").toLowerCase();
      const name = String(product.name || "").toLowerCase();
      const id = String(product.id || "").toLowerCase();
      return barcode.includes(query) || name.includes(query) || id.includes(query);
    })
    .slice(0, 8);

  if (saleSearchMatches.length === 0) {
    dom.saleSearchSuggestions.innerHTML = '<span class="sale-suggestion-empty">Sin coincidencias</span>';
    dom.saleSearchSuggestions.classList.remove("hidden");
    return;
  }

  dom.saleSearchSuggestions.innerHTML = saleSearchMatches
    .map((product) => {
      const label = `${escapeHtml(product.name)} (${escapeHtml(product.barcode || product.id || "")})`;
      return `<span class="sale-suggestion-pill" data-sale-suggestion-id="${escapeHtml(
        product.id
      )}" role="button" tabindex="0">${label}</span>`;
    })
    .join("");
  dom.saleSearchSuggestions.classList.remove("hidden");
}

function clearSaleSuggestions() {
  saleSearchMatches = [];
  if (!dom.saleSearchSuggestions) return;
  dom.saleSearchSuggestions.innerHTML = "";
  dom.saleSearchSuggestions.classList.add("hidden");
}

async function addFromSaleSearch(showNoMatchMessage = false) {
  if (saleUseScannerMode || !dom.saleScanInput) return;
  const query = String(dom.saleScanInput.value || "").trim();
  if (!query) return;

  const lower = query.toLowerCase();
  const exact = allStockProducts.find((product) => {
    const barcode = String(product.barcode || "").toLowerCase();
    const name = String(product.name || "").toLowerCase();
    const id = String(product.id || "").toLowerCase();
    return barcode === lower || name === lower || id === lower;
  });

  if (exact) {
    addProductToCurrentSale(exact);
    dom.saleScanInput.value = "";
    clearSaleSuggestions();
    return;
  }

  renderSaleSuggestions();
  if (saleSearchMatches.length === 1) {
    addProductToCurrentSale(saleSearchMatches[0]);
    dom.saleScanInput.value = "";
    clearSaleSuggestions();
    return;
  }

  if (showNoMatchMessage) {
    if (saleSearchMatches.length > 1) {
      setScanFeedback("Hay varias coincidencias. Selecciona una de la lista.");
    } else {
      setScanFeedback(`No se encontro "${query}" en stock.`);
    }
  }
}

function addProductToCurrentSale(product) {
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
  setScanFeedback(`Agregado: ${product.name}`, "success");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateForTable(value) {
  const date = normalizeDate(value);
  if (!date) return "-";
  return date.toLocaleString("es-AR");
}

function formatDateValue(value) {
  const date = normalizeDate(value);
  return date ? date.getTime() : 0;
}

function normalizeDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
