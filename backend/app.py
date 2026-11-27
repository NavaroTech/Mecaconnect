import os
import re
import uuid
import random
import hashlib
import hmac
import base64
import json
from datetime import datetime, timedelta, timezone
from functools import wraps

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash


# ==============================================================================
# Configuration de l'application Flask
# ==============================================================================
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "diallosouleymane7294@gmail.com").strip().lower()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Soule7294")
SECRET_KEY = os.environ.get("SECRET_KEY", "mecaconnect-guinee-secret-key")
app.config["SECRET_KEY"] = SECRET_KEY


# ==============================================================================
# Connexion PostgreSQL / Supabase
# ==============================================================================
def get_db_connection():
    """Ouvre une connexion PostgreSQL vers Supabase avec SSL activé."""
    if not DATABASE_URL:
        raise RuntimeError(
            "La variable d'environnement DATABASE_URL est manquante."
        )

    db_url = DATABASE_URL
    if db_url.startswith("postgres://"):
        db_url = "postgresql://" + db_url[len("postgres://") :]

    if "sslmode=" not in db_url:
        separator = "&" if "?" in db_url else "?"
        db_url = f"{db_url}{separator}sslmode=require"

    return psycopg2.connect(db_url, cursor_factory=RealDictCursor)


def init_db():
    """Initialise les tables si absentes et garantit la présence du compte admin."""
    schema_sql = """
    CREATE TABLE IF NOT EXISTS utilisateurs (
        id SERIAL PRIMARY KEY,
        nom_complet VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        telephone VARCHAR(30) UNIQUE NOT NULL,
        mot_de_passe_hash TEXT NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'client',
        statut_kyc VARCHAR(30) NOT NULL DEFAULT 'en_attente',
        email_verifie BOOLEAN NOT NULL DEFAULT FALSE,
        telephone_verifie BOOLEAN NOT NULL DEFAULT FALSE,
        ville VARCHAR(100) DEFAULT 'Conakry',
        quartier VARCHAR(120),
        specialite VARCHAR(120),
        tarif_base_gnf BIGINT DEFAULT 50000,
        actif BOOLEAN NOT NULL DEFAULT TRUE,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS email_verifie BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS telephone_verifie BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS email_otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(150) NOT NULL,
        code_otp VARCHAR(10) NOT NULL,
        expire_le TIMESTAMPTZ NOT NULL,
        utilise BOOLEAN NOT NULL DEFAULT FALSE,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sms_otps (
        id SERIAL PRIMARY KEY,
        telephone VARCHAR(30) NOT NULL,
        code_otp VARCHAR(10) NOT NULL,
        expire_le TIMESTAMPTZ NOT NULL,
        utilise BOOLEAN NOT NULL DEFAULT FALSE,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS documents_kyc (
        id SERIAL PRIMARY KEY,
        utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
        type_document VARCHAR(50) NOT NULL,
        numero_document VARCHAR(100) UNIQUE NOT NULL,
        url_document TEXT,
        url_selfie TEXT,
        statut VARCHAR(30) NOT NULL DEFAULT 'en_attente',
        motif_rejet TEXT,
        soumis_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        verifie_le TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS demandes_intervention (
        id SERIAL PRIMARY KEY,
        reference_code VARCHAR(40) UNIQUE NOT NULL,
        client_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
        mecanicien_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
        type_panne VARCHAR(120) NOT NULL,
        description TEXT,
        localisation VARCHAR(200) NOT NULL,
        montant_estime_gnf BIGINT NOT NULL DEFAULT 50000,
        statut VARCHAR(40) NOT NULL DEFAULT 'en_attente',
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mis_a_jour_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS paiements_gnf (
        id SERIAL PRIMARY KEY,
        reference_paiement VARCHAR(50) UNIQUE NOT NULL,
        demande_id INTEGER REFERENCES demandes_intervention(id) ON DELETE SET NULL,
        payeur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
        montant_gnf BIGINT NOT NULL,
        operateur VARCHAR(50) NOT NULL DEFAULT 'Orange Money',
        numero_telephone VARCHAR(30) NOT NULL,
        statut VARCHAR(30) NOT NULL DEFAULT 'confirme',
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
        titre VARCHAR(150) NOT NULL,
        message TEXT NOT NULL,
        lu BOOLEAN NOT NULL DEFAULT FALSE,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    """

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(schema_sql)
            cur.execute(
                """
                INSERT INTO utilisateurs (
                    nom_complet, email, telephone, mot_de_passe_hash, role,
                    statut_kyc, email_verifie, telephone_verifie, ville
                )
                VALUES (%s, %s, %s, %s, 'admin', 'verifie', TRUE, TRUE, 'Conakry')
                ON CONFLICT (email) DO NOTHING;
                """,
                (
                    "Administrateur MecaConnect",
                    ADMIN_EMAIL,
                    "+224620000000",
                    generate_password_hash(ADMIN_PASSWORD),
                ),
            )
        conn.commit()
    finally:
        conn.close()


