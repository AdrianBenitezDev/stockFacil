const { onRequest, adminAuth, db, Timestamp } = require("./shared/context");

const ALLOWED_ADMIN_EMAILS = new Set([
  "artbenitezdev@gmail.com",
  "admin@stockfacil.com.ar"
]);

const ALLOWED_ORIGINS = new Set([
  "https://admin.stockfacil.com.ar",
  "https://stockfacil.com.ar",
  "https://www.stockfacil.com.ar"
]);

const adminManageAccounts = onRequest(async (req, res) => {
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

    if (req.method === "GET") {
      const details = await getAccountDetails(req.query || {});
      res.status(200).json({ ok: true, ...details });
      return;
    }

    if (req.method === "PUT") {
      const result = await updateAccountState(req.body || {});
      res.status(200).json({ ok: true, ...result });
      return;
    }

    res.status(405).json({ ok: false, error: "Metodo no permitido." });
  } catch (error) {
    console.error("adminManageAccounts fallo:", error);
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

async function getAccountDetails(query) {
  const uid = String(query?.uid || "").trim();
  const tenantId = String(query?.tenantId || "").trim();
  if (!uid && !tenantId) {
    throw { status: 400, message: "Debes enviar uid o tenantId." };
  }

  const employer = await resolveEmployerByUidOrTenant(uid, tenantId);
  if (!employer) {
    throw { status: 404, message: "No se encontro el empleador." };
  }

  const employees = await loadEmployeesForTenant(employer.tenantId);
  return { employer, employees };
}

async function updateAccountState(payload) {
  const targetType = String(payload?.targetType || "").trim().toLowerCase();
  const uid = String(payload?.uid || "").trim();
  const tenantId = String(payload?.tenantId || "").trim();
  const active = payload?.active !== false;

  if (!uid) {
    throw { status: 400, message: "Debes enviar uid." };
  }
  if (targetType !== "employer" && targetType !== "employee") {
    throw { status: 400, message: "targetType invalido." };
  }

  if (targetType === "employer") {
    const employer = await setEmployerActiveState({ uid, tenantId, active });
    return { employer };
  }

  const employee = await setEmployeeActiveState({ uid, tenantId, active });
  return { employee };
}

async function setEmployerActiveState({ uid, tenantId, active }) {
  const employer = await resolveEmployerByUidOrTenant(uid, tenantId);
  if (!employer) {
    throw { status: 404, message: "No se encontro el empleador." };
  }
  if (tenantId && employer.tenantId !== tenantId) {
    throw { status: 403, message: "El empleador no pertenece al tenant indicado." };
  }

  const update = {
    activo: Boolean(active),
    estado: active ? "activo" : "suspendido",
    updatedAt: Timestamp.now()
  };
  await employer.ref.set(update, { merge: true });
  const refreshed = await employer.ref.get();
  return normalizeEmployer({ id: refreshed.id, ...(refreshed.data() || {}) });
}

async function setEmployeeActiveState({ uid, tenantId, active }) {
  const updates = {
    activo: Boolean(active),
    estado: active ? "activo" : "inactivo",
    updatedAt: Timestamp.now()
  };

  const touchedRefs = [];
  const employeeDoc = await db.collection("empleados").doc(uid).get();
  if (employeeDoc.exists) {
    const data = employeeDoc.data() || {};
    const employeeTenant = String(data.comercioId || data.tenantId || "").trim();
    if (!tenantId || employeeTenant === tenantId) {
      touchedRefs.push(employeeDoc.ref);
    }
  }

  const legacySnap = await db
    .collection("usuarios")
    .where("uid", "==", uid)
    .where("role", "==", "empleado")
    .get();
  legacySnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const employeeTenant = String(data.tenantId || data.comercioId || "").trim();
    if (!tenantId || employeeTenant === tenantId) {
      touchedRefs.push(docSnap.ref);
    }
  });

  const directLegacyDoc = await db.collection("usuarios").doc(uid).get();
  if (directLegacyDoc.exists) {
    const data = directLegacyDoc.data() || {};
    const role = String(data.role || data.tipo || "").trim().toLowerCase();
    const employeeTenant = String(data.tenantId || data.comercioId || "").trim();
    if (role === "empleado" && (!tenantId || employeeTenant === tenantId)) {
      touchedRefs.push(directLegacyDoc.ref);
    }
  }

  if (!touchedRefs.length) {
    throw { status: 404, message: "No se encontro el empleado." };
  }

  await Promise.all(
    [...new Set(touchedRefs.map((ref) => ref.path))].map((path) => db.doc(path).set(updates, { merge: true }))
  );

  return resolveEmployeeByUid(uid, tenantId);
}

