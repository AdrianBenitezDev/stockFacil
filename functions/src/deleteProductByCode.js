const { HttpsError, onCall, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const deleteProductByCode = onCall(async (request) => {
  const { tenantId } = await requireEmployerContext(request, { requireOwner: true });

  const codigo = String(request.data?.codigo || "").trim();
  if (!codigo) {
    throw new HttpsError("invalid-argument", "Debes enviar el codigo del producto.");
  }

  const batch = db.batch();

  const tenantProductRef = db.collection("tenants").doc(tenantId).collection("productos").doc(codigo);
  batch.delete(tenantProductRef);

  const legacyByBarcodeSnap = await db
    .collection("productos")
    .where("tenantId", "==", tenantId)
    .where("barcode", "==", codigo)
    .get();
  legacyByBarcodeSnap.docs.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  const legacyByCodigoSnap = await db
    .collection("productos")
    .where("tenantId", "==", tenantId)
    .where("codigo", "==", codigo)
    .get();
  legacyByCodigoSnap.docs.forEach((docSnap) => {
    batch.delete(docSnap.ref);
  });

  await batch.commit();
  return { success: true, codigo };
});

module.exports = {
  deleteProductByCode
};
