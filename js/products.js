import { getCurrentSession } from "./auth.js";
import { getProductByKioscoAndBarcode, getProductsByKiosco, putProduct } from "./db.js";
import { PRODUCT_CATEGORIES } from "./config.js";

export async function createProduct(formData) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  const barcode = String(formData.get("barcode") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const price = Number(formData.get("price"));
  const providerCostRaw = String(formData.get("providerCost") || "").trim();
  const providerCost = providerCostRaw === "" ? null : Number(providerCostRaw);
  const stock = Number(formData.get("stock"));

  if (!barcode || !name) {
    return { ok: false, error: "Completa codigo de barras y nombre." };
  }

  if (!category || !PRODUCT_CATEGORIES.includes(category)) {
    return { ok: false, error: "Debes seleccionar una categoria valida." };
  }

  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
    return { ok: false, error: "Precio y stock deben ser validos." };
  }

  if (session.role === "dueno") {
    if (providerCost === null || !Number.isFinite(providerCost) || providerCost < 0) {
      return { ok: false, error: "Debes cargar un valor de proveedor valido." };
    }
  }

  const exists = await getProductByKioscoAndBarcode(session.kioscoId, barcode);
  if (exists) {
    return { ok: false, error: "Ese codigo de barras ya existe." };
  }

  await putProduct({
    id: crypto.randomUUID(),
    kioscoId: session.kioscoId,
    barcode,
    name,
    category,
    price: Number(price.toFixed(2)),
    providerCost:
      providerCost === null || !Number.isFinite(providerCost)
        ? null
        : Number(providerCost.toFixed(2)),
    stock: Math.trunc(stock),
    createdBy: session.userId,
    createdAt: new Date().toISOString()
  });

  return { ok: true, message: "Producto guardado correctamente." };
}

export async function listProductsForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return [];

  const products = await getProductsByKiosco(session.kioscoId);
  return products.sort((a, b) => a.name.localeCompare(b.name));
}

export async function findProductByBarcodeForCurrentKiosco(barcodeInput) {
  const session = getCurrentSession();
  if (!session) return null;

  const barcode = String(barcodeInput || "").trim();
  if (!barcode) return null;

  return getProductByKioscoAndBarcode(session.kioscoId, barcode);
}
