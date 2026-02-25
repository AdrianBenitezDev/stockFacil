import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { ensureCurrentUserProfile } from "./auth.js";

const functions = getFunctions(firebaseApp);
const crearEmpleadoCallable = httpsCallable(functions, "crearEmpleado");
const deleteEmpleadoCallable = httpsCallable(functions, "deleteEmpleado");
const updateEmpleadoProductoPermissionCallable = httpsCallable(functions, "updateEmpleadoProductoPermission");

export async function createEmployeeViaCallable(formValues) {
  const payload = normalizePayload(formValues);
  if (!payload.ok) return payload;

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, error: "No hay sesion valida. Vuelve a iniciar sesion." };
  }
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error || "No se pudo validar tu perfil." };
  }

  try {
    const result = await crearEmpleadoCallable(payload.data);
    return {
      ok: true,
      data: result?.data || null
    };
  } catch (error) {
    const message = mapCallableError(error);
    return {
      ok: false,
      error: message
    };
  }
}

export async function deleteEmployeeViaCallable(uidEmpleado) {
  const uid = String(uidEmpleado || "").trim();
  if (!uid) {
    return { ok: false, error: "Empleado invalido." };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, error: "No hay sesion valida. Vuelve a iniciar sesion." };
  }
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error || "No se pudo validar tu perfil." };
  }

  try {
    const result = await deleteEmpleadoCallable({ uidEmpleado: uid });
    return {
      ok: true,
      data: result?.data || null
    };
  } catch (error) {
    const message = mapDeleteCallableError(error);
    return {
      ok: false,
      error: message
    };
  }
}

export async function updateEmployeeCreateProductsPermission(uidEmpleado, puedeCrearProductos) {
  const uid = String(uidEmpleado || "").trim();
  if (!uid) {
    return { ok: false, error: "Empleado invalido." };
  }
  if (typeof puedeCrearProductos !== "boolean") {
    return { ok: false, error: "Permiso invalido." };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, error: "No hay sesion valida. Vuelve a iniciar sesion." };
  }
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error || "No se pudo validar tu perfil." };
  }

  try {
    const result = await updateEmpleadoProductoPermissionCallable({ uidEmpleado: uid, puedeCrearProductos });
    return {
      ok: true,
      data: result?.data || null
    };
  } catch (error) {
    const message = mapPermissionCallableError(error);
    return {
      ok: false,
      error: message
    };
  }
}

export async function updateEmployeeEditProductsPermission(uidEmpleado, puedeEditarProductos) {
  const uid = String(uidEmpleado || "").trim();
  if (!uid) {
    return { ok: false, error: "Empleado invalido." };
  }
  if (typeof puedeEditarProductos !== "boolean") {
    return { ok: false, error: "Permiso invalido." };
  }

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser) {
    return { ok: false, error: "No hay sesion valida. Vuelve a iniciar sesion." };
  }
  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult.ok) {
    return { ok: false, error: profileResult.error || "No se pudo validar tu perfil." };
  }

  try {
    const result = await updateEmpleadoProductoPermissionCallable({ uidEmpleado: uid, puedeEditarProductos });
    return {
      ok: true,
      data: result?.data || null
    };
  } catch (error) {
    const message = mapPermissionCallableError(error);
    return {
      ok: false,
      error: message
    };
  }
}

function normalizePayload(values) {
  const displayName = String(values?.displayName || "").trim();
  const email = String(values?.email || "").trim().toLowerCase();
  const password = String(values?.password || "");

  if (!displayName || !email || !password) {
    return { ok: false, error: "Completa nombre visible, email y contrasena para crear el empleado." };
  }

  if (password.length < 6) {
    return { ok: false, error: "La contrasena temporal debe tener al menos 6 caracteres." };
  }

  return {
    ok: true,
    data: { displayName, email, password, appBaseUrl: window.location.origin }
  };
}

function mapCallableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  if (message) {
    return message;
  }

  if (code.includes("unauthenticated")) {
    return "No hay sesion valida. Vuelve a iniciar sesion.";
  }
  if (code.includes("permission-denied")) {
    return "No tienes permisos para crear empleados.";
  }
  if (code.includes("already-exists")) {
    return "Ese email o usuario ya existe.";
  }
  if (code.includes("failed-precondition")) {
    return "Se alcanzo el limite de empleados para este kiosco.";
  }
  return "No se pudo crear el empleado.";
}

function mapDeleteCallableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (message) return message;
  if (code.includes("unauthenticated")) return "No hay sesion valida.";
  if (code.includes("permission-denied")) return "No tienes permisos para eliminar empleados.";
  if (code.includes("not-found")) return "El empleado no existe o ya fue eliminado.";
  return "No se pudo eliminar el empleado.";
}

function mapPermissionCallableError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (message) return message;
  if (code.includes("unauthenticated")) return "No hay sesion valida.";
  if (code.includes("permission-denied")) return "No tienes permisos para editar este empleado.";
  if (code.includes("not-found")) return "El empleado no existe.";
  if (code.includes("invalid-argument")) return "Datos invalidos para actualizar permisos.";
  return "No se pudo actualizar el permiso del empleado.";
}
