const { HttpsError, onCall, db } = require("./shared/context");
const { requireEmployerContext } = require("./shared/authz");

const deleteCashRecord = onCall(async (request) => {
  const { tenantId } = await requireEmployerContext(request);

  const recordType = String(request.data?.recordType || "").trim().toLowerCase();
  const recordId = String(request.data?.recordId || "").trim();
  if (!recordId) {
    throw new HttpsError("invalid-argument", "Falta recordId.");
  }
  if (recordType !== "sale" && recordType !== "closure") {
    throw new HttpsError("invalid-argument", "recordType invalido.");
  }

  const collectionName = recordType === "sale" ? "ventas" : "cajas";
  const ref = db.collection("tenants").doc(tenantId).collection(collectionName).doc(recordId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { success: true, deleted: false, recordType, recordId };
  }

  await ref.delete();
  return { success: true, deleted: true, recordType, recordId };
});

module.exports = {
  deleteCashRecord
};
