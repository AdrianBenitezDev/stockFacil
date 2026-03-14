import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firestoreDb } from "../config.js";

const plansCards = document.getElementById("plans-cards");
const plansFeedback = document.getElementById("plans-feedback");
const REGISTER_URL = "../registro.html";

init().catch((error) => {
  console.error("No se pudo inicializar preciosPlanes:", error);
  setFeedback("No se pudieron cargar planes. Revisa tu conexion.");
});

async function init() {
  if (!plansCards || !plansFeedback) return;
  plansCards.addEventListener("click", handlePlanCardClick);

  setFeedback("Cargando planes...");
  const plans = await loadPlans();
  if (!plans.length) {
    plansCards.innerHTML = "";
    setFeedback("No hay planes activos disponibles.");
    return;
  }

  renderPlanCards(plans);
  setFeedback("Planes actualizados.");
}

async function loadPlans() {
  const snap = await getDocs(collection(firestoreDb, "planes"));
  const data = snap.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() || {}) }));
  return normalizePlans(data);
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

function renderPlanCards(plans) {
  plansCards.innerHTML = plans
    .map((plan) => {
      const employeesLine = plan.maxEmpleados > 0 ? `Hasta ${plan.maxEmpleados} empleados` : "Limite de empleados no definido";
      const featuresLine = plan.caracteristicas.length
        ? plan.caracteristicas.map((entry) => escapeHtml(entry)).join(" | ")
        : "Sin caracteristicas cargadas";

      return [
        `<article class="plan-card" data-plan-id="${escapeHtml(plan.id)}">`,
        `<span class="plan-card-title">${escapeHtml(plan.titulo || plan.id)}</span>`,
        `<span class="plan-card-price">${escapeHtml(plan.precio || "-")}</span>`,
        `<span class="plan-card-description">${escapeHtml(plan.descripcion || employeesLine)}</span>`,
        `<span class="plan-card-features">${escapeHtml(employeesLine)}</span>`,
        `<span class="plan-card-features">${featuresLine}</span>`,
        "</article>"
      ].join("");
    })
    .join("");
}

function handlePlanCardClick(event) {
  const card = event.target.closest("[data-plan-id]");
  if (!card) return;

  const shouldGoToRegister = window.confirm(
    "Seleccionaste un plan. Quieres ir a la seccion de registro?"
  );
  if (!shouldGoToRegister) return;
  window.location.href = REGISTER_URL;
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
