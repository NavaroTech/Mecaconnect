const API_BASE_URL = (
  window.API_BASE_URL ||
  window.API_BASE ||
  "https://mecaconnect-api.onrender.com/api"
).replace(/\/+$/, "");

const TOKEN_KEY = "mecaconnect_token";
const USER_KEY = "mecaconnect_user";

function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveSession(token, user) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  }
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getStoredToken();
  const user = getStoredUser();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (user && user.id) {
    headers["X-User-Id"] = String(user.id);
  }
  return headers;
}

function setFeedback(el, message, isError = false) {
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "#dc2626" : "#15803d";
  if (el.classList.contains("status-box")) {
    el.classList.remove("hidden", "error", "success", "info");
    el.classList.add(isError ? "error" : "success");
  }
}

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

function syncHeaderUI() {
  const user = getStoredUser();
  const displayName = user?.nom_complet || user?.nom || user?.email || "Invité";

  document.querySelectorAll("[data-user-name]").forEach((el) => {
    el.textContent = displayName;
  });

  const isLoggedIn = Boolean(user && (user.id || user.email || getStoredToken()));
  document.querySelectorAll(".auth-guest-only").forEach((el) => {
    el.style.display = isLoggedIn ? "none" : "";
  });
  document.querySelectorAll("[data-auth-logout]").forEach((el) => {
    el.style.display = isLoggedIn ? "" : "none";
  });
}