async function resolveEmployerByUidOrTenant(uid, tenantId) {
  if (uid) {
    const directDoc = await db.collection("usuarios").doc(uid).get();
    if (directDoc.exists) {
      const data = directDoc.data() || {};
      const role = String(data.role || data.tipo || "").trim().toLowerCase();
      if (role === "empleador") {
        const normalized = normalizeEmployer({ id: directDoc.id, ...(data || {}) });
        if (!tenantId || normalized.tenantId === tenantId) {
          return { ...normalized, ref: directDoc.ref };
        }
      }
    }

    const byUidSnap = await db
      .collection("usuarios")
      .where("uid", "==", uid)
      .where("role", "==", "empleador")
      .limit(1)
      .get();
    if (!byUidSnap.empty) {
      const docSnap = byUidSnap.docs[0];
      const normalized = normalizeEmployer({ id: docSnap.id, ...(docSnap.data() || {}) });
      if (!tenantId || normalized.tenantId === tenantId) {
        return { ...normalized, ref: docSnap.ref };
      }
    }
  }

  if (tenantId) {
    const byTenantSnap = await db
      .collection("usuarios")
      .where("tenantId", "==", tenantId)
      .where("role", "==", "empleador")
      .limit(1)
      .get();
    if (!byTenantSnap.empty) {
      const docSnap = byTenantSnap.docs[0];
      return { ...normalizeEmployer({ id: docSnap.id, ...(docSnap.data() || {}) }), ref: docSnap.ref };
    }
  }

  return null;
}

async function loadEmployeesForTenant(tenantId) {
  if (!tenantId) return [];

  const [employeesByCommerce, employeesByTenant, legacyEmployees] = await Promise.all([
    db.collection("empleados").where("comercioId", "==", tenantId).get(),
    db.collection("empleados").where("tenantId", "==", tenantId).get(),
    db.collection("usuarios").where("tenantId", "==", tenantId).where("role", "==", "empleado").get()
  ]);

  const map = new Map();
  const upsert = (data) => {
    const normalized = normalizeEmployee(data);
    if (!normalized.uid) return;
    const prev = map.get(normalized.uid);
    map.set(normalized.uid, prev ? { ...prev, ...normalized } : normalized);
  };

  employeesByCommerce.docs.forEach((docSnap) => upsert({ id: docSnap.id, ...(docSnap.data() || {}) }));
  employeesByTenant.docs.forEach((docSnap) => upsert({ id: docSnap.id, ...(docSnap.data() || {}) }));
  legacyEmployees.docs.forEach((docSnap) => upsert({ id: docSnap.id, ...(docSnap.data() || {}) }));

  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

async function resolveEmployeeByUid(uid, tenantId) {
  const [employeeDoc, legacySnap] = await Promise.all([
    db.collection("empleados").doc(uid).get(),
    db.collection("usuarios").where("uid", "==", uid).where("role", "==", "empleado").limit(1).get()
  ]);

  let employee = null;
  if (employeeDoc.exists) {
    employee = normalizeEmployee({ id: employeeDoc.id, ...(employeeDoc.data() || {}) });
  }
  if (!employee && !legacySnap.empty) {
    employee = normalizeEmployee({ id: legacySnap.docs[0].id, ...(legacySnap.docs[0].data() || {}) });
  }
  if (!employee) {
    return {
      uid,
      nombre: "-",
      email: "-",
      telefono: "-",
      tenantId: tenantId || "",
      activo: Boolean(false)
    };
  }
  if (tenantId && employee.tenantId !== tenantId) {
    throw { status: 403, message: "El empleado no pertenece al tenant indicado." };
  }
  return employee;
}

function normalizeEmployer(data) {
  const row = data || {};
  const tenantId = String(row.tenantId || row.kioscoId || row.comercioId || "").trim();
  return {
    uid: String(row.uid || row.id || "").trim(),
    tenantId,
    nombre:
      String(row.displayName || row.nombreApellido || row.username || row.email || "-").trim() || "-",
    email: String(row.email || "-").trim() || "-",
    telefono: String(row.telefono || row.phone || "-").trim() || "-",
    activo: row.activo !== false,
    estado: String(row.estado || "").trim() || (row.activo === false ? "suspendido" : "activo")
  };
}

function normalizeEmployee(data) {
  const row = data || {};
  return {
    uid: String(row.uid || row.id || "").trim(),
    tenantId: String(row.tenantId || row.comercioId || "").trim(),
    nombre: String(row.displayName || row.nombreApellido || row.username || row.email || "-").trim() || "-",
    email: String(row.email || "-").trim() || "-",
    telefono: String(row.telefono || row.phone || "-").trim() || "-",
    activo: row.activo !== false,
    estado: String(row.estado || "").trim() || (row.activo === false ? "inactivo" : "activo")
  };
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
  res.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return true;
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

module.exports = {
  adminManageAccounts
};
