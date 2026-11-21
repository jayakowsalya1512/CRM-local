-- Orders & Projects (prototype v17 · Sales → Orders & Projects) – run once per TENANT database.
-- Additive only: no table is dropped and no existing work order, milestone, invoice, tender or quote row is changed or
-- deleted. The application applies the same changes at startup (order_service.ensure_schema_all_tenants), so running
-- this script is optional and idempotent.
--
--   * order_lifecycles   – order lifecycles (Process Designer): Project / Supply + follow-on lifecycles (AMC, warranty …)
--   * order_profiles     – per order: lifecycle, start date, stage clock, approval hold, checklist, parent order (follow-on),
--                          source deal and an idempotency key for automatic / follow-on creation
--   * order_notes        – Notes tab of the order drawer
--   * wo_milestones.invoice_id – the billing record (wo_invoices) that invoiced a milestone
--   * the default order & project lifecycle (only when the tenant has none yet)
-- Existing work orders get their profile and stage on first read: Completed / Closed / Cancelled / Lost → Closed,
-- everything else → Kick-off. work_orders.status is kept in step (Confirmed / In Progress / Closed) for reports.

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

CREATE TABLE IF NOT EXISTS order_lifecycles (
    workflow VARCHAR(40) NOT NULL PRIMARY KEY,
    type_name VARCHAR(80) NOT NULL,
    label VARCHAR(120) NOT NULL,
    `trigger` VARCHAR(20) NOT NULL DEFAULT 'manual',
    template VARCHAR(60) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_order_lifecycles_type (type_name),
    CONSTRAINT fk_order_lifecycles_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_profiles (
    wo_id INT NOT NULL PRIMARY KEY,
    lifecycle VARCHAR(40) NOT NULL DEFAULT 'wo',
    start_date DATE NULL,
    stage_entered_at DATETIME NULL,
    pending_stage_id INT NULL,
    approval_request_id INT NULL,
    checklist JSON NULL,
    parent_wo_id INT NULL,
    deal_id INT NULL,
    auto_key VARCHAR(80) NULL,
    updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY auto_key (auto_key),
    KEY ix_order_profiles_lifecycle (lifecycle),
    KEY ix_order_profiles_approval_request_id (approval_request_id),
    KEY ix_order_profiles_parent_wo_id (parent_wo_id),
    KEY ix_order_profiles_deal_id (deal_id),
    CONSTRAINT fk_order_profiles_wo FOREIGN KEY (wo_id) REFERENCES work_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS order_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    wo_id INT NOT NULL,
    body TEXT NOT NULL,
    created_by INT NULL,
    created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NULL,
    KEY ix_order_notes_wo_id (wo_id),
    CONSTRAINT fk_order_notes_wo FOREIGN KEY (wo_id) REFERENCES work_orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_order_notes_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE wo_milestones ADD COLUMN IF NOT EXISTS `invoice_id` INT NULL;

-- Default order & project lifecycle (prototype v17 WF.wo) – only when the tenant has none yet.
INSERT INTO order_lifecycles (workflow, type_name, label, `trigger`, sort_order, is_active)
SELECT 'wo', 'Project / Supply', 'Project / Supply order', 'manual', 0, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM order_lifecycles WHERE workflow = 'wo');

INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
SELECT 'wo', 1, 'order-default', 'Order & project lifecycle', 'Orders & Projects defaults', NOW() FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'wo');

INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT x.workflow, 1, x.position, x.name, x.kind, x.sla_days, 'None', NULL, NULL
FROM (
    SELECT 'wo' AS workflow, 0 AS position, 'Kick-off' AS name, 'open' AS kind, 3 AS sla_days
    UNION ALL SELECT 'wo', 1, 'Procurement', 'open', 15
    UNION ALL SELECT 'wo', 2, 'Execution', 'open', 30
    UNION ALL SELECT 'wo', 3, 'Dispatch', 'open', 7
    UNION ALL SELECT 'wo', 4, 'Installation', 'open', 14
    UNION ALL SELECT 'wo', 5, 'Commissioning', 'open', 7
    UNION ALL SELECT 'wo', 6, 'Closed', 'won', 0
) x
WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'wo');

-- Settings → Orders & projects (prototype v17 defaults) – only when not configured yet.
INSERT INTO settings (`key`, `value`, `type`, `category`, `label`)
SELECT x.k, x.v, x.t, 'orders', x.l FROM (
    SELECT 'order_milestone_tracking' AS k, 'true' AS v, 'boolean' AS t, 'Milestone tracking' AS l
    UNION ALL SELECT 'order_billing_model', 'Milestone', 'string', 'Billing model'
    UNION ALL SELECT 'order_track_retention', 'false', 'boolean', 'Track retention money'
    UNION ALL SELECT 'order_retention_percent', '5', 'number', 'Retention (%)'
    UNION ALL SELECT 'order_auto_assign_pm', 'false', 'boolean', 'Auto-assign project manager'
    UNION ALL SELECT 'order_milestone_slip_alert', 'true', 'boolean', 'Alert when a milestone slips'
    UNION ALL SELECT 'order_number_format', 'WO-YY-####', 'string', 'Order number format'
) x
WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.`key` = x.k);