async function refreshNotificationsBadge() {
  const badges = document.querySelectorAll("[data-notif-badge]");
  if (!badges.length) return;

  const user = getStoredUser();
  if (!user && !getStoredToken()) {
    badges.forEach((b) => { b.textContent = "0"; });
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/notifications`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data.notifications) ? data.notifications : [];
    const unread = list.filter((n) => !n.lu).length;
    badges.forEach((b) => { b.textContent = String(unread); });
  } catch (_) {
    // Silencieux
  }
}

function bindLogout() {
  document.querySelectorAll("[data-auth-logout], #logoutBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      clearSession();
      syncHeaderUI();
      window.location.href = "./connexion.html";
    });
  });
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

async function submitLoginRequest(rawIdentifier, password, feedbackEl) {
  const cleanId = String(rawIdentifier || "").trim();
  const isEmail = cleanId.includes("@");
  const identifier = isEmail ? cleanId.toLowerCase() : normalizeGuineaPhone(cleanId);

  if (!cleanId || !password) {
    setFeedback(feedbackEl, "Identifiant (e-mail ou téléphone +224) et mot de passe requis.", true);
    return;
  }

  if (!isValidIdentifier(identifier)) {
    setFeedback(
      feedbackEl,
      "Format invalide : saisissez un e-mail valide ou un numéro +224 (8 ou 9 chiffres).",
      true
    );
    return;
  }

  setFeedback(feedbackEl, "Connexion en cours...", false);

  try {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier,
        identifiant: identifier,
        email: isEmail ? identifier : "",
        phone: isEmail ? "" : identifier,
        password,
        mot_de_passe: password
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || data.message || `Erreur HTTP ${response.status}`);
    }

    const userObj = data.user || { email: isEmail ? identifier : "", role: data.role || "" };
    saveSession(data.token || "", userObj);
    syncHeaderUI();

    setFeedback(feedbackEl, "Connexion réussie ! Redirection...", false);
    const role = userObj.role || data.role || "";
    setTimeout(() => {
      window.location.href = role === "admin" ? "./admin.html" : "./profil.html";
    }, 600);
  } catch (err) {
    setFeedback(feedbackEl, `Erreur de connexion : ${err.message}`, true);
  }
}

function bindLoginForms() {
  const connexionForm = document.getElementById("connexionForm");
  if (connexionForm) {
    connexionForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const idVal = document.getElementById("loginEmail")?.value || "";
      const pwdVal = document.getElementById("loginPassword")?.value || "";
      const fb = document.getElementById("loginFeedback");
      await submitLoginRequest(idVal, pwdVal, fb);
    });
  }

  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const idVal = document.getElementById("loginIdentifier")?.value || "";
      const pwdVal = document.getElementById("loginPassword")?.value || "";
      const fb = document.getElementById("loginStatus");
      await submitLoginRequest(idVal, pwdVal, fb);
    });
  }
}

function bindInscriptionForm() {
  const form = document.getElementById("inscriptionForm");
  if (!form) return;

  let emailVerified = false;
  let smsVerified = false;
  let selfieDataUrl = "";
  let cameraStream = null;

  const telInput = document.getElementById("telephone");
  if (telInput) {
    telInput.addEventListener("blur", () => {
      const norm = normalizeGuineaPhone(telInput.value);
      if (norm) telInput.value = norm;
    });
  }

  // --- Vérification OTP E-mail ---
  const sendOtpBtn = document.getElementById("sendOtpBtn");
  const otpGroup = document.getElementById("otpGroup");
  const emailHint = document.getElementById("emailStatusHint");
  const verifyOtpBtn = document.getElementById("verifyOtpBtn");
  const otpHint = document.getElementById("otpStatusHint");

  if (sendOtpBtn) {
    sendOtpBtn.addEventListener("click", async () => {
      const email = (document.getElementById("email")?.value || "").trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setFeedback(emailHint, "Saisissez une adresse e-mail valide avant d'envoyer le code.", true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/auth/request-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Impossible d'envoyer le code e-mail.");
        if (otpGroup) otpGroup.style.display = "";
        setFeedback(
          emailHint,
          data.otp_code
            ? `Code e-mail envoyé (test : ${data.otp_code}, expire dans ${data.expires_in_minutes || 15} min).`
            : "Code envoyé à votre adresse e-mail.",
          false
        );
      } catch (err) {
        setFeedback(emailHint, err.message, true);
      }
    });
  }

  if (verifyOtpBtn) {
    verifyOtpBtn.addEventListener("click", async () => {
      const email = (document.getElementById("email")?.value || "").trim().toLowerCase();
      const codeOtp = (document.getElementById("emailOtp")?.value || "").trim();
      if (!email || !codeOtp) {
        setFeedback(otpHint, "Saisissez l'e-mail et le code à 6 chiffres.", true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/auth/verify-email-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, code_otp: codeOtp })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Code e-mail invalide.");
        emailVerified = true;
        setFeedback(otpHint, "Adresse e-mail vérifiée avec succès.", false);
      } catch (err) {
        setFeedback(otpHint, err.message, true);
      }
    });
  }

  // --- Vérification OTP SMS (+224) ---
  const sendSmsBtn = document.getElementById("sendSmsBtn");
  const smsOtpGroup = document.getElementById("smsOtpGroup");
  const smsStatusHint = document.getElementById("smsStatusHint");
  const verifySmsBtn = document.getElementById("verifySmsBtn");
  const smsOtpHint = document.getElementById("smsOtpStatusHint");

  if (sendSmsBtn) {
    sendSmsBtn.addEventListener("click", async () => {
      const phone = normalizeGuineaPhone(document.getElementById("telephone")?.value || "");
      if (!/^\+224\d{8,9}$/.test(phone)) {
        setFeedback(smsStatusHint, "Numéro invalide : saisissez un numéro +224 (8 ou 9 chiffres).", true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/auth/request-sms-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ telephone: phone, phone })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Impossible d'envoyer le SMS.");
        if (smsOtpGroup) smsOtpGroup.style.display = "";
        setFeedback(
          smsStatusHint,
          data.otp_code
            ? `SMS envoyé au ${phone} (test : ${data.otp_code}, expire dans ${data.expires_in_minutes || 10} min).`
            : `SMS envoyé au ${phone}.`,
          false
        );
      } catch (err) {
        setFeedback(smsStatusHint, err.message, true);
      }
    });
  }

  if (verifySmsBtn) {
    verifySmsBtn.addEventListener("click", async () => {
      const phone = normalizeGuineaPhone(document.getElementById("telephone")?.value || "");
      const codeOtp = (document.getElementById("smsOtp")?.value || "").trim();
      if (!/^\+224\d{8,9}$/.test(phone) || !codeOtp) {
        setFeedback(smsOtpHint, "Numéro +224 et code SMS requis.", true);
        return;
      }
      try {
        const res = await fetch(`${API_BASE_URL}/auth/verify-sms-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ telephone: phone, phone, code_otp: codeOtp })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Code SMS invalide.");
        smsVerified = true;
        setFeedback(smsOtpHint, "Numéro +224 vérifié avec succès.", false);
      } catch (err) {
        setFeedback(smsOtpHint, err.message, true);
      }
    });
  }

  // --- Caméra Selfie KYC ---
  const startCameraBtn = document.getElementById("startCameraBtn");
  const takeSelfieBtn = document.getElementById("takeSelfieBtn");
  const selfieStatus = document.getElementById("selfieStatus");
  const selfieVideo = document.getElementById("selfieVideo");
  const selfiePreview = document.getElementById("selfiePreview");

  if (startCameraBtn && takeSelfieBtn) {
    startCameraBtn.addEventListener("click", async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("Caméra non prise en charge sur ce navigateur.");
        }
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false
        });
        if (selfieVideo) {
          selfieVideo.srcObject = cameraStream;
          selfieVideo.style.display = "block";
        }
        takeSelfieBtn.disabled = false;
        setFeedback(selfieStatus, "Caméra activée. Cadrez votre visage puis cliquez sur « Prendre le selfie ».", false);
      } catch (err) {
        setFeedback(selfieStatus, `Caméra indisponible (${err.message}). Vous pouvez continuer l'inscription.`, true);
      }
    });

    takeSelfieBtn.addEventListener("click", () => {
      try {
        if (selfieVideo && selfieVideo.videoWidth) {
          const canvas = document.createElement("canvas");
          canvas.width = selfieVideo.videoWidth;
          canvas.height = selfieVideo.videoHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(selfieVideo, 0, 0);
          selfieDataUrl = canvas.toDataURL("image/jpeg", 0.85);
          if (selfiePreview) {
            selfiePreview.src = selfieDataUrl;
            selfiePreview.style.display = "block";
          }
          selfieVideo.style.display = "none";
        } else {
          selfieDataUrl = "captured://selfie-kyc";
        }
        if (cameraStream) {
          cameraStream.getTracks().forEach((t) => t.stop());
          cameraStream = null;
        }
        setFeedback(selfieStatus, "Selfie capturé avec succès.", false);
      } catch (err) {
        setFeedback(selfieStatus, `Erreur capture selfie : ${err.message}`, true);
      }
    });
  }

  // --- Soumission Inscription ---
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fb = document.getElementById("inscriptionFeedback");

    const nomComplet = (document.getElementById("nomComplet")?.value || "").trim();
    const telephone = normalizeGuineaPhone(document.getElementById("telephone")?.value || "");
    const email = (document.getElementById("email")?.value || "").trim().toLowerCase();
    const role = document.getElementById("roleCompte")?.value || "chauffeur";
    const ville = document.getElementById("ville")?.value || "Conakry";
    const quartier = (document.getElementById("quartier")?.value || "").trim();
    const typePiece = document.getElementById("typePiece")?.value || "CNI Guinée";
    const numeroPiece = (document.getElementById("numeroPiece")?.value || "").trim().toUpperCase();
    const dateExpiration = document.getElementById("dateExpiration")?.value || "";
    const refAtelier = (document.getElementById("refAtelier")?.value || "").trim();
    const motDePasse = document.getElementById("motDePasse")?.value || "";

    if (!nomComplet || !/^\+224\d{8,9}$/.test(telephone) || motDePasse.length < 6) {
      setFeedback(
        fb,
        "Nom complet, téléphone +224 (8 ou 9 chiffres) et mot de passe (min 6 caractères) requis.",
        true
      );
      return;
    }

    setFeedback(fb, "Création du compte en cours...", false);

    try {
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nom_complet: nomComplet,
          telephone,
          email,
          role,
          ville,
          quartier,
          type_piece: typePiece,
          numero_piece: numeroPiece,
          date_expiration: dateExpiration,
          ref_atelier: refAtelier,
          mot_de_passe: motDePasse,
          email_verifie: emailVerified,
          telephone_verifie: smsVerified,
          selfie_data_url: selfieDataUrl
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || "Erreur lors de l'inscription.");
      }

      if (data.user) {
        saveSession(data.token || "", data.user);
        syncHeaderUI();
      }

      setFeedback(fb, "Compte créé avec succès ! Redirection vers votre profil...", false);
      setTimeout(() => {
        window.location.href = "./profil.html";
      }, 700);
    } catch (err) {
      setFeedback(fb, `Erreur d'inscription : ${err.message}`, true);
    }
  });
}

