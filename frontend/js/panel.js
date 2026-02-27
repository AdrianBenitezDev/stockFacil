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
  syncProductsFromCloudForCurrentKiosco,
  syncPendingProducts,
  listProductsForCurrentKiosco,
  updateProductDetails,
  updateProductStock
} from "./products.js";
import { isScannerReady, isScannerRunning, startScanner, stopScanner } from "./scanner.js";
import { createKeyboardScanner } from "./keyboard_scanner.js";
import { chargeSale, syncPendingSales } from "./sales.js";
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
import {
  createEmployeeViaCallable,
  deleteEmployeeViaCallable,
  updateEmployeeCreateProductsPermission,
  updateEmployeeEditProductsPermission
} from "./employees.js";
import { endEmployeeShift, startEmployeeShift, syncMyShiftStatusCache } from "./shifts.js";

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
let salePaymentType = "efectivo";
let salePaymentSubmitting = false;
let salePaymentCurrentTotal = 0;
const keyboardScanner = createKeyboardScanner(handleKeyboardBarcode);
const ICON_TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const ICON_DEVICE_PC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>';
const ICON_DEVICE_PHONE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>';
const ICON_EYE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.8 21.8 0 0 1-3.17 4.35"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
let cashSensitiveMasked = true;
let latestCashSnapshot = null;
let offlineSyncInProgress = false;
let cashSalesSectionVisible = true;
let cashClosuresSectionVisible = true;
let startupOverlayHidden = false;
let stockBulkSaveInProgress = false;
let stockDetailToastTimer = null;
let addProductToastTimer = null;
const pendingStockChanges = new Set();
const pendingStockValues = new Map();
let uiModeToastTimer = null;
let employeeShiftSubmitting = false;
let employeeShiftCandidates = [];
let selectedEmployeeShiftUid = "";

