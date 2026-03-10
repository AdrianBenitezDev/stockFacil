import { collection, doc, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { ensureFirebaseAuth, firebaseAuth, firebaseConfig, firestoreDb } from "../config.js";
import { ensureCurrentUserProfile, signInWithGoogle } from "./auth.js";
import {
  BUSINESS_CUSTOM_LABEL_MAX,
  CUSTOM_BUSINESS_TYPE_ID,
  getBusinessTypesForRegistration,
  isValidCustomBusinessLabel,
  normalizeBusinessTypeId,
  sanitizeCustomBusinessLabel
} from "./business_catalog.js";
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
const businessTypeSelect = document.getElementById("register-business-type");
const businessCustomWrap = document.getElementById("register-business-custom-wrap");
const businessCustomInput = document.getElementById("register-business-custom-label");
const subscriptionBox = document.getElementById("register-subscription-box");
const subscriptionStatusNode = document.getElementById("register-subscription-status");
const subscriptionMessageNode = document.getElementById("register-subscription-message");
const subscriptionActionBtn = document.getElementById("register-subscription-btn");
const subscriptionRetryBtn = document.getElementById("register-subscription-retry-btn");
const subscriptionCancelBtn = document.getElementById("register-subscription-cancel-btn");
const PROVINCES_API_URL = "https://countriesnow.space/api/v0.1/countries/states";
const SUBSCRIPTION_REG_ID_STORAGE_KEY = "stockfacil.subscription.registrationId";
const SUBSCRIPTION_INIT_POINT_STORAGE_KEY = "stockfacil.subscription.initPoint";
const SUBSCRIPTION_POLL_MS = 5000;
const SUBSCRIPTION_MAX_POLL_MS = 90000;
const COUNTRY_CODE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const COUNTRY_API_NAME_OVERRIDES = Object.freeze({
  "congo (rep. dem.)": "Democratic Republic of the Congo",
  "republica eslovaca": "Slovakia",
  "suazilandia": "Eswatini"
});
const availableCountries = buildCountryCatalog(paises);
const countryApiNameByNormalized = buildCountryApiNameLookup();

let availablePlans = [];
let availableBusinessTypes = [];
let currentCountryForProvinces = "";
let currentProvinceOptions = [];
let plansLoaded = false;
let businessTypesLoaded = false;
let subscriptionPollTimer = null;
let subscriptionPollStartedAt = 0;
let subscriptionStatusLoading = false;

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

  initCountryAutocomplete();
  prefillEmailFromQuery();
  await loadBusinessTypes();
  await loadPlans();
  if (!plansLoaded || !businessTypesLoaded) {
    registerSubmitBtn.disabled = true;
  }

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
  businessTypeSelect?.addEventListener("change", handleBusinessTypeChange);
  businessCustomInput?.addEventListener("input", handleBusinessCustomInput);
  registerForm?.addEventListener("submit", handleRegisterSubmit);
  subscriptionActionBtn?.addEventListener("click", handleSubscriptionActionClick);
  subscriptionRetryBtn?.addEventListener("click", handleSubscriptionRetryClick);
  subscriptionCancelBtn?.addEventListener("click", handleSubscriptionCancelClick);
  backLoginBtn?.addEventListener("click", () => {
    window.location.href = "index.html";
  });

  await handleSubscriptionReturnFlow();
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

  const matches = availableCountries
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
  const normalizedCountryName = sanitizeCountryLabel(countryName);
  countryInput.value = normalizedCountryName;
  hideCountrySuggestions();
  void renderProvinceOptions(normalizedCountryName);
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
  const candidates = getProvinceApiCountryCandidates(countryName);
  let lastError = null;
  let hasSuccessfulRequest = false;

  for (const candidate of candidates) {
    try {
      const provinces = await requestProvincesByCountryName(candidate);
      hasSuccessfulRequest = true;
      if (provinces.length) {
        return provinces;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (hasSuccessfulRequest) {
    return [];
  }

  throw lastError || new Error("No se pudo cargar provincias para el pais seleccionado.");
}

async function requestProvincesByCountryName(countryName) {
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

function getProvinceApiCountryCandidates(countryName) {
  const cleanedCountry = sanitizeCountryLabel(countryName);
  const normalizedCountry = normalizeText(cleanedCountry);
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const candidate = String(value || "").trim();
    if (!candidate) return;
    const normalizedCandidate = normalizeText(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate)) return;
    seen.add(normalizedCandidate);
    candidates.push(candidate);
  };

  pushCandidate(cleanedCountry);
  if (normalizedCountry) {
    const translatedCountry = countryApiNameByNormalized.get(normalizedCountry);
    if (translatedCountry) {
      pushCandidate(translatedCountry);
    }
  }

  return candidates;
}

function buildCountryCatalog(countryList) {
  if (!Array.isArray(countryList)) return [];

  const cleanedCountries = [];
  const seen = new Set();
  countryList.forEach((countryName) => {
    const cleanedName = sanitizeCountryLabel(countryName);
    const normalizedName = normalizeText(cleanedName);
    if (!normalizedName || seen.has(normalizedName)) return;
    seen.add(normalizedName);
    cleanedCountries.push(cleanedName);
  });

  return cleanedCountries;
}

function buildCountryApiNameLookup() {
  const countryMap = new Map();
  Object.entries(COUNTRY_API_NAME_OVERRIDES).forEach(([countryKey, apiCountryName]) => {
    const normalizedKey = normalizeText(countryKey);
    const normalizedApiCountryName = String(apiCountryName || "").trim();
    if (!normalizedKey || !normalizedApiCountryName) return;
    countryMap.set(normalizedKey, normalizedApiCountryName);
  });

  if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function") {
    return countryMap;
  }

  const displayNamesEs = new Intl.DisplayNames(["es"], { type: "region" });
  const displayNamesEn = new Intl.DisplayNames(["en"], { type: "region" });
  for (const isoCode of getIsoRegionCodes()) {
    const spanishName = sanitizeCountryLabel(displayNamesEs.of(isoCode));
    const englishName = sanitizeCountryLabel(displayNamesEn.of(isoCode));
    if (!spanishName || !englishName || spanishName === isoCode || englishName === isoCode) {
      continue;
    }

    const normalizedSpanishName = normalizeText(spanishName);
    const normalizedEnglishName = normalizeText(englishName);
    if (normalizedSpanishName && !countryMap.has(normalizedSpanishName)) {
      countryMap.set(normalizedSpanishName, englishName);
    }
    if (normalizedEnglishName && !countryMap.has(normalizedEnglishName)) {
      countryMap.set(normalizedEnglishName, englishName);
    }
  }

  return countryMap;
}

function getIsoRegionCodes() {
  const isoCodes = [];
  for (const firstLetter of COUNTRY_CODE_LETTERS) {
    for (const secondLetter of COUNTRY_CODE_LETTERS) {
      isoCodes.push(`${firstLetter}${secondLetter}`);
    }
  }
  return isoCodes;
}

function sanitizeCountryLabel(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  if (!looksLikeMojibake(rawValue)) return rawValue;

  const repairedValue = decodeLatin1Utf8(rawValue);
  return repairedValue || rawValue;
}

function looksLikeMojibake(value) {
  return /[\u00c2\u00c3\u00e2\ufffd]/.test(String(value || ""));
}

function decodeLatin1Utf8(value) {
  try {
    const bytes = Uint8Array.from(String(value || ""), (char) => char.charCodeAt(0) & 255);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
  } catch (_) {
    return String(value || "").trim();
  }
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

  if (!plansLoaded || !availablePlans.length) {
    registerFeedback.textContent = "No hay planes disponibles. Contacta al administrador.";
    return;
  }

  const payload = getFormPayload();
  const validation = validatePayload(payload);
  if (!validation.ok) {
    applyFieldErrors(validation.fieldErrors);
    registerFeedback.textContent = "Revisa los campos marcados.";
    return;
  }

  setDisabled(true);
  setButtonLoading(registerSubmitBtn, true);

  let authUser = firebaseAuth.currentUser;
  if (!authUser) {
    registerFeedback.textContent = "Para completar el registro debes validar tu cuenta Google.";
    try {
      await signInWithGoogle();
      authUser = firebaseAuth.currentUser;
    } catch (error) {
      console.error(error);
      registerFeedback.textContent = "No se pudo iniciar sesion con Google.";
      setDisabled(false);
      return;
    }
  }

  const profileResult = await ensureCurrentUserProfile();
  if (profileResult.ok) {
    registerFeedback.textContent = "Esta cuenta ya esta registrada. Ingresa como empleador.";
    setDisabled(false);
    return;
  }
  const profileError = String(profileResult.error || "").toLowerCase();
  if (profileError && !profileError.includes("no existe perfil")) {
    registerFeedback.textContent = profileResult.error || "No se pudo validar la cuenta.";
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

    if (isPaidPlan(payload.plan)) {
      const checkoutResult = await createSubscriptionCheckoutRequest(payload, idToken);
      if (!checkoutResult.ok) {
        if (checkoutResult.fieldErrors) {
          applyFieldErrors(checkoutResult.fieldErrors);
        }
        if (checkoutResult.registrationId) {
          persistPendingRegistration(checkoutResult.registrationId, checkoutResult.initPoint || "");
          renderSubscriptionUi({
            registrationStatus: "awaiting_webhook",
            subscriptionStatus: "pending_authorization",
            message: checkoutResult.error || "Ya tienes una suscripcion pendiente."
          });
          setSubscriptionActionLink(checkoutResult.initPoint || "");
        }
        registerFeedback.textContent = checkoutResult.error || "No se pudo iniciar la suscripcion.";
        setDisabled(false);
        return;
      }

      persistPendingRegistration(checkoutResult.registrationId, checkoutResult.initPoint || "");
      renderSubscriptionUi({
        registrationStatus: checkoutResult.registrationStatus || "awaiting_webhook",
        subscriptionStatus: checkoutResult.subscriptionStatus || "pending_authorization",
        message: "Redirigiendo a Mercado Pago para completar la suscripcion..."
      });
      setSubscriptionActionLink(checkoutResult.initPoint || "");
      redirectToSubscriptionCheckout(checkoutResult.initPoint);
      return;
    }

    clearPendingRegistration();
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

    registerFeedback.textContent = "Registro completado. Enviando correo de verificacion...";
    let verificationSent = "0";
    try {
      await requestVerificationEmail(idToken);
      verificationSent = "1";
    } catch (emailError) {
      console.error("No se pudo enviar el correo de verificacion:", emailError);
      registerFeedback.textContent =
        "Registro completado. No pudimos enviar el correo ahora, podras reenviarlo en la siguiente pantalla.";
    }
    const query = new URLSearchParams({ email: payload.email, sent: verificationSent });
    window.location.href = `verificar-correo.html?${query.toString()}`;
  } catch (error) {
    console.error(error);
    registerFeedback.textContent = "Error de red al registrar negocio.";
    setDisabled(false);
  } finally {
    setButtonLoading(registerSubmitBtn, false);
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
    plan: String(formData.get("plan") || "").trim().toLowerCase(),
    businessTypeId: normalizeBusinessTypeId(formData.get("businessTypeId")),
    businessTypeCustomLabel: sanitizeCustomBusinessLabel(formData.get("businessTypeCustomLabel"))
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
    fieldErrors.nombreKiosco = "Nombre del Negocio obligatorio.";
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

  const selectedBusinessType = normalizeBusinessTypeId(payload.businessTypeId);
  const validBusinessTypes = new Set(availableBusinessTypes.map((row) => row.id));
  if (!validBusinessTypes.has(selectedBusinessType) && selectedBusinessType !== CUSTOM_BUSINESS_TYPE_ID) {
    fieldErrors.businessTypeId = "Selecciona un tipo de negocio valido.";
  }

  if (selectedBusinessType === CUSTOM_BUSINESS_TYPE_ID) {
    if (!payload.businessTypeCustomLabel) {
      fieldErrors.businessTypeCustomLabel = "Ingresa la categoria de tu negocio.";
    } else if (payload.businessTypeCustomLabel.length > BUSINESS_CUSTOM_LABEL_MAX) {
      fieldErrors.businessTypeCustomLabel = `Maximo ${BUSINESS_CUSTOM_LABEL_MAX} caracteres.`;
    } else if (!isValidCustomBusinessLabel(payload.businessTypeCustomLabel)) {
      fieldErrors.businessTypeCustomLabel = "Solo letras, numeros, espacios, guion y apostrofe.";
    }
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

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle("btn-loading", loading);
}

async function loadPlans() {
  plansContainer.innerHTML = "";
  plansFeedback.textContent = "Cargando planes...";
  availablePlans = [];
  plansLoaded = false;

  try {
    const plansSnap = await getDocs(collection(firestoreDb, "planes"));
    const docsData = plansSnap.docs.map((snap) => ({ id: snap.id, ...(snap.data() || {}) }));

    availablePlans = normalizePlans(docsData);
    if (!availablePlans.length) {
      throw new Error("No hay planes activos en backend.");
    }

    renderPlanCards(availablePlans);
    plansLoaded = true;
    plansFeedback.textContent = "";
    registerSubmitBtn.disabled = !businessTypesLoaded;
  } catch (error) {
    console.warn("No se pudieron cargar planes desde Firestore:", error?.message || error);
    plansContainer.innerHTML = "";
    selectedPlanInput.value = "";
    plansLoaded = false;
    plansFeedback.textContent = "No se pudieron cargar los planes desde el backend.";
    registerSubmitBtn.disabled = true;
  }
}

async function loadBusinessTypes() {
  if (!businessTypeSelect) return;
  businessTypesLoaded = false;
  availableBusinessTypes = [];
  businessTypeSelect.innerHTML = '<option value="">Cargando tipos de negocio...</option>';
  businessTypeSelect.disabled = true;

  try {
    availableBusinessTypes = await getBusinessTypesForRegistration();
    if (!availableBusinessTypes.length) {
      throw new Error("No hay tipos de negocio configurados en Firebase.");
    }
    const options = [
      '<option value="">Selecciona un tipo de negocio</option>',
      ...availableBusinessTypes.map(
        (row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.nombre)}</option>`
      ),
      `<option value="${CUSTOM_BUSINESS_TYPE_ID}">Otra categoria</option>`
    ];
    businessTypeSelect.innerHTML = options.join("");
    businessTypeSelect.disabled = false;
    businessTypesLoaded = true;
    handleBusinessTypeChange();
  } catch (error) {
    console.warn("No se pudo cargar catalogo de tipo de negocio:", error?.message || error);
    businessTypeSelect.innerHTML = '<option value="">No se pudieron cargar tipos</option>';
    businessTypeSelect.disabled = true;
    businessTypesLoaded = false;
  } finally {
    registerSubmitBtn.disabled = !plansLoaded || !businessTypesLoaded;
  }
}

function handleBusinessTypeChange() {
  const selected = normalizeBusinessTypeId(businessTypeSelect?.value);
  const showCustom = selected === CUSTOM_BUSINESS_TYPE_ID;
  businessCustomWrap?.classList.toggle("hidden", !showCustom);
  if (businessCustomInput) {
    businessCustomInput.required = showCustom;
    if (!showCustom) {
      businessCustomInput.value = "";
    }
  }
}

function handleBusinessCustomInput() {
  if (!businessCustomInput) return;
  const sanitized = sanitizeCustomBusinessLabel(businessCustomInput.value);
  if (sanitized !== businessCustomInput.value) {
    businessCustomInput.value = sanitized;
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
        precioMensual: parseMoneyValue(item?.precioMensual ?? item?.precio),
        descripcion: String(item?.descripcion || "").trim(),
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

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function parseMoneyValue(valueLike) {
  if (typeof valueLike === "number") {
    return Number.isFinite(valueLike) ? valueLike : 0;
  }

  const raw = String(valueLike || "").trim();
  if (!raw) return 0;

  let normalized = raw.replace(/[^\d,.\-]/g, "");
  if (!normalized) return 0;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = normalized.replaceAll(".", "").replace(",", ".");
    } else {
      normalized = normalized.replaceAll(",", "");
    }
  } else if (hasComma) {
    const parts = normalized.split(",");
    const decimalPart = parts[parts.length - 1] || "";
    if (decimalPart.length <= 2) {
      normalized = parts.slice(0, -1).join("") + "." + decimalPart;
    } else {
      normalized = parts.join("");
    }
  } else if (hasDot) {
    const parts = normalized.split(".");
    const decimalPart = parts[parts.length - 1] || "";
    if (decimalPart.length > 2) {
      normalized = parts.join("");
    }
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
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

function resolveSelectedPlanMeta(planIdLike = selectedPlanInput?.value) {
  const selectedPlanId = String(planIdLike || "").trim().toLowerCase();
  if (!selectedPlanId) return null;
  return availablePlans.find((plan) => plan.id === selectedPlanId) || null;
}

function isPaidPlan(planIdLike) {
  const planId = String(planIdLike || "").trim().toLowerCase();
  if (!planId) return false;
  if (planId === "prueba") return false;

  const plan = resolveSelectedPlanMeta(planId);
  if (!plan) return true;
  if (plan.id === "prueba") return false;
  return true;
}

async function createSubscriptionCheckoutRequest(payload, idToken) {
  const response = await fetch(getCreateSubscriptionEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({
      ...payload,
      appBaseUrl: window.location.origin
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    return {
      ok: false,
      error: result?.error || "No se pudo iniciar la suscripcion.",
      fieldErrors: result?.fieldErrors || {},
      registrationId: String(result?.registrationId || "").trim(),
      initPoint: String(result?.initPoint || "").trim()
    };
  }

  return {
    ok: true,
    registrationId: String(result?.registrationId || "").trim(),
    preapprovalId: String(result?.preapprovalId || "").trim(),
    initPoint: String(result?.initPoint || "").trim(),
    registrationStatus: String(result?.registrationStatus || "").trim().toLowerCase(),
    subscriptionStatus: String(result?.subscriptionStatus || "").trim().toLowerCase()
  };
}

async function handleSubscriptionReturnFlow() {
  const returnPayload = readCheckoutReturnParams();
  const returnRegistrationId = String(returnPayload.registrationId || "").trim();
  if (returnRegistrationId) {
    persistPendingRegistration(returnRegistrationId, getPendingSubscriptionInitPoint());
  }

  const registrationId = returnRegistrationId || getPendingSubscriptionRegistrationId();
  if (!registrationId) return;

  renderSubscriptionUi({
    registrationStatus: "awaiting_webhook",
    subscriptionStatus: "pending_authorization",
    message: "Revisando estado de suscripcion..."
  });
  setSubscriptionActionLink(getPendingSubscriptionInitPoint());

  await refreshSubscriptionStatus(registrationId, { allowPolling: true });
}

function readCheckoutReturnParams() {
  const params = new URLSearchParams(window.location.search);
  const registrationId =
    String(params.get("registrationId") || "").trim() ||
    String(params.get("registration_id") || "").trim() ||
    String(params.get("reg_id") || "").trim() ||
    String(params.get("external_reference") || "").trim();

  const hasReturnSignals = [
    "registrationId",
    "registration_id",
    "reg_id",
    "external_reference",
    "preapproval_id",
    "collection_status",
    "payment_status"
  ].some((key) => params.has(key));

  return {
    registrationId,
    hasReturnSignals
  };
}

async function refreshSubscriptionStatus(registrationId, { allowPolling = false } = {}) {
  const normalizedRegistrationId = String(registrationId || "").trim();
  if (!normalizedRegistrationId) return { ok: false, error: "No hay registrationId." };

  if (subscriptionStatusLoading) {
    return { ok: false, error: "Consulta en curso." };
  }

  if (!firebaseAuth.currentUser) {
    renderSubscriptionUi({
      registrationStatus: "awaiting_webhook",
      subscriptionStatus: "pending_authorization",
      message: "Inicia sesion con Google para consultar el estado de tu suscripcion."
    });
    subscriptionRetryBtn?.classList.remove("hidden");
    subscriptionCancelBtn?.classList.remove("hidden");
    return { ok: false, error: "No hay sesion Google activa." };
  }

  subscriptionStatusLoading = true;
  try {
    const idToken = await firebaseAuth.currentUser.getIdToken(true);
    const statusResult = await requestSubscriptionStatus(normalizedRegistrationId, idToken);
    if (!statusResult.ok) {
      renderSubscriptionUi({
        registrationStatus: "awaiting_webhook",
        subscriptionStatus: "pending_authorization",
        message: statusResult.error || "No se pudo consultar el estado de suscripcion."
      });
      subscriptionRetryBtn?.classList.remove("hidden");
      subscriptionCancelBtn?.classList.remove("hidden");
      return statusResult;
    }

    const registrationStatus = String(statusResult.registrationStatus || "awaiting_webhook").toLowerCase();
    const subscriptionStatus = String(statusResult.subscriptionStatus || "pending_authorization").toLowerCase();
    renderSubscriptionUi({
      registrationStatus,
      subscriptionStatus,
      message:
        statusResult.message || buildDefaultSubscriptionMessage(registrationStatus, subscriptionStatus)
    });

    if (isTerminalSubscriptionState(registrationStatus, subscriptionStatus)) {
      stopSubscriptionStatusPolling();
      clearPendingRegistration();
    } else if (allowPolling) {
      startSubscriptionStatusPolling(normalizedRegistrationId);
    }

    return {
      ok: true,
      registrationStatus,
      subscriptionStatus
    };
  } catch (error) {
    console.error(error);
    renderSubscriptionUi({
      registrationStatus: "awaiting_webhook",
      subscriptionStatus: "pending_authorization",
      message: "No se pudo consultar el estado. Reintenta."
    });
    subscriptionRetryBtn?.classList.remove("hidden");
    return { ok: false, error: "Error de red al consultar estado." };
  } finally {
    subscriptionStatusLoading = false;
  }
}

async function requestSubscriptionStatus(registrationId, idToken) {
  const response = await fetch(getSubscriptionStatusEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({
      registrationId,
      appBaseUrl: window.location.origin
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    return {
      ok: false,
      error: result?.error || "No se pudo consultar el estado de suscripcion."
    };
  }

  return {
    ok: true,
    registrationStatus: String(result?.registrationStatus || "").trim().toLowerCase(),
    subscriptionStatus: String(result?.subscriptionStatus || "").trim().toLowerCase(),
    message: String(result?.message || "").trim()
  };
}

function startSubscriptionStatusPolling(registrationId) {
  stopSubscriptionStatusPolling();

  const normalizedRegistrationId = String(registrationId || "").trim();
  if (!normalizedRegistrationId) return;

  subscriptionPollStartedAt = Date.now();
  subscriptionPollTimer = window.setInterval(async () => {
    const elapsed = Date.now() - subscriptionPollStartedAt;
    if (elapsed >= SUBSCRIPTION_MAX_POLL_MS) {
      stopSubscriptionStatusPolling();
      renderSubscriptionUi({
        registrationStatus: "awaiting_webhook",
        subscriptionStatus: "pending_authorization",
        message: "La confirmacion esta tardando. Usa 'Actualizar estado' en unos segundos."
      });
      subscriptionRetryBtn?.classList.remove("hidden");
      return;
    }

    const result = await refreshSubscriptionStatus(normalizedRegistrationId, { allowPolling: false });
    if (result.ok && isTerminalSubscriptionState(result.registrationStatus, result.subscriptionStatus)) {
      stopSubscriptionStatusPolling();
    }
  }, SUBSCRIPTION_POLL_MS);
}

function stopSubscriptionStatusPolling() {
  if (subscriptionPollTimer) {
    window.clearInterval(subscriptionPollTimer);
    subscriptionPollTimer = null;
  }
}

function isTerminalSubscriptionState(registrationStatus, subscriptionStatus) {
  const reg = String(registrationStatus || "").trim().toLowerCase();
  const sub = String(subscriptionStatus || "").trim().toLowerCase();

  if (reg === "activated" || reg === "failed" || reg === "expired") return true;
  if (sub === "active" || sub === "cancelled" || sub === "payment_rejected" || sub === "paused") return true;
  return false;
}

function buildDefaultSubscriptionMessage(registrationStatus, subscriptionStatus) {
  const reg = String(registrationStatus || "").trim().toLowerCase();
  const sub = String(subscriptionStatus || "").trim().toLowerCase();

  if (sub === "active" || reg === "activated") {
    return "Suscripcion activa. Ya puedes continuar con tu alta.";
  }
  if (sub === "payment_rejected") {
    return "El pago fue rechazado. Puedes volver a intentar la suscripcion.";
  }
  if (sub === "cancelled") {
    return "La suscripcion fue cancelada.";
  }
  if (sub === "paused") {
    return "La suscripcion esta pausada.";
  }
  if (reg === "failed" || reg === "expired") {
    return "No se pudo completar el checkout. Intenta nuevamente.";
  }

  return "Estamos esperando confirmacion de Mercado Pago.";
}

function renderSubscriptionUi({ registrationStatus, subscriptionStatus, message }) {
  if (!subscriptionBox || !subscriptionStatusNode || !subscriptionMessageNode) return;

  subscriptionBox.classList.remove("hidden");
  const reg = String(registrationStatus || "").trim().toLowerCase();
  const sub = String(subscriptionStatus || "").trim().toLowerCase();

  const isActive = sub === "active" || reg === "activated";
  const isRejected = sub === "payment_rejected";
  const isCancelled = sub === "cancelled";
  const isPaused = sub === "paused";

  subscriptionStatusNode.classList.remove("is-pending", "is-active", "is-rejected", "is-cancelled");
  subscriptionStatusNode.classList.add("is-pending");
  subscriptionStatusNode.textContent = "Suscripcion pendiente";

  if (isActive) {
    subscriptionStatusNode.classList.remove("is-pending");
    subscriptionStatusNode.classList.add("is-active");
    subscriptionStatusNode.textContent = "Suscripcion activa";
  } else if (isRejected) {
    subscriptionStatusNode.classList.remove("is-pending");
    subscriptionStatusNode.classList.add("is-rejected");
    subscriptionStatusNode.textContent = "Pago rechazado";
  } else if (isCancelled || isPaused) {
    subscriptionStatusNode.classList.remove("is-pending");
    subscriptionStatusNode.classList.add("is-cancelled");
    subscriptionStatusNode.textContent = isPaused ? "Suscripcion pausada" : "Suscripcion cancelada";
  }

  subscriptionMessageNode.textContent = String(message || "").trim() || "Sin novedades de suscripcion.";

  const terminal = isTerminalSubscriptionState(registrationStatus, subscriptionStatus);
  if (isActive) {
    subscriptionRetryBtn?.classList.add("hidden");
    subscriptionCancelBtn?.classList.add("hidden");
  } else {
    subscriptionRetryBtn?.classList.remove("hidden");
    subscriptionCancelBtn?.classList.toggle("hidden", terminal);
  }
}

function setSubscriptionActionLink(initPoint) {
  if (!subscriptionActionBtn) return;

  const link = String(initPoint || "").trim();
  if (!link) {
    subscriptionActionBtn.classList.add("hidden");
    delete subscriptionActionBtn.dataset.href;
    return;
  }

  subscriptionActionBtn.dataset.href = link;
  subscriptionActionBtn.classList.remove("hidden");
}

function handleSubscriptionActionClick() {
  const link = String(subscriptionActionBtn?.dataset?.href || "").trim();
  if (!link) {
    registerFeedback.textContent = "No hay URL de checkout disponible.";
    return;
  }
  redirectToSubscriptionCheckout(link);
}

async function handleSubscriptionRetryClick() {
  const registrationId = getPendingSubscriptionRegistrationId();
  if (!registrationId) {
    renderSubscriptionUi({
      registrationStatus: "awaiting_webhook",
      subscriptionStatus: "pending_authorization",
      message: "No encontramos un registro pendiente para consultar."
    });
    return;
  }

  await refreshSubscriptionStatus(registrationId, { allowPolling: true });
}

function handleSubscriptionCancelClick() {
  stopSubscriptionStatusPolling();
  clearPendingRegistration();
  if (subscriptionBox) {
    subscriptionBox.classList.add("hidden");
  }
}

function persistPendingRegistration(registrationId, initPoint) {
  try {
    const normalizedId = String(registrationId || "").trim();
    if (normalizedId) {
      window.sessionStorage.setItem(SUBSCRIPTION_REG_ID_STORAGE_KEY, normalizedId);
    }

    const normalizedInitPoint = String(initPoint || "").trim();
    if (normalizedInitPoint) {
      window.sessionStorage.setItem(SUBSCRIPTION_INIT_POINT_STORAGE_KEY, normalizedInitPoint);
      setSubscriptionActionLink(normalizedInitPoint);
    }
  } catch (_) {
    // no-op
  }
}

function getPendingSubscriptionRegistrationId() {
  try {
    return String(window.sessionStorage.getItem(SUBSCRIPTION_REG_ID_STORAGE_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

function getPendingSubscriptionInitPoint() {
  try {
    return String(window.sessionStorage.getItem(SUBSCRIPTION_INIT_POINT_STORAGE_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

function clearPendingRegistration() {
  try {
    window.sessionStorage.removeItem(SUBSCRIPTION_REG_ID_STORAGE_KEY);
    window.sessionStorage.removeItem(SUBSCRIPTION_INIT_POINT_STORAGE_KEY);
  } catch (_) {
    // no-op
  }
  setSubscriptionActionLink("");
}

function redirectToSubscriptionCheckout(initPoint) {
  const destination = String(initPoint || "").trim();
  if (!destination) {
    throw new Error("No se recibio init_point para continuar la suscripcion.");
  }
  window.location.href = destination;
}

function isValidCountry(countryName) {
  return Boolean(findExactCountry(countryName));
}

function findExactCountry(countryName) {
  const normalizedInput = normalizeText(countryName);
  return availableCountries.find((country) => normalizeText(country) === normalizedInput) || "";
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

function getCreateSubscriptionEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/createSubscriptionCheckout`;
}

function getSubscriptionStatusEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/getSubscriptionStatus`;
}

async function requestVerificationEmail(idToken) {
  const response = await fetch(getSendVerificationEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ appBaseUrl: window.location.origin })
  });

  const result = await response.json().catch(() => ({}));
  console.log("Respuesta de sendEmployerVerificationEmail:", result.error || result);
  if (!response.ok || !result.ok) {
    throw new Error(result?.error || "No se pudo enviar el correo de verificacion.");
  }
}

function getSendVerificationEndpoint() {
  const projectId = String(firebaseConfig?.projectId || "").trim();
  return `https://us-central1-${projectId}.cloudfunctions.net/sendEmployerVerificationEmail`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
