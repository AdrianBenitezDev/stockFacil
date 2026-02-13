import { getCurrentSession } from "./auth.js";
import {
  getProductById,
  getProductByKioscoAndBarcode,
  getProductsByKiosco,
  getUnsyncedProductsByKiosco,
  markProductsAsSyncedByCodes,
  putProduct
} from "./db.js";
import { PRODUCT_CATEGORIES } from "./config.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

const SYNC_THRESHOLD = 30;
const functions = getFunctions(firebaseApp);
const syncProductsCallable = httpsCallable(functions, "syncProducts");

export async function createProduct(formData) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!isEmployerRole(session.role)) {
    return { ok: false, error: "Solo el empleador puede crear productos." };
  }

  const barcodeInput = String(formData.get("barcode") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const category = String(formData.get("category") || "").trim();
  const price = Number(formData.get("price"));
  const providerCostRaw = String(formData.get("providerCost") || "").trim();
  const providerCost = providerCostRaw === "" ? null : Number(providerCostRaw);
  const stock = Number(formData.get("stock"));

  if (!name) {
    return { ok: false, error: "Completa nombre del producto." };
  }

  if (!category || !PRODUCT_CATEGORIES.includes(category)) {
    return { ok: false, error: "Debes seleccionar una categoria valida." };
  }

  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0) {
    return { ok: false, error: "Precio y stock deben ser validos." };
  }

  if (providerCost === null || !Number.isFinite(providerCost) || providerCost < 0) {
    return { ok: false, error: "Debes cargar un valor de proveedor valido." };
  }

  const hasBarcode = Boolean(barcodeInput);
  const code = hasBarcode ? barcodeInput : `INT-${Date.now()}`;
  const exists = await getProductByKioscoAndBarcode(session.tenantId, code);
  if (exists) {
    return { ok: false, error: "Ese codigo de barras ya existe." };
  }

  const now = Date.now();
  const product = {
    id: crypto.randomUUID(),
    codigo: code,
    nombre: name,
    precioVenta: Number(price.toFixed(2)),
    precioCompra: Number(providerCost.toFixed(2)),
    categoria: category,
    stock: Math.trunc(stock),
    tieneCodigoBarras: hasBarcode,
    tenantId: session.tenantId,
    synced: false,
    createdAt: now,
    updatedAt: now,
    updatedBy: session.userId,
    kioscoId: session.tenantId,
    barcode: code,
    name,
    category,
    price: Number(price.toFixed(2)),
    providerCost: Number(providerCost.toFixed(2)),
    createdBy: session.userId,
    createdAtIso: new Date(now).toISOString()
  };

  await putProduct(product);

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  if (pending.length >= SYNC_THRESHOLD) {
    const syncResult = await syncPendingProducts({ force: true });
    if (syncResult.ok) {
      return {
        ok: true,
        message: `Producto guardado. Se sincronizaron ${syncResult.syncedCount} productos pendientes.`
      };
    }
    return {
      ok: true,
      message: `Producto guardado en local. Sync pendiente (${pending.length} sin sincronizar).`
    };
  }

  return {
    ok: true,
    message: `Producto guardado en local. Pendientes de sync: ${pending.length}.`
  };
}

export async function listProductsForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return [];

  const products = await getProductsByKiosco(session.tenantId);
  return products.map(normalizeProduct).sort((a, b) => {
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

  const product = await getProductByKioscoAndBarcode(session.tenantId, barcode);
  return product ? normalizeProduct(product) : null;
}

export async function updateProductStock(productId, newStockInput) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!isEmployerRole(session.role)) {
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

  const normalized = normalizeProduct(product);
  const now = Date.now();
  normalized.stock = Math.trunc(newStock);
  normalized.synced = false;
  normalized.updatedAt = now;
  normalized.updatedBy = session.userId;
  applyNormalizedToStoredProduct(product, normalized);

  await putProduct(product);

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  if (pending.length >= SYNC_THRESHOLD) {
    await syncPendingProducts({ force: true });
  }

  return { ok: true, message: `Stock actualizado para ${normalized.name}.` };
}