init()
  .catch((error) => {
    console.error(error);
    const msg = String(error?.message || "").toLowerCase();
    const looksLikeAuthError =
      msg.includes("sesion") ||
      msg.includes("auth") ||
      msg.includes("permission-denied") ||
      msg.includes("unauthenticated");
    if (looksLikeAuthError) {
      redirectToLogin();
      return;
    }
    if (dom.sessionInfo) {
      dom.sessionInfo.textContent = "No se pudo cargar el panel. Revisa consola y recarga la pagina.";
    }
  })
  .finally(() => {
    hideStartupOverlay();
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

  ensureCashOwnerActionsDom();
  showAppShell(currentUser);
  dom.syncProductsBtn?.classList.toggle("hidden", !canCurrentUserCreateProducts());
  updateStockBulkSaveButtonState();
  renderCategoryOptions(PRODUCT_CATEGORIES);
  renderStockCategoryOptions(PRODUCT_CATEGORIES);
  renderStockDetailEditCategoryOptions();
  setupDeviceSpecificUI();
  initSaleModeSwitch();
  focusBarcodeInputIfDesktop();
  renderCurrentSale(currentSaleItems);
  scheduleStartupOverlayFallback();
  hideStartupOverlay();
  await runPostStartupRefreshes();
  wireEvents();
  initializeOfflineSyncBanner();
}

function ensureCashOwnerActionsDom() {
  if (dom.cashOwnerActions && dom.closeMySalesBtn && dom.startEmployeeShiftBtn && dom.closeShiftBtn) return;
  const cashActionBar = document.querySelector(".cash-action-bar");
  const refreshBtn = dom.refreshCashBtn || document.getElementById("refresh-cash-btn");
  if (!cashActionBar || !refreshBtn) return;

  let ownerStack = document.getElementById("cash-owner-actions");
  if (!ownerStack) {
    ownerStack = document.createElement("div");
    ownerStack.id = "cash-owner-actions";
    ownerStack.className = "cash-owner-action-stack hidden";
  }

  if (!document.getElementById("close-my-sales-btn")) {
    const row1 = document.createElement("div");
    row1.className = "cash-owner-action-row";
    const closeMySalesBtn = document.createElement("button");
    closeMySalesBtn.id = "close-my-sales-btn";
    closeMySalesBtn.type = "button";
    closeMySalesBtn.className = "mode-btn-secondary";
    closeMySalesBtn.textContent = "CERRAR MIS VENTAS";
    row1.appendChild(closeMySalesBtn);
    ownerStack.appendChild(row1);
  }

  const hasShiftRow = Array.from(ownerStack.querySelectorAll(".cash-owner-action-row button")).some(
    (button) => button.id === "start-employee-shift-btn" || button.id === "close-shift-btn"
  );
  if (!hasShiftRow) {
    const row2 = document.createElement("div");
    row2.className = "cash-owner-action-row";

    const startShiftBtn = document.createElement("button");
    startShiftBtn.id = "start-employee-shift-btn";
    startShiftBtn.type = "button";
    startShiftBtn.className = "mode-btn-secondary";
    startShiftBtn.textContent = "INICIAR TURNO EMPLEADO";
    row2.appendChild(startShiftBtn);

    const closeShiftBtn = document.createElement("button");
    closeShiftBtn.id = "close-shift-btn";
    closeShiftBtn.type = "button";
    closeShiftBtn.textContent = "TERMINAR TURNO EMPLEADO";
    row2.appendChild(closeShiftBtn);

    ownerStack.appendChild(row2);
  }

  if (!ownerStack.parentElement) {
    cashActionBar.insertBefore(ownerStack, refreshBtn);
  }

  dom.cashOwnerActions = ownerStack;
  dom.closeMySalesBtn = document.getElementById("close-my-sales-btn");
  dom.startEmployeeShiftBtn = document.getElementById("start-employee-shift-btn");
  dom.closeShiftBtn = document.getElementById("close-shift-btn");
}

function hideStartupOverlay() {
  if (startupOverlayHidden) return;
  startupOverlayHidden = true;
  if (!dom.appLoadingOverlay) return;
  dom.appLoadingOverlay.classList.add("is-hidden");
  window.setTimeout(() => {
    dom.appLoadingOverlay?.classList.add("hidden");
  }, 260);
}

function scheduleStartupOverlayFallback() {
  window.setTimeout(() => {
    hideStartupOverlay();
  }, 4500);
}

async function runPostStartupRefreshes() {
  const tasks = [
    syncMyShiftStatusCache(currentUser),
    ensureInitialProductsConsistency(),
    refreshStock(),
    refreshCashPanel(),
    refreshEmployeesPanel(),
    refreshAuditPanel()
  ];
  const results = await Promise.allSettled(tasks);
  const firstError = results.find((entry) => entry.status === "rejected");
  if (firstError?.status === "rejected") {
    console.error("Error en tareas post-inicio:", firstError.reason);
  }
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
  dom.stockDetailEditBtn?.addEventListener("click", handleStockDetailEditClick);
  dom.stockDetailEditForm?.addEventListener("submit", handleStockDetailEditSubmit);
  dom.startAddScanBtn.addEventListener("click", handleStartAddBarcodeScanner);
  dom.stopAddScanBtn.addEventListener("click", handleStopAddBarcodeScanner);
  dom.startScanBtn.addEventListener("click", handleStartScanner);
  dom.stopScanBtn.addEventListener("click", handleStopScanner);
  dom.startStockScanBtn.addEventListener("click", handleStartStockScanner);
  dom.stopStockScanBtn.addEventListener("click", handleStopStockScanner);
  dom.clearSaleBtn.addEventListener("click", handleClearSale);
  dom.checkoutSaleBtn.addEventListener("click", handleCheckoutSale);
  dom.salePaymentCashBtn?.addEventListener("click", () => selectSalePaymentType("efectivo"));
  dom.salePaymentVirtualBtn?.addEventListener("click", () => selectSalePaymentType("virtual"));
  dom.salePaymentMixedBtn?.addEventListener("click", () => selectSalePaymentType("mixto"));
  dom.salePaymentCashInput?.addEventListener("input", handleMixedCashInputChange);
  dom.salePaymentCancelBtn?.addEventListener("click", closeSalePaymentOverlay);
  dom.salePaymentConfirmBtn?.addEventListener("click", handleConfirmSalePayment);
  dom.saleScanInput?.addEventListener("input", handleSaleScanInputChange);
  dom.saleScanInput?.addEventListener("keydown", handleSaleScanInputKeydown);
  dom.saleModeScannerSwitch?.addEventListener("change", handleSaleModeSwitchChange);
  dom.saleSearchSuggestions?.addEventListener("click", handleSaleSuggestionClick);
  dom.saleSearchSuggestions?.addEventListener("keydown", handleSaleSuggestionKeydown);
  dom.saleTableBody.addEventListener("click", handleRemoveCurrentSaleItem);
  dom.closeShiftBtn.addEventListener("click", handleCloseShift);
  dom.closeMySalesBtn?.addEventListener("click", handleCloseMySales);
  dom.startEmployeeShiftBtn?.addEventListener("click", handleOpenEmployeeShiftOverlay);
  dom.refreshCashBtn.addEventListener("click", handleRefreshCashClick);
  dom.employeeShiftCancelBtn?.addEventListener("click", closeEmployeeShiftOverlay);
  dom.employeeShiftConfirmBtn?.addEventListener("click", handleConfirmEmployeeShiftStart);
  dom.employeeShiftCashInput?.addEventListener("input", updateEmployeeShiftConfirmState);
  dom.employeeShiftEmployees?.addEventListener("click", handleSelectEmployeeShiftCandidate);
  dom.cashPrivacyToggle?.addEventListener("click", handleToggleCashPrivacy);
  dom.cashSalesToggleBtn?.addEventListener("click", handleToggleCashSalesSection);
  dom.cashClosuresToggleBtn?.addEventListener("click", handleToggleCashClosuresSection);
  dom.floatingSyncBtn?.addEventListener("click", handleFloatingSyncClick);
  dom.floatingStockSaveBtn?.addEventListener("click", handleFloatingStockSaveClick);
  dom.employeeListTableBody?.addEventListener("click", handleDeleteEmployeeClick);
  dom.employeeListTableBody?.addEventListener("change", handleToggleEmployeeProductPermissions);
  window.addEventListener("online", handleOnlineReconnection);
  window.addEventListener("offline", handleOfflineDetected);
  window.addEventListener("keydown", handleSalePaymentOverlayKeydown);
  window.addEventListener("keydown", handleEmployeeShiftOverlayKeydown);
  dom.offlineSyncBanner?.addEventListener("click", handleOfflineBannerClick);
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

  const submitBtn = dom.addProductSubmitBtn;
  const originalLabel = submitBtn?.textContent || "Crear producto";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add("is-loading");
    submitBtn.setAttribute("aria-busy", "true");
    submitBtn.textContent = "Creando...";
  }

  try {
    const result = await createProduct(new FormData(dom.addProductForm));
    if (!result.ok) {
      setProductFeedbackError(result.error);
      showAddProductToast(result.error || "No se pudo crear el producto.", "error");
      if (result.requiresLogin) {
        redirectToLogin();
      }
      return;
    }

    dom.addProductForm.reset();
    renderCategoryOptions(PRODUCT_CATEGORIES);
    setProductFeedbackSuccess(result.message);
    showAddProductToast(result.message || "Producto creado correctamente.", "success");
    focusBarcodeInputIfDesktop();
    await refreshStock();
  } catch (error) {
    console.error(error);
    const fallbackMessage = "No se pudo crear el producto. Intenta nuevamente.";
    setProductFeedbackError(fallbackMessage);
    showAddProductToast(fallbackMessage, "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove("is-loading");
      submitBtn.removeAttribute("aria-busy");
      submitBtn.textContent = originalLabel;
    }
  }
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

async function handleOnlineReconnection() {
  await runOfflinePendingSync();
}

async function handleFloatingSyncClick() {
  if (!dom.floatingSyncBtn) return;
  dom.floatingSyncBtn.classList.add("is-loading");
  dom.floatingSyncBtn.disabled = true;
  try {
    await runOfflinePendingSyncInternal({ forceCloudPull: true, showSuccessFeedback: true });
  } finally {
    dom.floatingSyncBtn.disabled = false;
    dom.floatingSyncBtn.classList.remove("is-loading");
  }
}

function handleOfflineDetected() {
  setOfflineSyncBannerState("offline");
}

async function handleOfflineBannerClick() {
  if (!navigator.onLine) {
    setOfflineSyncBannerState("offline");
    return;
  }
  await runOfflinePendingSync();
}

function initializeOfflineSyncBanner() {
  if (!dom.offlineSyncBanner) return;
  if (navigator.onLine) {
    hideOfflineSyncBanner();
    return;
  }
  setOfflineSyncBannerState("offline");
}

async function runOfflinePendingSync() {
  await runOfflinePendingSyncInternal({ forceCloudPull: false, showSuccessFeedback: false });
}

async function runOfflinePendingSyncInternal({ forceCloudPull = false, showSuccessFeedback = false } = {}) {
  if (offlineSyncInProgress) return;
  if (!dom.offlineSyncBanner) return;

  if (!navigator.onLine) {
    setOfflineSyncBannerState("offline");
    if (showSuccessFeedback) {
      setProductFeedbackError("Sin conexion. No se puede sincronizar ahora.");
    }
    return;
  }

  offlineSyncInProgress = true;
  setOfflineSyncBannerState("syncing");

  let shouldRefreshStock = false;
  let shouldRefreshCash = false;
  let syncError = "";

  try {
    if (canCurrentUserCreateProducts()) {
      const productsSync = await syncPendingProducts({ force: true });
      if (!productsSync.ok) {
        syncError = productsSync.error || "No se pudieron sincronizar productos pendientes.";
      } else {
        if (productsSync.syncedCount > 0) {
          setProductFeedbackSuccess(productsSync.message);
          shouldRefreshStock = true;
        }
      }
      const cloudPull = await syncProductsFromCloudForCurrentKiosco();
      if (!cloudPull.ok) {
        syncError = syncError || cloudPull.error || "No se pudieron descargar productos desde el servidor.";
      } else if (cloudPull.syncedCount > 0 || forceCloudPull) {
        shouldRefreshStock = true;
      }
    } else {
      const cloudPull = await syncProductsFromCloudForCurrentKiosco();
      if (!cloudPull.ok) {
        syncError = cloudPull.error || "No se pudieron descargar productos desde el servidor.";
      } else if (cloudPull.syncedCount > 0 || forceCloudPull) {
        shouldRefreshStock = true;
      }
    }

    const salesSync = await syncPendingSales();
    if (!salesSync.ok) {
      syncError = syncError || salesSync.error || "No se pudieron sincronizar ventas pendientes.";
    } else if (salesSync.syncedCount > 0) {
      shouldRefreshCash = true;
    }

    if (syncError) {
      setOfflineSyncBannerState("error", `Online con pendientes. Click para reintentar. ${syncError}`);
      return;
    }

    if (shouldRefreshStock) {
      await refreshStock();
    }
    if (shouldRefreshCash) {
      await refreshCashPanel();
    }
    if (showSuccessFeedback) {
      setProductFeedbackSuccess("Sincronizacion completada correctamente.");
    }
    hideOfflineSyncBanner();
  } finally {
    offlineSyncInProgress = false;
  }
}

async function ensureInitialProductsConsistency() {
  if (!navigator.onLine) return;
  if (canCurrentUserCreateProducts()) {
    await syncPendingProducts({ force: true });
  }
  await syncProductsFromCloudForCurrentKiosco();
}

async function handleCreateEmployeeSubmit(event) {
  event.preventDefault();
  clearEmployeeFeedback();

  if (!currentUser || currentUser.role !== "empleador") {
    setEmployeeFeedback("Solo el empleador puede crear empleados.");
    return;
  }

  const submitBtn = dom.createEmployeeBtn;
  const originalLabel = submitBtn?.textContent || "Crear empleado";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add("btn-loading");
    submitBtn.setAttribute("aria-busy", "true");
    submitBtn.textContent = "Creando...";
  }

  try {
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
        ? `Empleado creado, pero no se pudo enviar correo de verificacion. Detalle: ${String(
            result?.data?.verificationEmailError || "sin detalle"
          )}`
        : "Empleado creado y correo de verificacion enviado.",
      result?.data?.verificationEmailSent === false ? "error" : "success"
    );
    await refreshEmployeesPanel();
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove("btn-loading");
      submitBtn.removeAttribute("aria-busy");
      submitBtn.textContent = originalLabel;
    }
  }
}

