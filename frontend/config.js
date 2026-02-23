import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDyYK9NtitNWkIiK-UIPUKCZ3PwJ1a10t0",
  authDomain: "kiosco-stock-493c6.firebaseapp.com",
  projectId: "kiosco-stock-493c6",
  storageBucket: "kiosco-stock-493c6.firebasestorage.app",
  messagingSenderId: "997147264141",
  appId: "1:997147264141:web:be41c9744767e474750ec4"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const firestoreDb = initializeFirestore(firebaseApp, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});

let authReadyPromise = null;

export async function ensureFirebaseAuth() {
  if (!authReadyPromise) {
    authReadyPromise = setPersistence(firebaseAuth, browserLocalPersistence).catch((error) => {
      console.warn("No se pudo configurar persistencia de Firebase Auth:", error?.message || error);
    });
  }
  await authReadyPromise;
  return firebaseAuth.currentUser;
}
