const { Timestamp, db } = require("./context");

const SHIFT_STATUS_CACHE_TTL_MS = 30 * 1000;
const shiftStatusCache = new Map();

function getTurnoCollection(employeeUid) {
  return db.collection("empleados").doc(employeeUid).collection("turno");
}

async function getLatestEmployeeShift(employeeUid) {
  const uid = String(employeeUid || "").trim();
  if (!uid) return null;

  const snap = await getTurnoCollection(uid).orderBy("startedAt", "desc").limit(1).get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ...(docSnap.data() || {}) };
}

async function getEmployeeShiftStatusCached(employeeUid, tenantId) {
  const uid = String(employeeUid || "").trim();
  const expectedTenantId = String(tenantId || "").trim();
  if (!uid || !expectedTenantId) {
    return { ok: false, active: false, turno: null };
  }

  const now = Date.now();
  const cached = shiftStatusCache.get(uid);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const latest = await getLatestEmployeeShift(uid);
  const latestTenantId = String(latest?.tenantId || latest?.comercioId || "").trim();
  const turnoIniciado = latest?.turnoIniciado === true;
  const turnoCerrado = latest?.turnoCerrado === true;
  const active = Boolean(latest && latestTenantId === expectedTenantId && turnoIniciado && !turnoCerrado);

  const value = { ok: true, active, turno: latest || null };
  shiftStatusCache.set(uid, {
    expiresAt: now + SHIFT_STATUS_CACHE_TTL_MS,
    value
  });
  return value;
}

function invalidateEmployeeShiftCache(employeeUid) {
  const uid = String(employeeUid || "").trim();
  if (!uid) return;
  shiftStatusCache.delete(uid);
}

function buildTurnoPayload({
  idTurno,
  tenantId,
  employeeUid,
  nowDate,
  inicioCaja = 0,
  previous = null
}) {
  const date = formatDate(nowDate);
  const time = formatTime(nowDate);
  const startedAt = Timestamp.fromDate(nowDate);
  const base = {
    idTurno,
    tenantId,
    comercioId: tenantId,
    empleadoUid: employeeUid,
    fechaInicio: date,
    horaInicio: time,
    fechaCierre: null,
    horaCierre: null,
    inicioCaja: round2(inicioCaja),
    montoCierreCaja: null,
    turnoIniciado: true,
    turnoCerrado: false,
    startedAt,
    closedAt: null,
    updatedAt: Timestamp.now()
  };

  if (!previous) {
    return {
      ...base,
      createdAt: Timestamp.now()
    };
  }

  return {
    ...previous,
    ...base
  };
}

function closeTurnoPayload({ previous, nowDate, montoCierreCaja }) {
  const date = formatDate(nowDate);
  const time = formatTime(nowDate);
  const closedAt = Timestamp.fromDate(nowDate);
  return {
    ...previous,
    fechaCierre: date,
    horaCierre: time,
    montoCierreCaja: round2(montoCierreCaja),
    turnoCerrado: true,
    turnoIniciado: false,
    closedAt,
    updatedAt: Timestamp.now()
  };
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

module.exports = {
  getLatestEmployeeShift,
  getEmployeeShiftStatusCached,
  invalidateEmployeeShiftCache,
  buildTurnoPayload,
  closeTurnoPayload
};