async function refreshEmployeesPanel() {
  if (!dom.employeeListTableBody) return;
  if (!currentUser || currentUser.role !== "empleador") return;

  dom.employeeListTableBody.innerHTML = '<tr><td colspan="7">Cargando empleados...</td></tr>';
  try {
    const q = query(
      collection(firestoreDb, "empleados"),
      where("comercioId", "==", String(currentUser.tenantId || "").trim())
    );
    const snap = await getDocs(q);
    const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    rows.sort((a, b) => formatDateValue(b.createdAt) - formatDateValue(a.createdAt));

    if (!rows.length) {
      dom.employeeListTableBody.innerHTML = '<tr><td colspan="7">No hay empleados registrados.</td></tr>';
      return;
    }

    dom.employeeListTableBody.innerHTML = rows
      .map((employee) => {
        const name = escapeHtml(employee.displayName || employee.username || employee.uid || "-");
        const email = escapeHtml(employee.email || "-");
        const verified = employee.emailVerified === true || employee.correoVerificado === true ? "Si" : "No";
        const canCreateProducts = employee.puedeCrearProductos === true;
        const canEditProducts = employee.puedeEditarProductos === true;
        const created = escapeHtml(formatDateForTable(employee.createdAt));
        const uid = escapeHtml(employee.uid || employee.id || "");
        const createToggleId = `employee-create-products-${uid}`;
        const editToggleId = `employee-edit-products-${uid}`;
        return [
          "<tr>",
          `<td>${name}</td>`,
          `<td>${email}</td>`,
          `<td>${verified}</td>`,
          `<td><input id="${createToggleId}" type="checkbox" data-toggle-create-products-id="${uid}" ${canCreateProducts ? "checked" : ""}></td>`,
          `<td><input id="${editToggleId}" type="checkbox" data-toggle-edit-products-id="${uid}" ${canEditProducts ? "checked" : ""}></td>`,
          `<td>${created}</td>`,
          `<td><button type="button" class="stock-delete-btn icon-only-btn" data-delete-employee-id="${uid}" title="Eliminar empleado" aria-label="Eliminar empleado">${iconOnly(ICON_TRASH_SVG)}</button></td>`,
          "</tr>"
        ].join("");
      })
      .join("");
  } catch (error) {
    console.error("No se pudo cargar listado de empleados:", error);
    dom.employeeListTableBody.innerHTML =
      '<tr><td colspan="7">No se pudo cargar empleados. Verifica permisos y reglas.</td></tr>';
  } finally {
    await refreshAuditPanel();
  }
}

async function refreshAuditPanel() {
  if (!dom.auditSalesTableBody) return;
  if (!currentUser || currentUser.role !== "empleador") return;

  dom.auditSalesTableBody.innerHTML = '<tr><td colspan="5">Cargando ventas en auditoria...</td></tr>';
  try {
    const tenantId = String(currentUser.tenantId || "").trim();
    if (!tenantId) {
      dom.auditSalesTableBody.innerHTML = '<tr><td colspan="5">No se pudo resolver tenant actual.</td></tr>';
      return;
    }
    const salesQuery = query(
      collection(firestoreDb, "tenants", tenantId, "ventas"),
      where("auditRequired", "==", true)
    );
    const eventsQuery = query(
      collection(firestoreDb, "tenants", tenantId, "auditoria_turnos"),
      where("auditRequired", "==", true)
    );
    const [salesSnap, eventsSnap] = await Promise.all([getDocs(salesQuery), getDocs(eventsQuery)]);
    const saleRows = salesSnap.docs.map((docSnap) => ({ id: docSnap.id, kind: "sale", ...(docSnap.data() || {}) }));
    const eventRows = eventsSnap.docs.map((docSnap) => ({ id: docSnap.id, kind: "event", ...(docSnap.data() || {}) }));
    const rows = [...saleRows, ...eventRows];
    rows.sort((a, b) => formatDateValue(b.createdAt) - formatDateValue(a.createdAt));

    if (!rows.length) {
      dom.auditSalesTableBody.innerHTML = '<tr><td colspan="5">No hay ventas marcadas para auditoria.</td></tr>';
      return;
    }

    dom.auditSalesTableBody.innerHTML = rows
      .slice(0, 200)
      .map((row) => {
        const created = escapeHtml(formatDateForTable(row.createdAt));
        const user = escapeHtml(row.usuarioNombre || row.empleadoNombre || row.username || row.userId || row.empleadoUid || "-");
        const total = row.kind === "sale" ? `$${Number(row.total || 0).toFixed(2)}` : "-";
        const reason = escapeHtml(
          String(row.kind === "sale" ? row.auditReason || "revision_manual" : row.tipo || "evento_auditoria")
        );
        const source = escapeHtml(String(row.kind === "sale" ? row.auditSource || "-" : row.source || "-"));
        return [`<tr>`, `<td>${created}</td>`, `<td>${user}</td>`, `<td>${total}</td>`, `<td>${reason}</td>`, `<td>${source}</td>`, `</tr>`].join("");
      })
      .join("");
  } catch (error) {
    console.error("No se pudo cargar tabla de auditoria:", error);
    dom.auditSalesTableBody.innerHTML =
      '<tr><td colspan="5">No se pudo cargar auditoria. Verifica permisos y conexion.</td></tr>';
  }
}

async function handleToggleEmployeeProductPermissions(event) {
  const input = event.target.closest("[data-toggle-create-products-id], [data-toggle-edit-products-id]");
  if (!input) return;

  const uidEmpleado = String(
    input.getAttribute("data-toggle-create-products-id") || input.getAttribute("data-toggle-edit-products-id") || ""
  ).trim();
  if (!uidEmpleado) return;

  const nextValue = Boolean(input.checked);
  const isCreatePermissionToggle = input.hasAttribute("data-toggle-create-products-id");
  input.disabled = true;
  clearEmployeeFeedback();

  try {
    const result = isCreatePermissionToggle
      ? await updateEmployeeCreateProductsPermission(uidEmpleado, nextValue)
      : await updateEmployeeEditProductsPermission(uidEmpleado, nextValue);
    if (!result.ok) {
      input.checked = !nextValue;
      setEmployeeFeedback(result.error);
      return;
    }
    setEmployeeFeedback(
      isCreatePermissionToggle
        ? nextValue
          ? "Permiso activado: el empleado ya puede crear productos."
          : "Permiso removido: el empleado ya no puede crear productos."
        : nextValue
          ? "Permiso activado: el empleado ya puede editar productos."
          : "Permiso removido: el empleado ya no puede editar productos.",
      "success"
    );
  } finally {
    input.disabled = false;
  }
}

async function handleDeleteEmployeeClick(event) {
  const button = event.target.closest("[data-delete-employee-id]");
  if (!button) return;

  const uidEmpleado = String(button.getAttribute("data-delete-employee-id") || "").trim();
  if (!uidEmpleado) return;

  const row = button.closest("tr");
  const name = String(row?.children?.[0]?.textContent || "este empleado").trim();
  const confirmed = window.confirm(`Eliminar a ${name}? Esta accion borrara su acceso y su registro.`);
  if (!confirmed) return;

  const originalHtml = button.innerHTML;
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
    button.innerHTML = originalHtml || iconOnly(ICON_TRASH_SVG);
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
  pendingStockChanges.clear();
  pendingStockValues.clear();
  if (!canCurrentUserEditProducts()) {
    await syncProductsFromCloudForCurrentKiosco();
  }
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

  const visibleRows = filtered.slice(0, 10);
  renderStockTable(visibleRows, {
    canEditStock: canCurrentUserEditProducts(),
    canDeleteStock: isEmployerRole(currentUser?.role)
  });
  wireStockRowEvents();
  updateStockBulkSaveButtonState();

  const selectedInFiltered = filtered.find((p) => p.id === selectedStockProductId);
  if (selectedInFiltered) {
    renderStockDetailWithEditorState(selectedInFiltered);
  } else {
    selectedStockProductId = null;
    renderStockDetailWithEditorState(null);
  }
}

