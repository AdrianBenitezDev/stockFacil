import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth } from "../config.js";
import { ensureCurrentUserProfile } from "./auth.js";

const functions = getFunctions(firebaseApp);
const startEmployeeShiftCallable = httpsCallable(functions, "startEmployeeShift");
const endEmployeeShiftCallable = httpsCallable(functions, "endEmployeeShift");
const getMyShiftStatusCallable = httpsCallable(functions, "getMyShiftStatus");
const registerEmergencyShiftStartCallable = httpsCallable(functions, "registerEmergencyShiftStart");
const EMPLOYEE_SHIFT_CACHE_PREFIX = "stockfacil_employee_shift_status";
const OWNER_SHIFT_CASH_CACHE_PREFIX = "stockfacil_owner_shift_cash";

export async function startEmployeeShift({ employeeUid, inicioCaja }) {
  const uid = String(employeeUid || "").trim();
  const amount = Number(inicioCaja);
  if (!uid) {
    return { ok: false, error: "Debes seleccionar un empleado." };
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "El inicio de caja es invalido." };
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
    const response = await startEmployeeShiftCallable({ employeeUid: uid, inicioCaja: amount });
    const tenantId = String(profileResult?.user?.tenantId || "").trim();
    if (tenantId) {
      registerOwnerShiftStartLocal({ tenantId, employeeUid: uid, inicioCaja: amount });
    }
    return {
      ok: true,
      data: response?.data || null
    };
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    if (message) return { ok: false, error: message };
    if (code.includes("permission-denied")) return { ok: false, error: "Solo el empleador puede iniciar turnos." };
    if (code.includes("failed-precondition")) return { ok: false, error: "El empleado ya tiene un turno activo." };
    if (code.includes("not-found")) return { ok: false, error: "El empleado no existe." };
    return { ok: false, error: "No se pudo iniciar el turno del empleado." };
  }
}

export async function endEmployeeShift({ employeeUid, montoCierreCaja }) {
  const uid = String(employeeUid || "").trim();
  const amount = Number(montoCierreCaja);
  if (!uid) {
    return { ok: false, error: "Debes seleccionar un empleado." };
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "El monto de cierre de caja es invalido." };
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
    const response = await endEmployeeShiftCallable({ employeeUid: uid, montoCierreCaja: amount });
    const tenantId = String(profileResult?.user?.tenantId || "").trim();
    if (tenantId) {
      registerOwnerShiftEndLocal({ tenantId, employeeUid: uid });
    }
    return {
      ok: true,
      data: response?.data || null
    };
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    if (message) return { ok: false, error: message };
    if (code.includes("permission-denied")) return { ok: false, error: "Solo el empleador puede cerrar turnos." };
    if (code.includes("failed-precondition")) return { ok: false, error: "El empleado no tiene turno activo." };
    if (code.includes("not-found")) return { ok: false, error: "El empleado no existe." };
    return { ok: false, error: "No se pudo cerrar el turno del empleado." };
  }
}

export async function syncMyShiftStatusCache(sessionLike = null) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  const role = String(sessionLike?.role || "").trim().toLowerCase();
  if (!tenantId || !userId || role !== "empleado") return { ok: true, skipped: true };

  await ensureFirebaseAuth();
  if (!firebaseAuth.currentUser || !navigator.onLine) return { ok: false, skipped: true };

  try {
    const localBefore = readEmployeeShiftCache({ tenantId, userId });
    if (localBefore?.active === true && localBefore?.emergency === true && localBefore?.emergencySynced !== true) {
      await registerEmergencyShiftStartCallable({
        idTurno: String(localBefore.idTurno || "").trim(),
        inicioCaja: Number(localBefore.inicioCaja || 0),
        source: "offline_emergency"
      });
      writeEmployeeShiftCache({
        tenantId,
        userId,
        value: {
          ...localBefore,
          emergencySynced: true,
          updatedAt: new Date().toISOString()
        }
      });
    }

    const response = await getMyShiftStatusCallable();
    const data = response?.data || {};
    const next = {
      active: data.active === true,
      idTurno: String(data.idTurno || "").trim(),
      inicioCaja: Number(data.inicioCaja || 0),
      emergency: false,
      emergencySynced: false,
      tenantId,
      userId,
      updatedAt: new Date().toISOString()
    };
    writeEmployeeShiftCache({ tenantId, userId, value: next });
    return { ok: true, data: next };
  } catch (_) {
    return { ok: false };
  }
}

export function canEmployeeSellOfflineByShiftCache(sessionLike) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  const role = String(sessionLike?.role || "").trim().toLowerCase();
  if (role !== "empleado") return true;
  if (!tenantId || !userId) return false;

  const cached = readEmployeeShiftCache({ tenantId, userId });
  return cached?.active === true;
}

export function getEmployeeOfflineShiftState(sessionLike) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  if (!tenantId || !userId) {
    return { active: false, emergency: false, inicioCaja: 0, idTurno: "" };
  }
  const cached = readEmployeeShiftCache({ tenantId, userId });
  return {
    active: cached?.active === true,
    emergency: cached?.emergency === true,
    inicioCaja: Number(cached?.inicioCaja || 0),
    idTurno: String(cached?.idTurno || "").trim()
  };
}

