-- Travel & Expense (prototype v17 · Finance & Field → Travel & Expense) – run once per TENANT database.
-- Additive only: travel_requests, tada_claims, tada_line_items, tada_attachments and approvals are used as they are; no
-- existing table, column or row is changed or deleted. The application creates the same tables at startup
-- (travel_expense_service.ensure_schema_all_tenants), so running this script is optional and idempotent.
--
--   * travel_advance_txns – advance money actually paid out (disbursed) or returned (refunded) per trip, recorded by
--                           finance. A requested advance (travel_requests.advance_amount) is never counted as paid.
--   * travel_trip_notes   – trip drawer Notes tab.

CREATE TABLE IF NOT EXISTS travel_advance_txns (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    travel_request_id INT NOT NULL,
    kind VARCHAR(20) NOT NULL,                 -- disbursed | refunded
    amount DECIMAL(12,2) NOT NULL,
    txn_date DATE NOT NULL,
    reference VARCHAR(120) NULL,
    payment_mode VARCHAR(30) NULL,
    notes VARCHAR(500) NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY ix_travel_adv_trip (travel_request_id),
    CONSTRAINT fk_travel_adv_trip FOREIGN KEY (travel_request_id) REFERENCES travel_requests (id) ON DELETE CASCADE,
    CONSTRAINT fk_travel_adv_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS travel_trip_notes (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    travel_request_id INT NOT NULL,
    body TEXT NOT NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY ix_travel_note_trip (travel_request_id),
    CONSTRAINT fk_travel_note_trip FOREIGN KEY (travel_request_id) REFERENCES travel_requests (id) ON DELETE CASCADE,
    CONSTRAINT fk_travel_note_user FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