function renderStockDetailEditCategoryOptions() {
  if (!dom.stockDetailEditCategory) return;
  const options = [
    '<option value="">Selecciona una categoria</option>',
    ...PRODUCT_CATEGORIES.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
  ];
  dom.stockDetailEditCategory.innerHTML = options.join("");
}

function renderStockDetailWithEditorState(product) {
  renderStockDetail(product);
  const canEditDetail = canCurrentUserEditProducts() && Boolean(product);
  dom.stockDetailReadonly?.classList.toggle("hidden", !Boolean(product));
  dom.stockDetailEditActions?.classList.toggle("hidden", !canEditDetail);
  if (!product) {
    dom.stockDetailEditForm?.classList.add("hidden");
    return;
  }
  dom.stockDetailEditForm?.classList.add("hidden");
  dom.stockDetailReadonly?.classList.remove("hidden");
  dom.stockDetailEditActions?.classList.remove("hidden");
  populateStockDetailEditForm(product);
}

function populateStockDetailEditForm(product) {
  if (!product) return;
  if (dom.stockDetailEditName) dom.stockDetailEditName.value = String(product.name || "");
  if (dom.stockDetailEditStock) dom.stockDetailEditStock.value = String(Math.trunc(Number(product.stock || 0)));
  if (dom.stockDetailEditPrice) dom.stockDetailEditPrice.value = Number(product.price || 0).toFixed(2);
  if (dom.stockDetailEditProviderCost) {
    dom.stockDetailEditProviderCost.value = Number(product.providerCost || 0).toFixed(2);
  }
  if (dom.stockDetailEditCategory) dom.stockDetailEditCategory.value = String(product.category || "");
}

function handleStockDetailEditClick() {
  if (!canCurrentUserEditProducts()) {
    setStockFeedback("No tienes permisos para editar productos.");
    return;
  }
  if (!selectedStockProductId) {
    setStockFeedback("Selecciona un producto para editar.");
    return;
  }
  const product = allStockProducts.find((item) => item.id === selectedStockProductId);
  if (!product) {
    setStockFeedback("No se encontro el producto seleccionado.");
    return;
  }
  populateStockDetailEditForm(product);
  dom.stockDetailReadonly?.classList.add("hidden");
  dom.stockDetailEditActions?.classList.add("hidden");
  dom.stockDetailEditForm?.classList.remove("hidden");
}

async function handleStockDetailEditSubmit(event) {
  event.preventDefault();
  if (!canCurrentUserEditProducts()) {
    setStockFeedback("No tienes permisos para editar productos.");
    return;
  }
  if (!selectedStockProductId) {
    setStockFeedback("Selecciona un producto para editar.");
    return;
  }

  const button = dom.stockDetailSaveBtn;
  const stopLoading = setStockSaveButtonLoading(button, true);
  const payload = {
    name: String(dom.stockDetailEditName?.value || "").trim(),
    stock: dom.stockDetailEditStock?.value,
    price: dom.stockDetailEditPrice?.value,
    providerCost: dom.stockDetailEditProviderCost?.value,
    category: String(dom.stockDetailEditCategory?.value || "").trim()
  };

  try {
    const result = await updateProductDetails(selectedStockProductId, payload);
    if (!result.ok) {
      setStockFeedback(result.error);
      if (result.requiresLogin) {
        redirectToLogin();
      }
      return;
    }

    dom.stockDetailEditForm?.classList.add("hidden");
    dom.stockDetailReadonly?.classList.remove("hidden");
    dom.stockDetailEditActions?.classList.remove("hidden");
    setStockFeedback(result.message, "success");
    showStockDetailToast("cambios guardados");
    await refreshStock();
  } finally {
    stopLoading();
  }
}

function showStockDetailToast(message) {
  if (!dom.stockDetailToast) return;
  dom.stockDetailToast.textContent = message;
  dom.stockDetailToast.classList.remove("hidden");
  dom.stockDetailToast.classList.add("is-visible");
  if (stockDetailToastTimer) {
    window.clearTimeout(stockDetailToastTimer);
  }
  stockDetailToastTimer = window.setTimeout(() => {
    dom.stockDetailToast?.classList.remove("is-visible");
    window.setTimeout(() => {
      dom.stockDetailToast?.classList.add("hidden");
    }, 240);
  }, 1800);
}

function showAddProductToast(message, tone = "success") {
  if (!dom.addProductToast) return;
  dom.addProductToast.textContent = message;
  dom.addProductToast.classList.remove(
    "hidden",
    "add-product-toast--success",
    "add-product-toast--error"
  );
  dom.addProductToast.classList.add(
    tone === "error" ? "add-product-toast--error" : "add-product-toast--success"
  );
  dom.addProductToast.classList.add("is-visible");
  if (addProductToastTimer) {
    window.clearTimeout(addProductToastTimer);
  }
  addProductToastTimer = window.setTimeout(() => {
    dom.addProductToast?.classList.remove("is-visible");
    window.setTimeout(() => {
      dom.addProductToast?.classList.add("hidden");
    }, 220);
  }, 2200);
}

async function switchMode(mode) {
  if (mode === "add" && !canCurrentUserCreateProducts()) {
    setProductFeedbackError("No tienes permiso para crear productos.");
    return;
  }
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
  updateStockBulkSaveButtonState(mode);
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
  const minusBtn = event.target.closest("[data-sale-qty-minus-id]");
  if (minusBtn) {
    const productId = String(minusBtn.getAttribute("data-sale-qty-minus-id") || "").trim();
    if (!productId) return;
    const item = currentSaleItems.find((entry) => entry.productId === productId);
    if (!item) return;
    if (item.quantity <= 1) {
      setScanFeedback(`La cantidad minima para ${item.name} es 1.`);
      return;
    }
    item.quantity -= 1;
    item.subtotal = Number((item.quantity * item.price).toFixed(2));
    renderCurrentSale(currentSaleItems);
    setScanFeedback(`Cantidad actualizada: ${item.name} x${item.quantity}.`, "success");
    return;
  }

  const plusBtn = event.target.closest("[data-sale-qty-plus-id]");
  if (plusBtn) {
    const productId = String(plusBtn.getAttribute("data-sale-qty-plus-id") || "").trim();
    if (!productId) return;
    const item = currentSaleItems.find((entry) => entry.productId === productId);
    if (!item) return;
    const product = allStockProducts.find((entry) => entry.id === productId);
    const stock = Number(product?.stock || 0);
    const nextQuantity = item.quantity + 1;
    if (nextQuantity > stock) {
      setScanFeedback(`Stock insuficiente para ${item.name}. Disponible: ${stock}.`);
      return;
    }
    item.quantity = nextQuantity;
    item.subtotal = Number((item.quantity * item.price).toFixed(2));
    renderCurrentSale(currentSaleItems);
    setScanFeedback(`Cantidad actualizada: ${item.name} x${item.quantity}.`, "success");
    return;
  }

  const removeBtn = event.target.closest("[data-remove-sale-id]");
  if (!removeBtn) return;

  const productId = String(removeBtn.getAttribute("data-remove-sale-id") || "").trim();
  if (!productId) return;

  const index = currentSaleItems.findIndex((item) => item.productId === productId);
  if (index === -1) return;
  currentSaleItems.splice(index, 1);
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
  if (!Array.isArray(currentSaleItems) || currentSaleItems.length === 0) {
    setScanFeedback("No hay productos para cobrar.");
    return;
  }
  openSalePaymentOverlay();
}

