import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { ensureFirebaseAuth, firebaseAuth, firebaseConfig, firestoreDb } from "../config.js";
import { ensureCurrentUserProfile } from "./auth.js";
import { openDatabase } from "./db.js";
import { paises } from "./paises.js";

const registerForm = document.getElementById("register-form");
const registerSubmitBtn = document.getElementById("register-submit-btn");
const backLoginBtn = document.getElementById("back-login-btn");
const registerFeedback = document.getElementById("register-feedback");
const plansFeedback = document.getElementById("register-plans-feedback");
const plansContainer = document.getElementById("register-plan-cards");
const selectedPlanInput = document.getElementById("register-plan-selected");
const countryInput = document.getElementById("register-country-input");
const countrySuggestions = document.getElementById("register-country-suggestions");
const provinceSelect = document.getElementById("register-province");
const phoneInput = document.getElementById("register-phone");
const registerEmailInput = document.getElementById("register-email");
const PROVINCES_API_URL = "https://countriesnow.space/api/v0.1/countries/states";

const DEFAULT_PLANS = [
  {
    id: "prueba",
    titulo: "Prueba",
    precio: "$20000 dias",
    descripcion: "Ideal para validar el flujo inicial del negocio.",
    caracteristicas: ["Ventas y stock", "Sin costo inicial", "Soporte basico"],
    activo: true,
    orden: 1
  },
  {
    id: "standard",
    titulo: "Standard",
    precio: "$9.99 / mes",
    descripcion: "Plan equilibrado para operaciones diarias.",
    caracteristicas: ["Ventas + stock + caja", "Sincronizacion continua", "Soporte prioritario"],
    activo: true,
    orden: 2
  },
  {
    id: "premium",
    titulo: "Premium",
    precio: "$19.99 / mes",
    descripcion: "Para operaciones con mas volumen y control.",
    caracteristicas: ["Todo en Standard", "Reportes avanzados", "Soporte extendido"],
    activo: true,
    orden: 3
  }
];

let availablePlans = [];
let currentCountryForProvinces = "";
let currentProvinceOptions = [];

init().catch((error) => {
  console.error(error);
  registerFeedback.textContent = "No se pudo iniciar el registro.";
});

async function init() {
  await ensureFirebaseAuth();
  await openDatabase();

  const result = await ensureCurrentUserProfile();
  if (result.ok) {
    window.location.href = "panel.html";
    return;
  }

  if (!firebaseAuth.currentUser) {
    registerFeedback.textContent = "Primero debes acceder como empleador con Google.";
    setDisabled(true);
    backLoginBtn.disabled = false;
    return;
  }

  initCountryAutocomplete();
  prefillEmailFromQuery();
  await loadPlans();

  phoneInput?.addEventListener("input", () => {
    phoneInput.value = String(phoneInput.value || "").replace(/\D/g, "");
  });
  countrySuggestions?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-country]");
    if (!button) return;
    const selectedCountry = String(button.getAttribute("data-country") || "").trim();
    if (!selectedCountry) return;
    selectCountry(selectedCountry);
  });
  plansContainer?.addEventListener("click", handlePlanCardClick);
  registerForm?.addEventListener("submit", handleRegisterSubmit);
  backLoginBtn?.addEventListener("click", () => {
    window.location.href = "index.html";
  });
}

function prefillEmailFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const emailFromQuery = String(params.get("email") || "").trim().toLowerCase();
  const googleEmail = String(firebaseAuth.currentUser?.email || "").trim().toLowerCase();
  const email = emailFromQuery || googleEmail;
  if (email && registerEmailInput) {
    registerEmailInput.value = email;
  }
}

function initCountryAutocomplete() {
  clearProvinceOptions();
  countryInput?.addEventListener("input", () => {
    const typedValue = String(countryInput.value || "").trim();
    renderCountrySuggestions(typedValue);
    if (!isValidCountry(typedValue)) {
      clearProvinceOptions();
    }
  });
  countryInput?.addEventListener("focus", () => {
    renderCountrySuggestions(String(countryInput.value || "").trim());
  });
  countryInput?.addEventListener("blur", () => {
    window.setTimeout(() => {
      hideCountrySuggestions();
    }, 120);
  });
}

