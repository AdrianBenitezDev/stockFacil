import { dom } from "./dom.js";
const ICON_TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const ICON_REMOVE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
const EMPLOYEE_TONE_CLASSES = [
  "employee-tone-1",
  "employee-tone-2",
  "employee-tone-3",
  "employee-tone-4",
  "employee-tone-5"
];
const employeeToneByKey = new Map();
let nextEmployeeToneIndex = 0;

export function showAppShell(user) {
  const role = String(user.role || "").trim().toLowerCase();
  const isOwner = role === "empleador";
  const planLabel = String(user.planActual || "prueba").toUpperCase();
  dom.sessionInfo.textContent = `${user.displayName} (${user.role})`;
  dom.sessionEmail.textContent = user.email ? `${user.email}` : "****";
  dom.sessionPlan.textContent = planLabel;
  const canCreateProducts = isOwner || user?.canCreateProducts === true || user?.puedeCrearProductos === true;
  dom.providerCostGroup.classList.toggle("hidden", !canCreateProducts);
  dom.providerCostInput.required = canCreateProducts;
  dom.employeeAdminPanel.classList.toggle("hidden", !isOwner);
  dom.configModeBtn.classList.toggle("hidden", !isOwner);
  dom.cashCardCost?.classList.toggle("hidden", !isOwner);
  dom.cashCardProfit?.classList.toggle("hidden", !isOwner);
  dom.cashSummary?.classList.toggle("cash-summary-limited", !isOwner);
  dom.cashSalesProfitCol?.classList.toggle("hidden", !isOwner);
  dom.cashClosuresProfitCol?.classList.toggle("hidden", !isOwner);
  dom.closeMySalesBtn?.classList.toggle("hidden", !isOwner);
  dom.addModeBtn.disabled = !canCreateProducts;
  applyAddProductAvailability(canCreateProducts);
  setMode(canCreateProducts ? "add" : "sell");
}

export function setMode(mode) {
  dom.addProductPanel.classList.toggle("hidden", mode !== "add");
  dom.sellPanel.classList.toggle("hidden", mode !== "sell");
  dom.stockPanel.classList.toggle("hidden", mode !== "stock");
  dom.cashPanel.classList.toggle("hidden", mode !== "cash");
  dom.configPanel.classList.toggle("hidden", mode !== "config");
  dom.addModeBtn.classList.toggle("is-active", mode === "add");
  dom.sellModeBtn.classList.toggle("is-active", mode === "sell");
  dom.stockModeBtn.classList.toggle("is-active", mode === "stock");
  dom.cashModeBtn.classList.toggle("is-active", mode === "cash");
  dom.configModeBtn.classList.toggle("is-active", mode === "config");
}

export function setProductFeedbackError(message) {
  dom.productFeedback.style.color = "var(--danger)";
  dom.productFeedback.textContent = message;
}

export function setProductFeedbackSuccess(message) {
  dom.productFeedback.style.color = "var(--accent)";
  dom.productFeedback.textContent = message;
}

export function clearProductFeedback() {
  dom.productFeedback.style.color = "var(--danger)";
  dom.productFeedback.textContent = "";
}

export function setEmployeeFeedback(message, kind = "error") {
  dom.employeeFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.employeeFeedback.textContent = message;
}

export function clearEmployeeFeedback() {
  dom.employeeFeedback.style.color = "var(--danger)";
  dom.employeeFeedback.textContent = "";
}

export function renderCategoryOptions(categories) {
  const options = [
    '<option value="">Selecciona una categoria</option>',
    ...categories.map((category) => `<option value="${category}">${category}</option>`)
  ];
  dom.productCategory.innerHTML = options.join("");
}

export function renderStockCategoryOptions(categories) {
  const options = [
    '<option value="">Todas las categorias</option>',
    ...categories.map((category) => `<option value="${category}">${category}</option>`)
  ];
  dom.stockCategoryFilter.innerHTML = options.join("");
}

