const { onRequest, adminAuth, db, Timestamp } = require("./shared/context");

const ALLOWED_ADMIN_EMAILS = new Set([
  "artbenitezdev@gmail.com",
  "admin@stockfacil.com.ar"
]);

const adminManagePlans = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    await assertAdminRequest(req);

    if (req.method === "GET") {
      const plans = await loadPlans();
      res.status(200).json({ ok: true, plans });
      return;
    }

    if (req.method === "PUT") {
      const updatedPlan = await updatePlan(req.body || {});
      res.status(200).json({ ok: true, plan: updatedPlan });
      return;
    }

    res.status(405).json({ ok: false, error: "Metodo no permitido." });
  } catch (error) {
    console.error("adminManagePlans fallo:", error);
    const status = Number(error?.status || 500);
    res.status(status).json({ ok: false, error: error?.message || "Error interno." });
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

async function loadPlans() {
  const snap = await db.collection("planes").get();
  return snap.docs
    .map((docSnap) => normalizePlan({ id: docSnap.id, ...(docSnap.data() || {}) }))
    .sort((a, b) => a.orden - b.orden);
}

async function updatePlan(payload) {
  const id = String(payload?.id || "").trim().toLowerCase();
  if (!id) {
    throw { status: 400, message: "El id del plan es obligatorio." };
  }

  const planRef = db.collection("planes").doc(id);
  const planSnap = await planRef.get();
  if (!planSnap.exists) {
    throw { status: 404, message: "No se encontro el plan solicitado." };
  }

  const updates = {
    titulo: String(payload?.titulo || "").trim(),
    precio: String(payload?.precio || "").trim(),
    descripcion: String(payload?.descripcion || "").trim(),
    caracteristicas: toFeatures(payload?.caracteristicas),
    activo: Boolean(payload?.activo),
    orden: toPositiveInteger(payload?.orden),
    maxEmpleados: toPositiveInteger(payload?.maxEmpleados),
    updatedAt: Timestamp.now()
  };

  if (!updates.titulo) {
    throw { status: 400, message: "El titulo del plan es obligatorio." };
  }
  if (!updates.precio) {
    throw { status: 400, message: "El precio del plan es obligatorio." };
  }

  await planRef.set(updates, { merge: true });
  const updatedSnap = await planRef.get();
  return normalizePlan({ id: updatedSnap.id, ...(updatedSnap.data() || {}) });
}

function normalizePlan(raw) {
  const plan = raw || {};
  return {
    id: String(plan.id || "").trim().toLowerCase(),
    titulo: String(plan.titulo || plan.nombre || "").trim(),
    precio: String(plan.precio || "").trim(),
    descripcion: String(plan.descripcion || "").trim(),
    caracteristicas: toFeatures(plan.caracteristicas),
    activo: plan.activo !== false,
    orden: toPositiveInteger(plan.orden),
    maxEmpleados: toPositiveInteger(
      plan.maxEmpleados ?? plan.maxEmployees ?? plan.empleadosMax ?? plan.limiteEmpleados ?? 0
    )
  };
}

function toFeatures(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

module.exports = {
  adminManagePlans
};
