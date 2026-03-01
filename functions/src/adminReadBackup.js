const { onRequest, adminAuth } = require("./shared/context");
const { getStorage } = require("firebase-admin/storage");

const ADMIN_EMAIL = "artbenitezdev@gmail.com";
const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminReadBackup = onRequest(async (req, res) => {
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
    const path = String(req.query?.path || "").trim();
    const maxSales = resolveLimit(req.query?.maxSales);
    if (!tenantId) throw { status: 400, message: "Debes enviar tenantId." };
    if (!path) throw { status: 400, message: "Debes enviar path del backup." };
    ensureBackupPathIsAllowed({ tenantId, path });

    const backup = await readBackupContent({ path, maxSales });
    res.status(200).json({ ok: true, tenantId, path, ...backup });
  } catch (error) {
    console.error("adminReadBackup fallo:", error);
    res.status(Number(error?.status || 500)).json({
      ok: false,
      error: String(error?.message || "Error interno.")
    });
  }
});

async function assertAdminRequest(req) {
  const token = getBearerToken(req);
  if (!token) throw { status: 401, message: "Falta token de autenticacion." };
  const decoded = await adminAuth.verifyIdToken(token);
  const email = String(decoded?.email || "").trim().toLowerCase();
  if (!email || email !== ADMIN_EMAIL) throw { status: 403, message: "Acceso denegado." };
}

async function readBackupContent({ path, maxSales }) {
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw { status: 404, message: "No se encontro el backup solicitado." };

  const [buffer] = await file.download();
  const raw = String(buffer || "");
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    throw { status: 500, message: "El backup no tiene formato JSON valido." };
  }

  const salesSource = Array.isArray(payload?.ventas) ? payload.ventas : Array.isArray(payload?.sales) ? payload.sales : [];
  const normalizedSales = salesSource
    .map((row) => normalizeSale(row))
    .filter((row) => Boolean(row.id))
    .sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));

  const limited = normalizedSales.slice(0, maxSales).map(({ createdAtMs, ...row }) => row);
  return {
    metadata: {
      generatedAt: String(payload?.createdAt || payload?.generatedAt || ""),
      operationId: String(payload?.operationId || ""),
      totalSales: salesSource.length,
      returnedSales: limited.length
    },
    sales: limited
  };
}

function normalizeSale(row) {
  const sale = row || {};
  const id = String(sale.idVenta || sale.id || "").trim();
  const createdAtIso = toIsoString(sale.createdAt);
  return {
    id,
    createdAt: createdAtIso,
    createdAtMs: createdAtIso ? Date.parse(createdAtIso) || 0 : 0,
    usuario: String(sale.usuarioNombre || sale.username || sale.usuarioUid || "-"),
    total: Number(sale.total || 0),
    tipoPago: String(sale.tipoPago || "efectivo"),
    pagoEfectivo: Number(sale.pagoEfectivo || 0),
    pagoVirtual: Number(sale.pagoVirtual || 0),
    itemsCount: Number(sale.itemsCount || 0)
  };
}

function toIsoString(value) {
  if (!value) return "";
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  return "";
}

function ensureBackupPathIsAllowed({ tenantId, path }) {
  const normalizedTenant = String(tenantId || "").trim();
  const normalizedPath = String(path || "").trim();
  const requiredPrefix = `tenants/${normalizedTenant}/ventas/`;
  if (!normalizedPath.startsWith(requiredPrefix)) {
    throw { status: 403, message: "Ruta de backup no permitida para el tenant." };
  }
  if (normalizedPath.includes("..") || !normalizedPath.endsWith(".json")) {
    throw { status: 400, message: "Ruta de backup invalida." };
  }
}

function resolveLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
  return Math.min(Math.trunc(parsed), 10000);
}

function setCors(req, res) {
  const origin = String(req.headers?.origin || "").trim();
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  if (origin) res.set("Access-Control-Allow-Origin", origin);
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
  adminReadBackup
};
