-- Guarantees & Deposits (prototype v17 · Finance & Field → Guarantees & Deposits) – run once per TENANT database.
-- Additive only: no table is dropped and no existing instrument (emdbg), renewal history, tender or customer row is
-- changed or deleted. The application applies the same changes at startup (instrument_service.ensure_schema_all_tenants),
-- so running this script is optional and idempotent.
--
--   * emdbg.instrument_type: + 'BG', 'FDR' (values appended; existing values unchanged)
--   * emdbg.status: + 'Release Requested'
--   * instrument_types    – tenant instrument types (stable keys EMD / BG / PBG / SD / FDR + legacy types in use)
--   * instrument_profiles – release / extension workflow, lifecycle "Requested from bank", bank margin / lien, FDR,
--                           reminder / escalation history and the EMD auto-create idempotency key
--   * instrument_notes    – Notes tab
--   * Settings → Guarantees & deposits → Bid security defaults (only when not configured yet)

ALTER TABLE emdbg MODIFY COLUMN instrument_type
    ENUM('EMD','Performance BG','Security Deposit','Advance BG','Retention BG','DD','Online Payment','BG','FDR') NOT NULL;
ALTER TABLE emdbg MODIFY COLUMN status
    ENUM('Active','Expired','Released','Encashed','Renewed','Cancelled','Release Requested') DEFAULT 'Active';

CREATE TABLE IF NOT EXISTS instrument_types (
    `key` VARCHAR(40) NOT NULL PRIMARY KEY,
    label VARCHAR(60) NOT NULL,
    stored_value VARCHAR(40) NOT NULL,
    category VARCHAR(20) NOT NULL DEFAULT 'guarantee',
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS instrument_profiles (
    emdbg_id INT NOT NULL PRIMARY KEY,
    type_key VARCHAR(40) NULL,
    requested_on DATE NULL,
    release_state VARCHAR(20) NOT NULL DEFAULT 'none',
    release_requested_at DATETIME NULL,
    release_requested_by INT NULL,
    release_reason TEXT NULL,
    release_approval_id INT NULL,
    release_confirmed_by INT NULL,
    ext_new_date DATE NULL,
    ext_bank_ref VARCHAR(100) NULL,
    ext_approval_id INT NULL,
    margin_pct DECIMAL(5,2) NULL,
    margin_amount DECIMAL(15,2) NULL,
    lien_amount DECIMAL(15,2) NULL,
    lien_reference VARCHAR(100) NULL,
    fdr_number VARCHAR(100) NULL,
    fdr_amount DECIMAL(15,2) NULL,
    fdr_rate DECIMAL(5,2) NULL,
    fdr_maturity DATE NULL,
    reminded_for DATE NULL,
    escalated_at DATETIME NULL,
    escalation_count INT NOT NULL DEFAULT 0,
    auto_key VARCHAR(80) NULL,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY auto_key (auto_key),
    KEY ix_instrument_profiles_release_approval_id (release_approval_id),
    KEY ix_instrument_profiles_ext_approval_id (ext_approval_id),
    CONSTRAINT fk_instrument_profiles_emdbg FOREIGN KEY (emdbg_id) REFERENCES emdbg (id) ON DELETE CASCADE,
    CONSTRAINT fk_instrument_profiles_req_by FOREIGN KEY (release_requested_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_instrument_profiles_conf_by FOREIGN KEY (release_confirmed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS instrument_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    emdbg_id INT NOT NULL,
    body TEXT NOT NULL,
    created_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY ix_instrument_notes_emdbg_id (emdbg_id),
    CONSTRAINT fk_instrument_notes_emdbg FOREIGN KEY (emdbg_id) REFERENCES emdbg (id) ON DELETE CASCADE,
    CONSTRAINT fk_instrument_notes_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Instrument types (prototype FD.emd: EMD, BG, PBG, Security Deposit, FDR); legacy types only active when in use.
INSERT INTO instrument_types (`key`, label, stored_value, category, sort_order, is_active)
SELECT x.k, x.l, x.s, x.c, x.o, x.a FROM (
    SELECT 'EMD' AS k, 'EMD' AS l, 'EMD' AS s, 'deposit' AS c, 1 AS o, 1 AS a
    UNION ALL SELECT 'BG', 'BG', 'BG', 'guarantee', 2, 1
    UNION ALL SELECT 'PBG', 'PBG', 'Performance BG', 'guarantee', 3, 1
    UNION ALL SELECT 'SD', 'Security Deposit', 'Security Deposit', 'deposit', 4, 1
    UNION ALL SELECT 'FDR', 'FDR', 'FDR', 'deposit', 5, 1
    UNION ALL SELECT 'ABG', 'Advance BG', 'Advance BG', 'guarantee', 6, (SELECT COUNT(*) > 0 FROM emdbg WHERE instrument_type = 'Advance BG')
    UNION ALL SELECT 'RBG', 'Retention BG', 'Retention BG', 'guarantee', 7, (SELECT COUNT(*) > 0 FROM emdbg WHERE instrument_type = 'Retention BG')
    UNION ALL SELECT 'DD', 'DD', 'DD', 'deposit', 8, (SELECT COUNT(*) > 0 FROM emdbg WHERE instrument_type = 'DD')
    UNION ALL SELECT 'ONLINE', 'Online Payment', 'Online Payment', 'deposit', 9, (SELECT COUNT(*) > 0 FROM emdbg WHERE instrument_type = 'Online Payment')
) x
WHERE NOT EXISTS (SELECT 1 FROM instrument_types t WHERE t.`key` = x.k);

-- Settings → Guarantees & deposits → Bid security (prototype v17 defaults) – only when not configured yet.
INSERT INTO settings (`key`, `value`, `type`, `category`, `label`)
SELECT x.k, x.v, x.t, 'instruments', x.l FROM (
    SELECT 'instrument_expiry_reminder_days' AS k, '30' AS v, 'number' AS t, 'Expiry reminder (days before)' AS l
    UNION ALL SELECT 'instrument_track_margin', 'true', 'boolean', 'Track bank margin / lien'
    UNION ALL SELECT 'instrument_release_approval', 'true', 'boolean', 'Approval to request release'
    UNION ALL SELECT 'instrument_auto_create_emd', 'true', 'boolean', 'Auto-create instrument when a bid needs EMD'
    UNION ALL SELECT 'instrument_preferred_bank', 'SBI', 'string', 'Preferred bank'
    UNION ALL SELECT 'instrument_escalate_days', '45', 'number', 'Escalate unreleased after (days)'
    UNION ALL SELECT 'instrument_track_fdr', 'true', 'boolean', 'Track FDR deposits'
) x
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = x.k);