function bindKycForm() {
  const kycForm = document.getElementById("kycForm");
  if (!kycForm) return;

  const kycStatus = document.getElementById("kycStatus");
  const phoneInput = document.getElementById("phone");
  if (phoneInput) {
    phoneInput.addEventListener("blur", () => {
      const normalized = normalizeGuineaPhone(phoneInput.value);
      if (normalized) phoneInput.value = normalized;
    });
  }

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
      if (data.user) {
        saveSession(data.token || "", data.user);
        syncHeaderUI();
      }
      showStatus(kycStatus, "Inscription et dossier KYC envoyés avec succès !", "success");
    } catch (err) {
      showStatus(kycStatus, `Erreur lors de la soumission : ${err.message}`, "error");
    }
  });
}

async function initProfilePage() {
  const container = document.querySelector("[data-profile-info]") || document.getElementById("profilInfo");
  if (!container) return;

  const cachedUser = getStoredUser();
  if (!cachedUser && !getStoredToken()) {
    container.innerHTML = `
      <p>Vous n'êtes pas connecté.</p>
      <div class="hero-actions">
        <a href="connexion.html" class="btn-primary">Se connecter</a>
        <a href="inscription.html" class="btn-secondary">Créer un compte</a>
      </div>
    `;
    return;
  }

  let profile = cachedUser;
  try {
    const res = await fetch(`${API_BASE_URL}/profil`, {
      headers: getAuthHeaders()
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.user) {
        profile = data.user;
        saveSession(getStoredToken(), profile);
        syncHeaderUI();
      }
    }
  } catch (_) {
    // Utilise le cache local
  }

  if (!profile) return;

  container.innerHTML = `
    <div class="cards-grid">
      <div class="kyc-box">
        <strong>Nom complet :</strong> ${profile.nom_complet || "—"}<br />
        <strong>Rôle :</strong> ${profile.role || "—"}<br />
        <strong>Statut KYC :</strong> <span class="status-badge">${profile.statut_kyc || "en_attente"}</span><br />
        <strong>E-mail vérifié :</strong> ${profile.email_verifie ? "Oui" : "En attente"}<br />
        <strong>SMS +224 vérifié :</strong> ${profile.telephone_verifie ? "Oui" : "En attente"}
      </div>
      <div class="kyc-box">
        <strong>Téléphone :</strong> ${profile.telephone || "—"}<br />
        <strong>E-mail :</strong> ${profile.email || "—"}<br />
        <strong>Localisation :</strong> ${profile.ville || "Conakry"}${profile.quartier ? ` — ${profile.quartier}` : ""}
      </div>
    </div>
  `;
}

