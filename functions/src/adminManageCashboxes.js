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

const adminManageCashboxes = onRequest(async (req, res) => {
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

    const cashboxes = await loadCashboxes({ tenantId, q, limit });
    res.status(200).json({ ok: true, tenantId, total: cashboxes.length, cashboxes, rows: cashboxes });
  } catch (error) {
    console.error("adminManageCashboxes fallo:", error);
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

async function loadCashboxes({ tenantId, q, limit }) {
  const cashboxesRef = db.collection("tenants").doc(tenantId).collection("cajas");
  const snap = await cashboxesRef.limit(limit).get();

  let rows = snap.docs.map((docSnap) =>
    normalizeCashbox({ id: docSnap.id, ...(docSnap.data() || {}) })
  );
  if (q) {
    const query = normalizeText(q);
    rows = rows.filter((row) =>
      normalizeText([row.id, row.responsable, row.estado].join(" ")).includes(query)
    );
  }

  rows.sort((a, b) => (b._aperturaMs || 0) - (a._aperturaMs || 0));
  return rows.map(({ _aperturaMs, ...row }) => row);
}

function normalizeCashbox(input) {
  const row = input || {};
  const id = String(row.idCaja || row.cashboxId || row.id || "").trim();
  const aperturaIso = toIsoString(row.fechaApertura || row.apertura || row.openedAt || row.createdAt);
  const cierreIso = toIsoString(row.fechaCierre || row.cierre || row.closedAt);
  const saldoFinal = toNumberOrZero(row.total ?? row.totalCaja ?? row.finalBalance ?? row.saldoFinal);
  const responsable = String(row.usuarioNombre || row.responsable || row.owner || row.username || "").trim();
  const estado = cierreIso ? "cerrada" : "abierta";

  return {
    id: id || String(row.id || "").trim(),
    apertura: aperturaIso || "",
    cierre: cierreIso || "",
    responsable: responsable || "-",
    estado,
    saldoFinal,
    _aperturaMs: aperturaIso ? Date.parse(aperturaIso) || 0 : 0
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
  adminManageCashboxes
};
