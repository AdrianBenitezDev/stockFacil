import { DB_NAME, DB_VERSION, STORES } from "./config.js";

let dbInstance = null;

export async function openDatabase() {
  if (dbInstance) return dbInstance;

  dbInstance = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains(STORES.users)) {
        const users = database.createObjectStore(STORES.users, { keyPath: "id" });
        users.createIndex("byKioscoUsername", ["kioscoId", "username"], { unique: true });
      } else {
        const users = request.transaction.objectStore(STORES.users);
        if (!users.indexNames.contains("byKioscoUsername")) {
          users.createIndex("byKioscoUsername", ["kioscoId", "username"], { unique: true });
        }
      }

      if (!database.objectStoreNames.contains(STORES.products)) {
        const products = database.createObjectStore(STORES.products, { keyPath: "id" });
        products.createIndex("byKioscoBarcode", ["kioscoId", "barcode"], { unique: true });
        products.createIndex("byKiosco", "kioscoId", { unique: false });
      } else {
        const products = request.transaction.objectStore(STORES.products);
        if (!products.indexNames.contains("byKioscoBarcode")) {
          products.createIndex("byKioscoBarcode", ["kioscoId", "barcode"], { unique: true });
        }
        if (!products.indexNames.contains("byKiosco")) {
          products.createIndex("byKiosco", "kioscoId", { unique: false });
        }
      }

      if (!database.objectStoreNames.contains(STORES.sales)) {
        const sales = database.createObjectStore(STORES.sales, { keyPath: "id" });
        sales.createIndex("byKioscoCreatedAt", ["kioscoId", "createdAt"], { unique: false });
        sales.createIndex("byKioscoUserCreatedAt", ["kioscoId", "userId", "createdAt"], { unique: false });
      } else {
        const sales = request.transaction.objectStore(STORES.sales);
        if (!sales.indexNames.contains("byKioscoCreatedAt")) {
          sales.createIndex("byKioscoCreatedAt", ["kioscoId", "createdAt"], { unique: false });
        }
        if (!sales.indexNames.contains("byKioscoUserCreatedAt")) {
          sales.createIndex("byKioscoUserCreatedAt", ["kioscoId", "userId", "createdAt"], { unique: false });
        }
      }

      if (!database.objectStoreNames.contains(STORES.saleItems)) {
        const saleItems = database.createObjectStore(STORES.saleItems, { keyPath: "id" });
        saleItems.createIndex("bySaleId", "saleId", { unique: false });
      } else {
        const saleItems = request.transaction.objectStore(STORES.saleItems);
        if (!saleItems.indexNames.contains("bySaleId")) {
          saleItems.createIndex("bySaleId", "saleId", { unique: false });
        }
      }

      if (!database.objectStoreNames.contains(STORES.cashClosures)) {
        const closures = database.createObjectStore(STORES.cashClosures, { keyPath: "id" });
        closures.createIndex("byClosureKey", "closureKey", { unique: true });
        closures.createIndex("byKioscoCreatedAt", ["kioscoId", "createdAt"], { unique: false });
      } else {
        const closures = request.transaction.objectStore(STORES.cashClosures);
        if (!closures.indexNames.contains("byClosureKey")) {
          closures.createIndex("byClosureKey", "closureKey", { unique: true });
        }
        if (!closures.indexNames.contains("byKioscoCreatedAt")) {
          closures.createIndex("byKioscoCreatedAt", ["kioscoId", "createdAt"], { unique: false });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbInstance;
}

export async function getAllUsers() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.users, "readonly");
    const request = tx.objectStore(STORES.users).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getUserByKioscoAndUsername(kioscoId, username) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.users, "readonly");
    const users = tx.objectStore(STORES.users);
    const request = users.index("byKioscoUsername").get([kioscoId, username]);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function putUser(user) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.users, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORES.users).put(user);
  });
}

export async function getProductByKioscoAndBarcode(kioscoId, barcode) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readonly");
    const products = tx.objectStore(STORES.products);
    const request = products.index("byKioscoBarcode").get([kioscoId, barcode]);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function putProduct(product) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORES.products).put(product);
  });
}

export async function getProductById(productId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readonly");
    const request = tx.objectStore(STORES.products).get(productId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteProductById(productId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORES.products).delete(productId);
  });
}

