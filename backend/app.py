import os
import random
import re
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from flask import Flask, jsonify, request
from flask_cors import CORS
import mysql.connector
from werkzeug.security import check_password_hash, generate_password_hash

try:
    import dns.resolver
    HAS_DNS = True
except ImportError:
    HAS_DNS = False

app = Flask(__name__)
CORS(app)

EMAIL_REGEX = re.compile(r"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$")
DOMAINES_JETABLES = {
    "tempmail.com", "10minutemail.com", "guerrillamail.com",
    "mailinator.com", "yopmail.com", "throwaway.email"
}

OTP_STORE = {}

ADMIN_EMAIL = "admin@mecaconnect.gn"
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Admin@2026")


def get_db_connection():
    return mysql.connector.connect(
        host=os.getenv("DB_HOST", "localhost"),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", "Soule7294"),
        database=os.getenv("DB_NAME", "mecaconnect_db")
    )


def init_db_and_admin():
    conn = get_db_connection()
    cur = conn.cursor(dictionary=True)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS utilisateurs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nom_complet VARCHAR(150) NOT NULL,
            telephone VARCHAR(30) NOT NULL,
            email VARCHAR(180) NOT NULL UNIQUE,
            role VARCHAR(30) NOT NULL DEFAULT 'chauffeur',
            ville VARCHAR(80) NOT NULL,
            quartier VARCHAR(120) NOT NULL,
            type_piece VARCHAR(60),
            numero_piece VARCHAR(80) UNIQUE,
            date_expiration VARCHAR(30),
            ref_atelier VARCHAR(80),
            email_verifie TINYINT(1) NOT NULL DEFAULT 0,
            kyc_statut VARCHAR(30) NOT NULL DEFAULT 'en_attente',
            mot_de_passe VARCHAR(255) NOT NULL,
            cree_le DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("SELECT id FROM utilisateurs WHERE email = %s LIMIT 1", (ADMIN_EMAIL,))
    admin_existe = cur.fetchone()
    hashed_admin = generate_password_hash(ADMIN_PASSWORD)

    if not admin_existe:
        cur.execute("""
            INSERT INTO utilisateurs (
                nom_complet, telephone, email, role, ville, quartier,
                email_verifie, kyc_statut, mot_de_passe
            ) VALUES (%s, %s, %s, 'admin', 'Conakry', 'Kaloum', 1, 'verifie', %s)
        """, ("Administrateur MécaConnect", "+224 620 00 00 00", ADMIN_EMAIL, hashed_admin))
    else:
        cur.execute(
            "UPDATE utilisateurs SET role = 'admin', email_verifie = 1, kyc_statut = 'verifie', mot_de_passe = %s WHERE email = %s",
            (hashed_admin, ADMIN_EMAIL)
        )

    conn.commit()
    cur.close()
    conn.close()


def valider_domaine_email(email_brut: str):
    email = (email_brut or "").strip().lower()
    if not email or len(email) > 180 or not EMAIL_REGEX.match(email):
        return None, "Adresse e-mail invalide. Vérifiez le format (ex. nom@exemple.gn)."

    locale, domaine = email.split("@", 1)
    if locale.startswith(".") or locale.endswith(".") or ".." in email:
        return None, "Format d'adresse e-mail invalide."

    if domaine in DOMAINES_JETABLES:
        return None, "Les adresses e-mail temporaires ou jetables ne sont pas autorisées."

    if HAS_DNS:
        try:
            mx = dns.resolver.resolve(domaine, "MX")
            if not mx:
                return None, f"Le domaine « {domaine} » ne possède pas de serveur mail actif."
        except Exception:
            return None, f"L'adresse ou le domaine « {domaine} » n'existe pas ou est inaccessible."

    return email, None


def envoyer_mail_otp(destinataire: str, code: str):
    smtp_host = os.getenv("SMTP_HOST")
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_user = os.getenv("SMTP_USER")
    smtp_pass = os.getenv("SMTP_PASS")

    if not smtp_host or not smtp_user or not smtp_pass:
        print(f"[DEV OTP] Code de vérification pour {destinataire} : {code}")
        return True

    msg = EmailMessage()
    msg["Subject"] = "Code de vérification MecaConnect Guinée"
    msg["From"] = smtp_user
    msg["To"] = destinataire
    msg.set_content(f"Votre code de vérification MecaConnect est : {code}\nCe code expire dans 10 minutes.")

    with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.send_message(msg)
    return True


@app.post("/api/email/envoyer-otp")
def api_envoyer_otp():
    data = request.get_json(silent=True) or {}
    email, err = valider_domaine_email(data.get("email"))
    if err:
        return jsonify({"error": err}), 400

    conn = get_db_connection()
    cur = conn.cursor(dictionary=True)
    cur.execute("SELECT id FROM utilisateurs WHERE email = %s LIMIT 1", (email,))
    existe = cur.fetchone()
    cur.close()
    conn.close()

    if existe:
        return jsonify({"error": "Un compte existe déjà avec cette adresse e-mail."}), 409

    code = f"{random.randint(100000, 999999)}"
    OTP_STORE[email] = {
        "code": code,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        "verified": False
    }

    try:
        envoyer_mail_otp(email, code)
    except Exception:
        return jsonify({"error": "Impossible d'envoyer l'e-mail à cette adresse (adresse introuvable ou rejetée)."}), 400

    return jsonify({"message": "Code de vérification envoyé à votre adresse e-mail."}), 200