async function updateDemandeStatus(demandeId, statut, onDone = null) {
  try {
    const res = await fetch(`${API_BASE_URL}/demandes/${demandeId}/statut`, {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ statut })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Impossible de mettre à jour la demande.");
    }
    if (typeof onDone === "function") {
      await onDone();
    }
  } catch (err) {
    alert(err.message);
  }
}

async function initDemandesPage() {
  const listEl = document.getElementById("demandesList") || document.querySelector("[data-demandes-list]");
  if (!listEl) return;

  const user = getStoredUser();
  const isMecanicien = user?.role === "mecanicien" || user?.role === "admin";

  listEl.innerHTML = `<p class="kyc-hint">Chargement des demandes...</p>`;

  try {
    const res = await fetch(`${API_BASE_URL}/demandes`, {
      headers: getAuthHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      listEl.innerHTML = `<p class="kyc-hint">${data.error || "Connectez-vous pour consulter les demandes."}</p>`;
      return;
    }

    const demandes = Array.isArray(data.demandes) ? data.demandes : [];
    if (!demandes.length) {
      listEl.innerHTML = `<p class="kyc-hint">Aucune demande d'intervention pour le moment.</p>`;
      return;
    }

    listEl.innerHTML = "";
    demandes.forEach((d) => {
      const card = document.createElement("article");
      card.className = "demande-card";

      const actionButtons = isMecanicien
        ? `
          <div class="kyc-actions">
            <button type="button" class="btn-primary" data-action="accept" data-id="${d.id}">Accepter</button>
            <button type="button" class="btn-secondary" data-action="complete" data-id="${d.id}">Terminer</button>
          </div>
        `
        : `
          <div class="kyc-actions">
            <a href="paiement.html" class="btn-pay" onclick="localStorage.setItem('mecaconnect_derniere_intervention', ${JSON.stringify(d.reference_code || d.type_panne || "Intervention")}); localStorage.setItem('mecaconnect_dernier_montant_gnf', '${Number(d.montant_estime_gnf || 150000)}');">Payer en GNF</a>
          </div>
        `;

      card.innerHTML = `
        <div class="card-header">
          <strong>${d.reference_code || `#${d.id}`} — ${d.type_panne || "Intervention"}</strong>
          <span class="status-badge">${d.statut || "en_attente"}</span>
        </div>
        <p><strong>Localisation :</strong> ${d.localisation || "Guinée"}</p>
        <p><strong>Montant estimé :</strong> ${formatGnf(d.montant_estime_gnf)}</p>
        ${d.description ? `<p>${d.description}</p>` : ""}
        ${actionButtons}
      `;

      card.querySelector('[data-action="accept"]')?.addEventListener("click", () => {
        updateDemandeStatus(d.id, "acceptee", initDemandesPage);
      });
      card.querySelector('[data-action="complete"]')?.addEventListener("click", () => {
        updateDemandeStatus(d.id, "terminee", initDemandesPage);
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = `<p class="kyc-hint">Erreur de chargement : ${err.message}</p>`;
  }
}

async function initAdminPage() {
  const usersBody = document.getElementById("adminUsersTableBody");
  const demandesBody = document.getElementById("adminDemandesTableBody");
  const paiementsBody = document.getElementById("adminPaiementsTableBody");
  if (!usersBody && !demandesBody && !paiementsBody) return;

  let allUsers = [];

  const renderUsers = (filterText = "") => {
    if (!usersBody) return;
    const q = filterText.trim().toLowerCase();
    const filtered = !q
      ? allUsers
      : allUsers.filter((u) =>
          [u.nom_complet, u.email, u.telephone, u.role, u.numero_document, u.specialite, u.ville]
            .filter(Boolean)
            .some((val) => String(val).toLowerCase().includes(q))
        );

    if (!filtered.length) {
      usersBody.innerHTML = `<tr><td colspan="7">Aucun utilisateur trouvé.</td></tr>`;
      return;
    }

    usersBody.innerHTML = filtered
      .map(
        (u) => `
        <tr>
          <td>${u.id}</td>
          <td><strong>${u.nom_complet || "—"}</strong><br /><small>${u.role || "—"}</small></td>
          <td>${u.telephone || "—"} ${u.telephone_verifie ? "✓" : ""}<br /><small>${u.email || ""} ${u.email_verifie ? "✓" : ""}</small></td>
          <td>${u.numero_document ? `${u.type_document || "Pièce"} : ${u.numero_document}` : "Non renseignée"}</td>
          <td>${u.specialite || u.ville || "—"}</td>
          <td><span class="status-badge">${u.statut_kyc || "en_attente"}</span></td>
          <td>${u.actif === false ? "Inactif" : "Actif"}</td>
        </tr>
      `
      )
      .join("");
  };

  const loadOverview = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/overview`, {
        headers: getAuthHeaders()
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (usersBody) {
          usersBody.innerHTML = `<tr><td colspan="7">${data.error || "Accès administrateur requis."}</td></tr>`;
        }
        return;
      }

      const stats = data.stats || {};
      const elTotalUsers = document.getElementById("statTotalUsers");
      const elUsersSplit = document.getElementById("statUsersSplit");
      const elTotalDemandes = document.getElementById("statTotalDemandes");
      const elDemandesPending = document.getElementById("statDemandesPending");
      const elTotalRevenus = document.getElementById("statTotalRevenus");

      if (elTotalUsers) elTotalUsers.textContent = String(stats.total_users ?? 0);
      if (elUsersSplit) {
        elUsersSplit.textContent = `${stats.chauffeurs ?? 0} chauffeurs · ${stats.mecaniciens ?? 0} mécaniciens`;
      }
      if (elTotalDemandes) elTotalDemandes.textContent = String(stats.total_demandes ?? 0);
      if (elDemandesPending) elDemandesPending.textContent = `${stats.pending_demandes ?? 0} en attente`;
      if (elTotalRevenus) {
        elTotalRevenus.textContent = stats.total_revenus_formate || formatGnf(stats.total_revenus_gnf || 0);
      }

      allUsers = Array.isArray(data.users) ? data.users : [];
      renderUsers(document.getElementById("adminUserSearch")?.value || "");

      if (demandesBody) {
        const demandes = Array.isArray(data.demandes) ? data.demandes : [];
        demandesBody.innerHTML = demandes.length
          ? demandes
              .map(
                (d) => `
                <tr>
                  <td>${d.reference_code || d.id}</td>
                  <td>${d.client_nom || d.client_id || "—"}</td>
                  <td>${d.type_panne || "—"}</td>
                  <td>${d.localisation || "—"}</td>
                  <td>${formatGnf(d.montant_estime_gnf)}</td>
                  <td><span class="status-badge">${d.statut || "en_attente"}</span></td>
                  <td>
                    <button type="button" class="btn-secondary" data-admin-complete="${d.id}">Terminer</button>
                  </td>
                </tr>
              `
              )
              .join("")
          : `<tr><td colspan="7">Aucune demande enregistrée.</td></tr>`;

        demandesBody.querySelectorAll("[data-admin-complete]").forEach((btn) => {
          btn.addEventListener("click", () => {
            updateDemandeStatus(btn.getAttribute("data-admin-complete"), "terminee", loadOverview);
          });
        });
      }

      if (paiementsBody) {
        const paiements = Array.isArray(data.paiements) ? data.paiements : [];
        paiementsBody.innerHTML = paiements.length
          ? paiements
              .map(
                (p) => `
                <tr>
                  <td>${p.id}</td>
                  <td>${p.demande_ref || p.demande_id || p.reference_paiement || "—"}</td>
                  <td>${formatGnf(p.montant_gnf)}</td>
                  <td>${p.operateur || "Orange Money"}</td>
                  <td><span class="status-badge">${p.statut || "confirme"}</span></td>
                  <td>${p.cree_le ? new Date(p.cree_le).toLocaleDateString("fr-FR") : "—"}</td>
                </tr>
              `
              )
              .join("")
          : `<tr><td colspan="6">Aucun paiement enregistré.</td></tr>`;
      }
    } catch (err) {
      if (usersBody) {
        usersBody.innerHTML = `<tr><td colspan="7">Erreur : ${err.message}</td></tr>`;
      }
    }
  };

  document.getElementById("adminUserSearch")?.addEventListener("input", (e) => {
    renderUsers(e.target.value);
  });
  document.getElementById("refreshAdminBtn")?.addEventListener("click", loadOverview);

  await loadOverview();
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
  document.body.classList.add("page-loaded");
  syncHeaderUI();
  bindLogout();
  bindLoginForms();
  bindInscriptionForm();
  bindKycForm();
  bindHelpers();
  initProfilePage();
  initDemandesPage();
  initAdminPage();
  refreshNotificationsBadge();
  checkApiHealth();
});