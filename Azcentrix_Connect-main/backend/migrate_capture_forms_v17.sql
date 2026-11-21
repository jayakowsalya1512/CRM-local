-- Lead capture forms (prototype v17 · Sales → Capture Forms) – run against EACH tenant database.
-- The backend does all of this automatically on startup (capture_form_service.ensure_schema_all_tenants creates the
-- tables; sync_tenant_runtime_catalogs adds the sidebar module and permissions and grants them to Admin). This script
-- is for manual / DBA-controlled deployments. No existing table is changed and no master data is copied. Idempotent.

CREATE TABLE IF NOT EXISTS capture_forms (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  public_key VARCHAR(24) NOT NULL,                 -- random key used in the hosted URL / embed script
  name VARCHAR(200) NOT NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  fields LONGTEXT NOT NULL CHECK (JSON_VALID(fields)),       -- ordered field keys: name, contact, email, phone, interest, value, message, tender, state
  required LONGTEXT NOT NULL CHECK (JSON_VALID(required)),   -- subset of fields
  assign_mode VARCHAR(40) NOT NULL,                -- team:<org_tree_nodes.id> | state | user:<users.id>
  source_id INT NULL,                              -- lead_sources.id
  thanks TEXT NULL,
  spam VARCHAR(30) NOT NULL DEFAULT 'Honeypot',    -- Honeypot | CAPTCHA | Honeypot + CAPTCHA
  rr_cursor INT NOT NULL DEFAULT 0,                -- round-robin position
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_capture_forms_public_key (public_key),
  KEY ix_capture_forms_source (source_id),
  CONSTRAINT fk_capture_forms_source FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_forms_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_forms_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS capture_submissions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ref VARCHAR(24) NULL,                            -- CFyymmNNNNN
  form_id INT NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_test TINYINT(1) NOT NULL DEFAULT 0,           -- "Send a test submission" – left out of KPIs
  status VARCHAR(20) NOT NULL,                     -- lead_created | duplicate | spam | error | received
  spam_reason VARCHAR(120) NULL,
  data LONGTEXT NULL CHECK (JSON_VALID(data)),     -- submitted values
  company VARCHAR(300) NULL,
  contact VARCHAR(200) NULL,
  email VARCHAR(200) NULL,
  phone VARCHAR(40) NULL,
  interest VARCHAR(300) NULL,
  lead_id INT NULL,                                -- lead created (or the open lead a duplicate was attached to)
  customer_id INT NULL,
  contact_id INT NULL,
  assigned_to INT NULL,
  routing LONGTEXT NULL CHECK (JSON_VALID(routing)),   -- rule used, assignee, notes
  error TEXT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(300) NULL,
  page_url VARCHAR(500) NULL,
  submitted_by INT NULL,                           -- user who sent a test submission
  UNIQUE KEY uq_capture_submissions_ref (ref),
  KEY ix_capture_submissions_form_received (form_id, received_at),
  KEY ix_capture_submissions_ip_received (ip, received_at),
  KEY ix_capture_submissions_lead_id (lead_id),
  CONSTRAINT fk_capture_submissions_form FOREIGN KEY (form_id) REFERENCES capture_forms(id) ON DELETE CASCADE,
  CONSTRAINT fk_capture_submissions_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_submissions_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_submissions_contact FOREIGN KEY (contact_id) REFERENCES customer_contacts(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_submissions_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_capture_submissions_submitted_by FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sidebar entry: Sales → Capture Forms (after Leads). Ships with the Leads feature.
INSERT INTO modules (`key`, label, icon, route, section, sort_order, parent_key, permission_key, is_active, is_system)
SELECT 'capture_forms', 'Capture Forms', 'layout', '/capture-forms', 'sales', 23, NULL, 'capture_forms.view',
       COALESCE((SELECT m.is_active FROM modules m WHERE m.`key` = 'leads'), 1), 0
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM modules WHERE `key` = 'capture_forms');

INSERT INTO permissions (`key`, module, action, description)
SELECT * FROM (
  SELECT 'capture_forms.view' AS k, 'capture_forms' AS m, 'view' AS a, 'View lead capture forms, their submissions and KPIs' AS d UNION ALL
  SELECT 'capture_forms.create', 'capture_forms', 'create', 'Create lead capture forms' UNION ALL
  SELECT 'capture_forms.update', 'capture_forms', 'update', 'Configure, publish and test lead capture forms'
) p WHERE NOT EXISTS (SELECT 1 FROM permissions x WHERE x.`key` = p.k);

-- Admin gets the new permissions (other roles: grant them in Roles & Security).
INSERT INTO role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, 'all' FROM roles r JOIN permissions p ON p.`key` IN ('capture_forms.view', 'capture_forms.create', 'capture_forms.update')
WHERE r.name = 'admin' AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- Optional: restrict which websites may embed the forms (CSP frame-ancestors). Empty list = any site.
-- INSERT INTO settings (`key`, `value`, `type`, `category`, `label`, `description`)
-- VALUES ('capture_forms_allowed_origins', '["https://www.example.com"]', 'json', 'leads', 'Capture form embed sites',
--         'Websites allowed to embed lead capture forms; empty = any site');
