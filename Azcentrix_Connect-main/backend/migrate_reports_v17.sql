-- Reports (prototype v17 · Intelligence → Reports) – run once per TENANT database.
-- Additive only: no existing table, column or row is changed or deleted. Ready-made report definitions live in code;
-- custom reports reuse the report engine's saved_reports table. The application creates the same tables at startup
-- (reports_v17_service.ensure_schema_all_tenants), so running this script is optional and idempotent.
--
--   * report_favourites – the catalogue / report-header star, per user
--   * report_schedules  – frequency, format, recipients, next run, last result (one per user and report)
--   * report_runs       – export / e-mail / scheduled delivery history (who, when, format, rows, file, recipients, status)
-- New permissions reports.export / reports.schedule / reports.share are created by the tenant catalogue sync at startup and
-- granted once to every role that already holds reports.view (Roles & Security can revoke them afterwards).

CREATE TABLE IF NOT EXISTS report_favourites (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    report_key VARCHAR(80) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_report_fav_user_key (user_id, report_key),
    CONSTRAINT fk_report_fav_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_schedules (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    report_key VARCHAR(80) NOT NULL,
    report_name VARCHAR(200) NOT NULL,
    frequency VARCHAR(40) NOT NULL,
    fmt VARCHAR(10) NOT NULL DEFAULT 'PDF',
    period VARCHAR(10) NOT NULL DEFAULT 'FY',
    recipients JSON NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    next_run_at DATETIME NULL,
    last_run_at DATETIME NULL,
    last_status VARCHAR(20) NULL,
    last_error VARCHAR(500) NULL,
    failures INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_report_sched_user_key (user_id, report_key),
    KEY ix_report_sched_due (is_active, next_run_at),
    CONSTRAINT fk_report_sched_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS report_runs (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    report_key VARCHAR(80) NOT NULL,
    report_name VARCHAR(200) NOT NULL,
    user_id INT NULL,
    schedule_id INT NULL,
    `trigger` VARCHAR(20) NOT NULL,
    fmt VARCHAR(10) NULL,
    period VARCHAR(10) NULL,
    `rows` INT NULL,
    file_name VARCHAR(255) NULL,
    file_url VARCHAR(500) NULL,
    file_size_kb INT NULL,
    document_id INT NULL,
    recipients TEXT NULL,
    status VARCHAR(20) NOT NULL,
    error VARCHAR(500) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY ix_report_runs_key (report_key, created_at),
    KEY ix_report_runs_user (user_id, created_at),
    CONSTRAINT fk_report_runs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_report_runs_sched FOREIGN KEY (schedule_id) REFERENCES report_schedules (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
