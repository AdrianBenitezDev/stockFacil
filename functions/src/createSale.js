const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { requireTenantMemberContext } = require("./shared/authz");

const createSale = onCall(async (request) => {
  const { uid, tenantId, caller } = await requireTenantMemberContext(request);

  const payload = request.data || {};
  const requestedId = String(payload.idVenta || "").trim();
  const idVenta = requestedId || `V-${Date.now()}`;
  const rawItems = Array.isArray(payload.productos) ? payload.productos : [];
  if (rawItems.length === 0) {
    throw new HttpsError("invalid-argument", "No hay productos para cobrar.");
  }
  if (rawItems.length > 200) {
    throw new HttpsError("invalid-argument", "Maximo 200 items por venta.");
  }

  const grouped = new Map();
  for (const row of rawItems) {
    const codigo = String(row?.codigo || "").trim();
    const cantidad = Number(row?.cantidad || 0);
    if (!codigo) {
      throw new HttpsError("invalid-argument", "Cada item debe incluir codigo.");
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new HttpsError("invalid-argument", `Cantidad invalida para ${codigo}.`);
    }
    grouped.set(codigo, (grouped.get(codigo) || 0) + Math.trunc(cantidad));
  }

  const now = Timestamp.now();
  const saleItems = [];
  let total = 0;
  let totalCosto = 0;
  let ganaciaReal = 0;
  let itemsCount = 0;

  const batch = db.batch();

  for (const [codigo, cantidad] of grouped.entries()) {
    const productRef = db.collection("tenants").doc(tenantId).collection("productos").doc(codigo);
    const productSnap = await productRef.get();
    if (!productSnap.exists) {
      throw new HttpsError("failed-precondition", `Producto no encontrado: ${codigo}.`);
    }

    const product = productSnap.data() || {};
    const stock = Number(product.stock || 0);
    if (stock < cantidad) {
      throw new HttpsError("failed-precondition", `Stock insuficiente para ${codigo}. Disponible: ${stock}.`);
    }

    const precioVenta = Number(product.precioVenta ?? product.precio ?? 0);
    const precioCompra = Number(product.precioCompra ?? product.costoProveedor ?? 0);
    if (!Number.isFinite(precioVenta) || precioVenta < 0) {
      throw new HttpsError("failed-precondition", `Precio de venta invalido en ${codigo}.`);
    }
    if (!Number.isFinite(precioCompra) || precioCompra < 0) {
      throw new HttpsError("failed-precondition", `Precio de compra invalido en ${codigo}.`);
    }

    const subtotal = round2(precioVenta * cantidad);
    const subtotalCosto = round2(precioCompra * cantidad);
    const ganaciaRealVenta = round2((precioVenta - precioCompra) * cantidad);

    saleItems.push({
      codigo,
      nombre: String(product.nombre || "-"),
      cantidad,
      precioUnitario: round2(precioVenta),
      precioCompraUnitario: round2(precioCompra),
      subtotal,
      subtotalCosto,
      ganaciaRealVenta
    });

    total += subtotal;
    totalCosto += subtotalCosto;
    ganaciaReal += ganaciaRealVenta;
    itemsCount += cantidad;

    batch.update(productRef, {
      stock: stock - cantidad,
      updatedAt: now
    });
  }

  total = round2(total);
  totalCosto = round2(totalCosto);
  ganaciaReal = round2(ganaciaReal);

  const saleRef = db.collection("tenants").doc(tenantId).collection("ventas").doc(idVenta);
  batch.set(saleRef, {
    idVenta,
    tenantId,
    productos: saleItems,
    total,
    totalCosto,
    ganaciaReal,
    usuarioUid: uid,
    usuarioNombre: String(caller.username || caller.displayName || "usuario"),
    cajaCerrada: false,
    backups: true,
    itemsCount,
    createdAt: now
  });

  await batch.commit();

  return {
    success: true,
    idVenta,
    totalCalculado: total,
    totalCosto,
    ganaciaReal,
    itemsCount,
    productos: saleItems
  };
});

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

module.exports = {
  createSale
};
