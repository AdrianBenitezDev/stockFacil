import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  doc,
  getDocs,
  getDoc,
  query,
  serverTimestamp,
  setDoc,
  where,
  collection
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { ensureFirebaseAuth, firebaseAuth, firebaseConfig, firestoreDb } from "../config.js";
import { FIRESTORE_COLLECTIONS } from "./config.js";
import { syncLoginEventToFirestore } from "./firebase_sync.js";

let currentSession = null;
let loginSyncedForUid = null;

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export async function registerBusinessOwner({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");
  if (!normalizedEmail || !normalizedPassword) {
    return { ok: false, error: "Completa email y contrasena." };
  }
  if (normalizedPassword.length < 6) {
    return { ok: false, error: "La contrasena debe tener al menos 6 caracteres." };
  }

  await ensureFirebaseAuth();
  try {
    const existingByEmail = await getDocs(
      query(collection(firestoreDb, FIRESTORE_COLLECTIONS.usuarios), where("email", "==", normalizedEmail))
    );
    if (!existingByEmail.empty) {
      return { ok: false, error: "Este usuario ya esta registrado." };
    }

    const credential = await createUserWithEmailAndPassword(
      firebaseAuth,
      normalizedEmail,
      normalizedPassword
    );
    const authUser = credential.user;
    const kioscoId = `K-${Date.now()}`;
    const profileRef = doc(firestoreDb, FIRESTORE_COLLECTIONS.usuarios, authUser.uid);
    await setDoc(profileRef, {
      uid: authUser.uid,
      email: normalizedEmail,
      tipo: "empleador",
      role: "empleador",
      kioscoId,
      tenantId: kioscoId,
      estado: "activo",
      activo: true,
      fechaCreacion: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    return { ok: true, kioscoId };
  } catch (error) {
    const message = String(error?.message || "");
    const code = String(error?.code || "");
    if (code.includes("email-already-in-use")) {
      return { ok: false, error: "Este usuario ya esta registrado." };
    }
    if (code.includes("invalid-email")) {
      return { ok: false, error: "Email invalido." };
    }
    if (code.includes("weak-password")) {
      return { ok: false, error: "La contrasena es demasiado debil." };
    }
    return { ok: false, error: message || "No se pudo registrar el negocio." };
  }
}

export async function createAuthUserForRegistration({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");
  if (!normalizedEmail || !normalizedPassword) {
    return { ok: false, error: "Completa email y contrasena." };
  }
  if (normalizedPassword.length < 6) {
    return { ok: false, error: "La contrasena debe tener al menos 6 caracteres." };
  }

  await ensureFirebaseAuth();
  try {
    const credential = await createUserWithEmailAndPassword(
      firebaseAuth,
      normalizedEmail,
      normalizedPassword
    );
    const authUser = credential.user;
    const idToken = await authUser.getIdToken();
    return { ok: true, uid: authUser.uid, idToken };
  } catch (error) {
    const code = String(error?.code || "");
    if (code.includes("email-already-in-use")) {
      return { ok: false, error: "Este usuario ya esta registrado." };
    }
    if (code.includes("invalid-email")) {
      return { ok: false, error: "Email invalido." };
    }
    if (code.includes("weak-password")) {
      return { ok: false, error: "La contrasena es demasiado debil." };
    }
    return { ok: false, error: "No se pudo crear el usuario." };
  }
}

export async function rollbackAuthUserIfNeeded() {
  await ensureFirebaseAuth();
  const authUser = firebaseAuth.currentUser;
  if (!authUser) return;
  try {
    await deleteUser(authUser);
  } catch (_) {
    // no-op
  }
}

export async function signInWithCredentials({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");
  if (!normalizedEmail || !normalizedPassword) {
    return { ok: false, error: "Completa email y contrasena." };
  }

  await ensureFirebaseAuth();
  try {
    await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, normalizedPassword);
    return { ok: true };
  } catch (error) {
    const code = String(error?.code || "");
    if (code.includes("invalid-credential") || code.includes("wrong-password")) {
      return { ok: false, error: "Credenciales invalidas." };
    }
    if (code.includes("user-disabled")) {
      return { ok: false, error: "Usuario deshabilitado." };
    }
    if (code.includes("user-not-found")) {
      return { ok: false, error: "Usuario no encontrado." };
    }
    return { ok: false, error: "No se pudo iniciar sesion." };
  }
}

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

  const resolved = await resolveUserProfile(authUser.uid);
  if (!resolved) {
    currentSession = null;
    return {
      ok: false,
      error: "No existe perfil de usuario en Firestore."
    };
  }

  const profile = resolved.profile;
  const profileRef = resolved.ref;
  const tenantId = String(profile.kioscoId || profile.tenantId || profile.comercioId || "").trim();
  const role = normalizeRole(profile.tipo || profile.role || "empleado");
  const estado = String(profile.estado || (profile.activo === false ? "inactivo" : "activo")).trim();

  if (!tenantId) {
    currentSession = null;
    return { ok: false, error: "El perfil no tiene kioscoId valido." };
  }

  // Si Auth ya marca email verificado, actualiza Firestore en segundo plano.
  if (role === "empleador" && profile.correoVerificado !== true && authUser.emailVerified === true) {
    await syncVerifiedEmailFlag();
    const refreshedSnap = await getDoc(profileRef);
    if (refreshedSnap.exists()) {
      Object.assign(profile, refreshedSnap.data() || {});
    }
  }

  const canCreateProducts =
    role === "empleador"
      ? true
      : profile.puedeCrearProductos === true || String(profile.puedeCrearProductos || "").toLowerCase() === "true";

  currentSession = {
    userId: authUser.uid,
    uid: authUser.uid,
    email: authUser.email || profile.email || "",
    displayName: profile.displayName || authUser.displayName || authUser.email || "Usuario",
    role,
    tipo: role,
    tenantId,
    kioscoId: tenantId,
    estado,
    correoVerificado: role === "empleado" ? authUser.emailVerified === true : profile.correoVerificado === true,
    puedeCrearProductos: canCreateProducts,
    canCreateProducts,
    username: profile.username || authUser.email || authUser.uid,
    loggedAt: new Date().toISOString()
  };

  if (loginSyncedForUid !== authUser.uid) {
    await syncLoginEventToFirestore(currentSession);
    loginSyncedForUid = authUser.uid;
  }

  return { ok: true, user: currentSession };
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "dueno" ? "empleador" : role;
}

async function resolveUserProfile(uid) {
  const userRef = doc(firestoreDb, FIRESTORE_COLLECTIONS.usuarios, uid);
  const userSnap = await getDoc(userRef);
  if (userSnap.exists()) {
    return { profile: userSnap.data() || {}, ref: userRef };
  }

  const employeeRef = doc(firestoreDb, FIRESTORE_COLLECTIONS.empleados, uid);
  const employeeSnap = await getDoc(employeeRef);
  if (employeeSnap.exists()) {
    return { profile: employeeSnap.data() || {}, ref: employeeRef };
  }

  return null;
}

async function syncVerifiedEmailFlag() {
  const authUser = firebaseAuth.currentUser;
  if (!authUser) return;

  try {
    const idToken = await authUser.getIdToken(true);
    await fetch(getMarkVerifiedEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      }
    });
  } catch (error) {
    console.warn("No se pudo sincronizar correoVerificado:", error?.message || error);
  }
}

function getMarkVerifiedEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/markEmployerEmailVerified`;
}