export async function syncPendingProducts({ force = false } = {}) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!isEmployerRole(session.role)) {
    return { ok: false, error: "Solo el empleador puede sincronizar productos." };
  }

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  if (pending.length === 0) {
    return { ok: true, syncedCount: 0, pendingCount: 0, message: "No hay productos pendientes para sincronizar." };
  }

  if (!force && pending.length < SYNC_THRESHOLD) {
    return {
      ok: true,
      syncedCount: 0,
      pendingCount: pending.length,
      message: `Todavia no se alcanza el umbral de ${SYNC_THRESHOLD} pendientes.`
    };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, error: "No hay sesion Firebase valida para sincronizar." };
  }

  const payload = pending.map((product) => {
    const normalized = normalizeProduct(product);
    return {
      codigo: normalized.codigo,
      nombre: normalized.nombre,
      precioVenta: Number(normalized.precioVenta || 0),
      precioCompra: Number(normalized.precioCompra || 0),
      categoria: normalized.categoria || null,
      stock: Number(normalized.stock || 0),
      tieneCodigoBarras: Boolean(normalized.tieneCodigoBarras),
      tenantId: session.tenantId,
      synced: false,
      createdAt: Number(normalized.createdAt || Date.now())
    };
  });

  try {
    const response = await syncProductsCallable({ products: payload });
    const syncedIds = Array.isArray(response?.data?.syncedIds) ? response.data.syncedIds : [];
    const updatedCount = await markProductsAsSyncedByCodes(session.tenantId, syncedIds);
    const pendingCount = Math.max(0, pending.length - updatedCount);
    return {
      ok: true,
      syncedCount: updatedCount,
      pendingCount,
      message: `Sincronizacion completa. Productos sincronizados: ${updatedCount}.`
    };
  } catch (error) {
    return { ok: false, error: mapCallableError(error) };
  }
}

export async function getPendingProductsCountForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return 0;
  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  return pending.length;
}

function normalizeProduct(product) {
  const code = String(product?.codigo || product?.barcode || "").trim();
  const name = String(product?.nombre || product?.name || "").trim();
  const category = String(product?.categoria || product?.category || "").trim();
  const salePrice = Number(product?.precioVenta ?? product?.price ?? 0);
  const purchasePrice = Number(product?.precioCompra ?? product?.providerCost ?? 0);
  const stock = Math.trunc(Number(product?.stock || 0));

  return {
    ...product,
    codigo: code,
    nombre: name,
    precioVenta: Number.isFinite(salePrice) ? Number(salePrice.toFixed(2)) : 0,
    precioCompra: Number.isFinite(purchasePrice) ? Number(purchasePrice.toFixed(2)) : 0,
    categoria: category,
    stock: Number.isFinite(stock) ? stock : 0,
    tieneCodigoBarras: Boolean(product?.tieneCodigoBarras ?? !String(code).startsWith("INT-")),
    tenantId: String(product?.tenantId || product?.kioscoId || "").trim(),
    synced: product?.synced === true,
    createdAt: Number(product?.createdAt || Date.now()),
    barcode: code,
    name,
    category,
    price: Number.isFinite(salePrice) ? Number(salePrice.toFixed(2)) : 0,
    providerCost: Number.isFinite(purchasePrice) ? Number(purchasePrice.toFixed(2)) : 0,
    kioscoId: String(product?.kioscoId || product?.tenantId || "").trim()
  };
}

function applyNormalizedToStoredProduct(target, normalized) {
  target.codigo = normalized.codigo;
  target.nombre = normalized.nombre;
  target.precioVenta = normalized.precioVenta;
  target.precioCompra = normalized.precioCompra;
  target.categoria = normalized.categoria;
  target.stock = normalized.stock;
  target.tieneCodigoBarras = normalized.tieneCodigoBarras;
  target.tenantId = normalized.tenantId;
  target.synced = normalized.synced;
  target.createdAt = normalized.createdAt;
  target.updatedAt = normalized.updatedAt || Date.now();
  target.updatedBy = normalized.updatedBy || null;
  target.barcode = normalized.barcode;
  target.name = normalized.name;
  target.category = normalized.category;
  target.price = normalized.price;
  target.providerCost = normalized.providerCost;
  target.kioscoId = normalized.kioscoId;
}

function mapCallableError(error) {
  const message = String(error?.message || "");
  if (message) return message;

  const code = String(error?.code || "");
  if (code.includes("unauthenticated")) {
    return "No hay sesion Firebase valida para sincronizar.";
  }
  if (code.includes("permission-denied")) {
    return "No tienes permisos para sincronizar productos.";
  }
  if (code.includes("invalid-argument")) {
    return "La carga de productos para sincronizar es invalida.";
  }
  return "No se pudo sincronizar productos con Firebase.";
}

function isEmployerRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized === "empleador" || normalized === "dueno";
}
