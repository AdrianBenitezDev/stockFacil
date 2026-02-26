const { onRequest, adminAuth, db } = require("./shared/context");

const ADMIN_EMAIL = "artbenitezdev@gmail.com";
const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminManageProducts = onRequest(async (req, res) => {
  if (!setCors(req, res)) {
    res.status(403).json({ ok: false, error: "Origen no permitido." });
    return;
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    await assertAdminRequest(req);

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Metodo no permitido." });
      return;
    }

    const tenantId = String(req.query?.tenantId || "").trim();
    const q = String(req.query?.q || "").trim();
    const limit = resolveLimit(req.query?.limit);

    if (!tenantId) {
      throw { status: 400, message: "Debes enviar tenantId." };
    }

    const products = await loadProducts({ tenantId, q, limit });
    res.status(200).json({ ok: true, tenantId, total: products.length, products });
  } catch (error) {
    console.error("adminManageProducts fallo:", error);
    res.status(Number(error?.status || 500)).json({
      ok: false,
      error: String(error?.message || "Error interno.")
    });
  }
});

async function assertAdminRequest(req) {
  const token = getBearerToken(req);
  if (!token) {
    throw { status: 401, message: "Falta token de autenticacion." };
  }

  const decoded = await adminAuth.verifyIdToken(token);
  const email = String(decoded?.email || "").trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) {
    throw { status: 403, message: "Acceso denegado." };
  }
}

async function loadProducts({ tenantId, q, limit }) {
  const productsRef = db.collection("tenants").doc(tenantId).collection("productos");
  const snap = await productsRef.limit(limit).get();

  let rows = snap.docs.map((docSnap) => normalizeProduct({ id: docSnap.id, ...(docSnap.data() || {}) }));
  if (q) {
    const query = normalizeText(q);
    rows = rows.filter((row) =>
      normalizeText([row.codigo, row.nombre, row.categoria].join(" ")).includes(query)
    );
  }

  rows.sort((a, b) => {
    const byCategory = String(a.categoria || "").localeCompare(String(b.categoria || ""));
    if (byCategory !== 0) return byCategory;
    return String(a.nombre || "").localeCompare(String(b.nombre || ""));
  });

  return rows;
}

function normalizeProduct(input) {
  const row = input || {};
  return {
    id: String(row.id || "").trim(),
    codigo: String(row.codigo || row.barcode || row.id || "").trim(),
    nombre: String(row.nombre || row.name || "").trim(),
    categoria: String(row.categoria || row.category || "").trim(),
    stock: toNumberOrZero(row.stock),
    precioVenta: toNumberOrZero(row.precioVenta ?? row.price),
    precioCompra: toNumberOrZero(row.precioCompra ?? row.providerCost ?? row.costoProveedor),
    tenantId: String(row.tenantId || row.kioscoId || "").trim()
  };
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function resolveLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1000;
  return Math.min(Math.trunc(parsed), 2000);
}

function setCors(req, res) {
  const origin = String(req.headers?.origin || "").trim();
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return false;
  }
  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return true;
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

module.exports = {
  adminManageProducts
};
