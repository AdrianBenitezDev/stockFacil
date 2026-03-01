const { onRequest, adminAuth } = require("./shared/context");
const { getStorage } = require("firebase-admin/storage");

const ADMIN_EMAIL = "artbenitezdev@gmail.com";
const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminManageBackups = onRequest(async (req, res) => {
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

    const backups = await loadBackups({ tenantId, q, limit });
    res.status(200).json({ ok: true, tenantId, total: backups.length, backups, rows: backups });
  } catch (error) {
    console.error("adminManageBackups fallo:", error);
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

async function loadBackups({ tenantId, q, limit }) {
  const prefix = `tenants/${tenantId}/ventas/`;
  const bucket = getStorage().bucket();
  const [files] = await bucket.getFiles({ prefix, maxResults: limit });
  const rows = [];

  for (const file of files) {
    const path = String(file?.name || "").trim();
    if (!path || !path.endsWith(".json")) continue;
    const parsed = parseBackupName(path, prefix);
    if (!parsed) continue;

    let metadata = {};
    try {
      const [meta] = await file.getMetadata();
      metadata = meta || {};
    } catch (_) {
      metadata = {};
    }

    rows.push({
      id: path,
      path,
      nombreArchivo: parsed.fileName,
      usuario: parsed.usuario,
      dateKey: parsed.dateKey,
      timestamp: parsed.timestamp,
      createdAt: toIsoString(metadata.timeCreated || parsed.timestamp),
      updatedAt: toIsoString(metadata.updated || metadata.timeCreated || parsed.timestamp),
      sizeBytes: Number(metadata.size || 0)
    });
  }

  let filtered = rows;
  if (q) {
    const query = normalizeText(q);
    filtered = rows.filter((row) =>
      normalizeText([row.path, row.nombreArchivo, row.usuario, row.dateKey].join(" ")).includes(query)
    );
  }
  filtered.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  return filtered;
}

function parseBackupName(path, prefix) {
  const fileName = String(path || "").replace(prefix, "");
  const patternWithUser = /^all_ventas_(.+)_(\d{8})_(\d+)\.json$/i;
  const matchWithUser = fileName.match(patternWithUser);
  if (matchWithUser) {
    return {
      fileName,
      usuario: String(matchWithUser[1] || "").replace(/-/g, " "),
      dateKey: matchWithUser[2],
      timestamp: Number(matchWithUser[3] || 0)
    };
  }

  const patternLegacy = /^all_ventas_(\d{8})_(\d+)\.json$/i;
  const matchLegacy = fileName.match(patternLegacy);
  if (matchLegacy) {
    return {
      fileName,
      usuario: "-",
      dateKey: matchLegacy[1],
      timestamp: Number(matchLegacy[2] || 0)
    };
  }
  return null;
}

function toIsoString(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }
  return "";
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
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.min(Math.trunc(parsed), 500);
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
  adminManageBackups
};
