/* eslint-disable no-console */
const { initializeApp, applicationDefault, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = {
    apply: false,
    tenantId: "",
    serviceAccount: "",
    batchSize: 350
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").trim();
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--tenantId") {
      args.tenantId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--serviceAccount") {
      args.serviceAccount = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (token === "--batchSize") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.batchSize = Math.max(1, Math.min(450, Math.trunc(parsed)));
      }
      i += 1;
    }
  }

  return args;
}

function initAdmin(serviceAccountPath) {
  if (getApps().length > 0) return;

  const absolutePath = serviceAccountPath
    ? path.resolve(process.cwd(), serviceAccountPath)
    : "";

  if (absolutePath && fs.existsSync(absolutePath)) {
    const json = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    initializeApp({ credential: cert(json) });
    return;
  }

  initializeApp({ credential: applicationDefault() });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  initAdmin(args.serviceAccount);
  const db = getFirestore();

  const targetTenants = [];
  if (args.tenantId) {
    const tenantRef = db.collection("tenants").doc(args.tenantId);
    const tenantSnap = await tenantRef.get();
    if (!tenantSnap.exists) {
      throw new Error(`No existe tenant: ${args.tenantId}`);
    }
    targetTenants.push(tenantSnap);
  } else {
    const tenantsSnap = await db.collection("tenants").get();
    tenantsSnap.forEach((docSnap) => targetTenants.push(docSnap));
  }

  let scanned = 0;
  let alreadyOk = 0;
  let needsUpdate = 0;
  let updated = 0;
  let skippedByTenant = 0;

  let batch = db.batch();
  let writesInBatch = 0;

  for (const tenantDoc of targetTenants) {
    const tenantId = String(tenantDoc.id || "").trim();
    if (!tenantId) {
      skippedByTenant += 1;
      continue;
    }

    const productsSnap = await db.collection("tenants").doc(tenantId).collection("productos").get();
    for (const productDoc of productsSnap.docs) {
      scanned += 1;
      const row = productDoc.data() || {};
      const tipoVenta = String(row.tipoVenta || "").trim().toLowerCase();
      const unidadMedida = String(row.unidadMedida || "").trim().toLowerCase();
      const needsTipoVenta = !tipoVenta;
      const needsUnidad = !unidadMedida;

      if (!needsTipoVenta && !needsUnidad) {
        alreadyOk += 1;
        continue;
      }

      needsUpdate += 1;
      if (!args.apply) continue;

      batch.set(
        productDoc.ref,
        {
          ...(needsTipoVenta ? { tipoVenta: "unidad" } : {}),
          ...(needsUnidad ? { unidadMedida: "u" } : {}),
          updatedAt: FieldValue.serverTimestamp(),
          migratedTipoVentaAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      writesInBatch += 1;

      if (writesInBatch >= args.batchSize) {
        await batch.commit();
        updated += writesInBatch;
        batch = db.batch();
        writesInBatch = 0;
      }
    }
  }

  if (args.apply && writesInBatch > 0) {
    await batch.commit();
    updated += writesInBatch;
  }

  console.log("=== Migracion tipoVenta por defecto ===");
  console.log(`Modo: ${args.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Tenant filtro: ${args.tenantId || "(todos)"}`);
  console.log(`Tenants evaluados: ${targetTenants.length}`);
  console.log(`Tenants omitidos por id invalido: ${skippedByTenant}`);
  console.log(`Productos escaneados: ${scanned}`);
  console.log(`Productos ya correctos: ${alreadyOk}`);
  console.log(`Productos a actualizar: ${needsUpdate}`);
  console.log(`Productos actualizados: ${updated}`);
  if (!args.apply) {
    console.log("No se escribieron cambios. Ejecuta con --apply para aplicar.");
  }
}

run().catch((error) => {
  console.error("Fallo migracion tipoVenta:", error?.message || error);
  process.exitCode = 1;
});
