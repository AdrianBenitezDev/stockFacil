const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const syncProducts = onCall(async (request) => {
  const { tenantId, role, caller } = await requireTenantMemberContext(request);
  const normalizedRole = String(role || caller?.role || "").trim().toLowerCase();
  const canSyncProducts =
    normalizedRole === "empleador" ||
    caller?.canCreateProducts === true ||
    caller?.puedeCrearProductos === true ||
    caller?.canEditProducts === true ||
    caller?.puedeEditarProductos === true;
  if (!canSyncProducts) {
    throw new HttpsError("permission-denied", "No tienes permisos para sincronizar productos.");
  }

  const products = Array.isArray(request.data?.products) ? request.data.products : [];
  if (products.length === 0) {
    return { success: true, syncedIds: [] };
  }
  if (products.length > 500) {
    throw new HttpsError("invalid-argument", "Maximo 500 productos por sincronizacion.");
  }

  const now = Timestamp.now();
  const syncedIds = [];
  let batch = db.batch();
  let writesInBatch = 0;

  for (const input of products) {
    const product = normalizeProductForSync(input, tenantId);
    const productRef = db.collection("tenants").doc(tenantId).collection("productos").doc(product.codigo);

    batch.set(
      productRef,
      {
        codigo: product.codigo,
        nombre: product.nombre,
        precioVenta: product.precioVenta,
        precioCompra: product.precioCompra,
        categoria: product.categoria,
        stock: product.stock,
        tipoVenta: product.tipoVenta,
        unidadMedida: product.unidadMedida,
        gramosPorUnidad: product.gramosPorUnidad,
        gramsPerUnit: product.gramosPorUnidad,
        gramosAcumuladosPendientes: product.gramosAcumuladosPendientes,
        gramsPending: product.gramosAcumuladosPendientes,
        tieneCodigoBarras: product.tieneCodigoBarras,
        tenantId,
        synced: true,
        createdAt: product.createdAt,
        updatedAt: now,
        syncedAt: now
      },
      { merge: true }
    );

    syncedIds.push(product.codigo);
    writesInBatch += 1;
    if (writesInBatch >= 400) {
      await batch.commit();
      batch = db.batch();
      writesInBatch = 0;
    }
  }

  if (writesInBatch > 0) {
    await batch.commit();
  }

  return { success: true, syncedIds };
});

function normalizeProductForSync(input, tenantId) {
  const codigo = String(input?.codigo || "").trim();
  const nombre = String(input?.nombre || "").trim();
  const categoria = String(input?.categoria || "").trim();
  const precioVenta = Number(input?.precioVenta);
  const precioCompra = Number(input?.precioCompra);
  const stock = Number(input?.stock);
  const tipoVenta = normalizeSaleType(input?.tipoVenta);
  const unidadMedida = tipoVenta === "gramos" ? "g" : "u";
  const gramosPorUnidad = Math.trunc(Number(input?.gramosPorUnidad ?? input?.gramsPerUnit ?? 0));
  const gramosAcumuladosPendientes = Number(input?.gramosAcumuladosPendientes ?? input?.gramsPending ?? 0);
  const tieneCodigoBarras = Boolean(input?.tieneCodigoBarras);
  const createdAt = Number(input?.createdAt);
  const inputTenant = String(input?.tenantId || "").trim();

  if (!codigo || !nombre) {
    throw new HttpsError("invalid-argument", "Producto invalido: codigo y nombre son obligatorios.");
  }
  if (!Number.isFinite(precioVenta) || precioVenta < 0) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): precioVenta.`);
  }
  if (!Number.isFinite(precioCompra) || precioCompra < 0) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): precioCompra.`);
  }
  if (!Number.isFinite(stock) || stock < 0) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): stock.`);
  }
  if (tipoVenta === "gramos" && (!Number.isFinite(gramosPorUnidad) || gramosPorUnidad <= 0)) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): gramosPorUnidad.`);
  }
  if (!Number.isFinite(gramosAcumuladosPendientes) || gramosAcumuladosPendientes < 0) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): gramosAcumuladosPendientes.`);
  }
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new HttpsError("invalid-argument", `Producto invalido (${codigo}): createdAt.`);
  }
  if (inputTenant && inputTenant !== tenantId) {
    throw new HttpsError("permission-denied", `Tenant invalido en producto ${codigo}.`);
  }

  return {
    codigo,
    nombre,
    categoria: categoria || null,
    precioVenta: Number(precioVenta.toFixed(2)),
    precioCompra: Number(precioCompra.toFixed(2)),
    stock: Math.trunc(stock),
    tipoVenta,
    unidadMedida,
    gramosPorUnidad: tipoVenta === "gramos" ? Math.trunc(gramosPorUnidad) : 0,
    gramosAcumuladosPendientes: tipoVenta === "gramos" ? Number(Number(gramosAcumuladosPendientes || 0).toFixed(2)) : 0,
    tieneCodigoBarras,
    createdAt
  };
}

function normalizeSaleType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "gramos" || normalized === "g") return "gramos";
  return "unidad";
}

module.exports = {
  syncProducts
};