try:
    init_db()
except Exception as exc:
    app.logger.warning("Initialisation DB différée au démarrage : %s", exc)


# ==============================================================================
# Utilitaires (Téléphone Guinée +224, GNF, Jeton & Authentification)
# ==============================================================================
def normaliser_telephone_gn(telephone: str) -> str:
    """Normalise un numéro guinéen vers le format +224XXXXXXXXX."""
    cleaned = re.sub(r"[^\d+]", "", (telephone or "").strip())
    if cleaned.startswith("+224"):
        digits = re.sub(r"\D", "", cleaned[4:])
        return f"+224{digits}"
    if cleaned.startswith("224"):
        digits = re.sub(r"\D", "", cleaned[3:])
        return f"+224{digits}"
    digits = re.sub(r"\D", "", cleaned)
    return f"+224{digits}" if digits else ""


def formater_gnf(montant: int) -> str:
    """Formate un montant en Francs guinéens (GNF)."""
    return f"{int(montant):,} GNF".replace(",", " ")


def generer_token_session(user_id: int, role: str) -> str:
    """Génère un jeton signé HMAC (valide 7 jours)."""
    exp = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp())
    payload = json.dumps({"uid": int(user_id), "role": role, "exp": exp}, separators=(",", ":")).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    sig = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verifier_token_session(token: str):
    """Vérifie la signature et l'expiration du jeton et retourne l'user_id ou None."""
    if not token or "." not in token:
        return None
    try:
        payload_b64, sig = token.split(".", 1)
        expected_sig = hmac.new(SECRET_KEY.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8"))
        if int(data.get("exp", 0)) < int(datetime.now(timezone.utc).timestamp()):
            return None
        return int(data["uid"])
    except Exception:
        return None


def get_payload_any():
    """Récupère les données envoyées en JSON ou en FormData."""
    data = request.get_json(silent=True)
    if isinstance(data, dict) and data:
        return data
    if request.form:
        return request.form.to_dict()
    return {}


def get_current_user():
    """Récupère l'utilisateur via Authorization: Bearer <token> ou X-User-Id."""
    uid = None

    auth_header = request.headers.get("Authorization", "").strip()
    if auth_header.lower().startswith("bearer "):
        token = auth_header[7:].strip()
        uid = verifier_token_session(token)

    if uid is None:
        raw_uid = request.headers.get("X-User-Id")
        if raw_uid:
            try:
                uid = int(raw_uid)
            except ValueError:
                uid = None

    if not uid:
        return None

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, nom_complet, email, telephone, role, statut_kyc,
                       email_verifie, telephone_verifie, ville, quartier,
                       specialite, tarif_base_gnf, actif, cree_le
                FROM utilisateurs
                WHERE id = %s AND actif = TRUE
                """,
                (uid,),
            )
            return cur.fetchone()
    finally:
        conn.close()


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise."}), 401
        return fn(user, *args, **kwargs)

    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise."}), 401
        if user.get("role") != "admin":
            return jsonify({"error": "Accès réservé à l'administrateur."}), 403
        return fn(user, *args, **kwargs)

    return wrapper


def creer_notification(cur, utilisateur_id: int, titre: str, message: str):
    cur.execute(
        """
        INSERT INTO notifications (utilisateur_id, titre, message)
        VALUES (%s, %s, %s)
        """,
        (utilisateur_id, titre, message),
    )


# ==============================================================================
# Routes de santé & accueil API
# ==============================================================================
@app.get("/")
def index():
    return jsonify(
        {
            "service": "MecaConnect Guinea API",
            "country": "Guinée (+224)",
            "currency": "GNF",
            "status": "running",
        }
    )


@app.get("/api/health")
def health():
    try:
        conn = get_db_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 AS ok;")
                row = cur.fetchone()
        finally:
            conn.close()
        return jsonify({"status": "ok", "database": "connected", "check": row["ok"]}), 200
    except Exception as exc:
        return jsonify({"status": "error", "database": "unreachable", "details": str(exc)}), 500


# ==============================================================================
# Authentification & Vérification OTP (Email + SMS +224)
# ==============================================================================
@app.post("/api/auth/request-otp")
def request_otp():
    data = get_payload_any()
    email = (data.get("email") or "").strip().lower()
    if not email or not re.fullmatch(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email):
        return jsonify({"error": "Adresse e-mail valide requise."}), 400

    code_otp = f"{random.randint(100000, 999999)}"
    expire_le = datetime.now(timezone.utc) + timedelta(minutes=15)

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO email_otps (email, code_otp, expire_le)
                VALUES (%s, %s, %s)
                """,
                (email, code_otp, expire_le),
            )
        conn.commit()
    finally:
        conn.close()

    return jsonify(
        {
            "message": "Code OTP e-mail généré.",
            "email": email,
            "otp_code": code_otp,
            "expires_in_minutes": 15,
        }
    ), 200