function openSalePaymentOverlay() {
  salePaymentCurrentTotal = getCurrentSaleTotal();
  salePaymentType = "efectivo";
  salePaymentSubmitting = false;
  if (dom.salePaymentOverlay) {
    dom.salePaymentOverlay.classList.remove("hidden");
  }
  if (dom.salePaymentTotal) {
    dom.salePaymentTotal.textContent = `$${salePaymentCurrentTotal.toFixed(2)}`;
  }
  if (dom.salePaymentCashInput) {
    dom.salePaymentCashInput.value = salePaymentCurrentTotal.toFixed(2);
  }
  if (dom.salePaymentToast) {
    dom.salePaymentToast.classList.add("hidden");
  }
  if (dom.salePaymentProcessing) {
    dom.salePaymentProcessing.classList.add("hidden");
  }
  if (dom.salePaymentFeedback) {
    dom.salePaymentFeedback.textContent = "";
  }
  setSalePaymentActionsDisabled(false);
  selectSalePaymentType("efectivo");
}

function closeSalePaymentOverlay() {
  if (salePaymentSubmitting) return;
  dom.salePaymentOverlay?.classList.add("hidden");
}

function selectSalePaymentType(type) {
  salePaymentType = type;
  dom.salePaymentCashBtn?.classList.toggle("is-selected", type === "efectivo");
  dom.salePaymentVirtualBtn?.classList.toggle("is-selected", type === "virtual");
  dom.salePaymentMixedBtn?.classList.toggle("is-selected", type === "mixto");
  dom.salePaymentMixedFields?.classList.toggle("hidden", type !== "mixto");
  if (dom.salePaymentCashInput) {
    dom.salePaymentCashInput.disabled = salePaymentSubmitting || type !== "mixto";
  }
  if (type === "mixto" && dom.salePaymentCashInput) {
    if (!dom.salePaymentCashInput.value) {
      dom.salePaymentCashInput.value = salePaymentCurrentTotal.toFixed(2);
    }
    dom.salePaymentCashInput.focus({ preventScroll: true });
    dom.salePaymentCashInput.select();
  }
  updateMixedPaymentPreview();
}

function handleMixedCashInputChange() {
  updateMixedPaymentPreview();
}

function updateMixedPaymentPreview() {
  const cashValue = round2(Number(dom.salePaymentCashInput?.value || 0));
  const boundedCash = Math.max(0, Math.min(salePaymentCurrentTotal, Number.isFinite(cashValue) ? cashValue : 0));
  const virtualValue = round2(salePaymentCurrentTotal - boundedCash);
  if (dom.salePaymentVirtualPreview) {
    dom.salePaymentVirtualPreview.textContent = `$${virtualValue.toFixed(2)}`;
  }
}

function resolveSalePaymentPayload() {
  if (salePaymentType === "efectivo") {
    return {
      ok: true,
      payload: { tipoPago: "efectivo", pagoEfectivo: salePaymentCurrentTotal, pagoVirtual: 0 }
    };
  }
  if (salePaymentType === "virtual") {
    return {
      ok: true,
      payload: { tipoPago: "virtual", pagoEfectivo: 0, pagoVirtual: salePaymentCurrentTotal }
    };
  }

  const cashValueRaw = Number(dom.salePaymentCashInput?.value || 0);
  const cashValue = round2(cashValueRaw);
  if (!Number.isFinite(cashValue) || cashValue < 0 || cashValue > salePaymentCurrentTotal) {
    return { ok: false, error: "El pago en efectivo debe estar entre 0 y el total." };
  }
  const virtualValue = round2(salePaymentCurrentTotal - cashValue);
  if (virtualValue < 0) {
    return { ok: false, error: "El pago virtual no puede ser negativo." };
  }
  return {
    ok: true,
    payload: { tipoPago: "mixto", pagoEfectivo: cashValue, pagoVirtual: virtualValue }
  };
}

async function handleOpenEmployeeShiftOverlay() {
  if (!isEmployerRole(currentUser?.role)) return;
  resetEmployeeShiftOverlayState();
  dom.employeeShiftOverlay?.classList.remove("hidden");
  await loadEmployeeShiftCandidates();
}

function closeEmployeeShiftOverlay() {
  if (employeeShiftSubmitting) return;
  dom.employeeShiftOverlay?.classList.add("hidden");
}

function resetEmployeeShiftOverlayState() {
  employeeShiftSubmitting = false;
  employeeShiftCandidates = [];
  selectedEmployeeShiftUid = "";
  if (dom.employeeShiftEmployees) dom.employeeShiftEmployees.innerHTML = "";
  if (dom.employeeShiftCashInput) {
    dom.employeeShiftCashInput.value = "";
    dom.employeeShiftCashInput.disabled = true;
  }
  setEmployeeShiftFeedback("");
  updateEmployeeShiftConfirmState();
}

async function loadEmployeeShiftCandidates() {
  if (!dom.employeeShiftEmployees) return;
  const tenantId = String(currentUser?.tenantId || "").trim();
  if (!tenantId) {
    setEmployeeShiftFeedback("No se pudo resolver el tenant actual.");
    return;
  }

  dom.employeeShiftEmployees.innerHTML = '<span class="subtitle">Cargando empleados...</span>';
  try {
    const q = query(collection(firestoreDb, "empleados"), where("comercioId", "==", tenantId));
    const snap = await getDocs(q);
    const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    rows.sort((a, b) =>
      String(a.displayName || a.username || a.id || "").localeCompare(String(b.displayName || b.username || b.id || ""))
    );
    employeeShiftCandidates = rows;
    renderEmployeeShiftCandidates();
  } catch (error) {
    console.error("No se pudo cargar empleados para iniciar turno:", error);
    setEmployeeShiftFeedback("No se pudo cargar el listado de empleados.");
    dom.employeeShiftEmployees.innerHTML = "";
  }
}

function renderEmployeeShiftCandidates() {
  if (!dom.employeeShiftEmployees) return;
  if (!employeeShiftCandidates.length) {
    dom.employeeShiftEmployees.innerHTML = '<span class="subtitle">No hay empleados disponibles.</span>';
    return;
  }

  dom.employeeShiftEmployees.innerHTML = employeeShiftCandidates
    .map((employee) => {
      const uid = escapeHtml(employee.uid || employee.id || "");
      const label = escapeHtml(employee.displayName || employee.username || uid || "Empleado");
      const selectedClass = uid === selectedEmployeeShiftUid ? "is-selected" : "";
      return `<button type="button" class="shift-employee-btn ${selectedClass}" data-shift-employee-id="${uid}">${label}</button>`;
    })
    .join("");
}

function handleSelectEmployeeShiftCandidate(event) {
  const button = event.target.closest("[data-shift-employee-id]");
  if (!button) return;
  const uid = String(button.getAttribute("data-shift-employee-id") || "").trim();
  if (!uid) return;

  selectedEmployeeShiftUid = uid;
  if (dom.employeeShiftCashInput) {
    dom.employeeShiftCashInput.disabled = false;
    dom.employeeShiftCashInput.focus({ preventScroll: true });
  }
  renderEmployeeShiftCandidates();
  updateEmployeeShiftConfirmState();
}

function updateEmployeeShiftConfirmState() {
  if (!dom.employeeShiftConfirmBtn) return;
  const amountRaw = String(dom.employeeShiftCashInput?.value || "").trim();
  const amount = Number(amountRaw);
  const hasEmployee = Boolean(selectedEmployeeShiftUid);
  const hasValidAmount = amountRaw !== "" && Number.isFinite(amount) && amount >= 0;
  dom.employeeShiftConfirmBtn.disabled = employeeShiftSubmitting || !hasEmployee || !hasValidAmount;
}

function setEmployeeShiftFeedback(message, kind = "error") {
  if (!dom.employeeShiftFeedback) return;
  dom.employeeShiftFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.employeeShiftFeedback.textContent = String(message || "");
}

