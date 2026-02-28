const { HttpsError, onCall, onRequest } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) {
  const bucketFromEnv = String(process.env.FIREBASE_STORAGE_BUCKET || process.env.STORAGE_BUCKET || "").trim();
  initializeApp({
    storageBucket: bucketFromEnv || "kiosco-stock-493c6.firebasestorage.app"
  });
}

const adminAuth = getAuth();
const db = getFirestore();

module.exports = {
  HttpsError,
  onCall,
  onRequest,
  Timestamp,
  adminAuth,
  db
};