export async function getProductsByKiosco(kioscoId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readonly");
    const products = tx.objectStore(STORES.products);
    const request = products.index("byKiosco").getAll(kioscoId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getUnsyncedProductsByKiosco(kioscoId) {
  const products = await getProductsByKiosco(kioscoId);
  return products.filter((product) => product?.synced === false);
}

export async function markProductsAsSyncedByCodes(kioscoId, codes) {
  const normalizedCodes = Array.from(
    new Set((codes || []).map((value) => String(value || "").trim()).filter(Boolean))
  );
  if (normalizedCodes.length === 0) return 0;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.products, "readwrite");
    const store = tx.objectStore(STORES.products);
    const byKioscoBarcode = store.index("byKioscoBarcode");
    const now = Date.now();
    let updatedCount = 0;

    tx.oncomplete = () => resolve(updatedCount);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo actualizar sincronizacion local."));

    Promise.resolve()
      .then(async () => {
        for (const code of normalizedCodes) {
          const product = await reqToPromise(byKioscoBarcode.get([kioscoId, code]));
          if (!product) continue;
          product.synced = true;
          product.syncedAt = now;
          store.put(product);
          updatedCount += 1;
        }
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}

export async function getSalesByKioscoAndDateRange(kioscoId, startIso, endIso) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sales, "readonly");
    const sales = tx.objectStore(STORES.sales);
    const range = IDBKeyRange.bound([kioscoId, startIso], [kioscoId, endIso]);
    const request = sales.index("byKioscoCreatedAt").getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getSalesByKiosco(kioscoId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sales, "readonly");
    const request = tx.objectStore(STORES.sales).getAll();
    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? request.result : [];
      resolve(rows.filter((sale) => String(sale.kioscoId || "") === String(kioscoId || "")));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getSalesByKioscoUserAndDateRange(kioscoId, userId, startIso, endIso) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sales, "readonly");
    const sales = tx.objectStore(STORES.sales);
    const range = IDBKeyRange.bound([kioscoId, userId, startIso], [kioscoId, userId, endIso]);
    const request = sales.index("byKioscoUserCreatedAt").getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getUnsyncedSalesByKioscoAndUser(kioscoId, userId) {
  const sales = await getSalesByKiosco(kioscoId);
  return sales.filter(
    (sale) => String(sale.userId || "") === String(userId || "") && sale.synced !== true
  );
}

export async function getSaleItemsBySaleId(saleId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.saleItems, "readonly");
    const request = tx.objectStore(STORES.saleItems).index("bySaleId").getAll(saleId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function markSalesAsSyncedByIds(saleIds) {
  const ids = Array.from(new Set((saleIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (ids.length === 0) return 0;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sales, "readwrite");
    const store = tx.objectStore(STORES.sales);
    const now = new Date().toISOString();
    let updated = 0;

    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo marcar ventas sincronizadas."));

    Promise.resolve()
      .then(async () => {
        for (const id of ids) {
          const sale = await reqToPromise(store.get(id));
          if (!sale) continue;
          sale.synced = true;
          sale.backups = true;
          sale.syncedAt = now;
          store.put(sale);
          updated += 1;
        }
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}

export async function assignCashboxToSalesByIds(saleIds, cajaId) {
  const ids = Array.from(new Set((saleIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (ids.length === 0) return 0;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.sales, "readwrite");
    const store = tx.objectStore(STORES.sales);
    const now = new Date().toISOString();
    let updated = 0;

    tx.oncomplete = () => resolve(updated);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo actualizar caja en ventas locales."));

    Promise.resolve()
      .then(async () => {
        for (const id of ids) {
          const sale = await reqToPromise(store.get(id));
          if (!sale) continue;
          sale.cajaId = cajaId || null;
          sale.cajaCerrada = Boolean(cajaId);
          sale.cashClosedAt = now;
          store.put(sale);
          updated += 1;
        }
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}

export async function deleteSalesAndItemsBySaleIds(saleIds) {
  const ids = Array.from(new Set((saleIds || []).map((value) => String(value || "").trim()).filter(Boolean)));
  if (ids.length === 0) return 0;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.sales, STORES.saleItems], "readwrite");
    const salesStore = tx.objectStore(STORES.sales);
    const saleItemsStore = tx.objectStore(STORES.saleItems);
    const bySaleId = saleItemsStore.index("bySaleId");
    let deletedSales = 0;

    tx.oncomplete = () => resolve(deletedSales);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudieron eliminar ventas cerradas."));

    Promise.resolve()
      .then(async () => {
        for (const saleId of ids) {
          const existing = await reqToPromise(salesStore.get(saleId));
          if (existing) {
            salesStore.delete(saleId);
            deletedSales += 1;
          }

          const itemKeys = await reqToPromise(bySaleId.getAllKeys(saleId));
          for (const itemKey of itemKeys || []) {
            saleItemsStore.delete(itemKey);
          }
        }
      })
      .catch((error) => {
        try {
          tx.abort();
        } catch (_) {
          // no-op
        }
        reject(error);
      });
  });
}

export async function putCashClosure(closure) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.cashClosures, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORES.cashClosures).put(closure);
  });
}

export async function getCashClosureByKey(closureKey) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.cashClosures, "readonly");
    const closures = tx.objectStore(STORES.cashClosures);
    const request = closures.index("byClosureKey").get(closureKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function getCashClosuresByKioscoAndDateRange(kioscoId, startIso, endIso) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.cashClosures, "readonly");
    const closures = tx.objectStore(STORES.cashClosures);
    const range = IDBKeyRange.bound([kioscoId, startIso], [kioscoId, endIso]);
    const request = closures.index("byKioscoCreatedAt").getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCashClosureById(closureId) {
  const id = String(closureId || "").trim();
  if (!id) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.cashClosures, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo eliminar cierre local."));
    tx.objectStore(STORES.cashClosures).delete(id);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Error de IndexedDB."));
  });
}
