const DEFAULT_API_BASE = "https://mecaconnect-api.onrender.com";
const API_BASE = (window.API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");

function normalizeGuineaPhone(rawValue) {
  const digits = String(rawValue || "").replace(/\D/g, "");
  if (digits.startsWith("224")) {
    return "+" + digits;
  }
  return "+224" + digits;
}

function formatGnf(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return "0 GNF";
  return `${Math.round(num).toLocaleString("fr-FR")} GNF`;
}

function setStatusBox(element, message, type = "") {
  if (!element) return;
  element.textContent = message;
  element.className = "status-box" + (type ? ` ${type}` : "");
}

async function checkApiHealth() {
  const badge = document.getElementById("apiStatusBadge");
  if (!badge) return;

  try {
    const res = await fetch(`${API_BASE}/api/health`, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.database === "connected") {
      badge.textContent = "API & Base connectées";
      badge.className = "api-badge ok";
    } else {
      badge.textContent = "API active (BDD à vérifier)";
      badge.className = "api-badge err";
    }
  } catch (err) {
    badge.textContent = "API en veille ou inaccessible";
    badge.className = "api-badge err";
  }
}

function bindEvents() {
  const phoneInput = document.getElementById("phone");
  if (phoneInput) {
    phoneInput.addEventListener("blur", () => {
      phoneInput.value = normalizeGuineaPhone(phoneInput.value);
    });
  }

  const amountInput = document.getElementById("amountGnf");
  const formattedGnf = document.getElementById("formattedGnf");
  if (amountInput && formattedGnf) {
    const updateGnfDisplay = () => {
      formattedGnf.textContent = `Montant formaté : ${formatGnf(amountInput.value)}`;
    };
    amountInput.addEventListener("input", updateGnfDisplay);
    updateGnfDisplay();
  }

  const kycForm = document.getElementById("kycForm");
  const kycResult = document.getElementById("kycResult");
  if (kycForm) {
    kycForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setStatusBox(kycResult, "Envoi de l'inscription et du dossier KYC...");

      const formData = new FormData(kycForm);
      formData.set("phone", normalizeGuineaPhone(formData.get("phone")));

      try {
        const res = await fetch(`${API_BASE}/api/auth/register`, {
          method: "POST",
          body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatusBox(kycResult, data.error || data.message || `Erreur HTTP ${res.status}`, "error");
          return;
        }
        setStatusBox(kycResult, JSON.stringify(data, null, 2), "success");
      } catch (err) {
        setStatusBox(kycResult, `Erreur réseau vers ${API_BASE} : ${err.message}`, "error");
      }
    });
  }

  const loginForm = document.getElementById("loginForm");
  const sessionResult = document.getElementById("sessionResult");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setStatusBox(sessionResult, "Connexion en cours...");

      const payload = {
        identifier: document.getElementById("loginEmail")?.value.trim(),
        password: document.getElementById("loginPassword")?.value
      };

      try {
        const res = await fetch(`${API_BASE}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatusBox(sessionResult, data.error || data.message || `Erreur HTTP ${res.status}`, "error");
          return;
        }
        if (data.token) {
          localStorage.setItem("mecaconnect_token", data.token);
        }
        setStatusBox(sessionResult, JSON.stringify(data, null, 2), "success");
      } catch (err) {
        setStatusBox(sessionResult, `Erreur réseau vers ${API_BASE} : ${err.message}`, "error");
      }
    });
  }

  const pingBtn = document.getElementById("pingApiBtn");
  if (pingBtn) {
    pingBtn.addEventListener("click", async () => {
      setStatusBox(sessionResult, `Test de ${API_BASE}/api/health...`);
      try {
        const res = await fetch(`${API_BASE}/api/health`);
        const data = await res.json();
        setStatusBox(sessionResult, JSON.stringify(data, null, 2), res.ok ? "success" : "error");
        checkApiHealth();
      } catch (err) {
        setStatusBox(sessionResult, `Échec du test : ${err.message}`, "error");
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  checkApiHealth();
});