async function handleConfirmEmployeeShiftStart() {
  if (employeeShiftSubmitting) return;
  if (!selectedEmployeeShiftUid) {
    setEmployeeShiftFeedback("Debes seleccionar un empleado.");
    return;
  }

  const amount = Number(dom.employeeShiftCashInput?.value || 0);
  if (!Number.isFinite(amount) || amount < 0) {
    setEmployeeShiftFeedback("El inicio de caja es invalido.");
    return;
  }

  employeeShiftSubmitting = true;
  updateEmployeeShiftConfirmState();
  dom.employeeShiftConfirmBtn?.classList.add("btn-loading");
  dom.employeeShiftCancelBtn && (dom.employeeShiftCancelBtn.disabled = true);
  setEmployeeShiftFeedback("");

  try {
    const result = await startEmployeeShift({
      employeeUid: selectedEmployeeShiftUid,
      inicioCaja: amount
    });
    if (!result.ok) {
      setEmployeeShiftFeedback(result.error || "No se pudo iniciar el turno.");
      return;
    }

    const selectedEmployee = employeeShiftCandidates.find(
      (employee) => String(employee.uid || employee.id || "").trim() === selectedEmployeeShiftUid
    );
    const employeeName = String(selectedEmployee?.displayName || selectedEmployee?.username || "empleado");
    setCashFeedback(`Turno iniciado para ${employeeName}. Inicio de caja: $${Number(amount).toFixed(2)}.`, "success");
    closeEmployeeShiftOverlay();
    await refreshCashPanel();
  } finally {
    employeeShiftSubmitting = false;
    dom.employeeShiftConfirmBtn?.classList.remove("btn-loading");
    dom.employeeShiftCancelBtn && (dom.employeeShiftCancelBtn.disabled = false);
    updateEmployeeShiftConfirmState();
  }
}

async function handleConfirmSalePayment() {
  const payment = resolveSalePaymentPayload();
  if (!payment.ok) {
    if (dom.salePaymentFeedback) {
      dom.salePaymentFeedback.textContent = payment.error;
    }
    return;
  }
  if (dom.salePaymentFeedback) {
    dom.salePaymentFeedback.textContent = "";
  }

  salePaymentSubmitting = true;
  setSalePaymentActionsDisabled(true);
  dom.salePaymentProcessing?.classList.remove("hidden");

  const result = await chargeSale(currentSaleItems, payment.payload);
  if (!result.ok) {
    dom.salePaymentProcessing?.classList.add("hidden");
    setSalePaymentActionsDisabled(false);
    salePaymentSubmitting = false;
    if (dom.salePaymentFeedback) {
      dom.salePaymentFeedback.textContent = result.error;
    }
    if (String(result.error || "").trim().toLowerCase().includes("el empleador no inicio tu turno")) {
      window.alert("el empleador no inicio tu turno!");
    }
    if (result.requiresLogin) {
      redirectToLogin();
    }
    return;
  }

  currentSaleItems.length = 0;
  renderCurrentSale(currentSaleItems);
  const canViewSaleProfit = isEmployerRole(currentUser?.role);
  const checkoutMessage = canViewSaleProfit
    ? `Venta cobrada. Items: ${result.itemsCount}. Total: $${result.total.toFixed(2)}. Ganancia: $${result.profit.toFixed(2)}.`
    : `Venta cobrada. Items: ${result.itemsCount}. Total: $${result.total.toFixed(2)}.`;
  setScanFeedback(checkoutMessage, "success");
  dom.salePaymentProcessing?.classList.add("hidden");
  dom.salePaymentToast?.classList.remove("hidden");
  await refreshStock();
  await refreshCashPanel();
  window.setTimeout(() => {
    dom.salePaymentToast?.classList.add("hidden");
  
    salePaymentSubmitting = false;
      closeSalePaymentOverlay();
  }, 2400);
}

function setSalePaymentActionsDisabled(disabled) {
  dom.salePaymentCashBtn && (dom.salePaymentCashBtn.disabled = disabled);
  dom.salePaymentVirtualBtn && (dom.salePaymentVirtualBtn.disabled = disabled);
  dom.salePaymentMixedBtn && (dom.salePaymentMixedBtn.disabled = disabled);
  dom.salePaymentCashInput && (dom.salePaymentCashInput.disabled = disabled || salePaymentType !== "mixto");
  dom.salePaymentCancelBtn && (dom.salePaymentCancelBtn.disabled = disabled);
  dom.salePaymentConfirmBtn && (dom.salePaymentConfirmBtn.disabled = disabled);
}

function handleSalePaymentOverlayKeydown(event) {
  if (event.key !== "Escape") return;
  if (dom.salePaymentOverlay?.classList.contains("hidden")) return;
  event.preventDefault();
  closeSalePaymentOverlay();
}

function handleEmployeeShiftOverlayKeydown(event) {
  if (event.key !== "Escape") return;
  if (dom.employeeShiftOverlay?.classList.contains("hidden")) return;
  event.preventDefault();
  closeEmployeeShiftOverlay();
}

function getCurrentSaleTotal() {
  return round2(currentSaleItems.reduce((acc, item) => acc + Number(item?.subtotal || 0), 0));
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
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
  if (navigator.onLine) {
    await syncPendingSales();
  }
  const snapshot = await getCashSnapshotForToday();
  if (!snapshot.ok) {
    if (snapshot.requiresLogin) {
      redirectToLogin();
      return;
    }
    setCashFeedback(snapshot.error);
    return;
  }
  latestCashSnapshot = snapshot;
  renderCashSnapshot(snapshot);
}

function renderCashSnapshot(snapshot) {
  renderCashPrivacyToggle();
  renderCashScopeLabel(snapshot.scopeLabel);
  const canViewProfit = isEmployerRole(currentUser?.role);
  const maskProfit = canViewProfit && cashSensitiveMasked;
  const maskCost = canViewProfit && cashSensitiveMasked;
  renderCashSummary(snapshot.summary, { maskProfit, maskCost });
  renderCashSalesTable(snapshot.sales, { canViewProfit, maskProfit });
  renderCashClosureStatus(snapshot.todayClosure);
  renderCashClosuresTable(snapshot.recentClosures, { canViewProfit, maskProfit: !canViewProfit || maskProfit });
  renderCashSectionToggles();
  dom.closeShiftBtn.disabled = Number(snapshot.summary?.salesCount || 0) === 0;
}

function handleToggleCashPrivacy() {
  if (!isEmployerRole(currentUser?.role)) return;
  cashSensitiveMasked = !cashSensitiveMasked;
  renderCashPrivacyToggle();
  if (latestCashSnapshot) {
    renderCashSnapshot(latestCashSnapshot);
  }
}

function renderCashPrivacyToggle() {
  if (!dom.cashPrivacyToggle) return;
  const canViewProfit = isEmployerRole(currentUser?.role);
  dom.cashPrivacyToggle.classList.toggle("hidden", !canViewProfit);
  if (!canViewProfit) return;
  const icon = cashSensitiveMasked ? ICON_EYE_OFF_SVG : ICON_EYE_SVG;
  const label = cashSensitiveMasked ? "Mostrar ganancias" : "Ocultar ganancias";
  dom.cashPrivacyToggle.innerHTML = iconWithLabel(icon, label);
  dom.cashPrivacyToggle.setAttribute("title", label);
  dom.cashPrivacyToggle.setAttribute("aria-label", label);
  dom.cashPrivacyToggle.setAttribute("aria-pressed", String(!cashSensitiveMasked));
}

function handleToggleCashSalesSection() {
  cashSalesSectionVisible = !cashSalesSectionVisible;
  renderCashSectionToggles();
}

function handleToggleCashClosuresSection() {
  cashClosuresSectionVisible = !cashClosuresSectionVisible;
  renderCashSectionToggles();
}

function renderCashSectionToggles() {
  renderCashSectionToggleButton(dom.cashSalesToggleBtn, {
    sectionVisible: cashSalesSectionVisible,
    sectionLabel: "Ventas del dia"
  });
  dom.cashSalesTableWrap?.classList.toggle("hidden", !cashSalesSectionVisible);

  renderCashSectionToggleButton(dom.cashClosuresToggleBtn, {
    sectionVisible: cashClosuresSectionVisible,
    sectionLabel: "Historial de cierres"
  });
  dom.cashClosuresTableWrap?.classList.toggle("hidden", !cashClosuresSectionVisible);
}

