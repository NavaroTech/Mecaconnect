const STORAGE_KEYS = {
    user: "mecaconnect_user",
    lastAmountGnf: "mecaconnect_dernier_montant_gnf",
    lastIntervention: "mecaconnect_derniere_intervention"
};

const API_BASE =
    window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
        ? "http://127.0.0.1:5000/api"
        : "https://VOTRE-URL-BACKEND/api";

const DOMAIN_TYPO_SUGGESTIONS = {
    "gmial.com": "gmail.com",
    "gmil.com": "gmail.com",
    "gmai.com": "gmail.com",
    "gmail.con": "gmail.com",
    "gmail.co": "gmail.com",
    "yaho.com": "yahoo.com",
    "yahooo.com": "yahoo.com",
    "yahoo.con": "yahoo.com",
    "hotmal.com": "hotmail.com",
    "hotmai.com": "hotmail.com",
    "outlok.com": "outlook.com",
    "outloo.com": "outlook.com"
};

const DOMAINES_BLOQUES = new Set([
    "tempmail.com",
    "10minutemail.com",
    "guerrillamail.com",
    "mailinator.com",
    "yopmail.com",
    "throwaway.email"
]);

let emailVerifieParOtp = false;
let selfieCaptureOk = false;
let cameraStream = null;

document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("page-loaded");
    initAuthHeader();
    initEmailValidation();
    initOtpFlow();
    initCameraKyc();
    initInscriptionForm();
    initConnexionForm();
    initFilters();
    window.addEventListener("beforeunload", stopCameraStream);
});

function getCurrentUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEYS.user) || "null");
    } catch {
        return null;
    }
}

function setCurrentUser(user) {
    if (!user) {
        localStorage.removeItem(STORAGE_KEYS.user);
        return;
    }
    const safeUser = {
        id: user.id,
        nom_complet: user.nom_complet,
        telephone: user.telephone,
        email: user.email,
        role: user.role,
        ville: user.ville,
        quartier: user.quartier,
        email_verifie: user.email_verifie,
        kyc_statut: user.kyc_statut
    };
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(safeUser));
}

function initAuthHeader() {
    const user = getCurrentUser();
    document.querySelectorAll("[data-user-name]").forEach((el) => {
        el.textContent = user?.nom_complet || "Invité";
    });

    document.querySelectorAll(".auth-guest-only").forEach((el) => {
        el.style.display = user ? "none" : "";
    });

    document.querySelectorAll("[data-auth-logout]").forEach((btn) => {
        btn.style.display = user ? "" : "none";
        btn.addEventListener("click", () => {
            setCurrentUser(null);
            window.location.href = "connexion.html";
        });
    });
}

function normaliserEmail(valeur) {
    return (valeur || "").trim().toLowerCase();
}

function validerEmail(valeur) {
    const email = normaliserEmail(valeur);

    if (!email) {
        return { valide: false, message: "Veuillez saisir une adresse e-mail." };
    }
    if (/\s/.test((valeur || "").trim())) {
        return { valide: false, message: "L'adresse e-mail ne doit pas contenir d'espaces." };
    }

    const parties = email.split("@");
    if (parties.length !== 2 || !parties[0] || !parties[1]) {
        return { valide: false, message: "Format d'e-mail invalide (ex. nom@domaine.com ou nom@mecaconnect.gn)." };
    }

    const [utilisateur, domaine] = parties;
    const regexLocale = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
    const regexDomaine = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

    if (!regexLocale.test(utilisateur) || utilisateur.startsWith(".") || utilisateur.endsWith(".") || utilisateur.includes("..")) {
        return { valide: false, message: "La partie avant « @ » contient des caractères invalides." };
    }
    if (!regexDomaine.test(domaine) || domaine.includes("..")) {
        return { valide: false, message: "Le nom de domaine après « @ » est invalide." };
    }

    const tld = domaine.split(".").pop();
    if (!tld || tld.length < 2) {
        return { valide: false, message: "L'extension du domaine est incomplète." };
    }

    if (DOMAIN_TYPO_SUGGESTIONS[domaine]) {
        const suggestion = `${utilisateur}@${DOMAIN_TYPO_SUGGESTIONS[domaine]}`;
        return {
            valide: false,
            suggestion,
            message: `Adresse probablement incorrecte. Vouliez-vous dire ${suggestion} ?`
        };
    }

    if (DOMAINES_BLOQUES.has(domaine) || /\.(invalid|test|example|local)$/i.test(domaine)) {
        return {
            valide: false,
            message: "Ce domaine d'e-mail est temporaire ou inexistant. Utilisez une adresse active."
        };
    }

    return { valide: true, email, message: "" };
}

