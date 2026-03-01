const { onRequest, adminAuth } = require("./shared/context");
const { getStorage } = require("firebase-admin/storage");

const ALLOWED_ADMIN_EMAILS = new Set([
  "artbenitezdev@gmail.com",
  "admin@stockfacil.com.ar"
]);

const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminGetBackupDownloadUrl = onRequest(async (req, res) => {
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
    if (!tenantId) throw { status: 400, message: "Debes enviar tenantId." };
    if (!path) throw { status: 400, message: "Debes enviar path del backup." };
    ensureBackupPathIsAllowed({ tenantId, path });

    const bucket = getStorage().bucket();
    const file = bucket.file(path);
    const [exists] = await file.exists();
    if (!exists) throw { status: 404, message: "No se encontro el backup solicitado." };

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 15 * 60 * 1000
    });

    res.status(200).json({ ok: true, tenantId, path, url });
  } catch (error) {
    console.error("adminGetBackupDownloadUrl fallo:", error);
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
  if (!ALLOWED_ADMIN_EMAILS.has(email)) throw { status: 403, message: "Acceso denegado." };
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
  adminGetBackupDownloadUrl
};
