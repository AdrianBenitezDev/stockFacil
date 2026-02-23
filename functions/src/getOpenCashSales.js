const { onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const getOpenCashSales = onCall(async (request) => {
  const { uid, tenantId, role } = await requireTenantMemberContext(request);
  const requestedScope = String(request.data?.scope || "").trim().toLowerCase();
  const isOwner = String(role || "").trim().toLowerCase() === "empleador";
  const effectiveScope = !isOwner ? "mine" : requestedScope === "others" ? "others" : requestedScope === "mine" ? "mine" : "all";

  let salesQuery = db
    .collection("tenants")
    .doc(tenantId)
    .collection("ventas")
    .where("cajaCerrada", "==", false);

  if (effectiveScope === "mine") {
    salesQuery = salesQuery.where("usuarioUid", "==", uid);
  }

  const salesSnap = await salesQuery.get();
  const rows = salesSnap.docs
    .map((docSnap) => {
      const sale = docSnap.data() || {};
      return { docId: docSnap.id, sale };
    })
    .filter(({ sale }) => {
      if (effectiveScope !== "others") return true;
      return String(sale.usuarioUid || "") !== String(uid);
    });

  const sales = rows
    .map((row) => {
      const sale = row.sale || {};
      return {
        idVenta: String(sale.idVenta || row.docId || ""),
        usuarioUid: String(sale.usuarioUid || ""),
        usuarioNombre: String(sale.usuarioNombre || sale.username || "-"),
        total: Number(sale.total || 0),
        totalCost: Number(sale.totalCost ?? sale.totalCosto ?? 0),
        gananciaReal: Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0),
        itemsCount: Number(sale.itemsCount || 0),
        cajaCerrada: sale.cajaCerrada === true,
        createdAt: normalizeToIso(sale.createdAt)
      };
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  return {
    success: true,
    sales
  };
});

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

module.exports = {
  getOpenCashSales
};