function renderCountrySuggestions(searchTerm) {
  const query = normalizeText(searchTerm);
  const exactCountry = findExactCountry(searchTerm);
  if (exactCountry) {
    selectCountry(exactCountry);
    return;
  }

  const matches = paises
    .filter((country) => normalizeText(country).includes(query))
    .slice(0, 8);

  if (!query || !matches.length) {
    hideCountrySuggestions();
    return;
  }

  countrySuggestions.innerHTML = matches
    .map(
      (country) =>
        `<button type="button" class="country-suggestion-item" data-country="${escapeHtml(country)}">${escapeHtml(country)}</button>`
    )
    .join("");
  countrySuggestions.classList.remove("hidden");
}

function selectCountry(countryName) {
  countryInput.value = countryName;
  hideCountrySuggestions();
  void renderProvinceOptions(countryName);
}

async function renderProvinceOptions(countryName) {
  const exactCountry = findExactCountry(countryName);
  if (!exactCountry) {
    clearProvinceOptions();
    return;
  }

  currentCountryForProvinces = exactCountry;
  currentProvinceOptions = [];
  provinceSelect.disabled = true;
  provinceSelect.innerHTML = '<option value="">Cargando provincias...</option>';
  const provinceErrorNode = document.getElementById("err-provinciaEstado");
  if (provinceErrorNode) provinceErrorNode.textContent = "";

  try {
    const provinces = await fetchProvincesByCountry(exactCountry);
    if (currentCountryForProvinces !== exactCountry) {
      return;
    }

    currentProvinceOptions = provinces;
    if (!provinces.length) {
      clearProvinceOptions();
      if (provinceErrorNode) {
        provinceErrorNode.textContent = "No se encontraron provincias para este pais.";
      }
      return;
    }

    provinceSelect.innerHTML = [
      '<option value="">Selecciona una provincia/estado</option>',
      ...provinces.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    ].join("");
  } catch (error) {
    console.warn("No se pudieron cargar provincias desde API:", error?.message || error);
    if (currentCountryForProvinces !== exactCountry) return;
    clearProvinceOptions();
    if (provinceErrorNode) {
      provinceErrorNode.textContent = "No se pudieron cargar provincias. Reintenta.";
    }
  } finally {
    provinceSelect.disabled = false;
  }
}

async function fetchProvincesByCountry(countryName) {
  const response = await fetch(PROVINCES_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: countryName })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  const stateList = Array.isArray(payload?.data?.states) ? payload.data.states : [];
  const provinceNames = stateList
    .map((state) => String(state?.name || "").trim())
    .filter(Boolean);

  return [...new Set(provinceNames)];
}

function clearProvinceOptions() {
  currentProvinceOptions = [];
  provinceSelect.innerHTML = '<option value="">Selecciona una provincia/estado</option>';
  provinceSelect.disabled = false;
}

