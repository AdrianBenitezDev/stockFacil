import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";
import { ensureFirebaseAuth, firebaseApp, firebaseAuth, firestoreDb } from "../config.js";
import { FIRESTORE_COLLECTIONS } from "./config.js";
import { syncLoginEventToFirestore } from "./firebase_sync.js";

let currentSession = null;
let loginSyncedForUid = null;

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const functions = getFunctions(firebaseApp);
const bootstrapGoogleUserCallable = httpsCallable(functions, "bootstrapGoogleUser");

export async function signInWithGoogle() {
  await ensureFirebaseAuth();
  await signInWithPopup(firebaseAuth, provider);
}

export async function signOutUser() {
  currentSession = null;
  loginSyncedForUid = null;
  await signOut(firebaseAuth);
}

export function getCurrentSession() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser || !currentSession || currentSession.uid !== authUser.uid) {
    currentSession = null;
    return null;
  }
  return currentSession;
}

export async function ensureCurrentUserProfile() {
  await ensureFirebaseAuth();
  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    currentSession = null;
    return { ok: false, error: "No hay sesion iniciada.", requiresLogin: true };
  }

  try {
    await bootstrapGoogleUserCallable({});
  } catch (error) {
    return {
      ok: false,
      error: error?.message || "No se pudo inicializar tu perfil de usuario."
    };
  }

  await authUser.getIdToken(true);
  const tokenResult = await authUser.getIdTokenResult();
  const claimTenantId = String(tokenResult?.claims?.tenantId || "").trim();
  const claimRole = String(tokenResult?.claims?.role || "empleado").trim();

  const profileRef = doc(firestoreDb, FIRESTORE_COLLECTIONS.usuarios, authUser.uid);
  const profileSnap = await getDoc(profileRef);
  if (!profileSnap.exists()) {
    currentSession = null;
    return {
      ok: false,
      error: "No se encontro perfil de usuario en Firestore."
    };
  }

  const profile = profileSnap.data() || {};
  const tenantId = String(profile.tenantId || claimTenantId || "").trim();
  const role = String(profile.role || claimRole || "empleado").trim();

  if (!tenantId) {
    currentSession = null;
    return { ok: false, error: "El perfil no tiene tenantId valido." };
  }

  currentSession = {
    userId: authUser.uid,
    uid: authUser.uid,
    email: authUser.email || profile.email || "",
    displayName: profile.displayName || authUser.displayName || authUser.email || "Usuario",
    role,
    tenantId,
    username: profile.username || authUser.email || authUser.uid,
    loggedAt: new Date().toISOString()
  };

  if (loginSyncedForUid !== authUser.uid) {
    await syncLoginEventToFirestore(currentSession);
    loginSyncedForUid = authUser.uid;
  }

  return { ok: true, user: currentSession };
}
