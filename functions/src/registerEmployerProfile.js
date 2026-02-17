const { onRequest, Timestamp, adminAuth, db } = require("./shared/context");

const registerEmployerProfile = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
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
    const uid = String(decoded.uid || "").trim();
    if (!uid) {
      res.status(401).json({ ok: false, error: "Token invalido." });
      return;
    }

    const authUser = await adminAuth.getUser(uid);
    const payload = await normalizePayload(req.body || {}, authUser.email || "");
    if (!payload.ok) {
      res.status(400).json({ ok: false, error: payload.error, fieldErrors: payload.fieldErrors || {} });
      return;
    }

    const existingUser = await db.collection("usuarios").doc(uid).get();
    if (existingUser.exists) {
      res.status(409).json({ ok: false, error: "Este usuario ya esta registrado." });
      return;
    }

    const existingByEmail = await db
      .collection("usuarios")
      .where("email", "==", payload.data.email)
      .limit(1)
      .get();
    if (!existingByEmail.empty) {
      res.status(409).json({ ok: false, error: "Este usuario ya esta registrado." });
      return;
    }

    const negocioRef = db.collection("tenants").doc();
    const kioscoId = negocioRef.id;
    const now = Timestamp.now();

    const batch = db.batch();

    //datos del empleador
    batch.set(db.collection("usuarios").doc(uid), {
      uid,
      correoVerificado: false,
      email: payload.data.email,
      tipo: "empleador",
      role: "empleador",
      kioscoId,
      tenantId: kioscoId,
      estado: "activo",
      activo: true,
      nombreApellido: payload.data.nombreApellido,
      domicilio: payload.data.domicilio,
      pais: payload.data.pais,
      telefono: payload.data.telefono,
      plan: payload.data.plan,
      fechaCreacion: now,
      updatedAt: now
    });

    //datos del kiosco
    batch.set(db.collection("tenants").doc(kioscoId), {
      kioscoId,
      ownerUid: uid,
      emailOwner: payload.data.email,
      nombreKiosco: payload.data.nombreKiosco,
      pais: payload.data.pais,
      provinciaEstado: payload.data.provinciaEstado,
      distrito: payload.data.distrito,
      localidad: payload.data.localidad,
      domicilio: payload.data.domicilio,
      plan: payload.data.plan,
      estado: "activo",
      createdAt: now,
      updatedAt: now
    });

    await batch.commit();
    await adminAuth.setCustomUserClaims(uid, { tenantId: kioscoId, role: "empleador" });

    res.status(200).json({
      ok: true,
      kioscoId,
      nid: kioscoId
    });
  } catch (error) {
    console.error("registerEmployerProfile fallo:", error);
    res.status(500).json({ ok: false, error: "No se pudo completar el registro." });
  }
});

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getBearerToken(req) {
  const authHeader = String(req.headers?.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

async function normalizePayload(input, fallbackEmail) {
  const data = {
    nombreApellido: String(input.nombreApellido || "").trim(),
    email: String(input.email || fallbackEmail || "").trim().toLowerCase(),
    telefono: String(input.telefono || "").trim(),
    nombreKiosco: String(input.nombreKiosco || "").trim(),
    pais: String(input.pais || "").trim(),
    provinciaEstado: String(input.provinciaEstado || "").trim(),
    distrito: String(input.distrito || "").trim(),
    localidad: String(input.localidad || "").trim(),
    domicilio: String(input.domicilio || "").trim(),
    plan: String(input.plan || "").trim()
  };

  const fieldErrors = {};
  if (!/^[A-Za-zÀ-ÿ\s]{3,80}$/.test(data.nombreApellido)) {
    fieldErrors.nombreApellido = "Nombre y apellido invalido.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    fieldErrors.email = "Email invalido.";
  }
  if (!/^\d{6,20}$/.test(data.telefono)) {
    fieldErrors.telefono = "Telefono invalido. Solo numeros.";
  }
  if (!data.nombreKiosco) {
    fieldErrors.nombreKiosco = "Nombre del kiosco obligatorio.";
  }
  if (!data.pais) {
    fieldErrors.pais = "Pais obligatorio.";
  }
  if (!data.provinciaEstado) {
    fieldErrors.provinciaEstado = "Provincia/Estado obligatorio.";
  }
  if (!data.distrito) {
    fieldErrors.distrito = "Distrito obligatorio.";
  }
  if (!data.localidad) {
    fieldErrors.localidad = "Localidad obligatoria.";
  }
  if (!data.domicilio) {
    fieldErrors.domicilio = "Domicilio obligatorio.";
  }
  const allowedPlans = await loadAvailablePlans();
  if (!allowedPlans.size) {
    fieldErrors.plan = "No hay planes disponibles en backend.";
  } else if (!allowedPlans.has(data.plan.toLowerCase())) {
    fieldErrors.plan = "Plan invalido.";
  }

  const hasErrors = Object.keys(fieldErrors).length > 0;
  if (hasErrors) {
    return { ok: false, error: "Revisa los campos del formulario.", fieldErrors };
  }

  data.plan = data.plan.toLowerCase();
  return { ok: true, data };
}

async function loadAvailablePlans() {
  try {
    const plansSnap = await db.collection("planes").get();
    if (plansSnap.empty) return new Set();

    const ids = plansSnap.docs
      .map((snap) => {
        const data = snap.data() || {};
        const activo = data.activo !== false;
        if (!activo) return "";
        return String(snap.id || data.id || "").trim().toLowerCase();
      })
      .filter(Boolean);

    return new Set(ids);
  } catch (error) {
    console.warn("registerEmployerProfile: no se pudo leer planes", error?.message || error);
    return new Set();
  }
}

module.exports = {
  registerEmployerProfile
};