function afficherErreurEmail(inputEl, resultat) {
    if (!inputEl) return;
    const conteneur = inputEl.closest(".form-group") || inputEl.parentElement;
    let feedback = conteneur?.querySelector(".email-feedback");

    if (!feedback) {
        feedback = document.createElement("small");
        feedback.className = "email-feedback";
        feedback.style.display = "block";
        feedback.style.marginTop = "4px";
        feedback.style.fontSize = "0.82rem";
        conteneur?.appendChild(feedback);
    }

    feedback.innerHTML = "";

    if (resultat.valide) {
        inputEl.setCustomValidity("");
        inputEl.style.borderColor = "#15803d";
        feedback.style.color = "#15803d";
        feedback.textContent = "Format d'e-mail valide.";
        return;
    }

    inputEl.setCustomValidity(resultat.message);
    inputEl.style.borderColor = "#dc2626";
    feedback.style.color = "#dc2626";
    feedback.appendChild(document.createTextNode(resultat.message + " "));

    if (resultat.suggestion) {
        const btnFix = document.createElement("button");
        btnFix.type = "button";
        btnFix.textContent = `Corriger en ${resultat.suggestion}`;
        btnFix.style.marginLeft = "6px";
        btnFix.style.padding = "2px 8px";
        btnFix.style.borderRadius = "6px";
        btnFix.style.border = "1px solid #f97316";
        btnFix.style.background = "#fff7ed";
        btnFix.style.color = "#ea580c";
        btnFix.style.fontWeight = "700";
        btnFix.style.cursor = "pointer";
        btnFix.addEventListener("click", () => {
            inputEl.value = resultat.suggestion;
            emailVerifieParOtp = false;
            afficherErreurEmail(inputEl, validerEmail(inputEl.value));
        });
        feedback.appendChild(btnFix);
    }
}

function initEmailValidation() {
    document.querySelectorAll('input[type="email"]').forEach((inputEl) => {
        inputEl.addEventListener("blur", () => {
            afficherErreurEmail(inputEl, validerEmail(inputEl.value));
        });
        inputEl.addEventListener("input", () => {
            if (inputEl.id === "email") {
                emailVerifieParOtp = false;
            }
            if (inputEl.validationMessage) {
                afficherErreurEmail(inputEl, validerEmail(inputEl.value));
            }
        });
    });
}

