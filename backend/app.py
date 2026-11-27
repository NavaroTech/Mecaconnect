import os
import random
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from functools import wraps

import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10 Mo max

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "pdf"}
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "admin@mecaconnect.gn").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@2026")
SECRET_KEY = os.getenv("SECRET_KEY", "mecaconnect-guinee-secret-2026")


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def get_db_connection():
    database_url = os.getenv("DATABASE_URL", "").strip()
    sslmode = os.getenv("DB_SSLMODE", "require")

    if database_url:
        if database_url.startswith("postgres://"):
            database_url = database_url.replace("postgres://", "postgresql://", 1)
        return psycopg2.connect(
            database_url,
            sslmode=sslmode,
            cursor_factory=RealDictCursor,
        )

    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.getenv("DB_NAME", "postgres"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
        sslmode=sslmode,
        cursor_factory=RealDictCursor,
    )


def send_otp_email(to_email: str, code_otp: str) -> bool:
    smtp_host = os.getenv("SMTP_HOST", "").strip()
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER", "").strip()
    smtp_pass = os.getenv("SMTP_PASS", "").strip()

    if not smtp_host or not smtp_user or not smtp_pass:
        app.logger.info(f"[OTP DEV] Code pour {to_email} : {code_otp}")
        return False

    msg = EmailMessage()
    msg["Subject"] = "MécaConnect Guinée — Votre code de vérification OTP"
    msg["From"] = smtp_user
    msg["To"] = to_email
    msg.set_content(
        f"Bonjour,\n\nVotre code de vérification MécaConnect est : {code_otp}\n"
        f"Il expire dans 10 minutes.\n\nL'équipe MécaConnect Guinée"
    )

    with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.send_message(msg)
    return True


def ensure_admin_user():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT id FROM utilisateurs WHERE email = %s", (ADMIN_EMAIL,))
        existing = cur.fetchone()
        if not existing:
            pwd_hash = generate_password_hash(ADMIN_PASSWORD)
            cur.execute(
                """
                INSERT INTO utilisateurs (
                    nom_complet, email, telephone, role, mot_de_passe_hash, kyc_statut, actif
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (email) DO NOTHING
                """,
                (
                    "Administrateur MécaConnect",
                    ADMIN_EMAIL,
                    "+224620000000",
                    "admin",
                    pwd_hash,
                    "valide",
                    True,
                ),
            )
            conn.commit()
        cur.close()
        conn.close()
    except Exception as exc:
        app.logger.warning(f"Initialisation admin différée : {exc}")


ensure_admin_user()


