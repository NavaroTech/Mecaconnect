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
  const STORAGE_USERS_DB_KEY = "mecaconnect_users_db";

  const PROTECTED_PAGES = new Set([
    "chauffeur.html",
    "mecanicien.html",
    "demande.html",
    "paiement.html",
    "notifications.html",
    "profil.html",
    "admin.html"
  ]);

  function getCurrentPage() {
    const raw = window.location.pathname.split("/").pop() || "index.html";
    return raw.toLowerCase();
  }

  function readJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Ignore quota errors
    }
  }

  function getStoredUser() {
    const parsed = readJsonStorage(STORAGE_USER_KEY, null);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function getStoredToken() {
    const user = getStoredUser();
    return localStorage.getItem(STORAGE_TOKEN_KEY) || (user && user.token) || "";
  }

  function isAuthenticated() {
    const user = getStoredUser();
    const token = getStoredToken();
    return Boolean(user && (user.id || user.email || user.telephone || token));
  }

  function saveSession(user, token) {
    if (user) {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
      const db = readJsonStorage(STORAGE_USERS_DB_KEY, []);
      const idx = db.findIndex(
        (u) =>
          (user.email && u.email === user.email) ||
          (user.telephone && u.telephone === user.telephone)
      );
      if (idx >= 0) {
        db[idx] = { ...db[idx], ...user };
      } else {
        db.push(user);
      }
      writeJsonStorage(STORAGE_USERS_DB_KEY, db);
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
    return String(phone || "").trim();
  }

  function isValidGuineaPhone(phone) {
    return /^\+2246\d{8}$/.test(normalizeGuineaPhone(phone));
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }

  function generateOtpCode() {
    if (window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return String(100000 + (arr[0] % 900000));
    }
    return String(Math.floor(100000 + Math.random() * 900000));
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

  async function apiRequest(endpoint, options = {}, timeoutMs = 4500) {
    const token = getStoredToken();
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
        signal: controller.signal
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
    } finally {
      clearTimeout(timer);
    }
  }

  function setStatusMessage(target, text, type = "info") {
    const el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove(
      "hidden",
      "success",
      "error",
      "status-success",
      "status-error",
      "status-info"
    );
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.style.display = "block";
    if (type === "success") {
      el.style.color = "#15803d";
      el.classList.add("success", "status-success");
    } else if (type === "error") {
      el.style.color = "#dc2626";
      el.classList.add("error", "status-error");
    } else {
      el.style.color = "#1d4ed8";
      el.classList.add("status-info");
    }
  }

  function startButtonCooldown(btn, label, seconds = 20) {
    if (!btn) return;
    let left = seconds;
    btn.disabled = true;
    btn.textContent = `${label} (${left}s)`;
    const interval = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(interval);
        btn.disabled = false;
        btn.textContent = label;
      } else {
        btn.textContent = `${label} (${left}s)`;
      }
    }, 1000);
  }

  function updateNavigationUI() {
    const user = getStoredUser();
    const loggedIn = isAuthenticated();

    document.querySelectorAll("[data-user-name]").forEach((el) => {
      if (loggedIn && user) {
        el.textContent = user.nom || user.full_name || user.email || "Membre";
      } else {
        el.textContent = "Invité";
      }
    });

    document.querySelectorAll("#userGreeting, .user-greeting, [data-user-greeting]").forEach((el) => {
      if (el.querySelector("[data-user-name]")) return;
      if (loggedIn && user) {
        const displayName = user.nom || user.full_name || user.email || "Membre";
        el.innerHTML = `Bonjour, <strong>${escapeHtml(displayName)}</strong>`;
      } else {
        el.innerHTML = `Bonjour, <strong>Invité</strong>`;
      }
    });

    document.querySelectorAll("[data-notif-badge]").forEach((badge) => {
      badge.textContent = loggedIn ? String(user?.notifications ?? 1) : "0";
    });

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

    document.querySelectorAll(".auth-guest-only, [data-guest-only]").forEach((el) => {
      el.style.display = loggedIn ? "none" : "";
    });

    document.querySelectorAll("[data-auth-only], .btn-logout, [data-auth-logout]").forEach((el) => {
      el.style.display = loggedIn ? "" : "none";
    });

    document.querySelectorAll("#logoutBtn, [data-auth-logout]").forEach((btn) => {
      if (btn.dataset.logoutBound) return;
      btn.dataset.logoutBound = "1";
      btn.addEventListener("click", () => {
        clearSession();
        window.location.href = "connexion.html";
      });
    });
  }

  async function initApiHealthCheck() {
    const badge = document.getElementById("apiStatusBadge");
    const testBtn = document.getElementById("btnTestApi");
    const statusBox = document.getElementById("loginStatus");

    const runCheck = async (showDetails = false) => {
      if (badge) {
        badge.textContent = "Vérification API...";
        badge.classList.remove("ok", "err");
      }
      try {
        const data = await apiRequest("/health", {}, 2500);
        if (badge) {
          badge.textContent = "API & Base OK";
          badge.classList.add("ok");
        }
        if (showDetails && statusBox) {
          setStatusMessage(
            statusBox,
            `Connexion API réussie (${API_BASE}) — Base : ${data.database || "connectée"}.`,
            "success"
          );
        }
      } catch (err) {
        if (badge) {
          badge.textContent = "Mode local actif";
          badge.classList.add("ok");
        }
        if (showDetails && statusBox) {
          setStatusMessage(
            statusBox,
            `API distante non jointe (${err.message}). Mode stockage local actif.`,
            "info"
          );
        }
      }
    };

    if (testBtn) {
      testBtn.addEventListener("click", () => runCheck(true));
    }
    if (badge) {
      runCheck(false);
    }
  }

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

  function initLoginPage() {
    const form =
      document.getElementById("connexionForm") ||
      document.getElementById("loginForm") ||
      document.querySelector("form[data-form='login']") ||
      (getCurrentPage() === "connexion.html" ? document.querySelector("form") : null);
    if (!form) return;

    const statusBox =
      document.getElementById("loginStatus") ||
      document.getElementById("loginFeedback") ||
      (() => {
        const p = document.createElement("div");
        p.id = "loginStatus";
        p.className = "status-box hidden";
        form.appendChild(p);
        return p;
      })();

    const passwordInput = form.querySelector(
      "#loginPassword, #password, input[name='mot_de_passe'], input[name='password'], input[type='password']"
    );
    const togglePasswordBtn = document.getElementById("togglePasswordBtn");
    const submitBtn =
      document.getElementById("submitConnexionBtn") || form.querySelector("button[type='submit']");

    if (togglePasswordBtn && passwordInput) {
      togglePasswordBtn.addEventListener("click", () => {
        const isHidden = passwordInput.type === "password";
        passwordInput.type = isHidden ? "text" : "password";
        togglePasswordBtn.textContent = isHidden ? "🙈" : "👁️";
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const identifierInput = form.querySelector(
        "#loginEmail, #loginIdentifier, #email, input[name='identifier'], input[name='email'], input[type='text'], input[type='email']"
      );

      const identifier = (identifierInput?.value || "").trim();
      const password = passwordInput?.value || "";

      if (!identifier || !password) {
        setStatusMessage(
          statusBox,
          "Veuillez renseigner votre identifiant et votre mot de passe.",
          "error"
        );
        return;
      }

      const normalizedPhone = normalizeGuineaPhone(identifier);
      const isEmail = identifier.includes("@");

      if (!isEmail && !isValidGuineaPhone(normalizedPhone)) {
        setStatusMessage(
          statusBox,
          "Saisissez une adresse e-mail valide ou un numéro guinéen (+2246XXXXXXXX).",
          "error"
        );
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      setStatusMessage(statusBox, "Connexion en cours...", "info");

      try {
        const payload = {
          identifier: isEmail ? identifier.toLowerCase() : normalizedPhone,
          email: isEmail ? identifier.toLowerCase() : undefined,
          telephone: !isEmail ? normalizedPhone : undefined,
          password
        };
        const res = await apiRequest(
          "/auth/login",
          {
            method: "POST",
            body: JSON.stringify(payload)
          },
          3000
        );

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
        const db = readJsonStorage(STORAGE_USERS_DB_KEY, []);
        const found = db.find(
          (u) =>
            (isEmail && u.email === identifier.toLowerCase()) ||
            (!isEmail && u.telephone === normalizedPhone)
        );

        if (found) {
          if (found.password && found.password !== password) {
            if (submitBtn) submitBtn.disabled = false;
            setStatusMessage(statusBox, "Mot de passe incorrect.", "error");
            return;
          }
          saveSession(found, found.token || "local-session-token");
          setStatusMessage(statusBox, "Connexion réussie. Redirection...", "success");
          window.location.href = found.role === "admin" ? "admin.html" : "profil.html";
          return;
        }

        if (submitBtn) submitBtn.disabled = false;
        setStatusMessage(statusBox, `Erreur de connexion : ${err.message}`, "error");
      }
    });
  }

  function initRegisterPage() {
    const form =
      document.getElementById("inscriptionForm") ||
      document.getElementById("registerForm") ||
      document.querySelector("form[data-form='register']") ||
      (getCurrentPage() === "inscription.html" ? document.querySelector("form") : null);
    if (!form) return;

    const otpState = {
      expectedEmailCode: "",
      expectedPhoneCode: "",
      emailVerified: false,
      phoneVerified: false
    };

    const statusBox =
      document.getElementById("inscriptionFeedback") ||
      document.getElementById("registerStatus") ||
      (() => {
        const p = document.createElement("p");
        p.id = "registerStatus";
        p.style.marginTop = "12px";
        p.style.fontWeight = "600";
        form.appendChild(p);
        return p;
      })();

    const emailInput = form.querySelector("#email, #regEmail, input[name='email'], input[type='email']");
    const phoneInput = form.querySelector("#telephone, #regPhone, input[name='telephone'], input[type='tel']");
    const emailOtpInput = form.querySelector(
      "#emailOtp, #emailOtpCode, input[name='email_otp'], input[name='emailOtp']"
    );
    const phoneOtpInput = form.querySelector(
      "#smsOtp, #phoneOtpCode, input[name='sms_otp'], input[name='phoneOtp']"
    );

    const sendEmailOtpBtn =
      document.getElementById("sendOtpBtn") || document.getElementById("sendEmailOtpBtn");
    const verifyEmailOtpBtn =
      document.getElementById("verifyOtpBtn") || document.getElementById("verifyEmailOtpBtn");
    const sendPhoneOtpBtn =
      document.getElementById("sendSmsBtn") || document.getElementById("sendPhoneOtpBtn");
    const verifyPhoneOtpBtn =
      document.getElementById("verifySmsBtn") || document.getElementById("verifyPhoneOtpBtn");

    const emailOtpGroup = document.getElementById("otpGroup");
    const phoneOtpGroup = document.getElementById("smsOtpGroup");
    const emailHint =
      document.getElementById("emailStatusHint") || document.getElementById("otpStatusHint");
    const phoneHint =
      document.getElementById("smsStatusHint") || document.getElementById("smsOtpStatusHint");

    if (sendEmailOtpBtn && emailInput) {
      sendEmailOtpBtn.addEventListener("click", async () => {
        const email = emailInput.value.trim().toLowerCase();
        if (!isValidEmail(email)) {
          setStatusMessage(
            statusBox,
            "Saisissez une adresse e-mail valide avant l'envoi du code.",
            "error"
          );
          return;
        }
        const localCode = generateOtpCode();
        otpState.expectedEmailCode = localCode;
        otpState.emailVerified = false;
        if (emailOtpGroup) {
          emailOtpGroup.classList.remove("hidden");
          emailOtpGroup.style.display = "flex";
        }
        try {
          setStatusMessage(statusBox, "Envoi du code OTP e-mail...", "info");
          const res = await apiRequest(
            "/auth/send-otp",
            {
              method: "POST",
              body: JSON.stringify({ channel: "email", target: email })
            },
            2500
          );
          if (res.dev_code) otpState.expectedEmailCode = String(res.dev_code);
          const hintText = `Code envoyé à ${email}${res.dev_code ? ` (Code : ${res.dev_code})` : ""}.`;
          if (emailHint) emailHint.textContent = hintText;
          setStatusMessage(statusBox, hintText, "success");
        } catch (_) {
          const hintText = `Code e-mail généré pour ${email} (Code test : ${localCode}).`;
          if (emailHint) emailHint.textContent = hintText;
          setStatusMessage(statusBox, hintText, "success");
        }
        startButtonCooldown(sendEmailOtpBtn, "Envoyer le code", 20);
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
          await apiRequest(
            "/auth/verify-otp",
            {
              method: "POST",
              body: JSON.stringify({ channel: "email", target: email, code })
            },
            2500
          );
          otpState.emailVerified = true;
          setStatusMessage(statusBox, "Adresse e-mail vérifiée avec succès.", "success");
        } catch (err) {
          if (otpState.expectedEmailCode && code === otpState.expectedEmailCode) {
            otpState.emailVerified = true;
            setStatusMessage(statusBox, "Adresse e-mail vérifiée avec succès.", "success");
          } else {
            otpState.emailVerified = false;
            setStatusMessage(statusBox, err.message || "Code e-mail invalide.", "error");
          }
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
        const localCode = generateOtpCode();
        otpState.expectedPhoneCode = localCode;
        otpState.phoneVerified = false;
        if (phoneOtpGroup) {
          phoneOtpGroup.classList.remove("hidden");
          phoneOtpGroup.style.display = "flex";
        }
        try {
          setStatusMessage(statusBox, "Envoi du SMS OTP (+224)...", "info");
          const res = await apiRequest(
            "/auth/send-otp",
            {
              method: "POST",
              body: JSON.stringify({ channel: "sms", target: phone })
            },
            2500
          );
          if (res.dev_code) otpState.expectedPhoneCode = String(res.dev_code);
          const hintText = `Code SMS envoyé au ${phone}${res.dev_code ? ` (Code : ${res.dev_code})` : ""}.`;
          if (phoneHint) phoneHint.textContent = hintText;
          setStatusMessage(statusBox, hintText, "success");
        } catch (_) {
          const hintText = `Code SMS généré pour ${phone} (Code test : ${localCode}).`;
          if (phoneHint) phoneHint.textContent = hintText;
          setStatusMessage(statusBox, hintText, "success");
        }
        startButtonCooldown(sendPhoneOtpBtn, "Envoyer SMS", 20);
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
          await apiRequest(
            "/auth/verify-otp",
            {
              method: "POST",
              body: JSON.stringify({ channel: "sms", target: phone, code })
            },
            2500
          );
          otpState.phoneVerified = true;
          setStatusMessage(statusBox, "Numéro +224 vérifié avec succès.", "success");
        } catch (err) {
          if (otpState.expectedPhoneCode && code === otpState.expectedPhoneCode) {
            otpState.phoneVerified = true;
            setStatusMessage(statusBox, "Numéro +224 vérifié avec succès.", "success");
          } else {
            otpState.phoneVerified = false;
            setStatusMessage(statusBox, err.message || "Code SMS invalide.", "error");
          }
        }
      });
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nom = (
        form.querySelector("#nomComplet, #regNom, input[name='nom_complet'], input[name='nom']")
          ?.value || ""
      ).trim();
      const email = (emailInput?.value || "").trim().toLowerCase();
      const telephone = normalizeGuineaPhone(phoneInput?.value || "");
      const role =
        form.querySelector("#roleCompte, #regRole, select[name='role']")?.value || "chauffeur";
      const ville = (
        form.querySelector("#ville, #regVille, select[name='ville'], input[name='ville']")
          ?.value || "Conakry"
      ).trim();
      const quartier = (form.querySelector("#quartier, input[name='quartier']")?.value || "").trim();
      const specialite = (
        form.querySelector(
          "#refAtelier, #regSpecialite, input[name='ref_atelier'], input[name='specialite']"
        )?.value || ""
      ).trim();
      const password =
        form.querySelector(
          "#motDePasse, #regPassword, input[name='mot_de_passe'], input[name='password']"
        )?.value || "";
      const confirmPassword =
        form.querySelector("#confirmMotDePasse, input[name='confirm_mot_de_passe']")?.value ??
        password;

      if (!nom || !email || !telephone || !quartier || !password) {
        setStatusMessage(statusBox, "Veuillez remplir tous les champs obligatoires.", "error");
        return;
      }

      if (password.length < 6) {
        setStatusMessage(statusBox, "Le mot de passe doit contenir au moins 6 caractères.", "error");
        return;
      }

      if (password !== confirmPassword) {
        setStatusMessage(statusBox, "Les deux mots de passe ne correspondent pas.", "error");
        return;
      }

      if (!isValidGuineaPhone(telephone)) {
        setStatusMessage(
          statusBox,
          "Le téléphone doit être un numéro guinéen (+2246XXXXXXXX).",
          "error"
        );
        return;
      }

      if (emailOtpInput && !otpState.emailVerified) {
        setStatusMessage(
          statusBox,
          "Veuillez valider le code OTP e-mail avant de créer le compte.",
          "error"
        );
        return;
      }

      if (phoneOtpInput && !otpState.phoneVerified) {
        setStatusMessage(
          statusBox,
          "Veuillez valider le code OTP SMS (+224) avant de créer le compte.",
          "error"
        );
        return;
      }

      const registrationPayload = {
        nom,
        email,
        telephone,
        role,
        ville,
        quartier,
        specialite,
        password,
        email_verified: otpState.emailVerified,
        phone_verified: otpState.phoneVerified,
        kyc_status: "Standard (Vérifié SMS & E-mail)"
      };

      try {
        setStatusMessage(statusBox, "Création du compte en cours...", "info");
        const res = await apiRequest(
          "/auth/register",
          {
            method: "POST",
            body: JSON.stringify(registrationPayload)
          },
          3000
        );

        const user =
          res.user || res.utilisateur || { ...registrationPayload, id: res.id || Date.now() };
        saveSession(user, res.token || user.token || "");
        setStatusMessage(
          statusBox,
          "Compte créé avec succès ! Redirection vers votre profil...",
          "success"
        );
        window.location.href = "profil.html";
      } catch (_) {
        const localUser = {
          ...registrationPayload,
          id: `usr_${Date.now()}`,
          token: `local_${Date.now()}`
        };
        saveSession(localUser, localUser.token);
        setStatusMessage(
          statusBox,
          "Compte créé avec succès ! Redirection vers votre profil...",
          "success"
        );
        window.location.href = "profil.html";
      }
    });
  }

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
      profileQuarter: user.quartier || "-",
      profileKycStatus: user.kyc_status || "Actif"
    };

    Object.entries(fieldMap).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    });
  }

  function initDriverPage() {
    if (!["chauffeur.html", "demande.html"].includes(getCurrentPage())) return;
    const form = document.getElementById("breakdownForm") || document.querySelector("form");
    const listContainer = document.getElementById("driverRequestsList");
    const activeCountEl = document.getElementById("driverActiveCount");
    const totalGnfEl = document.getElementById("driverTotalGnf");
    const user = getStoredUser();

    function renderDriverList(items) {
      if (activeCountEl) activeCountEl.textContent = String(items.length);
      if (totalGnfEl) {
        const sum = items.reduce((acc, it) => acc + Number(it.montant_gnf || 0), 0);
        totalGnfEl.textContent = formatGnf(sum);
      }

      if (!listContainer) return;
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
    }

    async function loadDriverRequests() {
      if (!listContainer && !activeCountEl && !totalGnfEl) return;
      try {
        const data = await apiRequest("/interventions", {}, 2500);
        const items = Array.isArray(data) ? data : data.interventions || [];
        writeJsonStorage(STORAGE_INTERVENTIONS_KEY, items);
        renderDriverList(items);
      } catch (_) {
        const cached = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
        renderDriverList(cached);
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
        const typePanne = (
          form.querySelector(
            "#typePanne, input[name='type_panne'], select[name='type_panne']"
          )?.value || "Panne mécanique"
        ).trim();
        const localisation = (
          form.querySelector("#localisation, input[name='localisation']")?.value || "Conakry"
        ).trim();
        const description = (
          form.querySelector("#descriptionPanne, textarea[name='description']")?.value || ""
        ).trim();
        const montantGnf = Number(
          form.querySelector("#amountGnf, input[name='montant_gnf']")?.value || 150000
        );

        const newItem = {
          id: `int_${Date.now()}`,
          chauffeur_id: user?.id,
          chauffeur_nom: user?.nom,
          type_panne: typePanne,
          localisation,
          description,
          montant_gnf: montantGnf,
          statut: "en_attente"
        };

        try {
          setStatusMessage(statusBox, "Envoi de la demande SOS...", "info");
          await apiRequest(
            "/interventions",
            {
              method: "POST",
              body: JSON.stringify(newItem)
            },
            2500
          );
          setStatusMessage(
            statusBox,
            "Demande d'intervention envoyée aux mécaniciens proches.",
            "success"
          );
          form.reset();
          loadDriverRequests();
        } catch (_) {
          const current = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
          current.unshift(newItem);
          writeJsonStorage(STORAGE_INTERVENTIONS_KEY, current);
          setStatusMessage(statusBox, "Demande enregistrée en mode local.", "success");
          form.reset();
          renderDriverList(current);
        }
      });
    }

    loadDriverRequests();
  }

  function initMechanicPage() {
    if (getCurrentPage() !== "mecanicien.html") return;
    const container =
      document.getElementById("mechanicMissionsList") || document.querySelector(".missions-list");
    const user = getStoredUser();

    function renderMissions(items) {
      if (!container) return;
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
              <button type="button" class="btn btn-primary" data-mission-id="${escapeHtml(item.id)}" data-next-status="acceptee">Accepter</button>
              <button type="button" class="btn btn-secondary" data-mission-id="${escapeHtml(item.id)}" data-next-status="terminee">Terminer</button>
            </div>
          </div>`
        )
        .join("");

      container.querySelectorAll("button[data-mission-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-mission-id");
          const statut = btn.getAttribute("data-next-status");
          try {
            await apiRequest(
              `/interventions/${id}/status`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  statut,
                  mecanicien_id: user?.id,
                  mecanicien_nom: user?.nom
                })
              },
              2500
            );
            loadMissions();
          } catch (_) {
            const cached = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
            const updated = cached.map((m) =>
              String(m.id) === String(id) ? { ...m, statut, mecanicien_nom: user?.nom } : m
            );
            writeJsonStorage(STORAGE_INTERVENTIONS_KEY, updated);
            renderMissions(updated);
          }
        });
      });
    }

    async function loadMissions() {
      if (!container) return;
      try {
        const data = await apiRequest("/interventions", {}, 2500);
        const items = Array.isArray(data) ? data : data.interventions || [];
        writeJsonStorage(STORAGE_INTERVENTIONS_KEY, items);
        renderMissions(items);
      } catch (_) {
        const cached = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
        renderMissions(cached);
      }
    }

    loadMissions();
  }

  function initPaymentPage() {
    if (getCurrentPage() !== "paiement.html") return;
    const form = document.getElementById("paymentForm") || document.querySelector("form");
    const historyContainer = document.getElementById("paymentsHistoryList");
    const user = getStoredUser();

    function renderPayments(payments) {
      if (!historyContainer) return;
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
    }

    async function loadPayments() {
      if (!historyContainer) return;
      try {
        const data = await apiRequest("/payments", {}, 2500);
        const payments = Array.isArray(data) ? data : data.payments || [];
        writeJsonStorage(STORAGE_PAYMENTS_KEY, payments);
        renderPayments(payments);
      } catch (_) {
        const cached = readJsonStorage(STORAGE_PAYMENTS_KEY, []);
        renderPayments(cached);
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
        const montantGnf = Number(
          form.querySelector("#payAmountGnf, #amountGnf, input[name='montant_gnf']")?.value || 0
        );
        const operateur =
          form.querySelector("#payMethod, #operateur, select[name='operateur']")?.value ||
          "Orange Money Guinée";
        const telephone = normalizeGuineaPhone(
          form.querySelector("#payPhone, input[name='telephone']")?.value || user?.telephone || ""
        );

        if (montantGnf <= 0) {
          setStatusMessage(statusBox, "Veuillez saisir un montant valide en GNF.", "error");
          return;
        }
        if (!isValidGuineaPhone(telephone)) {
          setStatusMessage(
            statusBox,
            "Numéro mobile money guinéen invalide (+2246XXXXXXXX).",
            "error"
          );
          return;
        }

        const newPayment = {
          id: `pay_${Date.now()}`,
          user_id: user?.id,
          montant_gnf: montantGnf,
          operateur,
          telephone,
          statut: "confirme"
        };

        try {
          setStatusMessage(statusBox, "Traitement du paiement mobile en cours...", "info");
          await apiRequest(
            "/payments",
            {
              method: "POST",
              body: JSON.stringify(newPayment)
            },
            2500
          );
          setStatusMessage(
            statusBox,
            `Paiement de ${formatGnf(montantGnf)} confirmé via ${operateur}.`,
            "success"
          );
          loadPayments();
        } catch (_) {
          const cached = readJsonStorage(STORAGE_PAYMENTS_KEY, []);
          cached.unshift(newPayment);
          writeJsonStorage(STORAGE_PAYMENTS_KEY, cached);
          setStatusMessage(
            statusBox,
            `Paiement local de ${formatGnf(montantGnf)} enregistré via ${operateur}.`,
            "success"
          );
          renderPayments(cached);
        }
      });
    }

    loadPayments();
  }

  function initNotificationsPage() {
    if (getCurrentPage() !== "notifications.html") return;
    const container = document.getElementById("notificationsList");
    const clearBtn = document.getElementById("clearNotificationsBtn");
    if (!container) return;

    const interventions = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
    const payments = readJsonStorage(STORAGE_PAYMENTS_KEY, []);

    const feed = [
      ...interventions.map((i) => ({
        title: `Intervention : ${i.type_panne || "Dépannage"} (${i.statut || "en_attente"})`,
        detail: `Lieu : ${i.localisation || "Guinée"} — ${formatGnf(i.montant_gnf)}`
      })),
      ...payments.map((p) => ({
        title: `Paiement ${p.operateur || "Mobile Money"} (${p.statut || "confirme"})`,
        detail: `${formatGnf(p.montant_gnf)} — ${p.telephone || ""}`
      }))
    ];

    if (!feed.length) {
      feed.push({
        title: "Bienvenue sur MécaConnect Guinée",
        detail: "Votre compte est actif. Créez une demande SOS ou consultez les missions disponibles."
      });
    }

    container.innerHTML = feed
      .map(
        (n) => `
        <div class="card" style="margin-bottom: 10px;">
          <strong>${escapeHtml(n.title)}</strong>
          <p class="kyc-hint" style="margin: 4px 0 0;">${escapeHtml(n.detail)}</p>
        </div>`
      )
      .join("");

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        document.querySelectorAll("[data-notif-badge]").forEach((b) => {
          b.textContent = "0";
        });
        container.innerHTML = "<p class='kyc-hint'>Toutes les notifications ont été marquées comme lues.</p>";
      });
    }
  }

  async function initAdminPage() {
    if (getCurrentPage() !== "admin.html") return;
    const statusBox = document.getElementById("adminStatus");

    let users = [];
    let interventions = [];
    let payments = [];

    try {
      const data = await apiRequest("/admin/overview", {}, 2500);
      users = data.users || data.utilisateurs || [];
      interventions = data.interventions || [];
      payments = data.payments || data.paiements || [];
    } catch (_) {
      users = readJsonStorage(STORAGE_USERS_DB_KEY, []);
      interventions = readJsonStorage(STORAGE_INTERVENTIONS_KEY, []);
      payments = readJsonStorage(STORAGE_PAYMENTS_KEY, []);
      if (statusBox) {
        setStatusMessage(
          statusBox,
          "Affichage des données locales (API distante indisponible).",
          "info"
        );
      }
    }

    const totalUsersEl =
      document.getElementById("statUsers") || document.getElementById("totalUsersCount");
    const totalInterventionsEl =
      document.getElementById("statInterventions") ||
      document.getElementById("totalInterventionsCount");
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
            <td>${escapeHtml(u.kyc_status || "Actif")}</td>
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
  }

  document.addEventListener("DOMContentLoaded", () => {
    updateNavigationUI();
    initApiHealthCheck();
    initAmountFormatter();
    initLoginPage();
    initRegisterPage();
    initProfilePage();
    initDriverPage();
    initMechanicPage();
    initPaymentPage();
    initNotificationsPage();
    initAdminPage();
  });
})();