function initOtpFlow() {
    const emailInput = document.getElementById("email");
    const sendOtpBtn = document.getElementById("sendOtpBtn");
    const verifyOtpBtn = document.getElementById("verifyOtpBtn");
    const otpGroup = document.getElementById("otpGroup");
    const emailStatusHint = document.getElementById("emailStatusHint");
    const otpStatusHint = document.getElementById("otpStatusHint");

    if (!sendOtpBtn || !emailInput) return;

    emailInput.addEventListener("input", () => {
        if (otpGroup) otpGroup.style.display = "none";
        if (otpStatusHint) otpStatusHint.textContent = "";
    });

    sendOtpBtn.addEventListener("click", async () => {
        const check = validerEmail(emailInput.value);
        afficherErreurEmail(emailInput, check);
        if (!check.valide) {
            if (emailStatusHint) {
                emailStatusHint.style.color = "#dc2626";
                emailStatusHint.textContent = check.message;
            }
            return;
        }

        sendOtpBtn.disabled = true;
        if (emailStatusHint) {
            emailStatusHint.style.color = "#475569";
            emailStatusHint.textContent = "Vérification du domaine et envoi du code...";
        }

        try {
            const res = await fetch(`${API_BASE}/email/envoyer-otp`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: check.email })
            });
            const data = await res.json();

            if (!res.ok) {
                if (emailStatusHint) {
                    emailStatusHint.style.color = "#dc2626";
                    emailStatusHint.textContent = data.error || "Cette adresse e-mail ou ce domaine n'existe pas.";
                }
                return;
            }

            if (emailStatusHint) {
                emailStatusHint.style.color = "#15803d";
                emailStatusHint.textContent = data.message || "Code envoyé. Vérifiez votre boîte e-mail.";
            }
            if (otpGroup) otpGroup.style.display = "flex";
        } catch {
            if (emailStatusHint) {
                emailStatusHint.style.color = "#dc2626";
                emailStatusHint.textContent = "Erreur réseau lors de l'envoi du code.";
            }
        } finally {
            sendOtpBtn.disabled = false;
        }
    });

    verifyOtpBtn?.addEventListener("click", async () => {
        const email = normaliserEmail(emailInput.value);
        const code = (document.getElementById("emailOtp")?.value || "").trim();

        if (!/^\d{6}$/.test(code)) {
            if (otpStatusHint) {
                otpStatusHint.style.color = "#dc2626";
                otpStatusHint.textContent = "Entrez un code à 6 chiffres.";
            }
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/email/verifier-otp`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, code })
            });
            const data = await res.json();

            if (!res.ok) {
                emailVerifieParOtp = false;
                if (otpStatusHint) {
                    otpStatusHint.style.color = "#dc2626";
                    otpStatusHint.textContent = data.error || "Code incorrect ou expiré.";
                }
                return;
            }

            emailVerifieParOtp = true;
            if (otpStatusHint) {
                otpStatusHint.style.color = "#15803d";
                otpStatusHint.textContent = data.message || "Adresse e-mail vérifiée.";
            }
        } catch {
            if (otpStatusHint) {
                otpStatusHint.style.color = "#dc2626";
                otpStatusHint.textContent = "Impossible de vérifier le code.";
            }
        }
    });
}

function stopCameraStream() {
    if (cameraStream) {
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
    }
}

function initCameraKyc() {
    const startBtn = document.getElementById("startCameraBtn");
    const takeBtn = document.getElementById("takeSelfieBtn");
    const statusEl = document.getElementById("selfieStatus");

    startBtn?.addEventListener("click", async () => {
        try {
            stopCameraStream();
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            if (takeBtn) takeBtn.disabled = false;
            if (statusEl) {
                statusEl.style.color = "#15803d";
                statusEl.textContent = "Caméra active. Cliquez sur « Prendre le selfie ».";
            }
        } catch {
            if (statusEl) {
                statusEl.style.color = "#dc2626";
                statusEl.textContent = "Caméra indisponible ou permission refusée.";
            }
        }
    });

    takeBtn?.addEventListener("click", () => {
        selfieCaptureOk = true;
        stopCameraStream();
        if (statusEl) {
            statusEl.style.color = "#15803d";
            statusEl.textContent = "Selfie capturé et validé pour le dossier KYC.";
        }
    });
}

function initInscriptionForm() {
    const form = document.getElementById("inscriptionForm");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const feedback = document.getElementById("inscriptionFeedback");
        const emailInput = document.getElementById("email");
        const emailCheck = validerEmail(emailInput?.value);
        afficherErreurEmail(emailInput, emailCheck);

        if (!emailCheck.valide) {
            if (feedback) {
                feedback.style.color = "#dc2626";
                feedback.textContent = emailCheck.message;
            }
            return;
        }

        if (!emailVerifieParOtp) {
            if (feedback) {
                feedback.style.color = "#dc2626";
                feedback.textContent = "Veuillez envoyer puis valider le code à 6 chiffres reçu par e-mail.";
            }
            return;
        }

        const photoPiece = document.getElementById("photoPiece")?.files?.[0];
        if (!photoPiece) {
            if (feedback) {
                feedback.style.color = "#dc2626";
                feedback.textContent = "Veuillez joindre la photo nette de votre pièce d'identité.";
            }
            return;
        }

        if (!selfieCaptureOk) {
            if (feedback) {
                feedback.style.color = "#dc2626";
                feedback.textContent = "Veuillez activer la caméra et prendre votre selfie KYC.";
            }
            return;
        }

        const payload = {
            nom_complet: (document.getElementById("nomComplet")?.value || "").trim(),
            telephone: (document.getElementById("telephone")?.value || "").trim(),
            email: emailCheck.email,
            role: document.getElementById("roleCompte")?.value || "chauffeur",
            ville: document.getElementById("ville")?.value || "Conakry",
            quartier: (document.getElementById("quartier")?.value || "").trim(),
            type_piece: document.getElementById("typePiece")?.value || "CNI Guinée",
            numero_piece: (document.getElementById("numeroPiece")?.value || "").trim(),
            date_expiration: document.getElementById("dateExpiration")?.value || "",
            ref_atelier: (document.getElementById("refAtelier")?.value || "").trim(),
            mot_de_passe: document.getElementById("motDePasse")?.value || "",
            selfie_valide: true
        };

        try {
            const res = await fetch(`${API_BASE}/inscription`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (!res.ok) {
                if (feedback) {
                    feedback.style.color = "#dc2626";
                    feedback.textContent = data.error || "Erreur lors de la création du compte.";
                }
                return;
            }

            setCurrentUser(data.user);
            window.location.href = "index.html";
        } catch {
            if (feedback) {
                feedback.style.color = "#dc2626";
                feedback.textContent = "Impossible de joindre le serveur MecaConnect.";
            }
        }
    });
}

function initConnexionForm() {
    const form = document.getElementById("connexionForm");
    if (!form) return;

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById("loginEmail") || document.getElementById("email");
        const passInput = document.getElementById("loginPassword") || document.getElementById("motDePasse");
        const msgEl = document.getElementById("loginFeedback") || document.getElementById("connexionFeedback");
        const email = normaliserEmail(emailInput?.value);
        const motDePasse = passInput?.value || "";

        try {
            const res = await fetch(`${API_BASE}/connexion`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, mot_de_passe: motDePasse })
            });
            const data = await res.json();

            if (!res.ok) {
                if (msgEl) {
                    msgEl.style.color = "#dc2626";
                    msgEl.textContent = data.error || "Identifiants incorrects. Vérifiez votre adresse e-mail et votre mot de passe.";
                }
                return;
            }

            setCurrentUser(data.user);
            window.location.href = data.user.role === "admin" ? "admin.html" : "index.html";
        } catch {
            if (msgEl) {
                msgEl.style.color = "#dc2626";
                msgEl.textContent = "Impossible de joindre le serveur MecaConnect.";
            }
        }
    });
}

function initFilters() {
    const locationInput = document.getElementById("filterLocation");
    const problemSelect = document.getElementById("filterProblem");
    const availableOnly = document.getElementById("filterAvailableOnly");
    const resetBtn = document.getElementById("resetFiltersBtn");

    const applyFilters = () => {
        const q = (locationInput?.value || "").trim().toLowerCase();
        const prob = (problemSelect?.value || "").trim().toLowerCase();
        const onlyAvail = Boolean(availableOnly?.checked);

        document.querySelectorAll("[data-filter-item], .atelier-card").forEach((card) => {
            const txt = (card.textContent || "").toLowerCase();
            const isAvail = card.getAttribute("data-available") !== "false";
            const matchQ = !q || txt.includes(q);
            const matchP = !prob || txt.includes(prob);
            const matchA = !onlyAvail || isAvail;
            card.style.display = matchQ && matchP && matchA ? "" : "none";
        });
    };

    locationInput?.addEventListener("input", applyFilters);
    problemSelect?.addEventListener("change", applyFilters);
    availableOnly?.addEventListener("change", applyFilters);
    resetBtn?.addEventListener("click", () => {
        if (locationInput) locationInput.value = "";
        if (problemSelect) problemSelect.value = "";
        if (availableOnly) availableOnly.checked = false;
        applyFilters();
    });
}