def get_current_user():
    user_id = request.headers.get("X-User-Id")
    if not user_id:
        return None
    try:
        uid = int(user_id)
    except ValueError:
        return None

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, nom_complet, email, telephone, role, kyc_statut, actif, cree_le
        FROM utilisateurs
        WHERE id = %s AND actif = TRUE
        """,
        (uid,),
    )
    user = cur.fetchone()
    cur.close()
    conn.close()
    return user


def auth_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise (en-tête X-User-Id manquant ou invalide)."}), 401
        return fn(user, *args, **kwargs)

    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentification requise."}), 401
        if user["role"] != "admin":
            return jsonify({"error": "Accès réservé à l'administrateur."}), 403
        return fn(user, *args, **kwargs)

    return wrapper


def normalize_gn_phone(phone: str) -> str:
    cleaned = "".join(ch for ch in (phone or "") if ch.isdigit() or ch == "+")
    if cleaned.startswith("00224"):
        cleaned = "+224" + cleaned[5:]
    elif cleaned.startswith("224") and not cleaned.startswith("+224"):
        cleaned = "+224" + cleaned[3:]
    elif not cleaned.startswith("+224") and len(cleaned) == 9:
        cleaned = "+224" + cleaned
    return cleaned


@app.get("/api/health")
def health_check():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("SELECT 1 AS ok")
        cur.fetchone()
        cur.close()
        conn.close()
        return jsonify({"status": "ok", "database": "postgresql", "service": "mecaconnect-api"})
    except Exception as exc:
        return jsonify({"status": "error", "detail": str(exc)}), 500


@app.post("/api/auth/send-otp")
def send_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email:
        return jsonify({"error": "Adresse e-mail invalide."}), 400

    code_otp = f"{random.randint(100000, 999999)}"
    expire_le = datetime.now(timezone.utc) + timedelta(minutes=10)

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("UPDATE email_otps SET utilise = TRUE WHERE email = %s AND utilise = FALSE", (email,))
    cur.execute(
        """
        INSERT INTO email_otps (email, code_otp, expire_le, utilise)
        VALUES (%s, %s, %s, FALSE)
        """,
        (email, code_otp, expire_le),
    )
    conn.commit()
    cur.close()
    conn.close()

    sent_via_smtp = send_otp_email(email, code_otp)
    payload = {"message": "Code OTP envoyé.", "sent_via_smtp": sent_via_smtp}
    if not sent_via_smtp:
        payload["dev_otp"] = code_otp
    return jsonify(payload), 200


@app.post("/api/auth/verify-otp")
def verify_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    code_otp = (data.get("code_otp") or "").strip()

    if not email or not code_otp:
        return jsonify({"error": "E-mail et code OTP requis."}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, expire_le, utilise
        FROM email_otps
        WHERE email = %s AND code_otp = %s
        ORDER BY id DESC
        LIMIT 1
        """,
        (email, code_otp),
    )
    otp_row = cur.fetchone()
    if not otp_row:
        cur.close()
        conn.close()
        return jsonify({"error": "Code OTP incorrect."}), 400

    if otp_row["utilise"]:
        cur.close()
        conn.close()
        return jsonify({"error": "Ce code OTP a déjà été utilisé."}), 400

    now_utc = datetime.now(timezone.utc)
    exp = otp_row["expire_le"]
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)

    if now_utc > exp:
        cur.close()
        conn.close()
        return jsonify({"error": "Code OTP expiré."}), 400

    cur.execute("UPDATE email_otps SET utilise = TRUE WHERE id = %s", (otp_row["id"],))
    conn.commit()
    cur.close()
    conn.close()

    return jsonify({"verified": True, "message": "E-mail vérifié avec succès."}), 200


