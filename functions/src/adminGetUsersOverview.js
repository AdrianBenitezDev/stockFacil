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

const adminGetUsersOverview = onRequest(async (req, res) => {
  if (!setCors(req, res)) {
    res.status(403).json({ ok: false, error: "Origen no permitido." });
    return;
  }
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Metodo no permitido." });
    return;
  }

  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Falta token de autenticacion." });
      return;
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const email = String(decoded.email || "").trim().toLowerCase();
    if (!email) {
      res.status(403).json({ ok: false, error: "Acceso denegado." });
      return;
    }
    if (!ALLOWED_ADMIN_EMAILS.has(email)) {
      res.status(403).json({ ok: false, error: "Acceso denegado." });
      return;
    }

    const employers = await loadEmployers();
    const tenantCache = new Map();
    const rows = [];

    for (const employer of employers) {
      const tenantId = String(
        employer.tenantId || employer.kioscoId || employer.comercioId || ""
      ).trim();

      const tenantSummary = tenantId
        ? await getTenantSummaryCached(tenantId, tenantCache)
        : buildEmptyTenantSummary();
      const lastAccessIso = await loadLastAccessForUser(employer.uid, tenantId);

      rows.push({
        uid: String(employer.uid || "").trim(),
        tenantId,
        nombreNegocio:
          tenantSummary.nombreNegocio || String(employer.nombreKiosco || employer.negocio || "-").trim() || "-",
        direccionNegocio:
          tenantSummary.direccionNegocio ||
          buildAddressFromSource(employer) ||
          buildAddressFromSource(tenantSummary) ||
          "-",
        nombre:
          String(
            employer.displayName ||
              employer.nombreApellido ||
              employer.username ||
              employer.email ||
              "-"
          ).trim() || "-",
        email: String(employer.email || "-").trim() || "-",
        telefono: String(employer.telefono || employer.phone || "-").trim() || "-",
        activo: employer.activo !== false,
        estado: String(employer.estado || "").trim() || (employer.activo === false ? "suspendido" : "activo"),
        planActual: tenantSummary.planActual || String(employer.plan || "-").trim() || "-",
        ultimoAcceso: lastAccessIso || null,
        fechaCreacion: toIsoString(employer.createdAt || employer.fechaCreacion),
        fechaPago: tenantSummary.fechaPago || null,
        cantidadEmpleados: tenantSummary.cantidadEmpleados,
        cantidadProductos: tenantSummary.cantidadProductos
      });
    }

    rows.sort((a, b) => {
      const aDate = Date.parse(a.ultimoAcceso || "") || 0;
      const bDate = Date.parse(b.ultimoAcceso || "") || 0;
      return bDate - aDate;
    });

    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      total: rows.length,
      rows
    });
  } catch (error) {
    console.error("adminGetUsersOverview fallo:", error);
    res.status(500).json({ ok: false, error: "No se pudo obtener el resumen de usuarios." });
  }
});

async function loadEmployers() {
  const employerSnap = await db.collection("usuarios").where("role", "==", "empleador").get();
  if (!employerSnap.empty) {
    return employerSnap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  }
  const fallback = await db.collection("usuarios").get();
  return fallback.docs
    .map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .filter((row) => String(row.role || row.tipo || "").trim().toLowerCase() === "empleador");
}

async function getTenantSummaryCached(tenantId, cache) {
  if (cache.has(tenantId)) return cache.get(tenantId);

  const [tenantSnap, employeesSnap, productsSnap] = await Promise.all([
    db.collection("tenants").doc(tenantId).get(),
    db.collection("empleados").where("comercioId", "==", tenantId).get(),
    db.collection("tenants").doc(tenantId).collection("productos").get()
  ]);

  const tenant = tenantSnap.exists ? tenantSnap.data() || {} : {};
  const summary = {
    planActual: String(tenant.plan || tenant.planId || tenant.planActual || "-").trim() || "-",
    nombreNegocio:
      String(tenant.nombreKiosco || tenant.negocio || tenant.nombreComercio || tenant.nombre || "-").trim() || "-",
    direccionNegocio: buildAddressFromSource(tenant) || "-",
    fechaPago: toIsoString(
      tenant.fechaPago ||
        tenant.proximoPago ||
        tenant.ultimoPago ||
        tenant.lastPaymentAt ||
        tenant.paymentDate ||
        null
    ),
    cantidadEmpleados: employeesSnap.size,
    cantidadProductos: productsSnap.size
  };

  cache.set(tenantId, summary);
  return summary;
}

async function loadLastAccessForUser(uid, tenantId) {
  const byUser = await db
    .collection("sesiones")
    .where("userId", "==", String(uid || "").trim())
    .get();
  const fromUser = pickLatestSessionDate(byUser);
  if (fromUser) {
    return fromUser;
  }

  if (!tenantId) return null;
  const byTenant = await db
    .collection("sesiones")
    .where("tenantId", "==", String(tenantId || "").trim())
    .get();
  return pickLatestSessionDate(byTenant);
}

function buildEmptyTenantSummary() {
  return {
    planActual: "-",
    nombreNegocio: "-",
    direccionNegocio: "-",
    fechaPago: null,
    cantidadEmpleados: 0,
    cantidadProductos: 0
  };
}

function buildAddressFromSource(source) {
  const domicilio = String(source?.domicilio || source?.direccion || source?.address || "").trim();
  const localidad = String(source?.localidad || source?.ciudad || source?.city || "").trim();
  const distrito = String(source?.distrito || source?.municipio || "").trim();
  const provincia = String(source?.provinciaEstado || source?.provincia || source?.state || "").trim();
  const pais = String(source?.pais || source?.country || "").trim();

  return [domicilio, localidad, distrito, provincia, pais].filter(Boolean).join(", ");
}

function toIsoString(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric).toISOString();
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function pickLatestSessionDate(snapshot) {
  if (!snapshot || snapshot.empty) return null;
  let latestMs = 0;
  snapshot.docs.forEach((docSnap) => {
    const row = docSnap.data() || {};
    const iso = toIsoString(row.createdAt || row.loggedAt);
    const ms = iso ? Date.parse(iso) : 0;
    if (ms > latestMs) latestMs = ms;
  });
  return latestMs > 0 ? new Date(latestMs).toISOString() : null;
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
  adminGetUsersOverview
};
