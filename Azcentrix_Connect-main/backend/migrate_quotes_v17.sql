-- Quotes (prototype v17 · Sales → Quotes) – run once per TENANT database.
-- Additive only: no table is dropped, no existing row is changed or deleted. The application also applies the same
-- changes at startup (quote_service.ensure_schema_all_tenants), so running this script is optional and idempotent.
--
--   * quotation_line_items: discount_percent (Disc %) and product_id (From catalog)
--   * products_master: list_price / gst_percent (Product & Price Books values shown by "From catalog")
--   * quote_profiles: per-quote enquiry reference, stage / approval state, commercial-term overrides, work order link,
--     Form Builder values (keyed by the quote's first revision row id)
--   * shared workflow tables + the default quote lifecycle (only when the tenant has none yet)
--
-- Existing quotations keep working: every quotations row is one revision of the quote with the same quotation_number.

ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS `discount_percent` DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE quotation_line_items ADD COLUMN IF NOT EXISTS `product_id` INT NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `list_price` DECIMAL(15,2) NULL;
ALTER TABLE products_master ADD COLUMN IF NOT EXISTS `gst_percent` DECIMAL(5,2) NULL;

CREATE TABLE IF NOT EXISTS quote_profiles (
    quote_id INT NOT NULL PRIMARY KEY,
    quotation_number VARCHAR(50) NOT NULL,
    enquiry_ref VARCHAR(120) NULL,
    stage_entered_at DATETIME NULL,
    pending_stage_id INT NULL,
    approval_request_id INT NULL,
    lost_reason VARCHAR(120) NULL,
    lost_note TEXT NULL,
    checklist JSON NULL,
    payment_terms TEXT NULL,
    delivery_terms TEXT NULL,
    warranty_terms TEXT NULL,
    work_order_id INT NULL,
    custom_data JSON NULL,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_quote_profiles_quotation_number (quotation_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_definitions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workflow VARCHAR(40) NOT NULL,
    revision INT NOT NULL,
    template_key VARCHAR(40) NULL,
    template_name VARCHAR(150) NULL,
    applied_by VARCHAR(255) NULL,
    applied_at DATETIME NOT NULL,
    UNIQUE KEY uq_workflow_definitions_workflow (workflow)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_stages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    workflow VARCHAR(40) NOT NULL,
    revision INT NOT NULL,
    position INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    kind VARCHAR(10) NOT NULL DEFAULT 'open',
    sla_days INT NOT NULL DEFAULT 0,
    gate VARCHAR(20) NOT NULL DEFAULT 'None',
    owner_role VARCHAR(100) NULL,
    checklist JSON NULL,
    UNIQUE KEY uq_workflow_stages_position (workflow, revision, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS workflow_record_stages (
    workflow VARCHAR(40) NOT NULL,
    record_id INT NOT NULL,
    stage_id INT NOT NULL,
    mapped_at DATETIME NOT NULL,
    PRIMARY KEY (workflow, record_id),
    KEY ix_workflow_record_stages_stage (stage_id, workflow),
    CONSTRAINT fk_workflow_record_stages_stage FOREIGN KEY (stage_id) REFERENCES workflow_stages (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default quote lifecycle (prototype v17 WF.quote) – inserted only if the tenant has no "quote" workflow yet.
INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
SELECT 'quote', 1, 'quote-default', 'Quote lifecycle', 'Quotes defaults', NOW() FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'quote');

INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT x.workflow, 1, x.position, x.name, x.kind, x.sla_days, x.gate, x.owner_role, NULL
FROM (
    SELECT 'quote' AS workflow, 0 AS position, 'Draft' AS name, 'open' AS kind, 2 AS sla_days, 'None' AS gate, NULL AS owner_role
    UNION ALL SELECT 'quote', 1, 'Internal Review', 'open', 2, 'Approval', 'Sales Head'
    UNION ALL SELECT 'quote', 2, 'Sent to Customer', 'open', 1, 'None', NULL
    UNION ALL SELECT 'quote', 3, 'Under Negotiation', 'open', 7, 'None', NULL
    UNION ALL SELECT 'quote', 4, 'Accepted', 'won', 0, 'None', NULL
    UNION ALL SELECT 'quote', 5, 'Rejected', 'lost', 0, 'None', NULL
) x
WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'quote');
