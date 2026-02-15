const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

exports.seedPlanes = functions.https.onRequest(async (req, res) => {
  try {
    // 🔐 Seguridad básica: evitar que cualquiera la ejecute
    const secret = req.query.secret;
    if (secret !== "seed-planes-2026") {
      return res.status(403).send("No autorizado");
    }

    const planes = [
      {
        id: "prueba",
        titulo: "Prueba",
        precio: "$0 / 7 dias",
        descripcion: "Ideal para validar el flujo inicial del negocio.",
        caracteristicas: [
          "Ventas y stock",
          "Sin costo inicial",
          "Soporte basico"
        ],
        activo: true,
        orden: 1,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      {
        id: "standard",
        titulo: "Standard",
        precio: "$9.99 / mes",
        descripcion: "Plan equilibrado para la operacion diaria.",
        caracteristicas: [
          "Ventas + stock + caja",
          "Sincronizacion continua",
          "Soporte prioritario"
        ],
        activo: true,
        orden: 2,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      {
        id: "premium",
        titulo: "Premium",
        precio: "$19.99 / mes",
        descripcion: "Mayor capacidad y soporte para crecimiento.",
        caracteristicas: [
          "Todo en Standard",
          "Reportes avanzados",
          "Soporte extendido"
        ],
        activo: true,
        orden: 3,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    ];

    const batch = db.batch();

    planes.forEach((plan) => {
      const ref = db.collection("admin").doc(plan.id);
      batch.set(ref, plan);
    });

    await batch.commit();

    return res.status(200).send("Planes creados correctamente ✅");

  } catch (error) {
    console.error(error);
    return res.status(500).send("Error al crear planes");
  }
});
