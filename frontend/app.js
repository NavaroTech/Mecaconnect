const API_BASE_URL = (
  window.API_BASE_URL ||
  window.API_BASE ||
  "https://mecaconnect-api.onrender.com/api"
).replace(/\/+$/, "");

function showStatus(element, message, type = "info") {
  if (!element) return;
  element.textContent = message;
  element.className = `status-box ${type}`;
  element.classList.remove("hidden");
}

function normalizeGuineaPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("224") ? `+${digits}` : `+224${digits}`;
}

function isValidIdentifier(value) {
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const isGuineaPhone = /^\+224\d{8,9}$/.test(value.replace(/\s+/g, ""));
  return isEmail || isGuineaPhone;
}

function formatGnf(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return "0 GNF";
  }
  return `${new Intl.NumberFormat("fr-FR").format(Math.round(num))} GNF`;
}

async function checkApiHealth(statusTarget = null) {
  const badge = document.getElementById("apiStatusBadge");
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { method: "GET" });
    const data = await response.json().catch(() => ({}));

    if (response.ok && data.database === "connected") {
      if (badge) {
        badge.textContent = "API & Base connectées";
        badge.className = "api-badge ok";
      }
      if (statusTarget) {
        showStatus(statusTarget, "API et base de données opérationnelles.", "success");
      }
      return true;
    }

    throw new Error(data.details || `Statut HTTP ${response.status}`);
  } catch (err) {
    if (badge) {
      badge.textContent = "API en veille ou inaccessible";
      badge.className = "api-badge err";
    }
    if (statusTarget) {
      showStatus(
        statusTarget,
        `Impossible de joindre le serveur (${API_BASE_URL}) : ${err.message}`,
        "error"
      );
    }
    return false;
  }
}

function bindLoginForm() {
  const loginForm = document.getElementById("loginForm");
  const loginIdentifierInput = document.getElementById("loginIdentifier");
  const loginPasswordInput = document.getElementById("loginPassword");
  const loginStatus = document.getElementById("loginStatus");

  if (!loginForm) return;

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const rawIdentifier = (loginIdentifierInput?.value || "").trim();
    const password = loginPasswordInput?.value || "";

    if (!rawIdentifier || !password) {
      showStatus(
        loginStatus,
        "Identifiant (e-mail ou téléphone +224) et mot de passe requis.",
        "error"
      );
      return;
    }

    const isEmail = rawIdentifier.includes("@");
    const identifier = isEmail
      ? rawIdentifier.toLowerCase()
      : normalizeGuineaPhone(rawIdentifier);

    if (!isValidIdentifier(identifier)) {
      showStatus(
        loginStatus,
        "Format invalide : saisissez un e-mail valide ou un numéro +224 (8 ou 9 chiffres).",
        "error"
      );
      return;
    }

    showStatus(loginStatus, "Connexion en cours...", "info");

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier,
          email: isEmail ? identifier : "",
          phone: isEmail ? "" : identifier,
          password
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.message || `Erreur HTTP ${response.status}`);
      }

      if (data.token) {
        localStorage.setItem("mecaconnect_token", data.token);
      }
      if (data.user) {
        localStorage.setItem("mecaconnect_user", JSON.stringify(data.user));
      }

      showStatus(loginStatus, "Connexion réussie ! Redirection...", "success");

      const userRole = data.user?.role || data.role || "";
      setTimeout(() => {
        window.location.href = userRole === "admin" ? "./admin.html" : "./profil.html";
      }, 800);
    } catch (err) {
      showStatus(
        loginStatus,
        `Erreur réseau ou serveur : ${err.message}`,
        "error"
      );
    }
  });
}

function bindKycForm() {
  const kycForm = document.getElementById("kycForm");
  const kycStatus = document.getElementById("kycStatus");
  const phoneInput = document.getElementById("phone");

  if (phoneInput) {
    phoneInput.addEventListener("blur", () => {
      const normalized = normalizeGuineaPhone(phoneInput.value);
      if (normalized) {
        phoneInput.value = normalized;
      }
    });
  }

  if (!kycForm) return;

  kycForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fullName = (document.getElementById("fullName")?.value || "").trim();
    const phone = normalizeGuineaPhone(document.getElementById("phone")?.value || "");
    const role = document.getElementById("role")?.value || "client";
    const idNumber = (document.getElementById("idNumber")?.value || "").trim();
    const selfieFile = document.getElementById("kycSelfie")?.files?.[0];

    if (!fullName || !/^\+224\d{8,9}$/.test(phone) || !idNumber || !selfieFile) {
      showStatus(
        kycStatus,
        "Veuillez remplir tous les champs (téléphone +224 à 8 ou 9 chiffres) et joindre le selfie KYC.",
        "error"
      );
      return;
    }

    const formData = new FormData();
    formData.append("fullName", fullName);
    formData.append("full_name", fullName);
    formData.append("phone", phone);
    formData.append("role", role);
    formData.append("idNumber", idNumber);
    formData.append("id_number", idNumber);
    formData.append("kycSelfie", selfieFile);
    formData.append("selfie", selfieFile);

    showStatus(kycStatus, "Envoi du dossier KYC en cours...", "info");

    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        body: formData
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || data.message || "Erreur lors de l'inscription.");
      }

      showStatus(kycStatus, "Inscription et dossier KYC envoyés avec succès !", "success");
    } catch (err) {
      showStatus(kycStatus, `Erreur lors de la soumission : ${err.message}`, "error");
    }
  });
}

function bindHelpers() {
  const testApiBtn = document.getElementById("btnTestApi");
  const loginStatus = document.getElementById("loginStatus");
  if (testApiBtn) {
    testApiBtn.addEventListener("click", async () => {
      showStatus(loginStatus, "Test de connexion à l'API en cours...", "info");
      await checkApiHealth(loginStatus);
    });
  }

  const amountInput = document.getElementById("amountGnf");
  const formattedAmount = document.getElementById("formattedAmount");
  if (amountInput && formattedAmount) {
    const updateDisplay = () => {
      formattedAmount.textContent = `Montant formaté : ${formatGnf(amountInput.value)}`;
    };
    amountInput.addEventListener("input", updateDisplay);
    updateDisplay();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindLoginForm();
  bindKycForm();
  bindHelpers();
  checkApiHealth();
});