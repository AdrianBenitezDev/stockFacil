const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const updateEmpleadoProductoPermission = onCall(async (request) => {
  const { tenantId } = await requireEmployerContext(request);

  const uidEmpleado = String(request.data?.uidEmpleado || "").trim();
  const puedeCrearProductos = request.data?.puedeCrearProductos;
  const puedeEditarProductos = request.data?.puedeEditarProductos;

  if (!uidEmpleado) {
    throw new HttpsError("invalid-argument", "Falta uidEmpleado.");
  }
  const updates = {};
  if (typeof puedeCrearProductos !== "undefined") {
    if (typeof puedeCrearProductos !== "boolean") {
      throw new HttpsError("invalid-argument", "puedeCrearProductos debe ser boolean.");
    }
    updates.puedeCrearProductos = puedeCrearProductos;
  }
  if (typeof puedeEditarProductos !== "undefined") {
    if (typeof puedeEditarProductos !== "boolean") {
      throw new HttpsError("invalid-argument", "puedeEditarProductos debe ser boolean.");
    }
    updates.puedeEditarProductos = puedeEditarProductos;
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpsError("invalid-argument", "Debes enviar al menos un permiso a actualizar.");
  }

  const empleadoRef = db.collection("empleados").doc(uidEmpleado);
  const empleadoSnap = await empleadoRef.get();
  if (!empleadoSnap.exists) {
    throw new HttpsError("not-found", "No existe el empleado.");
  }

  const empleado = empleadoSnap.data() || {};
  const comercioId = String(empleado.comercioId || empleado.tenantId || "").trim();
  if (!comercioId || comercioId !== tenantId) {
    throw new HttpsError("permission-denied", "No puedes editar un empleado de otro comercio.");
  }

  const now = Timestamp.now();
  const batch = db.batch();
  batch.update(empleadoRef, {
    ...updates,
    updatedAt: now
  });

  const legacyRef = db.collection("usuarios").doc(uidEmpleado);
  const legacySnap = await legacyRef.get();
  if (legacySnap.exists) {
    batch.update(legacyRef, {
      ...updates,
      updatedAt: now
    });
  }

  await batch.commit();

  return {
    ok: true,
    uidEmpleado,
    ...updates
  };
});

module.exports = {
  updateEmpleadoProductoPermission
};