export function ensureEmployeeEmergencyOfflineShiftStart(sessionLike) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  const role = String(sessionLike?.role || "").trim().toLowerCase();
  if (role !== "empleado" || !tenantId || !userId) {
    return { ok: false, error: "Sesion invalida para iniciar turno offline." };
  }

  const promptMessage =
    "Estas sin internet y puedes seguir vendiendo.\n" +
    "Ingresa cuanto dinero hay en caja al iniciar.\n" +
    "Esta operacion quedara marcada para auditoria de forma preventiva.";
  const raw = window.prompt(promptMessage, "0");
  if (raw === null) {
    return { ok: false, cancelled: true, error: "Inicio de turno offline cancelado." };
  }

  const amount = Number(String(raw).replace(",", ".").trim());
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "El monto inicial de caja no es valido." };
  }

  writeEmployeeShiftCache({
    tenantId,
    userId,
    value: {
      active: true,
      emergency: true,
      emergencySynced: false,
      idTurno: `OFFLINE-${Date.now()}`,
      inicioCaja: Number(amount.toFixed(2)),
      tenantId,
      userId,
      updatedAt: new Date().toISOString()
    }
  });

  return { ok: true, inicioCaja: Number(amount.toFixed(2)) };
}

export function markEmployeeShiftCacheActive(sessionLike, { idTurno = "", inicioCaja = 0 } = {}) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  if (!tenantId || !userId) return;
  writeEmployeeShiftCache({
    tenantId,
    userId,
    value: {
      active: true,
      idTurno: String(idTurno || "").trim(),
      inicioCaja: Number(inicioCaja || 0),
      emergency: false,
      emergencySynced: false,
      tenantId,
      userId,
      updatedAt: new Date().toISOString()
    }
  });
}

export function markEmployeeShiftCacheInactive(sessionLike) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  if (!tenantId || !userId) return;
  writeEmployeeShiftCache({
    tenantId,
    userId,
    value: {
      active: false,
      idTurno: "",
      inicioCaja: 0,
      emergency: false,
      emergencySynced: false,
      tenantId,
      userId,
      updatedAt: new Date().toISOString()
    }
  });
}

export function getLocalShiftCashDetailFallback(sessionLike) {
  const tenantId = String(sessionLike?.tenantId || "").trim();
  const userId = String(sessionLike?.userId || "").trim();
  const role = String(sessionLike?.role || "").trim().toLowerCase();

  if (role === "empleador") {
    const ownerSnapshot = readOwnerShiftCashSnapshot(tenantId);
    return {
      startCashAmount: Number(ownerSnapshot?.startCashAmount || 0),
      activeShiftCount: Number(ownerSnapshot?.activeShiftCount || 0)
    };
  }

  const cached = readEmployeeShiftCache({ tenantId, userId });
  const startCashAmount = cached?.active === true ? Number(cached?.inicioCaja || 0) : 0;
  return {
    startCashAmount,
    activeShiftCount: cached?.active === true ? 1 : 0
  };
}

export function saveOwnerShiftCashSnapshot(tenantId, { startCashAmount = 0, activeShiftCount = 0 } = {}) {
  const key = getOwnerShiftCashCacheKey(tenantId);
  if (!key) return;
  const payload = {
    startCashAmount: Number(startCashAmount || 0),
    activeShiftCount: Number(activeShiftCount || 0),
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(payload));
}

export function registerOwnerShiftStartLocal({ tenantId, employeeUid, inicioCaja }) {
  const key = getOwnerShiftCashCacheKey(tenantId);
  if (!key) return;

  const parsed = readOwnerShiftCashSnapshot(tenantId);
  const existingByEmployee = parsed?.byEmployee && typeof parsed.byEmployee === "object" ? parsed.byEmployee : {};
  const employeeKey = String(employeeUid || "").trim();
  if (!employeeKey) return;
  existingByEmployee[employeeKey] = Number(inicioCaja || 0);

  const total = Object.values(existingByEmployee).reduce((acc, value) => acc + Number(value || 0), 0);
  const payload = {
    byEmployee: existingByEmployee,
    startCashAmount: Number(total || 0),
    activeShiftCount: Object.keys(existingByEmployee).length,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(payload));
}

export function registerOwnerShiftEndLocal({ tenantId, employeeUid }) {
  const key = getOwnerShiftCashCacheKey(tenantId);
  if (!key) return;

  const parsed = readOwnerShiftCashSnapshot(tenantId);
  const existingByEmployee = parsed?.byEmployee && typeof parsed.byEmployee === "object" ? parsed.byEmployee : {};
  const employeeKey = String(employeeUid || "").trim();
  if (!employeeKey) return;

  if (Object.prototype.hasOwnProperty.call(existingByEmployee, employeeKey)) {
    delete existingByEmployee[employeeKey];
  }

  const total = Object.values(existingByEmployee).reduce((acc, value) => acc + Number(value || 0), 0);
  const payload = {
    byEmployee: existingByEmployee,
    startCashAmount: Number(total || 0),
    activeShiftCount: Object.keys(existingByEmployee).length,
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(payload));
}

function readEmployeeShiftCache({ tenantId, userId }) {
  const key = getEmployeeShiftCacheKey({ tenantId, userId });
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeEmployeeShiftCache({ tenantId, userId, value }) {
  const key = getEmployeeShiftCacheKey({ tenantId, userId });
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(value || {}));
}

function readOwnerShiftCashSnapshot(tenantId) {
  const key = getOwnerShiftCashCacheKey(tenantId);
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function getEmployeeShiftCacheKey({ tenantId, userId }) {
  const tenant = String(tenantId || "").trim();
  const uid = String(userId || "").trim();
  if (!tenant || !uid) return "";
  return `${EMPLOYEE_SHIFT_CACHE_PREFIX}::${tenant}::${uid}`;
}

function getOwnerShiftCashCacheKey(tenantId) {
  const tenant = String(tenantId || "").trim();
  if (!tenant) return "";
  return `${OWNER_SHIFT_CASH_CACHE_PREFIX}::${tenant}`;
}
