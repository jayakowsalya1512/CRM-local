-- Forecasts (prototype v17 · Sales → Forecasts) – run once per TENANT database.
-- Additive only: no table is dropped, no existing row is changed or deleted. The application also creates the same
-- tables at startup (forecast_service.ensure_schema_all_tenants), so running this script is optional and idempotent.
--
--   * forecast_adjustments       – manager adjustment per forecast period + sales rep (inline "Manager adj.")
--   * forecast_submissions       – every "Submit forecast" (versioned per period + submitter, never overwritten),
--                                  its approval request and the KPI totals frozen at submit time
--   * forecast_submission_lines  – per-rep snapshot of a submission (historically consistent when deals change later)
--
-- Sales quotas come from kam_targets, deal values / stages from leads + deal pipelines, the fiscal calendar from
-- settings.fiscal_year_start and Forecast settings from settings (category "forecasts") – no new columns there.

CREATE TABLE IF NOT EXISTS forecast_adjustments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    period_key VARCHAR(20) NOT NULL,
    rep_user_id INT NOT NULL,
    amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    updated_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_forecast_adjustments_period_rep (period_key, rep_user_id),
    KEY ix_forecast_adjustments_rep_user_id (rep_user_id),
    CONSTRAINT fk_forecast_adjustments_rep FOREIGN KEY (rep_user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_forecast_adjustments_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forecast_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    period_key VARCHAR(20) NOT NULL,
    period_label VARCHAR(40) NOT NULL,
    period_start DATETIME NULL,
    period_end DATETIME NULL,
    version INT NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    submitted_by INT NULL,
    submitted_by_name VARCHAR(150) NULL,
    submitted_at DATETIME NOT NULL,
    approval_request_id INT NULL,
    approver_name VARCHAR(150) NULL,
    decided_by INT NULL,
    decided_at DATETIME NULL,
    remarks TEXT NULL,
    totals JSON NULL,
    settings JSON NULL,
    UNIQUE KEY uq_forecast_submissions_version (period_key, submitted_by, version),
    KEY ix_forecast_submissions_period (period_key, status),
    KEY ix_forecast_submissions_submitted_by (submitted_by),
    KEY ix_forecast_submissions_approval_request_id (approval_request_id),
    CONSTRAINT fk_forecast_submissions_by FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_forecast_submissions_decided FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS forecast_submission_lines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    submission_id INT NOT NULL,
    rep_user_id INT NULL,
    rep_name VARCHAR(150) NOT NULL,
    quota DECIMAL(18,2) NOT NULL DEFAULT 0,
    closed DECIMAL(18,2) NOT NULL DEFAULT 0,
    commit_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
    best_case DECIMAL(18,2) NOT NULL DEFAULT 0,
    pipeline DECIMAL(18,2) NOT NULL DEFAULT 0,
    adjustment DECIMAL(18,2) NOT NULL DEFAULT 0,
    attainment DECIMAL(9,2) NULL,
    KEY ix_forecast_submission_lines_submission_id (submission_id),
    CONSTRAINT fk_forecast_submission_lines_submission FOREIGN KEY (submission_id) REFERENCES forecast_submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default Forecast settings (prototype v17 Settings → Forecasts / Deals: commit ≥ 70 %, best case ≥ 40 %, quarterly,
-- manager adjustments on, no lock) – inserted only when the tenant has not configured them yet.
INSERT INTO settings (`key`, `value`, `type`, `category`, `label`)
SELECT x.k, x.v, x.t, 'forecasts', x.l FROM (
    SELECT 'forecast_commit_min_prob' AS k, '70' AS v, 'number' AS t, 'Minimum probability to count as commit (%)' AS l
    UNION ALL SELECT 'forecast_best_min_prob', '40', 'number', 'Minimum probability to count as best case (%)'
    UNION ALL SELECT 'forecast_period', 'Quarterly', 'string', 'Forecast period'
    UNION ALL SELECT 'forecast_adjustments', 'true', 'boolean', 'Manager adjustments'
    UNION ALL SELECT 'forecast_lock', 'false', 'boolean', 'Lock forecast at period start'
) x
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = x.k);