@app.post("/api/email/verifier-otp")
def api_verifier_otp():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    code = (data.get("code") or "").strip()

    entree = OTP_STORE.get(email)
    if not entree:
        return jsonify({"error": "Aucun code n'a été demandé pour cette adresse."}), 400

    if datetime.now(timezone.utc) > entree["expires_at"]:
        OTP_STORE.pop(email, None)
        return jsonify({"error": "Le code a expiré. Demandez un nouveau code."}), 400

    if entree["code"] != code:
        return jsonify({"error": "Code de vérification incorrect."}), 400

    entree["verified"] = True
    return jsonify({"message": "Adresse e-mail vérifiée."}), 200


@app.post("/api/inscription")
def api_inscription():
    data = request.get_json(silent=True) or {}

    email, err = valider_domaine_email(data.get("email"))
    if err:
        return jsonify({"error": err}), 400

    entree_otp = OTP_STORE.get(email)
    if not entree_otp or not entree_otp.get("verified"):
        return jsonify({"error": "Veuillez d'abord vérifier votre adresse e-mail avec le code à 6 chiffres."}), 400

    nom_complet = (data.get("nom_complet") or "").strip()
    telephone = (data.get("telephone") or "").strip()
    role = (data.get("role") or "chauffeur").strip().lower()
    ville = (data.get("ville") or "Conakry").strip()
    quartier = (data.get("quartier") or "").strip()
    type_piece = (data.get("type_piece") or "").strip()
    numero_piece = (data.get("numero_piece") or "").strip().upper()
    date_expiration = (data.get("date_expiration") or "").strip()
    ref_atelier = (data.get("ref_atelier") or "").strip()
    mot_de_passe = data.get("mot_de_passe") or ""
    selfie_valide = bool(data.get("selfie_valide"))

    if role not in ("chauffeur", "mecanicien"):
        role = "chauffeur"

    if not nom_complet or not telephone or not quartier or not numero_piece or len(mot_de_passe) < 6:
        return jsonify({"error": "Veuillez remplir tous les champs obligatoires (mot de passe de 6 caractères minimum)."}), 400

    if not selfie_valide:
        return jsonify({"error": "La capture du selfie en direct est obligatoire pour la vérification KYC."}), 400

    conn = get_db_connection()
    cur = conn.cursor(dictionary=True)

    cur.execute("SELECT id FROM utilisateurs WHERE email = %s LIMIT 1", (email,))
    if cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Cette adresse e-mail est déjà utilisée."}), 409

    cur.execute("SELECT id FROM utilisateurs WHERE numero_piece = %s LIMIT 1", (numero_piece,))
    if cur.fetchone():
        cur.close()
        conn.close()
        return jsonify({"error": "Ce numéro de pièce d'identité est déjà rattaché à un autre compte."}), 409

    hashed_pw = generate_password_hash(mot_de_passe)
    cur.execute("""
        INSERT INTO utilisateurs (
            nom_complet, telephone, email, role, ville, quartier,
            type_piece, numero_piece, date_expiration, ref_atelier,
            email_verifie, kyc_statut, mot_de_passe
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1, 'soumis', %s)
    """, (
        nom_complet, telephone, email, role, ville, quartier,
        type_piece, numero_piece, date_expiration, ref_atelier, hashed_pw
    ))
    conn.commit()
    user_id = cur.lastrowid

    cur.execute(
        "SELECT id, nom_complet, telephone, email, role, ville, quartier, email_verifie, kyc_statut FROM utilisateurs WHERE id = %s",
        (user_id,)
    )
    user = cur.fetchone()
    cur.close()
    conn.close()

    OTP_STORE.pop(email, None)
    return jsonify({"user": user}), 201


@app.post("/api/connexion")
def api_connexion():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    mot_de_passe = data.get("mot_de_passe") or ""

    erreur_generique = "Identifiants incorrects. Vérifiez votre adresse e-mail et votre mot de passe."

    if not email or not mot_de_passe:
        return jsonify({"error": erreur_generique}), 401

    conn = get_db_connection()
    cur = conn.cursor(dictionary=True)
    cur.execute(
        "SELECT id, nom_complet, telephone, email, role, ville, quartier, email_verifie, kyc_statut, mot_de_passe FROM utilisateurs WHERE email = %s LIMIT 1",
        (email,)
    )
    user = cur.fetchone()
    cur.close()
    conn.close()

    if not user or not check_password_hash(user["mot_de_passe"], mot_de_passe):
        return jsonify({"error": erreur_generique}), 401

    user.pop("mot_de_passe", None)
    return jsonify({"user": user}), 200


if __name__ == "__main__":
    init_db_and_admin()
    app.run(host="127.0.0.1", port=5000, debug=True)