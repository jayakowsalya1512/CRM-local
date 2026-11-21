-- Field Sales 360 (prototype v17 · Finance & Field → Field Sales 360) – run once per TENANT database.
-- Additive only: no existing table, column or row is changed or deleted. kam_activities, kam_log, kam_targets,
-- customers and deals are read as they are. The application creates the same tables at startup
-- (field_sales_service.ensure_schema_all_tenants), so running this script is optional and idempotent.
--
--   * field_visits               – visit check-in / check-out (time, GPS fix + accuracy, verification result), structured
--                                  outcome, planned flag, sentiment, recorded distance, follow-up task link.
--                                  Raw coordinates are cleared after Settings field_sales_location_retention_days (default 365).
--   * field_sales_targets        – annual (fiscal-year) target per KAM set on the Targets tab (rupees).
--   * field_sales_target_history – who changed a target, when, old → new, client IP.
--   * Settings (optional, defaults shown): field_sales_visit_days_tier_a = 14, field_sales_visit_days_tier_b = 30,
--     field_sales_visit_days_tier_c = 60, field_sales_location_retention_days = 365; fiscal year from fiscal_year_start.

CREATE TABLE IF NOT EXISTS field_visits (
    activity_id INT NOT NULL PRIMARY KEY,
    planned TINYINT(1) NULL,
    outcome_rating VARCHAR(20) NULL,
    sentiment SMALLINT NULL,
    check_in_at DATETIME NULL,
    check_in_lat DECIMAL(10,7) NULL,
    check_in_lng DECIMAL(10,7) NULL,
    check_in_accuracy DECIMAL(10,2) NULL,
    gps_status VARCHAR(20) NULL,
    check_out_at DATETIME NULL,
    check_out_lat DECIMAL(10,7) NULL,
    check_out_lng DECIMAL(10,7) NULL,
    check_out_accuracy DECIMAL(10,2) NULL,
    distance_km DECIMAL(10,2) NULL,
    location_purged_at DATETIME NULL,
    followup_task_id INT NULL,
    created_by INT NULL,
    updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_field_visits_checkin (check_in_at),
    CONSTRAINT fk_field_visits_activity FOREIGN KEY (activity_id) REFERENCES kam_activities (id) ON DELETE CASCADE,
    CONSTRAINT fk_field_visits_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_field_visits_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS field_sales_targets (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    fy_start DATE NOT NULL,
    annual_target DECIMAL(15,2) NOT NULL DEFAULT 0,
    created_by INT NULL,
    updated_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_field_sales_target_user_fy (user_id, fy_start),
    CONSTRAINT fk_fs_target_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_fs_target_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_fs_target_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS field_sales_target_history (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    fy_start DATE NOT NULL,
    old_value DECIMAL(15,2) NULL,
    new_value DECIMAL(15,2) NOT NULL,
    changed_by INT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45) NULL,
    KEY ix_fs_target_hist_user (user_id, fy_start),
    CONSTRAINT fk_fs_hist_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_fs_hist_changed_by FOREIGN KEY (changed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
