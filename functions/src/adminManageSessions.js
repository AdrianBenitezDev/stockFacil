const { onRequest, adminAuth, db } = require("./shared/context");

const ALLOWED_ADMIN_EMAILS = new Set([
  "artbenitezdev@gmail.com",
  "admin@stockfacil.com.ar"
]);

const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminManageSessions = onRequest(async (req, res) => {
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

    const sessions = await loadRecentSessions(10);
    res.status(200).json({
      ok: true,
      total: sessions.length,
      sessions,
      rows: sessions
    });
  } catch (error) {
    console.error("adminManageSessions fallo:", error);
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
  if (!ALLOWED_ADMIN_EMAILS.has(email)) {
    throw { status: 403, message: "Acceso denegado." };
  }
}

async function loadRecentSessions(limit) {
  const snap = await db
    .collection("sesiones")
    .orderBy("createdAt", "desc")
    .limit(Math.max(1, Math.min(Number(limit) || 10, 50)))
    .get();

  return snap.docs.map((docSnap) => normalizeSession(docSnap.id, docSnap.data() || {}));
}

function normalizeSession(id, row) {
  const createdAtIso = toIsoString(row.createdAt);
  const loggedAtIso = toIsoString(row.loggedAt);
  return {
    id: String(id || "").trim(),
    tenantId: String(row.tenantId || "").trim(),
    userId: String(row.userId || row.uid || "").trim(),
    username: String(row.username || row.displayName || "").trim(),
    role: String(row.role || "").trim(),
    loggedAt: loggedAtIso || "",
    createdAt: createdAtIso || loggedAtIso || ""
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
  adminManageSessions
};
