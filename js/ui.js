import { dom } from "./dom.js";

export function showAppShell(user) {
  dom.sessionInfo.textContent = `${user.displayName} (${user.role}) - ${user.kioscoId}`;
  const isOwner = user.role === "dueno";
  dom.providerCostGroup.classList.toggle("hidden", !isOwner);
  dom.providerCostInput.required = isOwner;
  setMode("add");
}

export function setMode(mode) {
  dom.addProductPanel.classList.toggle("hidden", mode !== "add");
  dom.sellPanel.classList.toggle("hidden", mode !== "sell");
  dom.stockPanel.classList.toggle("hidden", mode !== "stock");
  dom.cashPanel.classList.toggle("hidden", mode !== "cash");
  dom.addModeBtn.classList.toggle("is-active", mode === "add");
  dom.sellModeBtn.classList.toggle("is-active", mode === "sell");
  dom.stockModeBtn.classList.toggle("is-active", mode === "stock");
  dom.cashModeBtn.classList.toggle("is-active", mode === "cash");
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

export function renderCategoryOptions(categories) {
  const options = [
    '<option value="">Selecciona una categoria</option>',
    ...categories.map((category) => `<option value="${category}">${category}</option>`)
  ];
  dom.productCategory.innerHTML = options.join("");
}

export function renderStockTable(products) {
  if (products.length === 0) {
    dom.stockTableBody.innerHTML = '<tr><td colspan="5">Sin productos cargados.</td></tr>';
    return;
  }

  dom.stockTableBody.innerHTML = products
    .map((product) => {
      return [
        "<tr>",
        `<td>${escapeHtml(product.barcode)}</td>`,
        `<td>${escapeHtml(product.name)}</td>`,
        `<td>${escapeHtml(product.category || "Sin categoria")}</td>`,
        `<td>$${Number(product.price || 0).toFixed(2)}</td>`,
        `<td>${Number(product.stock || 0)}</td>`,
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
    dom.saleTableBody.innerHTML = '<tr><td colspan="5">No hay productos escaneados.</td></tr>';
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

export function renderCashSummary(summary) {
  dom.cashSalesCount.textContent = String(summary.salesCount || 0);
  dom.cashItemsCount.textContent = String(summary.itemsCount || 0);
  dom.cashTotalAmount.textContent = `$${Number(summary.totalAmount || 0).toFixed(2)}`;
  dom.cashProfitAmount.textContent = `$${Number(summary.profitAmount || 0).toFixed(2)}`;
}

export function renderCashSalesTable(sales) {
  if (!sales || sales.length === 0) {
    dom.cashSalesTableBody.innerHTML = '<tr><td colspan="5">No hay ventas registradas hoy.</td></tr>';
    return;
  }

  dom.cashSalesTableBody.innerHTML = sales
    .map((sale) => {
      const time = formatTime(sale.createdAt);
      const username = escapeHtml(sale.username || "-");
      return [
        "<tr>",
        `<td>${time}</td>`,
        `<td>${username}</td>`,
        `<td>${Number(sale.itemsCount || 0)}</td>`,
        `<td>$${Number(sale.total || 0).toFixed(2)}</td>`,
        `<td>$${Number(sale.profit || 0).toFixed(2)}</td>`,
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

function formatTime(isoDate) {
  if (!isoDate) return "--:--";
  const date = new Date(isoDate);
  return date.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}
