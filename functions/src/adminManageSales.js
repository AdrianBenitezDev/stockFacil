const { onRequest, adminAuth, db } = require("./shared/context");

const ADMIN_EMAIL = "artbenitezdev@gmail.com";
const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminManageSales = onRequest(async (req, res) => {
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

    const sales = await loadSales({ tenantId, q, limit });
    res.status(200).json({ ok: true, tenantId, total: sales.length, sales, rows: sales });
  } catch (error) {
    console.error("adminManageSales fallo:", error);
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

async function loadSales({ tenantId, q, limit }) {
  const salesRef = db.collection("tenants").doc(tenantId).collection("ventas");
  const snap = await salesRef.limit(limit).get();

  let rows = snap.docs.map((docSnap) => normalizeSale({ id: docSnap.id, ...(docSnap.data() || {}) }));
  if (q) {
    const query = normalizeText(q);
    rows = rows.filter((row) =>
      normalizeText([row.id, row.cliente, row.vendedor, row.metodoPago].join(" ")).includes(query)
    );
  }

  rows.sort((a, b) => (b._createdAtMs || 0) - (a._createdAtMs || 0));
  return rows.map(({ _createdAtMs, ...row }) => row);
}

function normalizeSale(input) {
  const row = input || {};
  const id = String(row.idVenta || row.saleId || row.id || "").trim();
  const createdAtIso = toIsoString(row.createdAt || row.fecha || row.timestamp || row.fechaVenta);
  const total = toNumberOrZero(row.total ?? row.totalVenta ?? row.amount);
  const vendedor = String(row.usuarioNombre || row.vendedor || row.employeeName || "").trim();
  const tipoPago = String(row.tipoPago || row.metodoPago || row.paymentMethod || "").trim();
  const cliente = String(row.cliente || row.customerName || row.customer || "").trim();

  return {
    id: id || String(row.id || "").trim(),
    fecha: createdAtIso || "",
    cliente: cliente || "-",
    vendedor: vendedor || "-",
    metodoPago: tipoPago || "efectivo",
    total,
    _createdAtMs: createdAtIso ? Date.parse(createdAtIso) || 0 : 0
  };
}

function toIsoString(value) {
  if (!value) return "";
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
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
  adminManageSales
};
