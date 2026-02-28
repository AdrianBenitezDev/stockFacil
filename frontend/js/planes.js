import { collection, doc, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firestoreDb } from "../config.js";
import { ensureCurrentUserProfile, getCurrentSession } from "./auth.js";

const plansCards = document.getElementById("plans-cards");
const plansFeedback = document.getElementById("plans-feedback");

init().catch((error) => {
  console.error("No se pudo inicializar la pantalla de planes:", error);
  setFeedback("No se pudo cargar planes. Revisa permisos y conexion.");
});

async function init() {
  if (!plansCards || !plansFeedback) return;
  setFeedback("Validando sesion...");

  const profileResult = await ensureCurrentUserProfile();
  if (!profileResult?.ok) {
    setFeedback(profileResult?.error || "Sesion invalida.");
    window.setTimeout(() => {
      window.location.href = "index.html";
    }, 800);
    return;
  }

  const session = getCurrentSession();
  if (!session?.tenantId) {
    setFeedback("No se pudo resolver el tenant del usuario.");
    return;
  }

  setFeedback("Cargando planes...");
  const [plans, currentPlanId] = await Promise.all([
    loadPlans(),
    resolveCurrentPlanId(session)
  ]);

  if (!plans.length) {
    plansCards.innerHTML = "";
    setFeedback("No hay planes activos disponibles en Firebase.");
    return;
  }

  renderPlanCards(plans, currentPlanId);
  if (currentPlanId) {
    setFeedback(`Plan actual: ${currentPlanId}.`);
  } else {
    setFeedback("No se pudo detectar el plan actual del usuario.");
  }
}

async function loadPlans() {
  const snap = await getDocs(collection(firestoreDb, "planes"));
  const data = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  return normalizePlans(data);
}

async function resolveCurrentPlanId(session) {
  const candidates = [session?.planActual];

  try {
    const tenantRef = doc(firestoreDb, "tenants", String(session?.tenantId || "").trim());
    const tenantSnap = await getDoc(tenantRef);
    if (tenantSnap.exists()) {
      const tenant = tenantSnap.data() || {};
      candidates.push(tenant?.plan, tenant?.planId, tenant?.planActual, tenant?.subscription?.planId, tenant?.suscripcion?.planId);
    }
  } catch (error) {
    // permisos de tenants pueden variar por regla; usamos fallback con session.planActual
    console.warn("No se pudo leer plan del tenant, se usa fallback de sesion:", error?.message || error);
  }

  for (const value of candidates) {
    const normalized = normalizePlanId(value);
    if (normalized) return normalized;
  }
  return "";
}

function normalizePlans(source) {
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => {
      const id = normalizePlanId(item?.id);
      return {
        id,
        titulo: String(item?.titulo || item?.nombre || id || "").trim(),
        precio: String(item?.precio || item?.precioMensual || "").trim(),
        descripcion: String(item?.descripcion || "").trim(),
        maxEmpleados: resolveMaxEmployees(item),
        caracteristicas: Array.isArray(item?.caracteristicas)
          ? item.caracteristicas.map((entry) => String(entry || "").trim()).filter(Boolean)
          : [],
        activo: toBoolean(item?.activo, true),
        orden: Number(item?.orden || 0)
      };
    })
    .filter((item) => item.activo && Boolean(item.id))
    .sort((a, b) => a.orden - b.orden);
}

function resolveMaxEmployees(item) {
  const value = Number(item?.maxEmpleados ?? item?.maxEmployees ?? item?.empleadosMax ?? item?.limiteEmpleados ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function renderPlanCards(plans, currentPlanId) {
  plansCards.innerHTML = plans
    .map((plan) => {
      const isCurrent = plan.id === currentPlanId;
      const employeesLine = plan.maxEmpleados > 0 ? `Hasta ${plan.maxEmpleados} empleados` : "Limite de empleados no definido";
      const featuresLine = plan.caracteristicas.length ? plan.caracteristicas.map((entry) => escapeHtml(entry)).join(" | ") : "Sin caracteristicas cargadas";
      return [
        `<article class="plan-card${isCurrent ? " is-selected" : ""}" data-plan-id="${escapeHtml(plan.id)}">`,
        `<span class="plan-card-title">${escapeHtml(plan.titulo || plan.id)}</span>`,
        `<span class="plan-card-price">${escapeHtml(plan.precio || "-")}</span>`,
        `<span class="plan-card-description">${escapeHtml(plan.descripcion || employeesLine)}</span>`,
        `<span class="plan-card-features">${escapeHtml(employeesLine)}</span>`,
        `<span class="plan-card-features">${featuresLine}</span>`,
        isCurrent ? '<span class="plan-card-current">Plan actual</span>' : "",
        "</article>"
      ].join("");
    })
    .join("");
}

function normalizePlanId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("prueba") || raw === "trial") return "prueba";
  if (raw.includes("basico") || raw === "basic" || raw.includes("standard")) return "standard";
  if (raw === "pro" || raw.includes("premium")) return "premium";
  return raw;
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function setFeedback(message) {
  if (!plansFeedback) return;
  plansFeedback.textContent = String(message || "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