@app.post("/api/auth/verify-email-otp")
def verify_email_otp():
    data = get_payload_any()
    email = (data.get("email") or "").strip().lower()
    code_otp = (data.get("code_otp") or data.get("code") or "").strip()

    if not email or not code_otp:
        return jsonify({"error": "Adresse e-mail et code OTP requis."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, expire_le, utilise
                FROM email_otps
                WHERE LOWER(email) = %s AND code_otp = %s
                ORDER BY id DESC
                LIMIT 1
                """,
                (email, code_otp),
            )
            row = cur.fetchone()
            if not row or row["utilise"]:
                return jsonify({"error": "Code e-mail invalide ou déjà utilisé."}), 400
            if row["expire_le"] < datetime.now(timezone.utc):
                return jsonify({"error": "Ce code e-mail a expiré."}), 400

            cur.execute("UPDATE email_otps SET utilise = TRUE WHERE id = %s", (row["id"],))
            cur.execute("UPDATE utilisateurs SET email_verifie = TRUE WHERE LOWER(email) = %s", (email,))
        conn.commit()
        return jsonify({"message": "Adresse e-mail vérifiée avec succès.", "verified": True}), 200
    finally:
        conn.close()


@app.post("/api/auth/request-sms-otp")
def request_sms_otp():
    data = get_payload_any()
    telephone = normaliser_telephone_gn(data.get("telephone") or data.get("phone") or "")

    if not re.fullmatch(r"\+224\d{8,9}", telephone):
        return jsonify(
            {"error": "Numéro de téléphone guinéen invalide (format attendu : +224 suivi de 8 ou 9 chiffres)."}
        ), 400

    code_otp = f"{random.randint(100000, 999999)}"
    expire_le = datetime.now(timezone.utc) + timedelta(minutes=10)

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sms_otps (telephone, code_otp, expire_le)
                VALUES (%s, %s, %s)
                """,
                (telephone, code_otp, expire_le),
            )
        conn.commit()
    finally:
        conn.close()

    # Branchez ici votre passerelle SMS Guinée / internationale en production
    return jsonify(
        {
            "message": "Code SMS généré.",
            "telephone": telephone,
            "otp_code": code_otp,
            "expires_in_minutes": 10,
        }
    ), 200


@app.post("/api/auth/verify-sms-otp")
def verify_sms_otp():
    data = get_payload_any()
    telephone = normaliser_telephone_gn(data.get("telephone") or data.get("phone") or "")
    code_otp = (data.get("code_otp") or data.get("code") or "").strip()

    if not re.fullmatch(r"\+224\d{8,9}", telephone) or not code_otp:
        return jsonify({"error": "Numéro +224 et code SMS requis."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, expire_le, utilise
                FROM sms_otps
                WHERE telephone = %s AND code_otp = %s
                ORDER BY id DESC
                LIMIT 1
                """,
                (telephone, code_otp),
            )
            row = cur.fetchone()
            if not row or row["utilise"]:
                return jsonify({"error": "Code SMS invalide ou déjà utilisé."}), 400
            if row["expire_le"] < datetime.now(timezone.utc):
                return jsonify({"error": "Ce code SMS a expiré."}), 400

            cur.execute("UPDATE sms_otps SET utilise = TRUE WHERE id = %s", (row["id"],))
            cur.execute("UPDATE utilisateurs SET telephone_verifie = TRUE WHERE telephone = %s", (telephone,))
        conn.commit()
        return jsonify({"message": "Numéro de téléphone vérifié avec succès.", "verified": True}), 200
    finally:
        conn.close()


@app.post("/api/auth/register")
def register():
    data = get_payload_any()
    nom_complet = (data.get("nom_complet") or data.get("fullName") or data.get("full_name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    telephone = normaliser_telephone_gn(data.get("telephone") or data.get("phone") or "")
    mot_de_passe = data.get("mot_de_passe") or data.get("password") or ""
    role = (data.get("role") or "client").strip().lower()
    ville = (data.get("ville") or "Conakry").strip()
    quartier = (data.get("quartier") or "").strip()
    specialite = (data.get("specialite") or data.get("ref_atelier") or "").strip()
    tarif_base_gnf = int(data.get("tarif_base_gnf") or 50000)

    email_verifie = str(data.get("email_verifie") or "").lower() in ("true", "1", "yes")
    telephone_verifie = str(data.get("telephone_verifie") or "").lower() in ("true", "1", "yes")

    if role == "chauffeur":
        role = "client"
    elif role not in ("client", "mecanicien"):
        role = "client"

    if not email and telephone:
        clean_digits = re.sub(r"\D", "", telephone)
        email = f"gn_{clean_digits}@mecaconnect.local"

    if not mot_de_passe:
        mot_de_passe = f"Gn{uuid.uuid4().hex[:8]}"

    if not nom_complet or not telephone or len(mot_de_passe) < 6:
        return jsonify(
            {
                "error": "Nom complet, téléphone (+224...) et mot de passe (min 6 caractères) sont requis."
            }
        ), 400

    if not re.fullmatch(r"\+224\d{8,9}", telephone):
        return jsonify({"error": "Numéro de téléphone guinéen invalide (ex: +224620123456)."}), 400

    numero_piece = (data.get("numero_piece") or data.get("idNumber") or data.get("id_number") or "").strip().upper()
    type_piece = (data.get("type_piece") or "CNI Guinée").strip()
    has_piece_file = bool(request.files.get("photo_piece"))
    has_selfie_file = bool(request.files.get("selfie") or request.files.get("kycSelfie") or data.get("selfie_data_url"))

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM utilisateurs WHERE email = %s OR telephone = %s", (email, telephone))
            if cur.fetchone():
                return jsonify({"error": "Un compte existe déjà avec cet e-mail ou ce numéro +224."}), 409

            if numero_piece:
                cur.execute("SELECT id FROM documents_kyc WHERE numero_document = %s", (numero_piece,))
                if cur.fetchone():
                    return jsonify({"error": "Cette pièce d'identité est déjà associée à un autre compte."}), 409

            cur.execute(
                """
                INSERT INTO utilisateurs (
                    nom_complet, email, telephone, mot_de_passe_hash, role,
                    statut_kyc, email_verifie, telephone_verifie, ville, quartier,
                    specialite, tarif_base_gnf
                )
                VALUES (%s, %s, %s, %s, %s, 'en_attente', %s, %s, %s, %s, %s, %s)
                RETURNING id, nom_complet, email, telephone, role, statut_kyc,
                          email_verifie, telephone_verifie, ville, quartier,
                          specialite, tarif_base_gnf, cree_le
                """,
                (
                    nom_complet,
                    email,
                    telephone,
                    generate_password_hash(mot_de_passe),
                    role,
                    email_verifie,
                    telephone_verifie,
                    ville,
                    quartier or None,
                    specialite or None,
                    tarif_base_gnf,
                ),
            )
            user = cur.fetchone()

            if numero_piece or has_piece_file or has_selfie_file:
                cur.execute(
                    """
                    INSERT INTO documents_kyc (
                        utilisateur_id, type_document, numero_document, url_document, url_selfie, statut
                    )
                    VALUES (%s, %s, %s, %s, %s, 'en_attente')
                    """,
                    (
                        user["id"],
                        type_piece,
                        numero_piece or f"DOC-{user['id']}-{uuid.uuid4().hex[:6].upper()}",
                        "upload://piece-identite" if has_piece_file else "pending://piece-identite",
                        "upload://selfie-kyc" if has_selfie_file else "pending://selfie-kyc",
                    ),
                )

            creer_notification(
                cur,
                user["id"],
                "Bienvenue sur MecaConnect Guinée",
                "Votre compte a été créé. Vérifiez votre e-mail, votre numéro +224 et votre dossier KYC.",
            )
        conn.commit()
        token = generer_token_session(user["id"], user["role"])
        return jsonify({"message": "Compte créé avec succès.", "token": token, "user": user}), 201
    finally:
        conn.close()


@app.post("/api/auth/login")
def login():
    data = get_payload_any()
    identifiant = (
        data.get("email")
        or data.get("identifiant")
        or data.get("identifier")
        or data.get("phone")
        or ""
    ).strip().lower()
    mot_de_passe = data.get("mot_de_passe") or data.get("password") or ""

    if not identifiant or not mot_de_passe:
        return jsonify({"error": "Identifiant (e-mail ou téléphone +224) et mot de passe requis."}), 400

    telephone_norm = normaliser_telephone_gn(identifiant)

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT * FROM utilisateurs
                WHERE LOWER(email) = %s OR telephone = %s
                """,
                (identifiant, telephone_norm),
            )
            user = cur.fetchone()

        if not user or not check_password_hash(user["mot_de_passe_hash"], mot_de_passe):
            return jsonify({"error": "Identifiants incorrects."}), 401

        if not user["actif"]:
            return jsonify({"error": "Ce compte est désactivé."}), 403

        user_safe = {k: v for k, v in user.items() if k != "mot_de_passe_hash"}
        token = generer_token_session(user["id"], user["role"])
        return jsonify(
            {
                "message": "Connexion réussie.",
                "token": token,
                "role": user["role"],
                "user": user_safe,
            }
        ), 200
    finally:
        conn.close()


# ==============================================================================
# Profil & Vérification KYC (1 compte par pièce d'identité + selfie)
# ==============================================================================
@app.get("/api/profil")
@auth_required
def get_profil(user):
    return jsonify({"user": user}), 200


@app.post("/api/kyc/soumettre")
@auth_required
def soumettre_kyc(user):
    data = get_payload_any()
    type_document = (data.get("type_document") or "CNI").strip()
    numero_document = (data.get("numero_document") or "").strip().upper()
    url_document = (data.get("url_document") or "upload://piece-identite").strip()
    url_selfie = (data.get("url_selfie") or "upload://selfie-kyc").strip()

    if not numero_document:
        return jsonify({"error": "Le numéro de pièce d'identité est obligatoire."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, utilisateur_id
                FROM documents_kyc
                WHERE numero_document = %s AND utilisateur_id <> %s
                """,
                (numero_document, user["id"]),
            )
            if cur.fetchone():
                return jsonify(
                    {"error": "Cette pièce d'identité est déjà associée à un autre compte."}
                ), 409

            cur.execute(
                """
                INSERT INTO documents_kyc (
                    utilisateur_id, type_document, numero_document, url_document, url_selfie, statut
                )
                VALUES (%s, %s, %s, %s, %s, 'en_attente')
                ON CONFLICT (numero_document) DO UPDATE SET
                    type_document = EXCLUDED.type_document,
                    url_document = EXCLUDED.url_document,
                    url_selfie = EXCLUDED.url_selfie,
                    statut = 'en_attente',
                    motif_rejet = NULL,
                    soumis_le = NOW()
                RETURNING *
                """,
                (user["id"], type_document, numero_document, url_document, url_selfie),
            )
            doc = cur.fetchone()

            cur.execute(
                "UPDATE utilisateurs SET statut_kyc = 'en_attente' WHERE id = %s",
                (user["id"],),
            )
        conn.commit()
        return jsonify({"message": "Dossier KYC soumis pour validation.", "kyc": doc}), 201
    finally:
        conn.close()


@app.post("/api/admin/kyc/<int:kyc_id>/valider")
@admin_required
def valider_kyc(admin_user, kyc_id: int):
    data = get_payload_any()
    approuve = bool(data.get("approuve", True))
    motif_rejet = (data.get("motif_rejet") or "").strip() or None

    nouveau_statut_doc = "verifie" if approuve else "rejete"
    nouveau_statut_user = "verifie" if approuve else "rejete"

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE documents_kyc
                SET statut = %s, motif_rejet = %s, verifie_le = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (nouveau_statut_doc, motif_rejet, kyc_id),
            )
            doc = cur.fetchone()
            if not doc:
                return jsonify({"error": "Document KYC introuvable."}), 404

            cur.execute(
                "UPDATE utilisateurs SET statut_kyc = %s WHERE id = %s",
                (nouveau_statut_user, doc["utilisateur_id"]),
            )
            creer_notification(
                cur,
                doc["utilisateur_id"],
                "Mise à jour de votre vérification KYC",
                "Votre identité a été vérifiée avec succès."
                if approuve
                else f"Votre dossier KYC a été rejeté : {motif_rejet or 'pièce non conforme'}.",
            )
        conn.commit()
        return jsonify({"message": "Statut KYC mis à jour.", "kyc": doc}), 200
    finally:
        conn.close()


# ==============================================================================
# Mécaniciens & Demandes d'intervention
# ==============================================================================
@app.get("/api/mecaniciens")
def lister_mecaniciens():
    ville = (request.args.get("ville") or "").strip()
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            if ville:
                cur.execute(
                    """
                    SELECT id, nom_complet, telephone, ville, quartier, specialite, tarif_base_gnf, statut_kyc
                    FROM utilisateurs
                    WHERE role = 'mecanicien' AND actif = TRUE AND LOWER(ville) = LOWER(%s)
                    ORDER BY id DESC
                    """,
                    (ville,),
                )
            else:
                cur.execute(
                    """
                    SELECT id, nom_complet, telephone, ville, quartier, specialite, tarif_base_gnf, statut_kyc
                    FROM utilisateurs
                    WHERE role = 'mecanicien' AND actif = TRUE
                    ORDER BY id DESC
                    """
                )
            mecaniciens = cur.fetchall()
            for m in mecaniciens:
                m["tarif_base_formate"] = formater_gnf(m["tarif_base_gnf"] or 0)
        return jsonify({"mecaniciens": mecaniciens}), 200
    finally:
        conn.close()


@app.post("/api/demandes")
@auth_required
def creer_demande(user):
    data = get_payload_any()
    type_panne = (data.get("type_panne") or data.get("categorie_panne") or "").strip()
    description = (data.get("description") or "").strip()
    localisation = (data.get("localisation") or "").strip()
    if not localisation:
        ville = (data.get("ville") or "").strip()
        quartier = (data.get("quartier") or "").strip()
        localisation = f"{quartier}, {ville}".strip(", ")
    montant_estime_gnf = int(data.get("montant_estime_gnf") or data.get("tarif_gnf") or 75000)
    mecanicien_id = data.get("mecanicien_id")

    if not type_panne or not localisation:
        return jsonify({"error": "Le type de panne et la localisation sont requis."}), 400

    reference_code = f"MC-{uuid.uuid4().hex[:8].upper()}"

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO demandes_intervention (
                    reference_code, client_id, mecanicien_id, type_panne,
                    description, localisation, montant_estime_gnf, statut
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'en_attente')
                RETURNING *
                """,
                (
                    reference_code,
                    user["id"],
                    mecanicien_id,
                    type_panne,
                    description or None,
                    localisation,
                    montant_estime_gnf,
                ),
            )
            demande = cur.fetchone()
            demande["montant_estime_formate"] = formater_gnf(demande["montant_estime_gnf"])

            if mecanicien_id:
                creer_notification(
                    cur,
                    int(mecanicien_id),
                    "Nouvelle demande d'intervention",
                    f"Demande {reference_code} ({type_panne}) à {localisation}.",
                )
        conn.commit()
        return jsonify({"message": "Demande d'intervention créée.", "demande": demande}), 201
    finally:
        conn.close()


@app.get("/api/demandes")
@auth_required
def lister_demandes(user):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            if user["role"] == "admin":
                cur.execute("SELECT * FROM demandes_intervention ORDER BY id DESC")
            elif user["role"] == "mecanicien":
                cur.execute(
                    """
                    SELECT * FROM demandes_intervention
                    WHERE mecanicien_id = %s OR mecanicien_id IS NULL
                    ORDER BY id DESC
                    """,
                    (user["id"],),
                )
            else:
                cur.execute(
                    "SELECT * FROM demandes_intervention WHERE client_id = %s ORDER BY id DESC",
                    (user["id"],),
                )
            demandes = cur.fetchall()
            for d in demandes:
                d["montant_estime_formate"] = formater_gnf(d["montant_estime_gnf"])
        return jsonify({"demandes": demandes}), 200
    finally:
        conn.close()


@app.route("/api/demandes/<int:demande_id>/statut", methods=["POST", "PATCH"])
@auth_required
def mettre_a_jour_statut_demande(user, demande_id: int):
    data = get_payload_any()
    nouveau_statut = (data.get("statut") or "").strip().lower()
    if nouveau_statut not in ("en_attente", "acceptee", "en_route", "sur_place", "terminee", "annulee"):
        return jsonify({"error": "Statut de demande invalide."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM demandes_intervention WHERE id = %s", (demande_id,))
            demande = cur.fetchone()
            if not demande:
                return jsonify({"error": "Demande introuvable."}), 404

            mecanicien_id = demande["mecanicien_id"]
            if nouveau_statut in ("acceptee", "en_route", "sur_place") and user["role"] == "mecanicien" and not mecanicien_id:
                mecanicien_id = user["id"]

            cur.execute(
                """
                UPDATE demandes_intervention
                SET statut = %s, mecanicien_id = %s, mis_a_jour_le = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (nouveau_statut, mecanicien_id, demande_id),
            )
            updated = cur.fetchone()
            updated["montant_estime_formate"] = formater_gnf(updated.get("montant_estime_gnf") or 0)

            creer_notification(
                cur,
                demande["client_id"],
                "Mise à jour de votre demande",
                f"Votre demande {demande['reference_code']} est maintenant : {nouveau_statut}.",
            )
        conn.commit()
        return jsonify({"message": "Statut mis à jour.", "demande": updated}), 200
    finally:
        conn.close()


# ==============================================================================
# Paiements en Francs guinéens (GNF) & Notifications
# ==============================================================================
@app.post("/api/paiements")
@auth_required
def enregistrer_paiement(user):
    data = get_payload_any()
    demande_id = data.get("demande_id")
    montant_gnf = int(data.get("montant_gnf") or 0)
    operateur = (data.get("operateur") or data.get("moyen_paiement") or "Orange Money").strip()
    numero_telephone = normaliser_telephone_gn(
        data.get("numero_telephone") or data.get("telephone") or user["telephone"]
    )

    if montant_gnf <= 0:
        return jsonify({"error": "Le montant en GNF doit être supérieur à zéro."}), 400

    reference_paiement = f"PAY-{uuid.uuid4().hex[:8].upper()}"

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO paiements_gnf (
                    reference_paiement, demande_id, payeur_id, montant_gnf,
                    operateur, numero_telephone, statut
                )
                VALUES (%s, %s, %s, %s, %s, %s, 'confirme')
                RETURNING *
                """,
                (
                    reference_paiement,
                    demande_id,
                    user["id"],
                    montant_gnf,
                    operateur,
                    numero_telephone,
                ),
            )
            paiement = cur.fetchone()
            paiement["montant_formate"] = formater_gnf(paiement["montant_gnf"])

            creer_notification(
                cur,
                user["id"],
                "Paiement enregistré",
                f"Paiement de {formater_gnf(montant_gnf)} ({operateur}) — Réf: {reference_paiement}.",
            )
        conn.commit()
        return jsonify({"message": "Paiement enregistré avec succès.", "paiement": paiement}), 201
    finally:
        conn.close()


@app.get("/api/notifications")
@auth_required
def lister_notifications(user):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT * FROM notifications
                WHERE utilisateur_id = %s
                ORDER BY id DESC
                """,
                (user["id"],),
            )
            notifs = cur.fetchall()
        return jsonify({"notifications": notifs}), 200
    finally:
        conn.close()


# ==============================================================================
# Administration
# ==============================================================================
@app.get("/api/admin/overview")
@admin_required
def admin_overview(admin_user):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.id, u.nom_complet, u.email, u.telephone, u.role, u.statut_kyc,
                       u.email_verifie, u.telephone_verifie, u.ville, u.quartier,
                       u.specialite, u.actif, u.cree_le,
                       d.type_document, d.numero_document, d.statut AS statut_document
                FROM utilisateurs u
                LEFT JOIN LATERAL (
                    SELECT type_document, numero_document, statut
                    FROM documents_kyc
                    WHERE utilisateur_id = u.id
                    ORDER BY id DESC
                    LIMIT 1
                ) d ON TRUE
                ORDER BY u.id DESC
                """
            )
            users = cur.fetchall()

            cur.execute(
                """
                SELECT dm.*, cl.nom_complet AS client_nom, cl.telephone AS client_telephone
                FROM demandes_intervention dm
                LEFT JOIN utilisateurs cl ON cl.id = dm.client_id
                ORDER BY dm.id DESC
                """
            )
            demandes = cur.fetchall()
            for dm in demandes:
                dm["montant_estime_formate"] = formater_gnf(dm.get("montant_estime_gnf") or 0)

            cur.execute(
                """
                SELECT p.*, dm.reference_code AS demande_ref
                FROM paiements_gnf p
                LEFT JOIN demandes_intervention dm ON dm.id = p.demande_id
                ORDER BY p.id DESC
                """
            )
            paiements = cur.fetchall()
            for p in paiements:
                p["montant_formate"] = formater_gnf(p.get("montant_gnf") or 0)

        total_users = len(users)
        chauffeurs = sum(1 for u in users if u.get("role") in ("client", "chauffeur"))
        mecaniciens = sum(1 for u in users if u.get("role") == "mecanicien")
        total_demandes = len(demandes)
        pending_demandes = sum(1 for d in demandes if d.get("statut") == "en_attente")
        total_revenus_gnf = sum(
            int(p.get("montant_gnf") or 0)
            for p in paiements
            if p.get("statut") in ("confirme", "paye", None)
        )

        return jsonify(
            {
                "stats": {
                    "total_users": total_users,
                    "chauffeurs": chauffeurs,
                    "mecaniciens": mecaniciens,
                    "total_demandes": total_demandes,
                    "pending_demandes": pending_demandes,
                    "total_revenus_gnf": total_revenus_gnf,
                    "total_revenus_formate": formater_gnf(total_revenus_gnf),
                },
                "users": users,
                "demandes": demandes,
                "paiements": paiements,
            }
        ), 200
    finally:
        conn.close()


# ==============================================================================
# Lancement local (Render utilise Gunicorn : backend.app:app)
# ==============================================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)