function renderCashSectionToggleButton(button, { sectionVisible, sectionLabel }) {
  if (!button) return;
  const icon = sectionVisible ? ICON_EYE_SVG : ICON_EYE_OFF_SVG;
  const actionLabel = `${sectionVisible ? "Ocultar" : "Mostrar"} ${sectionLabel.toLowerCase()}`;
  button.innerHTML = iconWithLabel(icon, sectionLabel);
  button.setAttribute("title", actionLabel);
  button.setAttribute("aria-label", actionLabel);
  button.setAttribute("aria-pressed", String(sectionVisible));
}

async function handleCloseShift() {
  if (!isEmployerRole(currentUser?.role)) {
    setCashFeedback("Solo el empleador puede terminar turno de empleado.");
    return;
  }
  if (dom.closeShiftBtn) {
    dom.closeShiftBtn.disabled = true;
    dom.closeShiftBtn.classList.add("btn-loading");
  }
  try {
  if (!employeeShiftCandidates.length) {
    await loadEmployeeShiftCandidates();
  }
  if (!employeeShiftCandidates.length) {
    setCashFeedback("No hay empleados disponibles para cerrar turno.");
    return;
  }

  const options = employeeShiftCandidates
    .map((employee, index) => {
      const label = String(employee.displayName || employee.username || employee.uid || employee.id || "Empleado");
      const uid = String(employee.uid || employee.id || "").trim();
      return `${index + 1}. ${label} (${uid})`;
    })
    .join("\n");
  const pickedRaw = window.prompt(
    `Selecciona el numero de empleado para terminar turno:\n${options}`,
    "1"
  );
  if (pickedRaw === null) return;
  const pickedIndex = Math.trunc(Number(pickedRaw)) - 1;
  if (!Number.isFinite(pickedIndex) || pickedIndex < 0 || pickedIndex >= employeeShiftCandidates.length) {
    setCashFeedback("Seleccion de empleado invalida.");
    return;
  }
  const selectedEmployee = employeeShiftCandidates[pickedIndex];
  const selectedUid = String(selectedEmployee?.uid || selectedEmployee?.id || "").trim();
  if (!selectedUid) {
    setCashFeedback("No se pudo resolver el empleado seleccionado.");
    return;
  }

  const cierreRaw = window.prompt(
    "Ingresa monto de cierre de caja del empleado:",
    "0"
  );
  if (cierreRaw === null) return;
  const montoCierreCaja = Number(String(cierreRaw).replace(",", ".").trim());
  if (!Number.isFinite(montoCierreCaja) || montoCierreCaja < 0) {
    setCashFeedback("Monto de cierre invalido.");
    return;
  }

  const result = await endEmployeeShift({ employeeUid: selectedUid, montoCierreCaja });
  if (!result.ok) {
    setCashFeedback(result.error);
    return;
  }

  const employeeName = String(selectedEmployee?.displayName || selectedEmployee?.username || "empleado");
  setCashFeedback(
    `Turno de ${employeeName} finalizado. Monto de cierre: $${Number(montoCierreCaja).toFixed(2)}.`,
    "success"
  );
  await refreshCashPanel();
  } finally {
    if (dom.closeShiftBtn) {
      dom.closeShiftBtn.disabled = false;
      dom.closeShiftBtn.classList.remove("btn-loading");
    }
  }
}

async function handleCloseMySales() {
  if (dom.closeMySalesBtn) {
    dom.closeMySalesBtn.disabled = true;
    dom.closeMySalesBtn.classList.add("btn-loading");
  }
  try {
  if (!isEmployerRole(currentUser?.role)) return;
  const myPendingSales = (latestCashSnapshot?.sales || []).filter(
    (sale) => String(sale.userId || sale.usuarioUid || "") === String(currentUser?.userId || "")
  );
  const mySalesCount = myPendingSales.length;
  const myTotal = myPendingSales.reduce((acc, sale) => acc + Number(sale.total || 0), 0);

  const confirmed = window.confirm(
    mySalesCount > 0
      ? `Se cerraran solo tus ventas (${mySalesCount}) por $${myTotal.toFixed(2)}. Continuar?`
      : "No tienes ventas pendientes para cerrar. Continuar?"
  );
  if (!confirmed) return;

  const result = await closeTodayShift({ scope: "mine" });
  if (!result.ok) {
    if (result.requiresLogin) {
      redirectToLogin();
      return;
    }
    setCashFeedback(result.error);
    return;
  }

  setCashFeedback(
    `Tus ventas fueron cerradas. Total: $${Number(result.summary?.totalAmount || 0).toFixed(2)}.`,
    "success"
  );
  await refreshCashPanel();
  } finally {
    if (dom.closeMySalesBtn) {
      dom.closeMySalesBtn.disabled = false;
      dom.closeMySalesBtn.classList.remove("btn-loading");
    }
  }
}

async function handleRefreshCashClick() {
  if (!dom.refreshCashBtn) {
    await refreshCashPanel();
    return;
  }

  dom.refreshCashBtn.disabled = true;
  dom.refreshCashBtn.classList.add("btn-loading");
  try {
    await refreshCashPanel();
  } finally {
    dom.refreshCashBtn.disabled = false;
    dom.refreshCashBtn.classList.remove("btn-loading");
  }
}

function wireStockRowEvents() {
  const rows = document.querySelectorAll("[data-stock-row-id]");
  rows.forEach((row) => {
    row.addEventListener("click", () => {
      const productId = row.getAttribute("data-stock-row-id");
      selectedStockProductId = productId;
      const product = allStockProducts.find((item) => item.id === productId) || null;
      renderStockDetailWithEditorState(product);
    });
  });

  const buttons = document.querySelectorAll("[data-save-stock-id]");
  buttons.forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const productId = button.getAttribute("data-save-stock-id");
      const input = document.querySelector(`[data-stock-input-id="${productId}"]`);
      if (!input) return;
      await saveSingleStockChange(productId, input.value, { button, refreshAfter: true, showSuccessFeedback: true });
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
      const confirmed = window.confirm(`Eliminar ${label}? Esta accion no se puede deshacer.`);
      if (!confirmed) return;

      const originalLabel = button.innerHTML;
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
        button.innerHTML = originalLabel || iconWithLabel(ICON_TRASH_SVG, "Eliminar");
      }
    });
  });

  const inputs = document.querySelectorAll("[data-stock-input-id]");
  inputs.forEach((input) => {
    const productId = String(input.getAttribute("data-stock-input-id") || "").trim();
    if (productId) {
      syncPendingStockChangeState(productId, input.value);
      input.addEventListener("input", () => {
        syncPendingStockChangeState(productId, input.value);
      });
      input.addEventListener("change", () => {
        syncPendingStockChangeState(productId, input.value);
      });
    }
    input.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });
}

