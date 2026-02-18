const { HttpsError, onCall, adminAuth, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const deleteEmpleado = onCall(async (request) => {
  const { tenantId } = await requireEmployerContext(request);

  const uidEmpleado = String(request.data?.uidEmpleado || "").trim();
  if (!uidEmpleado) {
    throw new HttpsError("invalid-argument", "Falta uidEmpleado.");
  }

  const empleadoRef = db.collection("empleados").doc(uidEmpleado);
  const empleadoSnap = await empleadoRef.get();
  if (!empleadoSnap.exists) {
    throw new HttpsError("not-found", "No existe el empleado.");
  }

  const empleado = empleadoSnap.data() || {};
  const comercioId = String(empleado.comercioId || empleado.tenantId || "").trim();
  if (!comercioId || comercioId !== tenantId) {
    throw new HttpsError("permission-denied", "No puedes eliminar un empleado de otro comercio.");
  }

  let authDeleted = false;
  try {
    await adminAuth.deleteUser(uidEmpleado);
    authDeleted = true;
  } catch (error) {
    const code = String(error?.code || "");
    if (!code.includes("user-not-found")) {
      throw new HttpsError("internal", "No se pudo eliminar el usuario en Authentication.");
    }
  }

  const batch = db.batch();
  batch.delete(empleadoRef);
  batch.delete(db.collection("usuarios").doc(uidEmpleado));
  await batch.commit();

  return {
    ok: true,
    uidEmpleado,
    authDeleted
  };
});

module.exports = {
  deleteEmpleado
};