@app.post("/api/auth/register")
def register():
    # Accepte multipart/form-data (avec fichiers KYC) ou JSON
    if request.content_type and "multipart/form-data" in request.content_type:
        form = request.form
        piece_file = request.files.get("piece_identite")
        selfie_file = request.files.get("selfie")
    else:
        form = request.get_json(silent=True) or {}
        piece_file = None
        selfie_file = None

    nom_complet = (form.get("nom_complet") or "").strip()
    email = (form.get("email") or "").strip().lower()
    telephone = normalize_gn_phone(form.get("telephone") or "")
    mot_de_passe = form.get("mot_de_passe") or ""
    role = (form.get("role") or "client").strip().lower()
    type_piece = (form.get("type_piece") or "").strip()
    numero_piece = (form.get("numero_piece") or "").strip().upper()

    if role not in {"client", "mecanicien"}:
        role = "client"

    if not nom_complet or not email or not telephone or not mot_de_passe:
        return jsonify({"error": "Nom complet, e-mail, téléphone (+224) et mot de passe sont obligatoires."}), 400

    if not type_piece or not numero_piece or not piece_file or not selfie_file:
        return jsonify({"error": "KYC obligatoire : type de pièce, numéro de pièce, photo de pièce et selfie sont requis."}), 400

    if not allowed_file(piece_file.filename) or not allowed_file(selfie_file.filename):
        return jsonify({"error": "Formats acceptés pour les fichiers KYC : png, jpg, jpeg, webp, pdf."}), 400

    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("SELECT id FROM utilisateurs WHERE email = %s", (email,))
    if cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Un compte existe déjà avec cette adresse e-mail."}), 409

    # Règle stricte : un seul compte par document d'identité guinéen
    cur.execute("SELECT id FROM documents_kyc WHERE numero_piece = %s", (numero_piece,))
    if cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Ce numéro de pièce d'identité est déjà associé à un compte."}), 409

    piece_ext = piece_file.filename.rsplit(".", 1)[1].lower()
    selfie_ext = selfie_file.filename.rsplit(".", 1)[1].lower()
    piece_name = secure_filename(f"kyc_piece_{uuid.uuid4().hex}.{piece_ext}")
    selfie_name = secure_filename(f"kyc_selfie_{uuid.uuid4().hex}.{selfie_ext}")

    piece_path = os.path.join(app.config["UPLOAD_FOLDER"], piece_name)
    selfie_path = os.path.join(app.config["UPLOAD_FOLDER"], selfie_name)
    piece_file.save(piece_path)
    selfie_file.save(selfie_path)

    pwd_hash = generate_password_hash(mot_de_passe)

    cur.execute(
        """
        INSERT INTO utilisateurs (
            nom_complet, email, telephone, role, mot_de_passe_hash, kyc_statut, actif
        )
        VALUES (%s, %s, %s, %s, %s, %s, TRUE)
        RETURNING id, nom_complet, email, telephone, role, kyc_statut
        """,
        (nom_complet, email, telephone, role, pwd_hash, "en_attente"),
    )
    user_row = cur.fetchone()

    cur.execute(
        """
        INSERT INTO documents_kyc (
            utilisateur_id, type_piece, numero_piece, chemin_piece, chemin_selfie, statut_verification
        )
        VALUES (%s, %s, %s, %s, %s, 'en_attente')
        RETURNING id, type_piece, numero_piece, statut_verification
        """,
        (user_row["id"], type_piece, numero_piece, piece_name, selfie_name),
    )
    kyc_row = cur.fetchone()

    cur.execute(
        """
        INSERT INTO notifications (utilisateur_id, titre, message, lu)
        VALUES (%s, %s, %s, FALSE)
        """,
        (
            user_row["id"],
            "Dossier KYC soumis",
            f"Votre pièce ({type_piece} - {numero_piece}) et votre selfie ont été enregistrés pour vérification.",
        ),
    )

    conn.commit()
    cur.close()
    conn.close()

    return jsonify({"user": user_row, "kyc": kyc_row}), 201


@app.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    mot_de_passe = data.get("mot_de_passe") or ""

    if not email or not mot_de_passe:
        return jsonify({"error": "E-mail et mot de passe requis."}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, nom_complet, email, telephone, role, mot_de_passe_hash, kyc_statut, actif
        FROM utilisateurs
        WHERE email = %s
        """,
        (email,),
    )
    user = cur.fetchone()
    cur.close()
    conn.close()

    if not user or not user["actif"]:
        return jsonify({"error": "Identifiants invalides ou compte inactif."}), 401

    # Compatibilité si un mot de passe admin n'a pas encore été re-hashé
    password_ok = False
    try:
        password_ok = check_password_hash(user["mot_de_passe_hash"], mot_de_passe)
    except Exception:
        password_ok = False

    if not password_ok and email == ADMIN_EMAIL and mot_de_passe == ADMIN_PASSWORD:
        password_ok = True

    if not password_ok:
        return jsonify({"error": "E-mail ou mot de passe incorrect."}), 401

    safe_user = {k: v for k, v in user.items() if k != "mot_de_passe_hash"}
    return jsonify({"user": safe_user}), 200


@app.get("/api/interventions")
@auth_required
def list_interventions(user):
    conn = get_db_connection()
    cur = conn.cursor()
    if user["role"] == "admin":
        cur.execute("SELECT * FROM demandes_intervention ORDER BY id DESC")
    elif user["role"] == "mecanicien":
        cur.execute(
            """
            SELECT * FROM demandes_intervention
            WHERE statut = 'ouverte' OR mecanicien_id = %s
            ORDER BY id DESC
            """,
            (user["id"],),
        )
    else:
        cur.execute(
            "SELECT * FROM demandes_intervention WHERE client_id = %s ORDER BY id DESC",
            (user["id"],),
        )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"interventions": rows}), 200


@app.post("/api/interventions")
@auth_required
def create_intervention(user):
    data = request.get_json(silent=True) or {}
    type_panne = (data.get("type_panne") or "").strip()
    description = (data.get("description") or "").strip()
    localisation = (data.get("localisation") or "").strip()

    if not type_panne or not description or not localisation:
        return jsonify({"error": "Type de panne, description et localisation sont requis."}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO demandes_intervention (client_id, type_panne, description, localisation, statut)
        VALUES (%s, %s, %s, %s, 'ouverte')
        RETURNING *
        """,
        (user["id"], type_panne, description, localisation),
    )
    created = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"intervention": created}), 201


