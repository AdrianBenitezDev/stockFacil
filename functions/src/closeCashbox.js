const { HttpsError, onCall, Timestamp, db } = require("./shared/context");
const { getStorage } = require("firebase-admin/storage");
const { createHash } = require("node:crypto");
const { requireTenantMemberContext } = require("./shared/authz");

const closeCashbox = onCall(async (request) => {
  const { uid, tenantId, role, caller } = await requireTenantMemberContext(request);

  const turnoId = String(request.data?.turnoId || "").trim();
  const requestedScope = String(request.data?.scope || "").trim().toLowerCase();
  const normalizedRole = String(role || "").trim().toLowerCase();
  const isOwner = normalizedRole === "empleador";
  const effectiveScope = !isOwner ? "mine" : requestedScope === "others" ? "others" : requestedScope === "mine" ? "mine" : "all";
  const closeTimestampMs = Date.now();
  const closedByUid = String(uid || "").trim();
  const closedByName = String(caller?.displayName || caller?.username || caller?.email || uid).trim();

  let salesQuery = db
    .collection("tenants")
    .doc(tenantId)
    .collection("ventas")
    .where("cajaCerrada", "==", false);

  if (effectiveScope === "mine") {
    salesQuery = salesQuery.where("usuarioUid", "==", uid);
  }

  const salesSnap = await salesQuery.get();
  const targetSalesDocs = salesSnap.docs.filter((docSnap) => {
    if (effectiveScope !== "others") return true;
    const sale = docSnap.data() || {};
    return String(sale.usuarioUid || "") !== String(uid);
  });

  if (targetSalesDocs.length === 0) {
    throw new HttpsError("failed-precondition", "No hay ventas pendientes para cerrar caja.");
  }

  const groupedBySeller = buildSellerGroups(targetSalesDocs);
  const groupEntries = Array.from(groupedBySeller.values());
  const fechaCierre = Timestamp.now();
  const operationId = `CLOSE-${tenantId}-${closeTimestampMs}-${Math.trunc(Math.random() * 100000)}`;
  const backupInfo = await createCashboxBackupInStorage({
    tenantId,
    turnoId,
    effectiveScope,
    closeTimestampMs,
    closedByUid,
    closedByName,
    operationId,
    salesDocs: targetSalesDocs,
    groups: groupEntries
  });
  const batch = db.batch();

  const closures = groupEntries.map((group, index) => {
    const safeUserId = sanitizeIdPart(group.usuarioUid || "sin-usuario");
    const idCaja = turnoId
      ? `CAJA-${turnoId}-${safeUserId}-${closeTimestampMs}-${index + 1}`
      : `CAJA-${safeUserId}-${closeTimestampMs}-${index + 1}`;
    const productosIncluidos = Array.from(group.productosIncluidosMap.values()).sort((a, b) =>
      String(a.idProducto || "").localeCompare(String(b.idProducto || ""))
    );
    const roleForClosure = String(group.role || (group.usuarioUid === closedByUid ? role : "empleado"));
    const scopeKey = String(group.usuarioUid || "sin-usuario");

    const cajaRef = db.collection("tenants").doc(tenantId).collection("cajas").doc(idCaja);
    batch.set(cajaRef, {
      idCaja,
      tenantId,
      dateKey: turnoId || null,
      scopeKey,
      total: group.totalCaja,
      efectivoEntregar: group.totalEfectivoEntregar,
      virtualEntregar: group.totalVirtualEntregar,
      GanaciaRealCaja: group.totalGananciaRealCaja,
      totalGananciaRealCaja: group.totalGananciaRealCaja,
      usuarioUid: group.usuarioUid,
      usuarioNombre: group.usuarioNombre,
      role: roleForClosure,
      fechaApertura: group.fechaApertura ? Timestamp.fromDate(group.fechaApertura) : fechaCierre,
      fechaCierre,
      productosIncluidos,
      salesCount: Number(group.ventasIncluidas.length || 0),
      closedByUid,
      closedByName,
      backupPath: backupInfo.path,
      backupMd5: backupInfo.md5,
      backupSizeBytes: backupInfo.sizeBytes,
      backupCreatedAt: Timestamp.now(),
      operationId,
      createdAt: Timestamp.now()
    });
    group.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });

    return {
      idCaja,
      scopeKey,
      usuarioUid: group.usuarioUid,
      usuarioNombre: group.usuarioNombre,
      role: roleForClosure,
      totalCaja: group.totalCaja,
      efectivoEntregar: group.totalEfectivoEntregar,
      virtualEntregar: group.totalVirtualEntregar,
      totalGananciaRealCaja: group.totalGananciaRealCaja,
      salesCount: Number(group.ventasIncluidas.length || 0),
      productosIncluidos
    };
  });

  await batch.commit();

  const totalSalesCount = closures.reduce((acc, closure) => acc + Number(closure.salesCount || 0), 0);
  const totalCaja = round2(closures.reduce((acc, closure) => acc + Number(closure.totalCaja || 0), 0));
  const totalEfectivoEntregar = round2(
    closures.reduce((acc, closure) => acc + Number(closure.efectivoEntregar || 0), 0)
  );
  const totalVirtualEntregar = round2(
    closures.reduce((acc, closure) => acc + Number(closure.virtualEntregar || 0), 0)
  );
  const totalGananciaRealCaja = round2(
    closures.reduce((acc, closure) => acc + Number(closure.totalGananciaRealCaja || 0), 0)
  );
  const productosIncluidos = mergeClosureProducts(closures);

  return {
    success: true,
    idCaja: closures.length === 1 ? String(closures[0].idCaja || "") : "",
    totalCaja,
    totalEfectivoEntregar,
    totalVirtualEntregar,
    efectivoEntregar: totalEfectivoEntregar,
    virtualEntregar: totalVirtualEntregar,
    totalGananciaRealCaja,
    totalSalesCount,
    productosIncluidos,
    backup: {
      operationId,
      path: backupInfo.path,
      md5: backupInfo.md5,
      sizeBytes: backupInfo.sizeBytes
    },
    cierres: closures
  };
});

