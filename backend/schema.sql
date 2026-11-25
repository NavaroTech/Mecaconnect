-- ============================================================================
-- MecaConnect Guinée — Schéma complet MySQL
-- Base de données : mecaconnect_db
-- ============================================================================

CREATE DATABASE IF NOT EXISTS mecaconnect_db
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE mecaconnect_db;

-- 1. Utilisateurs, rôles (chauffeur, mecanicien, admin) et statut KYC
CREATE TABLE IF NOT EXISTS utilisateurs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom_complet VARCHAR(150) NOT NULL,
    telephone VARCHAR(30) NOT NULL,
    email VARCHAR(180) NOT NULL UNIQUE,
    role VARCHAR(30) NOT NULL DEFAULT 'chauffeur',
    ville VARCHAR(80) NOT NULL,
    quartier VARCHAR(120) NOT NULL,
    type_piece VARCHAR(60) NULL,
    numero_piece VARCHAR(80) NULL UNIQUE,
    date_expiration VARCHAR(30) NULL,
    ref_atelier VARCHAR(80) NULL,
    email_verifie TINYINT(1) NOT NULL DEFAULT 0,
    kyc_statut VARCHAR(30) NOT NULL DEFAULT 'en_attente',
    mot_de_passe VARCHAR(255) NOT NULL,
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    mis_a_jour_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_utilisateurs_role (role),
    INDEX idx_utilisateurs_ville (ville),
    INDEX idx_utilisateurs_kyc (kyc_statut)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Codes OTP de vérification d'adresse e-mail (stockage persistant)
CREATE TABLE IF NOT EXISTS email_otps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(180) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    expire_le DATETIME NOT NULL,
    verifie TINYINT(1) NOT NULL DEFAULT 0,
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_otps_email (email),
    INDEX idx_email_otps_expire (expire_le)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Documents KYC (pièce d'identité + selfie en direct + empreinte SHA-256)
CREATE TABLE IF NOT EXISTS documents_kyc (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT NOT NULL,
    chemin_piece VARCHAR(255) NOT NULL,
    chemin_selfie VARCHAR(255) NOT NULL,
    hash_piece VARCHAR(128) NULL,
    valide_par_admin_id INT NULL,
    valide_le DATETIME NULL,
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_documents_kyc_user (utilisateur_id),
    CONSTRAINT fk_documents_kyc_utilisateur
        FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Demandes d'intervention (dépannage urgent & rendez-vous atelier en GNF)
CREATE TABLE IF NOT EXISTS demandes_intervention (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT NULL,
    type_intervention VARCHAR(30) NOT NULL DEFAULT 'urgence',
    categorie_panne VARCHAR(60) NOT NULL,
    ville VARCHAR(80) NOT NULL,
    quartier VARCHAR(120) NOT NULL,
    vehicule VARCHAR(150) NOT NULL,
    telephone VARCHAR(30) NOT NULL,
    description TEXT NOT NULL,
    date_creneau VARCHAR(40) NULL,
    tarif_gnf INT NOT NULL DEFAULT 150000,
    statut VARCHAR(40) NOT NULL DEFAULT 'en_attente',
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_demandes_user (utilisateur_id),
    INDEX idx_demandes_ville (ville),
    INDEX idx_demandes_statut (statut),
    CONSTRAINT fk_demandes_utilisateur
        FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Paiements en Francs guinéens (Orange Money, MTN MoMo, Espèces)
CREATE TABLE IF NOT EXISTS paiements_gnf (
    id INT AUTO_INCREMENT PRIMARY KEY,
    reference_code VARCHAR(40) NOT NULL UNIQUE,
    demande_id INT NULL,
    intervention_label VARCHAR(180) NOT NULL,
    montant_gnf INT NOT NULL,
    moyen_paiement VARCHAR(50) NOT NULL,
    telephone VARCHAR(30) NULL,
    statut VARCHAR(30) NOT NULL DEFAULT 'confirme',
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_paiements_demande (demande_id),
    INDEX idx_paiements_statut (statut),
    CONSTRAINT fk_paiements_demande
        FOREIGN KEY (demande_id) REFERENCES demandes_intervention(id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Notifications utilisateurs
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    utilisateur_id INT NULL,
    titre VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    lu TINYINT(1) NOT NULL DEFAULT 0,
    cree_le DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notifications_user (utilisateur_id),
    INDEX idx_notifications_lu (lu),
    CONSTRAINT fk_notifications_utilisateur
        FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;