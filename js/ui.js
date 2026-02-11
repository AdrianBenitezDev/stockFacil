import { dom } from "./dom.js";

export function showAppShell(user) {
  dom.sessionInfo.textContent = `${user.displayName} (${user.role}) - ${user.kioscoId}`;
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