function hideCountrySuggestions() {
  countrySuggestions.classList.add("hidden");
  countrySuggestions.innerHTML = "";
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  clearFieldErrors();
  registerFeedback.textContent = "";
  plansFeedback.textContent = "";

  const payload = getFormPayload();
  const validation = validatePayload(payload);
  if (!validation.ok) {
    applyFieldErrors(validation.fieldErrors);
    registerFeedback.textContent = "Revisa los campos marcados.";
    return;
  }

  setDisabled(true);

  const authUser = firebaseAuth.currentUser;
  if (!authUser) {
    registerFeedback.textContent = "Sesion expirada. Vuelve a acceder con Google.";
    setDisabled(false);
    return;
  }

  const authUserEmail = String(authUser.email || "").trim().toLowerCase();
  if (!authUserEmail) {
    registerFeedback.textContent = "La cuenta Google no tiene un email valido.";
    setDisabled(false);
    return;
  }
  if (payload.email !== authUserEmail) {
    applyFieldErrors({ email: "Debe coincidir con la cuenta Google autenticada." });
    registerFeedback.textContent = "El email no coincide con tu cuenta Google.";
    setDisabled(false);
    return;
  }

  try {
    const idToken = await authUser.getIdToken(true);
    const response = await fetch(getRegisterEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      if (result?.fieldErrors) {
        applyFieldErrors(result.fieldErrors);
      }
      registerFeedback.textContent = result?.error || "No se pudo completar el registro.";
      setDisabled(false);
      return;
    }

    registerFeedback.textContent = "Negocio registrado correctamente.";
    window.location.href = "panel.html";
  } catch (error) {
    console.error(error);
    registerFeedback.textContent = "Error de red al registrar negocio.";
    setDisabled(false);
  }
}

function getFormPayload() {
  const formData = new FormData(registerForm);
  return {
    nombreApellido: String(formData.get("nombreApellido") || "").trim(),
    email: String(formData.get("email") || "").trim().toLowerCase(),
    telefono: String(formData.get("telefono") || "").trim(),
    nombreKiosco: String(formData.get("nombreKiosco") || "").trim(),
    pais: String(formData.get("pais") || "").trim(),
    provinciaEstado: String(formData.get("provinciaEstado") || "").trim(),
    distrito: String(formData.get("distrito") || "").trim(),
    localidad: String(formData.get("localidad") || "").trim(),
    domicilio: String(formData.get("domicilio") || "").trim(),
    plan: String(formData.get("plan") || "").trim().toLowerCase()
  };
}

function validatePayload(payload) {
  const fieldErrors = {};

  if (!/^[A-Za-zÀ-ÿ\s]{3,80}$/.test(payload.nombreApellido)) {
    fieldErrors.nombreApellido = "Nombre y apellido invalido.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    fieldErrors.email = "Email invalido.";
  }
  if (!/^\d{6,20}$/.test(payload.telefono)) {
    fieldErrors.telefono = "Telefono invalido. Solo numeros.";
  }
  if (!payload.nombreKiosco) {
    fieldErrors.nombreKiosco = "Nombre del kiosco obligatorio.";
  }
  if (!payload.pais) {
    fieldErrors.pais = "Pais obligatorio.";
  } else if (!isValidCountry(payload.pais)) {
    fieldErrors.pais = "Selecciona un pais valido de la lista.";
  }
  if (!payload.provinciaEstado) {
    fieldErrors.provinciaEstado = "Provincia/Estado obligatorio.";
  } else {
    if (!currentProvinceOptions.includes(payload.provinciaEstado)) {
      fieldErrors.provinciaEstado = "Selecciona una provincia valida para el pais.";
    }
  }
  if (!payload.distrito) {
    fieldErrors.distrito = "Distrito obligatorio.";
  }
  if (!payload.localidad) {
    fieldErrors.localidad = "Localidad obligatoria.";
  }
  if (!payload.domicilio) {
    fieldErrors.domicilio = "Domicilio obligatorio.";
  }

  const validPlans = new Set(availablePlans.map((plan) => String(plan.id || "").toLowerCase()));
  if (!validPlans.has(payload.plan)) {
    fieldErrors.plan = "Selecciona un plan valido.";
  }

  return {
    ok: Object.keys(fieldErrors).length === 0,
    fieldErrors
  };
}

function applyFieldErrors(fieldErrors) {
  Object.entries(fieldErrors || {}).forEach(([key, message]) => {
    const node = document.getElementById(`err-${key}`);
    if (node) node.textContent = message;
  });
}

function clearFieldErrors() {
  const nodes = registerForm.querySelectorAll("[id^='err-']");
  nodes.forEach((node) => {
    node.textContent = "";
  });
}

function setDisabled(disabled) {
  const controls = registerForm.querySelectorAll("input, select, button");
  controls.forEach((node) => {
    node.disabled = disabled;
  });
}

