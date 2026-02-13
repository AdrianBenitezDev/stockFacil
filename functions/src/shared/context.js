const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp();
}

const adminAuth = getAuth();
const db = getFirestore();

module.exports = {
  HttpsError,
  onCall,
  Timestamp,
  adminAuth,
  db
};
