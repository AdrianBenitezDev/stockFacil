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