async function createCashboxBackupInStorage({
  tenantId,
  turnoId,
  effectiveScope,
  closeTimestampMs,
  closedByUid,
  closedByName,
  operationId,
  salesDocs,
  groups
}) {
  const date = new Date(closeTimestampMs);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const safeUsuario = sanitizeIdPart(closedByName || closedByUid || "usuario");
  const filePath = `tenants/${tenantId}/ventas/all_ventas_${safeUsuario}_${yyyy}${mm}${dd}_${closeTimestampMs}.json`;

  const ventas = salesDocs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data()
  }));
  const cierresPreview = groups.map((group) => ({
    usuarioUid: String(group.usuarioUid || ""),
    usuarioNombre: String(group.usuarioNombre || ""),
    totalCaja: round2(Number(group.totalCaja || 0)),
    efectivoEntregar: round2(Number(group.totalEfectivoEntregar || 0)),
    virtualEntregar: round2(Number(group.totalVirtualEntregar || 0)),
    totalGananciaRealCaja: round2(Number(group.totalGananciaRealCaja || 0)),
    salesCount: Number(group.ventasIncluidas?.length || 0),
    ventasIncluidas: Array.isArray(group.ventasIncluidas) ? group.ventasIncluidas : []
  }));

  const payload = {
    version: 1,
    operationId,
    tenantId,
    turnoId: turnoId || null,
    scope: effectiveScope,
    createdAt: new Date(closeTimestampMs).toISOString(),
    closedByUid,
    closedByName,
    totals: {
      totalSalesCount: ventas.length,
      totalCaja: round2(cierresPreview.reduce((acc, row) => acc + Number(row.totalCaja || 0), 0)),
      totalEfectivoEntregar: round2(cierresPreview.reduce((acc, row) => acc + Number(row.efectivoEntregar || 0), 0)),
      totalVirtualEntregar: round2(cierresPreview.reduce((acc, row) => acc + Number(row.virtualEntregar || 0), 0)),
      totalGananciaRealCaja: round2(
        cierresPreview.reduce((acc, row) => acc + Number(row.totalGananciaRealCaja || 0), 0)
      )
    },
    cierres: cierresPreview,
    ventas
  };

  const rawJson = JSON.stringify(payload);
  const jsonBuffer = Buffer.from(rawJson, "utf8");
  const md5 = createHash("md5").update(jsonBuffer).digest("hex");

  const bucket = getStorage().bucket();
  const file = bucket.file(filePath);
  await file.save(jsonBuffer, {
    resumable: false,
    contentType: "application/json",
    metadata: {
      metadata: {
        operationId,
        tenantId,
        scope: String(effectiveScope || "all"),
        turnoId: String(turnoId || "")
      }
    }
  });

  return {
    path: filePath,
    md5,
    sizeBytes: jsonBuffer.length
  };
}

