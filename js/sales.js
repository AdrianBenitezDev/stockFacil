import { getCurrentSession } from "./auth.js";
import { STORES } from "./config.js";
import { openDatabase } from "./db.js";

export async function chargeSale(cartItems) {
  const session = getCurrentSession();
  if (!session) {
    return { ok: false, error: "Sesion expirada. Inicia sesion nuevamente.", requiresLogin: true };
  }

  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return { ok: false, error: "No hay productos para cobrar." };
  }

  const db = await openDatabase();
  const now = new Date().toISOString();
  const saleId = crypto.randomUUID();
  const itemsCount = cartItems.reduce((acc, item) => acc + Number(item.quantity || 0), 0);
  const total = cartItems.reduce((acc, item) => acc + Number(item.subtotal || 0), 0);

  try {
    await runWriteTransaction(db, [STORES.products, STORES.sales, STORES.saleItems], async (tx) => {
      const productsStore = tx.objectStore(STORES.products);
      const salesStore = tx.objectStore(STORES.sales);
      const saleItemsStore = tx.objectStore(STORES.saleItems);

      for (const cartItem of cartItems) {
        const product = await reqToPromise(productsStore.get(cartItem.productId));
        if (!product || product.kioscoId !== session.kioscoId) {
          throw new Error(`Producto no disponible: ${cartItem.name}.`);
        }

        const requestedQty = Number(cartItem.quantity || 0);
        if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
          throw new Error(`Cantidad invalida para ${cartItem.name}.`);
        }

        if (Number(product.stock || 0) < requestedQty) {
          throw new Error(`Stock insuficiente para ${product.name}. Disponible: ${product.stock}.`);
        }

        product.stock = Number(product.stock || 0) - requestedQty;
        productsStore.put(product);

        saleItemsStore.put({
          id: crypto.randomUUID(),
          saleId,
          kioscoId: session.kioscoId,
          userId: session.userId,
          productId: product.id,
          barcode: product.barcode,
          name: product.name,
          quantity: requestedQty,
          unitPrice: Number(cartItem.price || 0),
          subtotal: Number(cartItem.subtotal || 0),
          createdAt: now
        });
      }

      salesStore.put({
        id: saleId,
        kioscoId: session.kioscoId,
        userId: session.userId,
        username: session.username,
        role: session.role,
        total: Number(total.toFixed(2)),
        itemsCount,
        createdAt: now
      });
    });
  } catch (error) {
    return { ok: false, error: error.message || "No se pudo cobrar la venta." };
  }

  return {
    ok: true,
    saleId,
    total: Number(total.toFixed(2)),
    itemsCount
  };
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Error de IndexedDB."));
  });
}

function runWriteTransaction(db, storeNames, executor) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    let settled = false;

    tx.oncomplete = () => {
      if (!settled) resolve();
    };
    tx.onerror = () => {
      if (!settled) reject(tx.error || new Error("No se pudo completar la transaccion."));
    };
    tx.onabort = () => {
      if (!settled) reject(tx.error || new Error("La transaccion fue cancelada."));
    };

    Promise.resolve()
      .then(() => executor(tx))
      .catch((error) => {
        settled = true;
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}