async function handleFloatingStockSaveClick() {
  if (stockBulkSaveInProgress) return;
  if (!canCurrentUserEditProducts()) return;

  const pendingIds = [...pendingStockChanges];
  if (pendingIds.length === 0) {
    setStockFeedback("No hay cambios de stock pendientes.", "success");
    updateStockBulkSaveButtonState();
    return;
  }

  stockBulkSaveInProgress = true;
  if (dom.floatingStockSaveBtn) {
    dom.floatingStockSaveBtn.disabled = true;
    dom.floatingStockSaveBtn.classList.add("btn-loading");
  }

  let savedCount = 0;
  let failedCount = 0;
  let firstError = "";

  try {
    for (const productId of pendingIds) {
      const rowButton = document.querySelector(`[data-save-stock-id="${productId}"]`);
      const rowInput = document.querySelector(`[data-stock-input-id="${productId}"]`);
      const stockValue = rowInput ? rowInput.value : pendingStockValues.get(productId);
      if (typeof stockValue === "undefined") {
        failedCount += 1;
        firstError = firstError || "No se encontro uno de los cambios pendientes.";
        continue;
      }

      const result = await saveSingleStockChange(productId, stockValue, {
        button: rowButton,
        refreshAfter: false,
        showSuccessFeedback: false
      });

      if (result.ok) {
        savedCount += 1;
        continue;
      }

      failedCount += 1;
      firstError = firstError || result.error || "No se pudo guardar un cambio de stock.";
    }

    if (savedCount > 0) {
      await refreshStock();
    } else {
      updateStockBulkSaveButtonState();
    }

    if (failedCount === 0) {
      setStockFeedback(`Se guardaron ${savedCount} cambio(s) de stock.`, "success");
      return;
    }
    if (savedCount > 0) {
      setStockFeedback(
        `Se guardaron ${savedCount} de ${savedCount + failedCount} cambio(s). ${firstError}`
      );
      return;
    }
    setStockFeedback(firstError || "No se pudieron guardar los cambios de stock.");
  } finally {
    stockBulkSaveInProgress = false;
    if (dom.floatingStockSaveBtn) {
      dom.floatingStockSaveBtn.classList.remove("btn-loading");
    }
    updateStockBulkSaveButtonState();
  }
}

async function saveSingleStockChange(
  productId,
  stockValue,
  { button = null, refreshAfter = true, showSuccessFeedback = true } = {}
) {
  const stopLoading = setStockSaveButtonLoading(button, true);
  try {
    const result = await updateProductStock(productId, stockValue);
    if (!result.ok) {
      if (showSuccessFeedback) {
        setStockFeedback(result.error);
      }
      if (result.requiresLogin) {
        redirectToLogin();
      }
      return result;
    }

    pendingStockChanges.delete(productId);
    pendingStockValues.delete(productId);
    if (showSuccessFeedback) {
      setStockFeedback(result.message, "success");
    }
    if (refreshAfter) {
      await refreshStock();
    } else {
      updateStockBulkSaveButtonState();
    }
    return result;
  } finally {
    stopLoading();
  }
}

function setStockSaveButtonLoading(button, isLoading) {
  if (!button) return () => {};
  if (isLoading) {
    button.disabled = true;
    button.classList.add("btn-loading");
    return () => {
      button.disabled = false;
      button.classList.remove("btn-loading");
    };
  }
  button.disabled = false;
  button.classList.remove("btn-loading");
  return () => {};
}

function syncPendingStockChangeState(productId, rawStockValue) {
  const source = allStockProducts.find((item) => item.id === productId);
  if (!source) return;

  const nextStock = Number(rawStockValue);
  const isValid = Number.isFinite(nextStock) && nextStock >= 0;
  const normalizedNextStock = isValid ? Math.trunc(nextStock) : NaN;
  const currentStock = Math.trunc(Number(source.stock || 0));
  const isDirty = !isValid || normalizedNextStock !== currentStock;

  if (isDirty) {
    pendingStockChanges.add(productId);
    pendingStockValues.set(productId, String(rawStockValue ?? ""));
  } else {
    pendingStockChanges.delete(productId);
    pendingStockValues.delete(productId);
  }

  const rowSaveBtn = document.querySelector(`[data-save-stock-id="${productId}"]`);
  rowSaveBtn?.classList.toggle("is-dirty", isDirty);
  updateStockBulkSaveButtonState();
}

function updateStockBulkSaveButtonState(explicitMode = "") {
  if (!dom.floatingStockSaveBtn) return;
  const currentMode = explicitMode || getCurrentMode();
  const canShow = canCurrentUserEditProducts() && currentMode === "stock";
  dom.floatingStockSaveBtn.classList.toggle("hidden", !canShow);
  if (!canShow) return;

  const pendingCount = pendingStockChanges.size;
  dom.floatingStockSaveBtn.disabled = stockBulkSaveInProgress || pendingCount === 0;
  dom.floatingStockSaveBtn.setAttribute(
    "title",
    pendingCount > 0
      ? `Guardar cambios de stock (${pendingCount} pendiente${pendingCount === 1 ? "" : "s"})`
      : "Guardar cambios de stock"
  );
}

function setupDeviceSpecificUI() {
  const showCameraControls = isMobileMode();
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
  showUiModeToast(nextMode === "mobile" ? "Modo celular activado" : "Modo PC activado");
  const currentMode = getCurrentMode();
  keyboardScanner.setEnabled(shouldEnableKeyboardScanner(currentMode));
  if (currentMode === "add") {
    focusBarcodeInputIfDesktop();
  }
}

function renderUiModeToggleLabel() {
  if (!dom.uiModeToggle) return;
  const icon = isMobileMode() ? ICON_DEVICE_PHONE_SVG : ICON_DEVICE_PC_SVG;
  const label = isMobileMode() ? "Modo: Celular" : "Modo: PC";
  dom.uiModeToggle.innerHTML = iconWithLabel(icon, label);
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
  return normalized === "empleador";
}

function canCurrentUserCreateProducts() {
  if (!currentUser) return false;
  if (isEmployerRole(currentUser.role)) return true;
  return currentUser.canCreateProducts === true || currentUser.puedeCrearProductos === true;
}

function canCurrentUserEditProducts() {
  if (!currentUser) return false;
  if (isEmployerRole(currentUser.role)) return true;
  return currentUser.canEditProducts === true || currentUser.puedeEditarProductos === true;
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

function showUiModeToast(message) {
  if (!dom.uiModeToast) return;
  dom.uiModeToast.textContent = message;
  dom.uiModeToast.classList.remove("hidden");
  dom.uiModeToast.classList.add("is-visible");
  if (uiModeToastTimer) {
    window.clearTimeout(uiModeToastTimer);
  }
  uiModeToastTimer = window.setTimeout(() => {
    dom.uiModeToast?.classList.remove("is-visible");
    window.setTimeout(() => {
      dom.uiModeToast?.classList.add("hidden");
    }, 220);
  }, 1700);
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
    dom.saleModeScannerSwitch.disabled = false;
  }
  document.body.classList.toggle("sell-manual-mode", !saleUseScannerMode);
  document.body.classList.toggle("sell-scanner-mode", saleUseScannerMode);
  const showSellCameraControls = isMobileMode() && !saleUseScannerMode;
  dom.startScanBtn?.classList.toggle("hidden", !showSellCameraControls);
  dom.stopScanBtn?.classList.toggle("hidden", !showSellCameraControls);
  dom.saleScannerReader?.classList.toggle("hidden", !showSellCameraControls);
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

function setOfflineSyncBannerState(state, customMessage = "") {
  if (!dom.offlineSyncBanner) return;
  dom.offlineSyncBanner.classList.remove("hidden", "is-offline", "is-syncing", "is-error");

  if (state === "syncing") {
    dom.offlineSyncBanner.classList.add("is-syncing");
    dom.offlineSyncBanner.textContent = customMessage || "Reconectando y sincronizando pendientes...";
    dom.offlineSyncBanner.disabled = true;
    return;
  }

  if (state === "error") {
    dom.offlineSyncBanner.classList.add("is-error");
    dom.offlineSyncBanner.textContent = customMessage || "No se pudo sincronizar. Click para reintentar.";
    dom.offlineSyncBanner.disabled = false;
    return;
  }

  dom.offlineSyncBanner.classList.add("is-offline");
  dom.offlineSyncBanner.textContent = customMessage || "Sin conexion. Click para reintentar sync.";
  dom.offlineSyncBanner.disabled = false;
}

function hideOfflineSyncBanner() {
  if (!dom.offlineSyncBanner) return;
  dom.offlineSyncBanner.classList.add("hidden");
  dom.offlineSyncBanner.disabled = true;
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


function iconWithLabel(iconSvg, label) {
  return `<span class="btn-icon" aria-hidden="true">${iconSvg}</span><span>${escapeHtml(label)}</span>`;
}

function iconOnly(iconSvg) {
  return `<span class="btn-icon" aria-hidden="true">${iconSvg}</span>`;
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

