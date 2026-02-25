import { ensureCurrentUserProfile, getCurrentSession } from "./auth.js";
import {
  getProductById,
  getProductByKioscoAndBarcode,
  getProductsByKiosco,
  getUnsyncedProductsByKiosco,
  markProductsAsSyncedByCodes,
  deleteProductById,
  putProduct
} from "./db.js";
import { PRODUCT_CATEGORIES } from "./config.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firestoreDb } from "../config.js";

const SYNC_THRESHOLD = 30;
const functions = getFunctions(firebaseApp);
const syncProductsCallable = httpsCallable(functions, "syncProducts");
const deleteProductCallable = httpsCallable(functions, "deleteProductByCode");

export async function createProduct(formData) {
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok || !profileResult.user) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  const session = profileResult.user;
  if (!canCreateProducts(session)) {
    return { ok: false, error: "No tienes permisos para crear productos." };
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
  let exists = await getProductByKioscoAndBarcode(session.tenantId, code);
  if (exists?.pendingDelete === true) {
    await deleteProductById(exists.id);
    exists = null;
  }
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
  const immediateSync = await trySyncProductsNow(session, [normalizeProduct(product)]);
  if (immediateSync.ok) {
    return { ok: true, message: "Producto guardado y sincronizado correctamente." };
  }

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  return {
    ok: true,
    message: `Producto guardado en local por falta de sync online. Pendientes: ${pending.length}.`
  };
}

export async function listProductsForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return [];

  const products = await getProductsByKiosco(session.tenantId);
  return products
    .map(normalizeProduct)
    .filter((product) => product.pendingDelete !== true)
    .sort((a, b) => {
    const categoryCmp = String(a.category || "").localeCompare(String(b.category || ""));
    if (categoryCmp !== 0) return categoryCmp;
    const stockCmp = Number(a.stock || 0) - Number(b.stock || 0);
    if (stockCmp !== 0) return stockCmp;
    return String(a.name || "").localeCompare(String(b.name || ""));
    });
}

export async function syncProductsFromCloudForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return { ok: false, error: "Sesion expirada." };

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser || !navigator.onLine) {
    return { ok: true, syncedCount: 0, skipped: true };
  }

  try {
    const ref = collection(firestoreDb, "tenants", session.tenantId, "productos");
    const snap = await getDocs(ref);
    const remoteRows = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
    if (!remoteRows.length) {
      return { ok: true, syncedCount: 0 };
    }

    const localRows = await getProductsByKiosco(session.tenantId);
    const localByCode = new Map(
      localRows.map((row) => [String(row?.codigo || row?.barcode || "").trim(), row]).filter(([code]) => Boolean(code))
    );

    let syncedCount = 0;
    const now = Date.now();
    for (const remote of remoteRows) {
      const code = String(remote?.codigo || remote?.barcode || remote?.id || "").trim();
      if (!code) continue;

      const existing = localByCode.get(code);
      const next = normalizeProduct({
        ...(existing || {}),
        id: String(existing?.id || remote.id || crypto.randomUUID()),
        tenantId: session.tenantId,
        kioscoId: session.tenantId,
        codigo: code,
        barcode: code,
        nombre: String(remote?.nombre || remote?.name || existing?.nombre || existing?.name || "").trim(),
        name: String(remote?.nombre || remote?.name || existing?.nombre || existing?.name || "").trim(),
        categoria: String(remote?.categoria || remote?.category || existing?.categoria || existing?.category || "").trim(),
        category: String(remote?.categoria || remote?.category || existing?.categoria || existing?.category || "").trim(),
        precioVenta: Number(remote?.precioVenta ?? remote?.price ?? existing?.precioVenta ?? existing?.price ?? 0),
        price: Number(remote?.precioVenta ?? remote?.price ?? existing?.precioVenta ?? existing?.price ?? 0),
        precioCompra: Number(
          remote?.precioCompra ?? remote?.costoProveedor ?? remote?.providerCost ?? existing?.precioCompra ?? existing?.providerCost ?? 0
        ),
        providerCost: Number(
          remote?.precioCompra ?? remote?.costoProveedor ?? remote?.providerCost ?? existing?.precioCompra ?? existing?.providerCost ?? 0
        ),
        stock: Number(remote?.stock ?? existing?.stock ?? 0),
        tieneCodigoBarras: true,
        synced: true,
        syncedAt: now,
        updatedAt: now,
        createdAt: Number(existing?.createdAt || now)
      });

      applyNormalizedToStoredProduct(next, next);
      await putProduct(next);
      syncedCount += 1;
    }

    return { ok: true, syncedCount };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || "No se pudo traer productos desde el servidor.") };
  }
}

