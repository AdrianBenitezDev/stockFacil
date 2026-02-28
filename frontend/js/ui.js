import { dom } from "./dom.js";
const ICON_TRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
const ICON_REMOVE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
const ICON_WIFI_OFF_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 22 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-1.5"/><path d="M10.71 5.05A16 16 0 0 1 22 8.5"/><path d="M2 8.5a16 16 0 0 1 4.9-2.85"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><path d="M12 20h.01"/></svg>';
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
  const role = String(user.role || user.tipo || "").trim().toLowerCase();
  const isOwner = role === "empleador" || role === "dueno";
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


  dom.cashClosuresProfitPrecieBuy?.classList.toggle("hidden", !isOwner);
  dom.cashClosuresProfitDetalleBuy?.classList.toggle("hidden", !isOwner);
  
  dom.cashOwnerActions?.classList.toggle("hidden", !isOwner);
  dom.addModeBtn.disabled = !canCreateProducts;
  applyAddProductAvailability(canCreateProducts);
  setMode(canCreateProducts ? "add" : "sell");
}

export function setMode(mode) {
  document.body.classList.remove("mode-add", "mode-sell", "mode-stock", "mode-cash", "mode-config");
  document.body.classList.add(`mode-${mode}`);
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

export function renderStockTable(products, { canEditStock = false, canDeleteStock = false, canViewStock = true } = {}) {
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
            canDeleteStock
              ? `<button type="button" class="stock-delete-btn" data-delete-stock-id="${escapeHtml(
                  product.id
                )}">${iconWithLabel(ICON_TRASH_SVG, "Eliminar")}</button>`
              : "",
            "</div>"
          ].join("")
        : '<span class="subtitle">Solo empleador</span>';
      const stockValue = canViewStock ? String(stock) : "**";
      return [
        `<tr class="${stockClass}" data-stock-row-id="${escapeHtml(product.id)}">`,

        `<td>${escapeHtml(product.name)}</td>`,
        `<td>$${Number(product.price || 0).toFixed(2)}</td>`,
        canEditStock ? `<td>$${Number(product.providerCost || 0).toFixed(2)}</td>` : "",
        `<td>${stockValue}</td>`,
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
      const saleType = String(item?.saleType || "unidad").trim().toLowerCase();
      const quantityLabel =
        saleType === "gramos"
          ? `${Number(item?.quantityGrams || 0).toFixed(0)} g`
          : `${Number(item?.quantity || 0)}`;
      const quantityCell =
        saleType === "gramos"
          ? `<span class="sale-qty-value">${quantityLabel}</span>`
          : `<div class="sale-qty-controls"><button type="button" class="sale-qty-btn" data-sale-qty-minus-id="${escapeHtml(
              item.productId
            )}" aria-label="Restar cantidad de ${escapeHtml(item.name)}">-</button><span class="sale-qty-value">${quantityLabel}</span><button type="button" class="sale-qty-btn" data-sale-qty-plus-id="${escapeHtml(
              item.productId
            )}" aria-label="Sumar cantidad de ${escapeHtml(item.name)}">+</button></div>`;
      return [
        "<tr>",
        `<td>${escapeHtml(item.barcode)}</td>`,
        `<td>${escapeHtml(item.name)}</td>`,
        `<td>${quantityCell}</td>`,
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
  dom.cashItemsCount.textContent = `${Number(summary.itemsCount || 0)} productos vendidos`;
  dom.cashTotalAmount.textContent = `$${Number(summary.totalToDeliverAmount || summary.totalAmount || 0).toFixed(2)}`;
  if (dom.cashShiftStartAmount) {
    dom.cashShiftStartAmount.textContent = `=> $${Number(summary.startCashAmount || 0).toFixed(2)} inicio de caja`;
  }
  if (dom.cashDetailCashAmount) {
    dom.cashDetailCashAmount.textContent = `=> $${Number(summary.efectivoAmount || 0).toFixed(2)} efectivo`;
  }
  if (dom.cashDetailVirtualAmount) {
    dom.cashDetailVirtualAmount.textContent = `=> $${Number(summary.virtualAmount || 0).toFixed(2)} virtual`;
  }
  dom.cashTotalCost.textContent = maskCost ? "****" : `$${Number(summary.totalCost || 0).toFixed(2)}`;
  dom.cashProfitAmount.textContent = maskProfit
    ? "****"
    : `$${Number(summary.profitAmount || 0).toFixed(2)}`;
}

export function renderCashSalesTable(sales, { canViewProfit = true, maskProfit = false, canManageRecords = false } = {}) {
  const emptyColspan = canViewProfit ? 5 : 4;
  if (!sales || sales.length === 0) {
    dom.cashSalesTableBody.innerHTML = `<tr><td colspan="${emptyColspan}">No hay ventas registradas hoy.</td></tr>`;
    return;
  }

  const orderedSales = [...sales].sort((a, b) => getTimestampMs(b?.createdAt) - getTimestampMs(a?.createdAt));
  dom.cashSalesTableBody.innerHTML = orderedSales
    .map((sale) => {
      const time = formatTime(sale.createdAt);
      const username = escapeHtml(sale.username || "-");
      const rowToneClass = getEmployeeToneClass(sale.username);
      const saleId = escapeHtml(sale.id || "");
      const unsynced = sale.synced !== true;
      const syncBadge = unsynced
        ? `<span class="sync-state-badge unsynced" title="No sincronizado" aria-label="No sincronizado">${iconOnly(
            ICON_WIFI_OFF_SVG
          )}</span>`
        : "";
      const deleteAction = canManageRecords && saleId
        ? `<button type="button" class="cash-row-action-btn" data-delete-sale-id="${saleId}" data-sale-synced="${
            sale.synced === true ? "true" : "false"
          }" title="Eliminar venta" aria-label="Eliminar venta">${iconOnly(ICON_TRASH_SVG)}</button>`
        : "";
      return [
        `<tr class="${rowToneClass}">`,
        `<td>${syncBadge}${deleteAction}${time}</td>`,
        `<td>${username}</td>`,
        `<td>${Number(sale.itemsCount || 0)}</td>`,
        `<td>$${Number(sale.total || 0).toFixed(2)}</td>`,
          `<td class="cash-split-cash">$${Number(sale.pagoEfectivo || 0).toFixed(2)}</td>`,
            `<td class="cash-split-virtual">$${Number(sale.pagoVirtual || 0).toFixed(2)}</td>`,
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

export function renderStockDetail(product, { maskStock = false } = {}) {
  if (!product) {
    dom.stockDetailPanel.classList.add("hidden");
    return;
  }

  dom.stockDetailName.textContent = String(product.name || "-");
  dom.stockDetailBarcode.textContent = String(product.barcode || "-");
  dom.stockDetailCategory.textContent = String(product.category || "Sin categoria");
  dom.stockDetailPrice.textContent = `$${Number(product.price || 0).toFixed(2)}`;
  if (dom.stockDetailBuy) {
    dom.stockDetailBuy.textContent = `$${Number(product.providerCost || 0).toFixed(2)}`;
  }
  dom.stockDetailStock.textContent = maskStock ? "**" : String(Number(product.stock || 0));
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

export function renderCashClosuresTable(closures, { canViewProfit = true, maskProfit = false, canManageRecords = false } = {}) {
  const emptyColspan = canViewProfit ? 8 : 7;
  if (!closures || closures.length === 0) {
    dom.cashClosuresTableBody.innerHTML = `<tr><td colspan="${emptyColspan}">No hay cierres registrados.</td></tr>`;
    return;
  }

  const orderedClosures = [...closures].sort((a, b) => getTimestampMs(b?.createdAt) - getTimestampMs(a?.createdAt));
  dom.cashClosuresTableBody.innerHTML = orderedClosures
    .map((closure) => {
      const rowToneClass = getEmployeeToneClass(closure.username);
      const closureId = escapeHtml(closure.id || "");
      const unsynced = closure.synced !== true;
      const syncBadge = unsynced
        ? `<span class="sync-state-badge unsynced" title="No sincronizado" aria-label="No sincronizado">${iconOnly(
            ICON_WIFI_OFF_SVG
          )}</span>`
        : "";
      const deleteAction = canManageRecords && closureId
        ? `<button type="button" class="cash-row-action-btn" data-delete-closure-id="${closureId}" data-closure-synced="${
            closure.synced === true ? "true" : "false"
          }" title="Eliminar caja" aria-label="Eliminar caja">${iconOnly(ICON_TRASH_SVG)}</button>`
        : "";
      return [
        `<tr class="${rowToneClass}">`,
        `<td>${syncBadge}${deleteAction}${escapeHtml(closure.dateKey || "-")}</td>`,
        `<td>${escapeHtml(closure.username || "-")}</td>`,
        `<td>${Number(closure.salesCount || 0)}</td>`,
        `<td>$${Number(closure.totalAmount || 0).toFixed(2)}</td>`,
        `<td class="cash-split-cash">$${Number(closure.efectivoEntregar || 0).toFixed(2)}</td>`,
        `<td class="cash-split-virtual">$${Number(closure.virtualEntregar || 0).toFixed(2)}</td>`,
        `<td class="cash-split-start">$${Number(closure.inicioCaja || 0).toFixed(2)}</td>`,
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
  if (Number.isNaN(date.getTime())) return "--:--";
  return date
    .toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })
    .replace(" ", "");
}

function getTimestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 0;
  return parsed.getTime();
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
