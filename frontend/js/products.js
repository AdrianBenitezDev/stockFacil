import { getCurrentSession } from "./auth.js";
import { getProductById, getProductByKioscoAndBarcode, getProductsByKiosco, putProduct } from "./db.js";
import { syncProductToFirestore } from "./firebase_sync.js";
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

  if (session.role === "empleador") {
    if (providerCost === null || !Number.isFinite(providerCost) || providerCost < 0) {
      return { ok: false, error: "Debes cargar un valor de proveedor valido." };
    }
  }

  const exists = await getProductByKioscoAndBarcode(session.tenantId, barcode);
  if (exists) {
    return { ok: false, error: "Ese codigo de barras ya existe." };
  }

  const product = {
    id: crypto.randomUUID(),
    kioscoId: session.tenantId,
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
  };

  await putProduct(product);
  await syncProductToFirestore(product);

  return { ok: true, message: "Producto guardado correctamente." };
}

export async function listProductsForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return [];

  const products = await getProductsByKiosco(session.tenantId);
  return products.sort((a, b) => {
    const categoryCmp = String(a.category || "").localeCompare(String(b.category || ""));
    if (categoryCmp !== 0) return categoryCmp;
    const stockCmp = Number(a.stock || 0) - Number(b.stock || 0);
    if (stockCmp !== 0) return stockCmp;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

export async function findProductByBarcodeForCurrentKiosco(barcodeInput) {
  const session = getCurrentSession();
  if (!session) return null;

  const barcode = String(barcodeInput || "").trim();
  if (!barcode) return null;

  return getProductByKioscoAndBarcode(session.tenantId, barcode);
}

export async function updateProductStock(productId, newStockInput) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (session.role !== "empleador") {
    return { ok: false, error: "Solo el empleador puede editar stock." };
  }

  const newStock = Number(newStockInput);
  if (!Number.isFinite(newStock) || newStock < 0) {
    return { ok: false, error: "Stock invalido." };
  }

  const product = await getProductById(productId);
  if (!product || product.kioscoId !== session.tenantId) {
    return { ok: false, error: "Producto no encontrado." };
  }

  product.stock = Math.trunc(newStock);
  product.updatedAt = new Date().toISOString();
  product.updatedBy = session.userId;
  await putProduct(product);
  await syncProductToFirestore(product);

  return { ok: true, message: `Stock actualizado para ${product.name}.` };
}
