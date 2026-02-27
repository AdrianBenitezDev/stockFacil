const { onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const getRecentCashClosures = onCall(async (request) => {
  const { uid, tenantId, role } = await requireTenantMemberContext(request);
  const daysBack = clampInt(request.data?.daysBack, 30, 1, 120);
  const limit = clampInt(request.data?.limit, 30, 1, 100);
  const rangeStart = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  let queryRef = db.collection("tenants").doc(tenantId).collection("cajas");

  if (String(role || "").trim().toLowerCase() !== "empleador") {
    queryRef = queryRef.where("usuarioUid", "==", uid);
  }

  queryRef = queryRef.orderBy("createdAt", "desc").limit(limit);

  const snap = await queryRef.get();
  const usernameByUid = new Map();
  const closures = [];

  for (const docSnap of snap.docs) {
    const row = docSnap.data() || {};
    const createdAtIso = normalizeToIso(row.createdAt || row.fechaCierre || null);
    if (!createdAtIso) continue;
    if (Date.parse(createdAtIso) < rangeStart) continue;

    const userId = String(row.usuarioUid || row.userId || "").trim();
    const username = await resolveUsername(userId, row, usernameByUid);
    const dateKey = String(row.dateKey || "").trim();
    const scopeKey = userId || "all";

    closures.push({
      id: String(row.idCaja || docSnap.id),
      userId,
      username,
      role: String(row.role || "").trim().toLowerCase() || "empleado",
      dateKey,
      scopeKey,
      totalAmount: Number(row.total || row.totalCaja || 0),
      efectivoEntregar: Number(row.efectivoEntregar ?? row.efectivoEtregar ?? 0),
      virtualEntregar: Number(row.virtualEntregar ?? row.virtualEtregar ?? 0),
      inicioCaja: Number(row.inicioCaja || 0),
      efectivoEtregar: Number(row.efectivoEtregar ?? row.efectivoEntregar ?? 0),
      virtualEtregar: Number(row.virtualEtregar ?? row.virtualEntregar ?? 0),
      totalCost: Number(row.totalCost || row.totalCosto || 0),
      profitAmount: Number(row.totalGananciaRealCaja || row.GanaciaRealCaja || 0),
      salesCount: Array.isArray(row.ventasIncluidas) ? row.ventasIncluidas.length : Number(row.salesCount || 0),
      itemsCount: Number(row.itemsCount || 0),
      ventasIncluidas: Array.isArray(row.ventasIncluidas) ? row.ventasIncluidas : [],
      productosIncluidos: Array.isArray(row.productosIncluidos) ? row.productosIncluidos : [],
      closureKey: `${tenantId}::${dateKey || buildDateKey(createdAtIso)}::${scopeKey}::${String(
        row.idCaja || docSnap.id
      )}`,
      createdAt: createdAtIso,
      synced: true
    });
  }

  return {
    success: true,
    closures
  };
});

async function resolveUsername(userId, row, cache) {
  const fromRow = String(row.usuarioNombre || row.username || "").trim();
  if (fromRow) return fromRow;
  if (!userId) return "-";
  if (cache.has(userId)) return cache.get(userId);

  const usuariosDoc = await db.collection("usuarios").doc(userId).get();
  if (usuariosDoc.exists) {
    const data = usuariosDoc.data() || {};
    const label = String(data.displayName || data.username || data.email || userId).trim();
    cache.set(userId, label || userId);
    return cache.get(userId);
  }

  const empleadosDoc = await db.collection("empleados").doc(userId).get();
  if (empleadosDoc.exists) {
    const data = empleadosDoc.data() || {};
    const label = String(data.displayName || data.username || data.email || userId).trim();
    cache.set(userId, label || userId);
    return cache.get(userId);
  }

  cache.set(userId, userId);
  return userId;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeToIso(value) {
  if (!value) return "";
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return "";
}

function buildDateKey(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate()
  ).padStart(2, "0")}`;
}

module.exports = {
  getRecentCashClosures
};