export async function findProductByBarcodeForCurrentKiosco(barcodeInput) {
  const session = getCurrentSession();
  if (!session) return null;

  const barcode = String(barcodeInput || "").trim();
  if (!barcode) return null;

  const product = await getProductByKioscoAndBarcode(session.tenantId, barcode);
  if (product?.pendingDelete === true) return null;
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
  const immediateSync = await trySyncProductsNow(session, [normalizeProduct(product)]);
  if (immediateSync.ok) {
    return { ok: true, message: `Stock actualizado y sincronizado para ${normalized.name}.` };
  }

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  return {
    ok: true,
    message: `Stock actualizado en local para ${normalized.name}. Pendientes de sync: ${pending.length}.`
  };
}

export async function updateProductDetails(productId, detailsInput) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!isEmployerRole(session.role)) {
    return { ok: false, error: "Solo el empleador puede editar productos." };
  }

  const nextName = String(detailsInput?.name || "").trim();
  const nextCategory = String(detailsInput?.category || "").trim();
  const nextStock = Number(detailsInput?.stock);
  const nextPrice = Number(detailsInput?.price);
  const nextProviderCost = Number(detailsInput?.providerCost);

  if (!nextName) {
    return { ok: false, error: "El nombre del producto es obligatorio." };
  }
  if (!nextCategory || !PRODUCT_CATEGORIES.includes(nextCategory)) {
    return { ok: false, error: "Debes seleccionar una categoria valida." };
  }
  if (!Number.isFinite(nextStock) || nextStock < 0) {
    return { ok: false, error: "Stock invalido." };
  }
  if (!Number.isFinite(nextPrice) || nextPrice < 0) {
    return { ok: false, error: "Precio de venta invalido." };
  }
  if (!Number.isFinite(nextProviderCost) || nextProviderCost < 0) {
    return { ok: false, error: "Precio de compra invalido." };
  }

  const product = await getProductById(productId);
  if (!product || product.kioscoId !== session.tenantId) {
    return { ok: false, error: "Producto no encontrado." };
  }

  const normalized = normalizeProduct(product);
  const now = Date.now();
  normalized.name = nextName;
  normalized.nombre = nextName;
  normalized.category = nextCategory;
  normalized.categoria = nextCategory;
  normalized.stock = Math.trunc(nextStock);
  normalized.price = Number(nextPrice.toFixed(2));
  normalized.precioVenta = Number(nextPrice.toFixed(2));
  normalized.providerCost = Number(nextProviderCost.toFixed(2));
  normalized.precioCompra = Number(nextProviderCost.toFixed(2));
  normalized.synced = false;
  normalized.updatedAt = now;
  normalized.updatedBy = session.userId;
  applyNormalizedToStoredProduct(product, normalized);

  await putProduct(product);
  const immediateSync = await trySyncProductsNow(session, [normalizeProduct(product)]);
  if (immediateSync.ok) {
    return { ok: true, message: `Producto ${normalized.name} actualizado y sincronizado.` };
  }

  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  return {
    ok: true,
    message: `Producto ${normalized.name} actualizado en local. Pendientes de sync: ${pending.length}.`
  };
}