export function renderStockTable(products, { canEditStock = false } = {}) {
  if (products.length === 0) {
    dom.stockTableBody.innerHTML = '<tr><td colspan="4">Sin productos cargados.</td></tr>';
    return;
  }

  dom.stockTableBody.innerHTML = products
    .map((product) => {
      const stock = Number(product.stock || 0);
      const stockClass = stock <= 0 ? "stock-danger" : stock < 10 ? "stock-warning" : "";
      const editCell = canEditStock
        ? [
            '<div class="stock-edit-cell">',
            `<input class="stock-edit-input" type="number" min="0" step="1" value="${stock}" data-stock-input-id="${escapeHtml(
              product.id
            )}">`,
            `<button type="button" class="stock-save-btn" data-save-stock-id="${escapeHtml(
              product.id
            )}">Guardar</button>`,
            `<button type="button" class="stock-delete-btn" data-delete-stock-id="${escapeHtml(
              product.id
            )}">${iconWithLabel(ICON_TRASH_SVG, "Eliminar")}</button>`,
            "</div>"
          ].join("")
        : '<span class="subtitle">Solo empleador</span>';

      return [
        `<tr data-stock-row-id="${escapeHtml(product.id)}">`,
        `<td>${escapeHtml(product.name)}</td>`,
        `<td>$${Number(product.price || 0).toFixed(2)}</td>`,
        `<td><span class="${stockClass}">${stock}</span></td>`,
        `<td>${editCell}</td>`,
        "</tr>"
      ].join("");
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function setScanFeedback(message, kind = "error") {
  dom.scanFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.scanFeedback.textContent = message;
}

export function clearScanFeedback() {
  dom.scanFeedback.style.color = "var(--danger)";
  dom.scanFeedback.textContent = "";
}

export function setAddScanFeedback(message, kind = "error") {
  dom.addScanFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.addScanFeedback.textContent = message;
}

export function clearAddScanFeedback() {
  dom.addScanFeedback.style.color = "var(--danger)";
  dom.addScanFeedback.textContent = "";
}

export function renderCurrentSale(items) {
  if (items.length === 0) {
    dom.saleTableBody.innerHTML = '<tr><td colspan="6">No hay productos escaneados.</td></tr>';
    dom.saleTotal.textContent = "$0.00";
    return;
  }

  dom.saleTableBody.innerHTML = items
    .map((item) => {
      return [
        "<tr>",
        `<td>${escapeHtml(item.barcode)}</td>`,
        `<td>${escapeHtml(item.name)}</td>`,
        `<td>${item.quantity}</td>`,
        `<td>$${item.price.toFixed(2)}</td>`,
        `<td>$${item.subtotal.toFixed(2)}</td>`,
        `<td><button type="button" class="sale-remove-btn" data-remove-sale-id="${escapeHtml(
          item.productId
        )}" aria-label="Quitar ${escapeHtml(item.name)}">${iconOnly(ICON_REMOVE_SVG)}</button></td>`,
        "</tr>"
      ].join("");
    })
    .join("");

  const total = items.reduce((acc, item) => acc + item.subtotal, 0);
  dom.saleTotal.textContent = `$${total.toFixed(2)}`;
}

export function renderCashScopeLabel(label) {
  dom.cashScopeLabel.textContent = label;
}

export function renderCashSummary(summary, { maskProfit = false, maskCost = false } = {}) {
  dom.cashSalesCount.textContent = String(summary.salesCount || 0);
  dom.cashItemsCount.textContent = String(summary.itemsCount || 0);
  dom.cashTotalAmount.textContent = `$${Number(summary.totalAmount || 0).toFixed(2)}`;
  dom.cashTotalCost.textContent = maskCost ? "****" : `$${Number(summary.totalCost || 0).toFixed(2)}`;
  dom.cashProfitAmount.textContent = maskProfit
    ? "****"
    : `$${Number(summary.profitAmount || 0).toFixed(2)}`;
}

export function renderCashSalesTable(sales, { canViewProfit = true, maskProfit = false } = {}) {
  const emptyColspan = canViewProfit ? 5 : 4;
  if (!sales || sales.length === 0) {
    dom.cashSalesTableBody.innerHTML = `<tr><td colspan="${emptyColspan}">No hay ventas registradas hoy.</td></tr>`;
    return;
  }

  dom.cashSalesTableBody.innerHTML = sales
    .map((sale) => {
      const time = formatTime(sale.createdAt);
      const username = escapeHtml(sale.username || "-");
      const rowToneClass = getEmployeeToneClass(sale.username);
      return [
        `<tr class="${rowToneClass}">`,
        `<td>${time}</td>`,
        `<td>${username}</td>`,
        `<td>${Number(sale.itemsCount || 0)}</td>`,
        `<td>$${Number(sale.total || 0).toFixed(2)}</td>`,
        ...(canViewProfit
          ? [`<td>${maskProfit ? "****" : `$${Number(sale.profit || 0).toFixed(2)}`}</td>`]
          : []),
        "</tr>"
      ].join("");
    })
    .join("");
}

export function setCashFeedback(message, kind = "error") {
  dom.cashFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.cashFeedback.textContent = message;
}

export function clearCashFeedback() {
  dom.cashFeedback.style.color = "var(--danger)";
  dom.cashFeedback.textContent = "";
}

export function setStockFeedback(message, kind = "error") {
  dom.stockFeedback.style.color = kind === "success" ? "var(--accent)" : "var(--danger)";
  dom.stockFeedback.textContent = message;
}

export function clearStockFeedback() {
  dom.stockFeedback.style.color = "var(--danger)";
  dom.stockFeedback.textContent = "";
}

export function renderStockDetail(product) {
  if (!product) {
    dom.stockDetailPanel.classList.add("hidden");
    return;
  }

  dom.stockDetailName.textContent = String(product.name || "-");
  dom.stockDetailBarcode.textContent = String(product.barcode || "-");
  dom.stockDetailCategory.textContent = String(product.category || "Sin categoria");
  dom.stockDetailPrice.textContent = `$${Number(product.price || 0).toFixed(2)}`;
  dom.stockDetailStock.textContent = String(Number(product.stock || 0));
  dom.stockDetailPanel.classList.remove("hidden");
}

export function renderCashClosureStatus(todayClosure) {
  if (!todayClosure) {
    dom.cashClosureStatus.textContent = "Turno abierto: aun no se registro cierre hoy.";
    return;
  }

  const time = formatTime(todayClosure.createdAt);
  dom.cashClosureStatus.textContent =
    `Turno cerrado hoy a las ${time}. Monto: $${Number(todayClosure.totalAmount || 0).toFixed(2)}.`;
}

export function renderCashClosuresTable(closures, { canViewProfit = true, maskProfit = false } = {}) {
  const emptyColspan = canViewProfit ? 5 : 4;
  if (!closures || closures.length === 0) {
    dom.cashClosuresTableBody.innerHTML = `<tr><td colspan="${emptyColspan}">No hay cierres registrados.</td></tr>`;
    return;
  }

  dom.cashClosuresTableBody.innerHTML = closures
    .map((closure) => {
      const rowToneClass = getEmployeeToneClass(closure.username);
      return [
        `<tr class="${rowToneClass}">`,
        `<td>${escapeHtml(closure.dateKey || "-")}</td>`,
        `<td>${escapeHtml(closure.username || "-")}</td>`,
        `<td>${Number(closure.salesCount || 0)}</td>`,
        `<td>$${Number(closure.totalAmount || 0).toFixed(2)}</td>`,
        ...(canViewProfit
          ? [`<td>${maskProfit ? "****" : `$${Number(closure.profitAmount || 0).toFixed(2)}`}</td>`]
          : []),
        "</tr>"
      ].join("");
    })
    .join("");
}

function getEmployeeToneClass(username) {
  const key = String(username || "").trim().toLowerCase();
  if (!key) return "";
  const existing = employeeToneByKey.get(key);
  if (existing) return existing;
  const tone = EMPLOYEE_TONE_CLASSES[nextEmployeeToneIndex % EMPLOYEE_TONE_CLASSES.length];
  nextEmployeeToneIndex += 1;
  employeeToneByKey.set(key, tone);
  return tone;
}


function iconWithLabel(iconSvg, label) {
  return `<span class="btn-icon" aria-hidden="true">${iconSvg}</span><span>${escapeHtml(label)}</span>`;
}

function iconOnly(iconSvg) {
  return `<span class="btn-icon" aria-hidden="true">${iconSvg}</span>`;
}
function formatTime(isoDate) {
  if (!isoDate) return "--:--";
  const date = new Date(isoDate);
  return date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

function applyAddProductAvailability(enabled) {
  const controls = dom.addProductForm?.querySelectorAll("input, select, button") || [];
  controls.forEach((control) => {
    control.disabled = !enabled;
  });
  if (!enabled) {
    setProductFeedbackError("No tienes permiso para crear productos.");
    return;
  }
  clearProductFeedback();
}