function buildSellerGroups(salesDocs) {
  const bySeller = new Map();
  salesDocs.forEach((docSnap) => {
    const sale = docSnap.data() || {};
    const usuarioUid = String(sale.usuarioUid || "sin-usuario").trim() || "sin-usuario";
    const usuarioNombre = String(sale.usuarioNombre || sale.username || usuarioUid).trim() || usuarioUid;
    const groupKey = usuarioUid;
    const existing = bySeller.get(groupKey);
    const createdAt = normalizeToDate(sale.createdAt);
    if (!existing) {
      const created = {
        usuarioUid,
        usuarioNombre,
        role: String(sale.role || "").trim().toLowerCase() || "",
        totalCaja: 0,
        totalEfectivoEntregar: 0,
        totalVirtualEntregar: 0,
        totalGananciaRealCaja: 0,
        fechaApertura: null,
        ventasIncluidas: [],
        productosIncluidosMap: new Map(),
        docs: []
      };
      bySeller.set(groupKey, created);
    }

    const group = bySeller.get(groupKey);
    group.docs.push(docSnap);
    group.ventasIncluidas.push(docSnap.id);
    group.totalCaja = round2(Number(group.totalCaja || 0) + Number(sale.total || 0));
    const payment = resolveSalePaymentBreakdown(sale);
    group.totalEfectivoEntregar = round2(
      Number(group.totalEfectivoEntregar || 0) + Number(payment.pagoEfectivo || 0)
    );
    group.totalVirtualEntregar = round2(
      Number(group.totalVirtualEntregar || 0) + Number(payment.pagoVirtual || 0)
    );
    group.totalGananciaRealCaja = round2(
      Number(group.totalGananciaRealCaja || 0) + Number(sale.gananciaReal ?? sale.ganaciaReal ?? sale.profit ?? 0)
    );
    collectSaleProducts(sale, group.productosIncluidosMap);
    if (createdAt && (!group.fechaApertura || createdAt < group.fechaApertura)) {
      group.fechaApertura = createdAt;
    }
  });
  return bySeller;
}

function mergeClosureProducts(closures) {
  const map = new Map();
  closures.forEach((closure) => {
    const items = Array.isArray(closure?.productosIncluidos) ? closure.productosIncluidos : [];
    items.forEach((item) => {
      const key = `${String(item?.idProducto || "").trim()}::${Number(item?.precioVenta || 0)}::${Number(
        item?.precioCompra || 0
      )}`;
      const current = map.get(key);
      if (!current) {
        map.set(key, {
          idProducto: String(item?.idProducto || "").trim(),
          cantidadVendido: round2(Number(item?.cantidadVendido || 0)),
          precioVenta: round2(Number(item?.precioVenta || 0)),
          precioCompra: round2(Number(item?.precioCompra || 0))
        });
        return;
      }
      current.cantidadVendido = round2(Number(current.cantidadVendido || 0) + Number(item?.cantidadVendido || 0));
    });
  });
  return Array.from(map.values()).sort((a, b) => String(a.idProducto || "").localeCompare(String(b.idProducto || "")));
}

function sanitizeIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48) || "sin-usuario";
}

function collectSaleProducts(sale, targetMap) {
  const items = Array.isArray(sale?.productos) ? sale.productos : [];
  items.forEach((item) => {
    const idProducto = String(
      item?.idProducto || item?.codigo || item?.productId || item?.barcode || ""
    ).trim();
    if (!idProducto) return;

    const cantidad = Number(item?.cantidad ?? item?.quantity ?? 0);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return;

    const precioVenta = round2(Number(item?.precioUnitario ?? item?.unitPrice ?? 0));
    const precioCompra = round2(Number(item?.precioCompraUnitario ?? item?.unitProviderCost ?? 0));

    const key = `${idProducto}::${precioVenta}::${precioCompra}`;
    const current = targetMap.get(key);
    if (!current) {
      targetMap.set(key, {
        idProducto,
        cantidadVendido: round2(cantidad),
        precioVenta,
        precioCompra
      });
      return;
    }

    current.cantidadVendido = round2(Number(current.cantidadVendido || 0) + cantidad);
  });
}

function normalizeToDate(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (typeof value?.toDate === "function") return value.toDate();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function resolveSalePaymentBreakdown(sale) {
  const total = round2(Number(sale?.total || 0));
  const tipoPago = String(sale?.tipoPago || "").trim().toLowerCase();

  if (tipoPago === "virtual") {
    return { pagoEfectivo: 0, pagoVirtual: total };
  }
  if (tipoPago === "mixto") {
    const pagoEfectivo = round2(Number(sale?.pagoEfectivo || 0));
    const pagoVirtual = round2(Number(sale?.pagoVirtual || total - pagoEfectivo));
    if (
      Number.isFinite(pagoEfectivo) &&
      Number.isFinite(pagoVirtual) &&
      pagoEfectivo >= 0 &&
      pagoVirtual >= 0 &&
      round2(pagoEfectivo + pagoVirtual) === total
    ) {
      return { pagoEfectivo, pagoVirtual };
    }
  }

  const explicitCash = round2(Number(sale?.pagoEfectivo || 0));
  const explicitVirtual = round2(Number(sale?.pagoVirtual || 0));
  if (explicitCash > 0 || explicitVirtual > 0) {
    const normalizedVirtual = round2(total - explicitCash);
    if (normalizedVirtual >= 0) {
      return { pagoEfectivo: explicitCash, pagoVirtual: normalizedVirtual };
    }
  }

  return { pagoEfectivo: total, pagoVirtual: 0 };
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

module.exports = {
  closeCashbox
};