@app.post("/api/paiements")
@auth_required
def create_paiement(user):
    data = request.get_json(silent=True) or {}
    demande_id = data.get("demande_id")
    moyen_paiement = (data.get("moyen_paiement") or "").strip()
    reference_transaction = (data.get("reference_transaction") or "").strip()

    try:
        montant_gnf = int(data.get("montant_gnf"))
    except (TypeError, ValueError):
        return jsonify({"error": "Le montant en GNF doit être un entier valide."}), 400

    if not demande_id or montant_gnf <= 0 or not moyen_paiement or not reference_transaction:
        return jsonify({"error": "demande_id, montant_gnf (> 0), moyen_paiement et reference_transaction sont requis."}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM demandes_intervention WHERE id = %s", (demande_id,))
    if not cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Demande d'intervention introuvable."}), 404

    cur.execute("SELECT id FROM paiements_gnf WHERE reference_transaction = %s", (reference_transaction,))
    if cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Cette référence de transaction existe déjà."}), 409

    cur.execute(
        """
        INSERT INTO paiements_gnf (
            demande_id, payeur_id, montant_gnf, moyen_paiement, reference_transaction, statut
        )
        VALUES (%s, %s, %s, %s, %s, 'en_attente')
        RETURNING *
        """,
        (demande_id, user["id"], montant_gnf, moyen_paiement, reference_transaction),
    )
    paiement = cur.fetchone()
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"paiement": paiement}), 201


@app.get("/api/notifications")
@auth_required
def list_notifications(user):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM notifications WHERE utilisateur_id = %s ORDER BY id DESC",
        (user["id"],),
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"notifications": rows}), 200


@app.get("/api/admin/kyc")
@admin_required
def admin_list_kyc(_admin):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT d.*, u.nom_complet, u.email, u.telephone, u.role
        FROM documents_kyc d
        JOIN utilisateurs u ON u.id = d.utilisateur_id
        ORDER BY d.id DESC
        """
    )
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"kyc_documents": rows}), 200


@app.post("/api/admin/kyc/<int:kyc_id>/decision")
@admin_required
def admin_decide_kyc(_admin, kyc_id: int):
    data = request.get_json(silent=True) or {}
    decision = (data.get("decision") or "").strip().lower()
    if decision not in {"valide", "rejete"}:
        return jsonify({"error": "La décision doit être 'valide' ou 'rejete'."}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM documents_kyc WHERE id = %s", (kyc_id,))
    doc = cur.fetchone()
    if not doc:
        cur.close()
        conn.close()
        return jsonify({"error": "Dossier KYC introuvable."}), 404

    cur.execute(
        "UPDATE documents_kyc SET statut_verification = %s WHERE id = %s",
        (decision, kyc_id),
    )
    cur.execute(
        "UPDATE utilisateurs SET kyc_statut = %s WHERE id = %s",
        (decision, doc["utilisateur_id"]),
    )
    cur.execute(
        """
        INSERT INTO notifications (utilisateur_id, titre, message, lu)
        VALUES (%s, %s, %s, FALSE)
        """,
        (
            doc["utilisateur_id"],
            "Mise à jour de votre KYC",
            f"Votre vérification KYC a été marquée comme : {decision}.",
        ),
    )
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"kyc_id": kyc_id, "statut": decision}), 200


@app.get("/api/uploads/<path:filename>")
@admin_required
def get_upload(_admin, filename: str):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")