export async function syncPendingProducts({ force = false } = {}) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!canCreateProducts(session)) {
    return { ok: false, error: "No tienes permisos para sincronizar productos." };
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
  if (!firebaseAuth.currentUser || !navigator.onLine) {
    return { ok: false, error: "No hay sesion valida para sincronizar." };
  }

  const pendingDeletes = pending.filter((product) => product?.pendingDelete === true);
  const pendingUpserts = pending.filter((product) => product?.pendingDelete !== true);
  let syncedDeletes = 0;
  let syncedUpserts = 0;
  let lastError = "";

  for (const product of pendingDeletes) {
    try {
      const normalized = normalizeProduct(product);
      await deleteProductCallable({ codigo: normalized.codigo });
      await deleteProductById(product.id);
      syncedDeletes += 1;
    } catch (error) {
      lastError = mapCallableError(error);
    }
  }

  const payload = pendingUpserts.map((product) => {
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

  if (payload.length > 0) {
    try {
      const response = await syncProductsCallable({ products: payload });
      const syncedIds = Array.isArray(response?.data?.syncedIds) ? response.data.syncedIds : [];
      syncedUpserts = await markProductsAsSyncedByCodes(session.tenantId, syncedIds);
    } catch (error) {
      lastError = mapCallableError(error);
    }
  }

  const syncedCount = syncedDeletes + syncedUpserts;
  const pendingCount = (await getUnsyncedProductsByKiosco(session.tenantId)).length;
  if (syncedCount === 0 && lastError) {
    return { ok: false, error: lastError };
  }
  return {
    ok: true,
    syncedCount,
    pendingCount,
    message: `Sincronizacion productos: ${syncedUpserts} actualizados, ${syncedDeletes} eliminados.`
  };
}

export async function getPendingProductsCountForCurrentKiosco() {
  const session = getCurrentSession();
  if (!session) return 0;
  const pending = await getUnsyncedProductsByKiosco(session.tenantId);
  return pending.length;
}

export async function deleteProduct(productId) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }
  if (!isEmployerRole(session.role)) {
    return { ok: false, error: "Solo el empleador puede eliminar productos." };
  }

  const stored = await getProductById(productId);
  if (!stored || String(stored.kioscoId || stored.tenantId || "") !== session.tenantId) {
    return { ok: false, error: "Producto no encontrado." };
  }

  const normalized = normalizeProduct(stored);
  const onlineReady = await canUseCloudNow();
  if (onlineReady) {
    try {
      await deleteProductCallable({ codigo: normalized.codigo });
      await deleteProductById(productId);
      return { ok: true, message: `Producto ${normalized.name} eliminado y sincronizado.` };
    } catch (error) {
      await markProductPendingDelete(stored, session.userId);
      return {
        ok: true,
        localDeleted: true,
        message: `Producto ocultado en local. Pendiente de eliminacion: ${mapCallableError(error)}`
      };
    }
  }

  await markProductPendingDelete(stored, session.userId);
  return {
    ok: true,
    localDeleted: true,
    message: "Producto ocultado en local sin conexion. Se eliminara al reconectar."
  };
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
    pendingDelete: product?.pendingDelete === true,
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
  target.pendingDelete = normalized.pendingDelete === true;
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
    return "No hay sesion valida para sincronizar.";
  }
  if (code.includes("permission-denied")) {
    return "No tienes permisos para sincronizar productos.";
  }
  if (code.includes("invalid-argument")) {
    return "La carga de productos para sincronizar es invalida.";
  }
  return "No se pudo sincronizar productos.";
}

function isEmployerRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized === "empleador";
}

function canCreateProducts(session) {
  if (!session) return false;
  if (isEmployerRole(session.role)) return true;
  return session.canCreateProducts === true || session.puedeCrearProductos === true;
}

async function canUseCloudNow() {
  await ensureFirebaseAuth();
  return Boolean(firebaseAuth.currentUser) && navigator.onLine;
}

async function markProductPendingDelete(stored, userId) {
  const next = normalizeProduct(stored);
  next.pendingDelete = true;
  next.synced = false;
  next.updatedBy = userId || null;
  next.updatedAt = Date.now();
  applyNormalizedToStoredProduct(stored, next);
  await putProduct(stored);
}

async function trySyncProductsNow(session, products) {
  const onlineReady = await canUseCloudNow();
  if (!onlineReady) return { ok: false, reason: "offline" };

  const payload = (products || []).map((product) => {
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
    await markProductsAsSyncedByCodes(session.tenantId, syncedIds);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: mapCallableError(error) };
  }
}
