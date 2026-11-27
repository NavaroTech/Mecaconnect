import os
import re
import uuid
import random
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
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@mecaconnect.gn").strip().lower()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin@2026")
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
        ville VARCHAR(100) DEFAULT 'Conakry',
        quartier VARCHAR(120),
        specialite VARCHAR(120),
        tarif_base_gnf BIGINT DEFAULT 50000,
        actif BOOLEAN NOT NULL DEFAULT TRUE,
        cree_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS email_otps (
        id SERIAL PRIMARY KEY,
        email VARCHAR(150) NOT NULL,
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
                    nom_complet, email, telephone, mot_de_passe_hash, role, statut_kyc, ville
                )
                VALUES (%s, %s, %s, %s, 'admin', 'verifie', 'Conakry')
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
# Utilitaires (Téléphone Guinée +224, GNF, authentification simple)
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
    return f"+224{digits}"


def formater_gnf(montant: int) -> str:
    """Formate un montant en Francs guinéens (GNF)."""
    return f"{int(montant):,} GNF".replace(",", " ")


def get_current_user():
    """Récupère l'utilisateur via l'en-tête X-User-Id (à remplacer par JWT/session en prod)."""
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        return None
    try:
        uid = int(user_id)
    except ValueError:
        return None

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, nom_complet, email, telephone, role, statut_kyc,
                       ville, quartier, specialite, tarif_base_gnf, actif, cree_le
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
            return jsonify({"error": "Authentification requise (X-User-Id manquant ou invalide)."}), 401
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
# Authentification & OTP Email
# ==============================================================================
@app.post("/api/auth/request-otp")
def request_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
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

    # En production, branchez ici un fournisseur d'e-mail (SMTP / Resend / Brevo)
    return jsonify(
        {
            "message": "Code OTP généré.",
            "email": email,
            "otp_code": code_otp,
            "expires_in_minutes": 15,
        }
    ), 200


@app.post("/api/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    nom_complet = (data.get("nom_complet") or "").strip()
    email = (data.get("email") or "").strip().lower()
    telephone = normaliser_telephone_gn(data.get("telephone") or "")
    mot_de_passe = data.get("mot_de_passe") or ""
    role = (data.get("role") or "client").strip().lower()
    ville = (data.get("ville") or "Conakry").strip()
    quartier = (data.get("quartier") or "").strip()
    specialite = (data.get("specialite") or "").strip()
    tarif_base_gnf = int(data.get("tarif_base_gnf") or 50000)

    if role not in ("client", "mecanicien"):
        role = "client"

    if not nom_complet or not email or not telephone or len(mot_de_passe) < 6:
        return jsonify(
            {
                "error": "Nom complet, e-mail, téléphone (+224...) et mot de passe (min 6 caractères) sont requis."
            }
        ), 400

    if not re.fullmatch(r"\+224\d{8,9}", telephone):
        return jsonify({"error": "Numéro de téléphone guinéen invalide (ex: +224620123456)."}), 400

    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM utilisateurs WHERE email = %s OR telephone = %s", (email, telephone))
            if cur.fetchone():
                return jsonify({"error": "Un compte existe déjà avec cet e-mail ou ce numéro +224."}), 409

            cur.execute(
                """
                INSERT INTO utilisateurs (
                    nom_complet, email, telephone, mot_de_passe_hash, role,
                    statut_kyc, ville, quartier, specialite, tarif_base_gnf
                )
                VALUES (%s, %s, %s, %s, %s, 'en_attente', %s, %s, %s, %s)
                RETURNING id, nom_complet, email, telephone, role, statut_kyc,
                          ville, quartier, specialite, tarif_base_gnf, cree_le
                """,
                (
                    nom_complet,
                    email,
                    telephone,
                    generate_password_hash(mot_de_passe),
                    role,
                    ville,
                    quartier or None,
                    specialite or None,
                    tarif_base_gnf,
                ),
            )
            user = cur.fetchone()
            creer_notification(
                cur,
                user["id"],
                "Bienvenue sur MecaConnect Guinée",
                "Complétez votre vérification KYC (pièce d'identité + selfie) pour activer toutes les fonctionnalités.",
            )
        conn.commit()
        return jsonify({"message": "Compte créé avec succès.", "user": user}), 201
    finally:
        conn.close()


@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    identifiant = (data.get("email") or data.get("identifiant") or "").strip().lower()
    mot_de_passe = data.get("mot_de_passe") or ""

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
        return jsonify({"message": "Connexion réussie.", "user": user_safe}), 200
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
    data = request.get_json(silent=True) or {}
    type_document = (data.get("type_document") or "CNI").strip()
    numero_document = (data.get("numero_document") or "").strip().upper()
    url_document = (data.get("url_document") or "").strip()
    url_selfie = (data.get("url_selfie") or "").strip()

    if not numero_document or not url_document or not url_selfie:
        return jsonify(
            {"error": "Le numéro de pièce, la photo/URL du document et le selfie sont obligatoires."}
        ), 400

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
    data = request.get_json(silent=True) or {}
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
    data = request.get_json(silent=True) or {}
    type_panne = (data.get("type_panne") or "").strip()
    description = (data.get("description") or "").strip()
    localisation = (data.get("localisation") or "").strip()
    montant_estime_gnf = int(data.get("montant_estime_gnf") or 75000)
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


# ==============================================================================
# Paiements en Francs guinéens (GNF) & Notifications
# ==============================================================================
@app.post("/api/paiements")
@auth_required
def enregistrer_paiement(user):
    data = request.get_json(silent=True) or {}
    demande_id = data.get("demande_id")
    montant_gnf = int(data.get("montant_gnf") or 0)
    operateur = (data.get("operateur") or "Orange Money").strip()
    numero_telephone = normaliser_telephone_gn(data.get("numero_telephone") or user["telephone"])

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
# Lancement local (Render utilise Gunicorn : backend.app:app)
# ==============================================================================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)