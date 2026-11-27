// ==============================================================================
// Configuration de l'URL de base de l'API MecaConnect Guinée
// ==============================================================================
const API_BASE = "https://mecaconnect-api.onrender.com";

const STORAGE_USER_KEY = "mecaconnect_user";
const STORAGE_USER_ID_KEY = "mecaconnect_user_id";


// ==============================================================================
// Utilitaires session, formatage GNF et téléphone Guinée (+224)
// ==============================================================================
function getStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("Erreur lecture session utilisateur :", err);
    return null;
  }
}

function getStoredUserId() {
  const explicitId = localStorage.getItem(STORAGE_USER_ID_KEY);
  if (explicitId) return explicitId;
  const user = getStoredUser();
  return user && user.id ? String(user.id) : "";
}

function setSessionUser(user) {
  if (!user) return;
  localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
  if (user.id !== undefined && user.id !== null) {
    localStorage.setItem(STORAGE_USER_ID_KEY, String(user.id));
  }
}

function clearSessionUser() {
  localStorage.removeItem(STORAGE_USER_KEY);
  localStorage.removeItem(STORAGE_USER_ID_KEY);
}

function formatGNF(amount) {
  const num = Number(amount || 0);
  return `${num.toLocaleString("fr-FR").replace(/\u00a0|\u202f/g, " ")} GNF`;
}

function normalizePhoneGN(phone) {
  const digitsOnly = String(phone || "").replace(/[^\d+]/g, "");
  if (digitsOnly.startsWith("+224")) {
    return `+224${digitsOnly.slice(4).replace(/\D/g, "")}`;
  }
  if (digitsOnly.startsWith("224")) {
    return `+224${digitsOnly.slice(3).replace(/\D/g, "")}`;
  }
  return `+224${digitsOnly.replace(/\D/g, "")}`;
}


// ==============================================================================
// Client HTTP générique vers API_BASE
// ==============================================================================
async function apiRequest(endpoint, options = {}) {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const url = `${API_BASE}${path}`;

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const userId = getStoredUserId();
  if (userId && !headers["X-User-Id"]) {
    headers["X-User-Id"] = userId;
  }

  const fetchOptions = {
    method: options.method || "GET",
    headers,
  };

  if (options.body !== undefined) {
    fetchOptions.body =
      typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  let data = null;

  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Erreur HTTP ${response.status} sur ${path}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}


// ==============================================================================
// Appels API MecaConnect Guinée
// ==============================================================================
async function checkApiHealth() {
  return apiRequest("/api/health");
}

async function requestEmailOtp(email) {
  return apiRequest("/api/auth/request-otp", {
    method: "POST",
    body: { email: String(email || "").trim().toLowerCase() },
  });
}

async function registerUser(payload) {
  const body = {
    ...payload,
    telephone: normalizePhoneGN(payload.telephone),
  };
  const data = await apiRequest("/api/auth/register", {
    method: "POST",
    body,
  });
  if (data && data.user) {
    setSessionUser(data.user);
  }
  return data;
}

async function loginUser(identifiant, motDePasse) {
  const data = await apiRequest("/api/auth/login", {
    method: "POST",
    body: {
      identifiant: String(identifiant || "").trim(),
      mot_de_passe: motDePasse,
    },
  });
  if (data && data.user) {
    setSessionUser(data.user);
  }
  return data;
}

async function fetchProfil() {
  return apiRequest("/api/profil");
}

async function submitKyc({ type_document, numero_document, url_document, url_selfie }) {
  return apiRequest("/api/kyc/soumettre", {
    method: "POST",
    body: {
      type_document,
      numero_document,
      url_document,
      url_selfie,
    },
  });
}

async function fetchMecaniciens(ville = "") {
  const query = ville ? `?ville=${encodeURIComponent(ville.trim())}` : "";
  return apiRequest(`/api/mecaniciens${query}`);
}

async function createIntervention({
  type_panne,
  description,
  localisation,
  montant_estime_gnf,
  mecanicien_id = null,
}) {
  return apiRequest("/api/demandes", {
    method: "POST",
    body: {
      type_panne,
      description,
      localisation,
      montant_estime_gnf: Number(montant_estime_gnf || 75000),
      mecanicien_id,
    },
  });
}

async function fetchInterventions() {
  return apiRequest("/api/demandes");
}

async function createPaymentGnf({ demande_id = null, montant_gnf, operateur, numero_telephone }) {
  return apiRequest("/api/paiements", {
    method: "POST",
    body: {
      demande_id,
      montant_gnf: Number(montant_gnf),
      operateur: operateur || "Orange Money",
      numero_telephone: normalizePhoneGN(numero_telephone),
    },
  });
}

async function fetchNotifications() {
  return apiRequest("/api/notifications");
}


// ==============================================================================
// Vérification automatique au chargement de la page
// ==============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const health = await checkApiHealth();
    console.info("MecaConnect API connectée :", health);
  } catch (err) {
    console.warn("API indisponible ou en cours de réveil :", err.message);
  }
});