async function loadPlans() {
  plansContainer.innerHTML = "";
  plansFeedback.textContent = "Cargando planes...";
  availablePlans = [];

  try {
    const freeRef = doc(firestoreDb, "planes", "prueba");
const standardRef = doc(firestoreDb, "planes", "standard");
const premiumRef = doc(firestoreDb, "planes", "premium");

const freeSnap = await getDoc(freeRef);
const standardSnap = await getDoc(standardRef);
const premiumSnap = await getDoc(premiumRef);

// Verificar que los documentos existen y tienen datos


    const arrayPlanes= [freeSnap,standardSnap,premiumSnap];
    const validSnaps = arrayPlanes.filter((s) => s.exists() && s.data());
    console.log(validSnaps)
    if (validSnaps.length === 0) {
      throw new Error("No se encontraron planes en Firestore.");
    }

    
    const data = validSnaps.map((snap) => snap.data())

    // const data = validSnaps[0].exists() ? validSnaps[0].data() || {} : {};

    console.log(data)

    availablePlans = normalizePlans(data);

    console.log("Planes disponibles:", availablePlans);

    if (!availablePlans.length) {
      availablePlans = DEFAULT_PLANS.filter((plan) => plan.activo !== false);
    }

    renderPlanCards(availablePlans);

    plansFeedback.textContent = "";


  } catch (error) {

    console.warn("No se pudieron cargar planes desde Firestore:", error?.message || error);
    
    plansFeedback.textContent = "Error al conectarse con el servidor.";
  }
}

function normalizePlans(source) {
  if (!Array.isArray(source)) return [];

  return source
    .map((item) => {
      const id = String(item?.id || "").trim().toLowerCase();
      return {
        id,
        titulo: String(item?.titulo || item?.nombre || id || "").trim(),
        precio: String(item?.precio || item?.precioMensual || "").trim(),
        descripcion: String(item?.descripcion || "").trim(),
        caracteristicas: Array.isArray(item?.caracteristicas)
          ? item.caracteristicas.map((entry) => String(entry || "").trim()).filter(Boolean)
          : [],
        activo: item?.activo !== false,
        orden: Number(item?.orden || 0)
      };
    })
    .filter((item) => item.activo && Boolean(item.id))
    .sort((a, b) => a.orden - b.orden);
}

function renderPlanCards(plans) {
  plansContainer.innerHTML = plans
    .map(
      (plan) => `
        <button type="button" class="plan-card${plan.id === "prueba" ? " is-selected" : ""}" data-plan-id="${escapeHtml(plan.id)}">
          <span class="plan-card-title">${escapeHtml(plan.titulo || plan.id)}</span>
          <span class="plan-card-price">${escapeHtml(plan.precio || "")}</span>
          <span class="plan-card-description">${escapeHtml(plan.descripcion || "")}</span>
          <span class="plan-card-features">${plan.caracteristicas.map((entry) => escapeHtml(entry)).join(" | ")}</span>
        </button>
      `
    )
    .join("");

  const defaultPlan = plans.find((item) => item.id === "prueba") || plans[0] || null;
  selectedPlanInput.value = defaultPlan ? defaultPlan.id : "";
}

function handlePlanCardClick(event) {
  const target = event.target.closest("[data-plan-id]");
  if (!target) return;

  const selectedPlanId = String(target.getAttribute("data-plan-id") || "").trim().toLowerCase();
  if (!selectedPlanId) return;

  selectedPlanInput.value = selectedPlanId;
  plansContainer.querySelectorAll("[data-plan-id]").forEach((node) => {
    node.classList.toggle("is-selected", node === target);
  });
}

function isValidCountry(countryName) {
  return Boolean(findExactCountry(countryName));
}

function findExactCountry(countryName) {
  const normalizedInput = normalizeText(countryName);
  return paises.find((country) => normalizeText(country) === normalizedInput) || "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getRegisterEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/registerEmployerProfile`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
