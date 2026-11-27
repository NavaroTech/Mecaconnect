(() => {
  const API_BASE =
    window.MECACONNECT_API_BASE ||
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
      ? "http://localhost:5000/api"
      : "https://mecaconnect-api.onrender.com/api");

  const STORAGE_USER_KEY = "mecaconnect_user";
  const STORAGE_TOKEN_KEY = "mecaconnect_token";
  const STORAGE_INTERVENTIONS_KEY = "mecaconnect_interventions";
  const STORAGE_PAYMENTS_KEY = "mecaconnect_payments";
  const STORAGE_NOTIFICATIONS_KEY = "mecaconnect_notifications";

  const PUBLIC_PAGES = new Set(["index.html", "connexion.html", "inscription.html", ""]);
  const PROTECTED_PAGES = new Set([
    "chauffeur.html",
    "mecanicien.html",
    "paiement.html",
    "profil.html",
    "admin.html"
  ]);

  function getCurrentPage() {
    const raw = window.location.pathname.split("/").pop() || "index.html";
    return raw.toLowerCase();
  }

  function getStoredUser() {
    try {
      const raw = localStorage.getItem(STORAGE_USER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function getStoredToken() {
    const user = getStoredUser();
    return localStorage.getItem(STORAGE_TOKEN_KEY) || (user && user.token) || "";
  }

  function isAuthenticated() {
    const user = getStoredUser();
    const token = getStoredToken();
    return Boolean(user && (user.id || user.email || token));
  }

  function saveSession(user, token) {
    if (user) {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
    }
    if (token) {
      localStorage.setItem(STORAGE_TOKEN_KEY, token);
    } else if (user && user.token) {
      localStorage.setItem(STORAGE_TOKEN_KEY, user.token);
    }
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_USER_KEY);
    localStorage.removeItem(STORAGE_TOKEN_KEY);
  }

  // Verrouillage immédiat des pages privées pour les visiteurs non connectés
  function enforceRouteAccess() {
    const page = getCurrentPage();
    const loggedIn = isAuthenticated();
    const user = getStoredUser();

    if (PROTECTED_PAGES.has(page) && !loggedIn) {
      window.location.replace("connexion.html");
      return false;
    }

    if (page === "admin.html" && user && user.role !== "admin") {
      window.location.replace("profil.html");
      return false;
    }

    return true;
  }

  if (!enforceRouteAccess()) {
    return;
  }

  function normalizeGuineaPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("224") && digits.length === 12) {
      return `+${digits}`;
    }
    if (digits.length === 9 && digits.startsWith("6")) {
      return `+224${digits}`;
    }
    return phone.trim();
  }

  function isValidGuineaPhone(phone) {
    return /^\+2246\d{8}$/.test(normalizeGuineaPhone(phone));
  }

  function formatGnf(value) {
    const amount = Number(value || 0);
    if (Number.isNaN(amount)) return "0 GNF";
    return `${Math.round(amount).toLocaleString("fr-FR")} GNF`;
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function apiRequest(endpoint, options = {}) {
    const token = getStoredToken();
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : { message: await response.text() };

    if (!response.ok) {
      const errorMessage =
        data.error || data.message || `Erreur serveur (${response.status})`;
      throw new Error(errorMessage);
    }
    return data;
  }

  function setStatusMessage(target, text, type = "info") {
    const el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el) return;
    el.textContent = text || "";
    el.style.display = text ? "block" : "none";
    el.classList.remove("status-success", "status-error", "status-info");
    if (type === "success") {
      el.style.color = "#15803d";
      el.classList.add("status-success");
    } else if (type === "error") {
      el.style.color = "#dc2626";
      el.classList.add("status-error");
    } else {
      el.style.color = "#1d4ed8";
      el.classList.add("status-info");
    }
  }

  function updateNavigationUI() {
    const user = getStoredUser();
    const loggedIn = isAuthenticated();

    // Mise à jour du message de bienvenue dans l'en-tête
    const greetingTargets = document.querySelectorAll(
      "#userGreeting, .user-greeting, [data-user-greeting]"
    );
    greetingTargets.forEach((el) => {
      if (loggedIn && user) {
        const displayName = user.nom || user.full_name || user.email || "Membre";
        el.innerHTML = `Bonjour, <strong>${escapeHtml(displayName)}</strong>`;
      } else {
        el.innerHTML = `Bonjour, <strong>Invité</strong>`;
      }
    });

    // Masquer les liens privés dans le menu latéral et les barres de navigation si déconnecté
    document.querySelectorAll("a[href]").forEach((link) => {
      const href = (link.getAttribute("href") || "").split("?")[0].toLowerCase();
      if (!PROTECTED_PAGES.has(href)) return;

      const wrapper = link.closest("li") || link;
      if (!loggedIn) {
        wrapper.style.display = "none";
      } else if (href === "admin.html" && user && user.role !== "admin") {
        wrapper.style.display = "none";
      } else {
        wrapper.style.display = "";
      }
    });

    // Gestion des boutons Créer un compte / Déconnexion
    document.querySelectorAll("[data-auth-only]").forEach((el) => {
      el.style.display = loggedIn ? "" : "none";
    });
    document.querySelectorAll("[data-guest-only]").forEach((el) => {
      el.style.display = loggedIn ? "none" : "";
    });

    const headerActions = document.querySelector(".header-actions, .top-actions, header");
    if (loggedIn && headerActions && !document.getElementById("globalLogoutBtn")) {
      const signupLinks = headerActions.querySelectorAll('a[href*="inscription.html"]');
      signupLinks.forEach((a) => {
        a.style.display = "none";
      });

      const logoutBtn = document.createElement("button");
      logoutBtn.id = "globalLogoutBtn";
      logoutBtn.type = "button";
      logoutBtn.className = "btn btn-secondary";
      logoutBtn.style.marginLeft = "8px";
      logoutBtn.textContent = "Déconnexion";
      logoutBtn.addEventListener("click", () => {
        clearSession();
        window.location.href = "connexion.html";
      });
      headerActions.appendChild(logoutBtn);
    }
  }

  // Formatage dynamique du montant GNF (accueil & paiement)
  function initAmountFormatter() {
    const amountInput = document.getElementById("amountGnf") || document.getElementById("montantGnf");
    const formattedSpan =
      document.getElementById("formattedAmount") || document.getElementById("montantFormate");
    if (!amountInput || !formattedSpan) return;

    const refresh = () => {
      formattedSpan.textContent = `Montant formaté : ${formatGnf(amountInput.value)}`;
    };
    amountInput.addEventListener("input", refresh);
    refresh();
  }

  // Page de connexion (connexion.html)
  function initLoginPage() {
    const form =
      document.getElementById("loginForm") ||
      document.querySelector("form[data-form='login']") ||
      (getCurrentPage() === "connexion.html" ? document.querySelector("form") : null);
    if (!form) return;

    const statusBox =
      document.getElementById("loginStatus") ||
      (() => {
        const p = document.createElement("p");
        p.id = "loginStatus";
        p.style.marginTop = "10px";
        p.style.fontWeight = "600";
        form.appendChild(p);
        return p;
      })();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const identifierInput = form.querySelector(
        "#loginIdentifier, #email, input[name='identifier'], input[name='email'], input[type='text'], input[type='email']"
      );
      const passwordInput = form.querySelector(
        "#loginPassword, #password, input[name='password'], input[type='password']"
      );

      const identifier = (identifierInput?.value || "").trim();
      const password = passwordInput?.value || "";

      if (!identifier || !password) {
        setStatusMessage(statusBox, "Veuillez renseigner votre identifiant et votre mot de passe.", "error");
        return;
      }

      setStatusMessage(statusBox, "Connexion en cours...", "info");

      try {
        const payload = {
          identifier: identifier.includes("@") ? identifier.toLowerCase() : normalizeGuineaPhone(identifier),
          email: identifier.includes("@") ? identifier.toLowerCase() : undefined,
          password
        };
        const res = await apiRequest("/auth/login", {
          method: "POST",
          body: JSON.stringify(payload)
        });

        const user = res.user || res.utilisateur || res;
        const token = res.token || user.token || "";
        saveSession(user, token);
        setStatusMessage(statusBox, "Connexion réussie. Redirection...", "success");

        if (user.role === "admin") {
          window.location.href = "admin.html";
        } else if (user.role === "mecanicien") {
          window.location.href = "mecanicien.html";
        } else if (user.role === "chauffeur") {
          window.location.href = "chauffeur.html";
        } else {
          window.location.href = "profil.html";
        }
      } catch (err) {
        setStatusMessage(statusBox, `Erreur de connexion : ${err.message}`, "error");
      }
    });
  }

  // Page d'inscription KYC + Double OTP (E-mail & SMS +224) + Caméra Selfie
  function initRegisterPage() {
    const form =
      document.getElementById("registerForm") ||
      document.querySelector("form[data-form='register']") ||
      (getCurrentPage() === "inscription.html" ? document.querySelector("form") : null);
    if (!form) return;

    const otpState = {
      emailVerified: false,
      phoneVerified: false,
      selfieDataUrl: ""
    };

    const statusBox =
      document.getElementById("registerStatus") ||
      (() => {
        const p = document.createElement("p");
        p.id = "registerStatus";
        p.style.marginTop = "12px";
        p.style.fontWeight = "600";
        form.appendChild(p);
        return p;
      })();

    const emailInput = form.querySelector("#regEmail, #email, input[name='email'], input[type='email']");
    const phoneInput = form.querySelector("#regPhone, #telephone, input[name='telephone'], input[type='tel']");
    const emailOtpInput = form.querySelector("#emailOtpCode, input[name='emailOtp']");
    const phoneOtpInput = form.querySelector("#phoneOtpCode, input[name='phoneOtp']");

    const sendEmailOtpBtn = document.getElementById("sendEmailOtpBtn");
    const verifyEmailOtpBtn = document.getElementById("verifyEmailOtpBtn");
    const sendPhoneOtpBtn = document.getElementById("sendPhoneOtpBtn");
    const verifyPhoneOtpBtn = document.getElementById("verifyPhoneOtpBtn");

    if (sendEmailOtpBtn && emailInput) {
      sendEmailOtpBtn.addEventListener("click", async () => {
        const email = emailInput.value.trim().toLowerCase();
        if (!email || !email.includes("@")) {
          setStatusMessage(statusBox, "Saisissez une adresse e-mail valide avant l'envoi du code.", "error");
          return;
        }
        try {
          setStatusMessage(statusBox, "Envoi du code OTP e-mail...", "info");
          const res = await apiRequest("/auth/send-otp", {
            method: "POST",
            body: JSON.stringify({ channel: "email", target: email })
          });
          const devHint = res.dev_code ? ` (Code test : ${res.dev_code})` : "";
          setStatusMessage(statusBox, `Code OTP envoyé à ${email}.${devHint}`, "success");
        } catch (err) {
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    if (verifyEmailOtpBtn && emailInput && emailOtpInput) {
      verifyEmailOtpBtn.addEventListener("click", async () => {
        const email = emailInput.value.trim().toLowerCase();
        const code = emailOtpInput.value.trim();
        if (!code) {
          setStatusMessage(statusBox, "Entrez le code OTP reçu par e-mail.", "error");
          return;
        }
        try {
          await apiRequest("/auth/verify-otp", {
            method: "POST",
            body: JSON.stringify({ channel: "email", target: email, code })
          });
          otpState.emailVerified = true;
          setStatusMessage(statusBox, "Adresse e-mail vérifiée avec succès.", "success");
        } catch (err) {
          otpState.emailVerified = false;
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    if (sendPhoneOtpBtn && phoneInput) {
      sendPhoneOtpBtn.addEventListener("click", async () => {
        const phone = normalizeGuineaPhone(phoneInput.value);
        phoneInput.value = phone;
        if (!isValidGuineaPhone(phone)) {
          setStatusMessage(
            statusBox,
            "Numéro guinéen invalide. Utilisez le format +2246XXXXXXXX.",
            "error"
          );
          return;
        }
        try {
          setStatusMessage(statusBox, "Envoi du SMS OTP (+224)...", "info");
          const res = await apiRequest("/auth/send-otp", {
            method: "POST",
            body: JSON.stringify({ channel: "sms", target: phone })
          });
          const devHint = res.dev_code ? ` (Code SMS test : ${res.dev_code})` : "";
          setStatusMessage(statusBox, `Code SMS envoyé au ${phone}.${devHint}`, "success");
        } catch (err) {
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    if (verifyPhoneOtpBtn && phoneInput && phoneOtpInput) {
      verifyPhoneOtpBtn.addEventListener("click", async () => {
        const phone = normalizeGuineaPhone(phoneInput.value);
        const code = phoneOtpInput.value.trim();
        if (!code) {
          setStatusMessage(statusBox, "Entrez le code OTP reçu par SMS.", "error");
          return;
        }
        try {
          await apiRequest("/auth/verify-otp", {
            method: "POST",
            body: JSON.stringify({ channel: "sms", target: phone, code })
          });
          otpState.phoneVerified = true;
          setStatusMessage(statusBox, "Numéro +224 vérifié avec succès.", "success");
        } catch (err) {
          otpState.phoneVerified = false;
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    // Gestion caméra selfie KYC en direct
    const startCameraBtn = document.getElementById("startCameraBtn");
    const captureSelfieBtn = document.getElementById("captureSelfieBtn");
    const videoEl = document.getElementById("kycVideo");
    const canvasEl = document.getElementById("kycCanvas");
    const selfiePreview = document.getElementById("selfiePreview");
    let mediaStream = null;

    if (startCameraBtn && videoEl) {
      startCameraBtn.addEventListener("click", async () => {
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user" },
            audio: false
          });
          videoEl.srcObject = mediaStream;
          videoEl.style.display = "block";
          await videoEl.play();
          setStatusMessage(statusBox, "Caméra activée. Positionnez votre visage puis capturez le selfie.", "info");
        } catch (err) {
          setStatusMessage(
            statusBox,
            `Impossible d'accéder à la caméra : ${err.message}`,
            "error"
          );
        }
      });
    }

    if (captureSelfieBtn && videoEl && canvasEl) {
      captureSelfieBtn.addEventListener("click", () => {
        if (!videoEl.videoWidth) {
          setStatusMessage(statusBox, "Activez d'abord la caméra avant de prendre le selfie.", "error");
          return;
        }
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        const ctx = canvasEl.getContext("2d");
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        otpState.selfieDataUrl = canvasEl.toDataURL("image/jpeg", 0.85);

        if (selfiePreview) {
          selfiePreview.src = otpState.selfieDataUrl;
          selfiePreview.style.display = "block";
        }
        if (mediaStream) {
          mediaStream.getTracks().forEach((track) => track.stop());
          mediaStream = null;
        }
        setStatusMessage(statusBox, "Selfie KYC capturé avec succès.", "success");
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nom = (form.querySelector("#regNom, input[name='nom']")?.value || "").trim();
      const email = (emailInput?.value || "").trim().toLowerCase();
      const telephone = normalizeGuineaPhone(phoneInput?.value || "");
      const role = form.querySelector("#regRole, select[name='role']")?.value || "chauffeur";
      const ville = (form.querySelector("#regVille, select[name='ville'], input[name='ville']")?.value || "Conakry").trim();
      const specialite = (form.querySelector("#regSpecialite, input[name='specialite']")?.value || "").trim();
      const numeroPiece = (form.querySelector("#regPiece, input[name='numero_piece']")?.value || "").trim();
      const password = form.querySelector("#regPassword, input[name='password']")?.value || "";

      if (!nom || !email || !telephone || !password) {
        setStatusMessage(statusBox, "Veuillez remplir tous les champs obligatoires.", "error");
        return;
      }

      if (!isValidGuineaPhone(telephone)) {
        setStatusMessage(statusBox, "Le téléphone doit être un numéro guinéen (+2246XXXXXXXX).", "error");
        return;
      }

      if (emailOtpInput && !otpState.emailVerified) {
        setStatusMessage(statusBox, "Veuillez valider le code OTP e-mail avant de créer le compte.", "error");
        return;
      }

      if (phoneOtpInput && !otpState.phoneVerified) {
        setStatusMessage(statusBox, "Veuillez valider le code OTP SMS (+224) avant de créer le compte.", "error");
        return;
      }

      if ((videoEl || startCameraBtn) && !otpState.selfieDataUrl) {
        setStatusMessage(statusBox, "La capture du selfie KYC en direct est obligatoire.", "error");
        return;
      }

      try {
        setStatusMessage(statusBox, "Création du compte et validation KYC...", "info");
        const res = await apiRequest("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            nom,
            email,
            telephone,
            role,
            ville,
            specialite,
            numero_piece: numeroPiece,
            password,
            email_verified: otpState.emailVerified,
            phone_verified: otpState.phoneVerified,
            selfie_data: otpState.selfieDataUrl
          })
        });

        const user = res.user || res.utilisateur || res;
        saveSession(user, res.token || user.token || "");
        setStatusMessage(statusBox, "Compte créé avec succès ! Redirection vers votre profil...", "success");
        window.location.href = "profil.html";
      } catch (err) {
        setStatusMessage(statusBox, `Échec de l'inscription : ${err.message}`, "error");
      }
    });
  }

  // Page profil (profil.html)
  function initProfilePage() {
    if (getCurrentPage() !== "profil.html") return;
    const user = getStoredUser();
    if (!user) return;

    const fieldMap = {
      profileName: user.nom || "Utilisateur",
      profileEmail: user.email || "-",
      profilePhone: user.telephone || "-",
      profileRole: (user.role || "chauffeur").toUpperCase(),
      profileCity: user.ville || "Conakry",
      profileKycStatus: user.kyc_status || "Vérifié"
    };

    Object.entries(fieldMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });

    const selfieImg = document.getElementById("profileSelfie");
    if (selfieImg && user.selfie_data) {
      selfieImg.src = user.selfie_data;
      selfieImg.style.display = "block";
    }
  }

  // Page chauffeur (chauffeur.html)
  function initDriverPage() {
    if (getCurrentPage() !== "chauffeur.html") return;
    const form = document.getElementById("breakdownForm") || document.querySelector("form");
    const listContainer = document.getElementById("driverRequestsList");
    const user = getStoredUser();

    async function loadDriverRequests() {
      if (!listContainer) return;
      try {
        const data = await apiRequest("/interventions");
        const items = Array.isArray(data) ? data : data.interventions || [];
        if (!items.length) {
          listContainer.innerHTML = "<p>Aucune demande d'intervention enregistrée.</p>";
          return;
        }
        listContainer.innerHTML = items
          .map(
            (item) => `
            <div class="card" style="margin-bottom:12px;">
              <strong>${escapeHtml(item.type_panne || item.titre || "Dépannage")}</strong>
              <p>Lieu : ${escapeHtml(item.localisation || item.ville || "Conakry")} — Montant : ${formatGnf(item.montant_gnf)}</p>
              <p>Statut : <strong>${escapeHtml(item.statut || "en_attente")}</strong></p>
            </div>`
          )
          .join("");
      } catch (err) {
        listContainer.innerHTML = `<p style="color:#dc2626;">${escapeHtml(err.message)}</p>`;
      }
    }

    if (form) {
      const statusBox = document.getElementById("driverStatus") || document.createElement("p");
      if (!statusBox.id) {
        statusBox.id = "driverStatus";
        form.appendChild(statusBox);
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const typePanne = (form.querySelector("#typePanne, input[name='type_panne'], select[name='type_panne']")?.value || "Panne mécanique").trim();
        const localisation = (form.querySelector("#localisation, input[name='localisation']")?.value || "Conakry").trim();
        const description = (form.querySelector("#descriptionPanne, textarea[name='description']")?.value || "").trim();
        const montantGnf = Number(form.querySelector("#amountGnf, input[name='montant_gnf']")?.value || 150000);

        try {
          setStatusMessage(statusBox, "Envoi de la demande SOS...", "info");
          await apiRequest("/interventions", {
            method: "POST",
            body: JSON.stringify({
              chauffeur_id: user?.id,
              chauffeur_nom: user?.nom,
              type_panne: typePanne,
              localisation,
              description,
              montant_gnf: montantGnf
            })
          });
          setStatusMessage(statusBox, "Demande d'intervention envoyée aux mécaniciens proches.", "success");
          form.reset();
          loadDriverRequests();
        } catch (err) {
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    loadDriverRequests();
  }

  // Page mécanicien (mecanicien.html)
  function initMechanicPage() {
    if (getCurrentPage() !== "mecanicien.html") return;
    const container = document.getElementById("mechanicMissionsList") || document.querySelector(".missions-list");
    const user = getStoredUser();

    async function loadMissions() {
      if (!container) return;
      try {
        const data = await apiRequest("/interventions");
        const items = Array.isArray(data) ? data : data.interventions || [];
        if (!items.length) {
          container.innerHTML = "<p>Aucune mission disponible pour le moment.</p>";
          return;
        }
        container.innerHTML = items
          .map(
            (item) => `
            <div class="card" style="margin-bottom:12px;">
              <h4>${escapeHtml(item.type_panne || "Intervention")} — ${escapeHtml(item.localisation || "Guinée")}</h4>
              <p>${escapeHtml(item.description || "Assistance demandée")}</p>
              <p>Tarif : <strong>${formatGnf(item.montant_gnf)}</strong> | Statut : <strong>${escapeHtml(item.statut || "en_attente")}</strong></p>
              <div style="display:flex;gap:8px;margin-top:8px;">
                <button type="button" class="btn btn-primary" data-mission-id="${item.id}" data-next-status="acceptee">Accepter</button>
                <button type="button" class="btn btn-secondary" data-mission-id="${item.id}" data-next-status="terminee">Terminer</button>
              </div>
            </div>`
          )
          .join("");

        container.querySelectorAll("button[data-mission-id]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const id = btn.getAttribute("data-mission-id");
            const statut = btn.getAttribute("data-next-status");
            try {
              await apiRequest(`/interventions/${id}/status`, {
                method: "PATCH",
                body: JSON.stringify({
                  statut,
                  mecanicien_id: user?.id,
                  mecanicien_nom: user?.nom
                })
              });
              loadMissions();
            } catch (err) {
              alert(err.message);
            }
          });
        });
      } catch (err) {
        container.innerHTML = `<p style="color:#dc2626;">${escapeHtml(err.message)}</p>`;
      }
    }

    loadMissions();
  }

  // Page paiement GNF (paiement.html)
  function initPaymentPage() {
    if (getCurrentPage() !== "paiement.html") return;
    const form = document.getElementById("paymentForm") || document.querySelector("form");
    const historyContainer = document.getElementById("paymentsHistoryList");
    const user = getStoredUser();

    async function loadPayments() {
      if (!historyContainer) return;
      try {
        const data = await apiRequest("/payments");
        const payments = Array.isArray(data) ? data : data.payments || [];
        if (!payments.length) {
          historyContainer.innerHTML = "<p>Aucune transaction GNF enregistrée.</p>";
          return;
        }
        historyContainer.innerHTML = payments
          .map(
            (p) => `
            <div class="card" style="margin-bottom:10px;">
              <strong>${formatGnf(p.montant_gnf)}</strong> — ${escapeHtml(p.operateur || "Orange Money")} (${escapeHtml(p.telephone || "")})
              <div>Statut : <strong>${escapeHtml(p.statut || "confirme")}</strong></div>
            </div>`
          )
          .join("");
      } catch (err) {
        historyContainer.innerHTML = `<p style="color:#dc2626;">${escapeHtml(err.message)}</p>`;
      }
    }

    if (form) {
      const statusBox = document.getElementById("paymentStatus") || document.createElement("p");
      if (!statusBox.id) {
        statusBox.id = "paymentStatus";
        form.appendChild(statusBox);
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const montantGnf = Number(form.querySelector("#amountGnf, input[name='montant_gnf']")?.value || 0);
        const operateur = form.querySelector("#operateur, select[name='operateur']")?.value || "Orange Money Guinée";
        const telephone = normalizeGuineaPhone(
          form.querySelector("#payPhone, input[name='telephone']")?.value || user?.telephone || ""
        );

        if (montantGnf <= 0) {
          setStatusMessage(statusBox, "Veuillez saisir un montant valide en GNF.", "error");
          return;
        }
        if (!isValidGuineaPhone(telephone)) {
          setStatusMessage(statusBox, "Numéro mobile money guinéen invalide (+2246XXXXXXXX).", "error");
          return;
        }

        try {
          setStatusMessage(statusBox, "Traitement du paiement mobile en cours...", "info");
          await apiRequest("/payments", {
            method: "POST",
            body: JSON.stringify({
              user_id: user?.id,
              montant_gnf: montantGnf,
              operateur,
              telephone
            })
          });
          setStatusMessage(statusBox, `Paiement de ${formatGnf(montantGnf)} confirmé via ${operateur}.`, "success");
          loadPayments();
        } catch (err) {
          setStatusMessage(statusBox, err.message, "error");
        }
      });
    }

    loadPayments();
  }

  // Page administration (admin.html)
  async function initAdminPage() {
    if (getCurrentPage() !== "admin.html") return;
    const statusBox = document.getElementById("adminStatus");

    try {
      const data = await apiRequest("/admin/overview");
      const users = data.users || data.utilisateurs || [];
      const interventions = data.interventions || [];
      const payments = data.payments || data.paiements || [];

      const totalUsersEl = document.getElementById("statUsers") || document.getElementById("totalUsersCount");
      const totalInterventionsEl =
        document.getElementById("statInterventions") || document.getElementById("totalInterventionsCount");
      const totalRevenueEl =
        document.getElementById("statRevenue") || document.getElementById("totalRevenueGnf");

      if (totalUsersEl) totalUsersEl.textContent = String(users.length);
      if (totalInterventionsEl) totalInterventionsEl.textContent = String(interventions.length);
      if (totalRevenueEl) {
        const sumGnf = payments.reduce((acc, item) => acc + Number(item.montant_gnf || 0), 0);
        totalRevenueEl.textContent = formatGnf(sumGnf);
      }

      const usersBody = document.getElementById("adminUsersTableBody");
      if (usersBody) {
        usersBody.innerHTML = users
          .map(
            (u) => `
            <tr>
              <td>${escapeHtml(u.nom || "-")}</td>
              <td>${escapeHtml(u.email || "-")}</td>
              <td>${escapeHtml(u.telephone || "-")}</td>
              <td>${escapeHtml(u.role || "-")}</td>
              <td>${escapeHtml(u.ville || "Conakry")}</td>
              <td>${escapeHtml(u.kyc_status || "Vérifié")}</td>
            </tr>`
          )
          .join("");
      }

      const interventionsBody = document.getElementById("adminInterventionsTableBody");
      if (interventionsBody) {
        interventionsBody.innerHTML = interventions
          .map(
            (i) => `
            <tr>
              <td>${escapeHtml(i.type_panne || "-")}</td>
              <td>${escapeHtml(i.localisation || "-")}</td>
              <td>${formatGnf(i.montant_gnf)}</td>
              <td>${escapeHtml(i.statut || "en_attente")}</td>
            </tr>`
          )
          .join("");
      }

      const paymentsBody = document.getElementById("adminPaymentsTableBody");
      if (paymentsBody) {
        paymentsBody.innerHTML = payments
          .map(
            (p) => `
            <tr>
              <td>${escapeHtml(p.operateur || "-")}</td>
              <td>${escapeHtml(p.telephone || "-")}</td>
              <td>${formatGnf(p.montant_gnf)}</td>
              <td>${escapeHtml(p.statut || "confirme")}</td>
            </tr>`
          )
          .join("");
      }
    } catch (err) {
      if (statusBox) {
        setStatusMessage(statusBox, `Erreur chargement supervision : ${err.message}`, "error");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    updateNavigationUI();
    initAmountFormatter();
    initLoginPage();
    initRegisterPage();
    initProfilePage();
    initDriverPage();
    initMechanicPage();
    initPaymentPage();
    initAdminPage();
  });
})();