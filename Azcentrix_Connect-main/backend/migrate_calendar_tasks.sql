-- Calendar & Tasks (prototype v17) – run against EACH tenant database.
-- The backend creates these tables automatically on startup
-- (app.services.calendar_service.ensure_calendar_schema_all_tenants) and seeds the module and
-- permissions (tenant_module_service), so this script is only for manual / DBA-controlled deployments. Idempotent.

CREATE TABLE IF NOT EXISTS crm_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(300) NOT NULL,
  related_module VARCHAR(30) NULL,
  related_id INT NULL,
  related_label VARCHAR(300) NULL,
  assignee_id INT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT 'Medium',
  due_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'To do',
  source VARCHAR(30) NULL,
  completed_at DATETIME NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_crm_tasks_assignee_status (assignee_id, status),
  KEY idx_crm_tasks_creator (created_by),
  KEY idx_crm_tasks_due (due_date),
  KEY idx_crm_tasks_related (related_module, related_id),
  CONSTRAINT fk_crm_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_crm_tasks_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS calendar_connections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  provider VARCHAR(20) NOT NULL DEFAULT 'google',
  account_email VARCHAR(255) NULL,
  calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',
  token_blob TEXT NULL,                       -- AES-GCM encrypted OAuth tokens
  status VARCHAR(20) NOT NULL DEFAULT 'connected',
  last_sync_at DATETIME NULL,
  last_status VARCHAR(20) NULL,
  last_message VARCHAR(500) NULL,
  last_counts VARCHAR(120) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_calendar_connection_user_provider (user_id, provider),
  CONSTRAINT fk_calendar_connections_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS calendar_sync_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  connection_id INT NOT NULL,
  event_key VARCHAR(80) NOT NULL,
  external_id VARCHAR(255) NOT NULL,
  fingerprint VARCHAR(64) NOT NULL,
  event_date DATE NULL,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_calendar_sync_item_key (connection_id, event_key),
  CONSTRAINT fk_calendar_sync_items_connection FOREIGN KEY (connection_id) REFERENCES calendar_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sidebar: "Calendar & Tasks" in the Main group right after Inbox & Notifications
INSERT INTO modules (`key`, label, icon, route, section, sort_order, parent_key, permission_key, is_active, is_system)
SELECT 'calendar', 'Calendar & Tasks', 'Calendar', '/calendar', 'main', 16, NULL, 'calendar.view', 1, 0
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE `key` = 'calendar');

INSERT IGNORE INTO permissions (`key`, module, action, description) VALUES
  ('calendar.view', 'calendar', 'view', 'View calendar & tasks'),
  ('calendar.create', 'calendar', 'create', 'Create tasks'),
  ('calendar.update', 'calendar', 'update', 'Edit tasks and change task status'),
  ('calendar.delete', 'calendar', 'delete', 'Delete tasks');

-- First enablement: every active role gets the calendar permissions (own data), Admin sees all.
INSERT INTO role_permissions (role_id, permission_id, data_scope)
SELECT r.id, p.id, IF(r.name = 'admin', 'all', 'own')
FROM roles r JOIN permissions p ON p.`key` LIKE 'calendar.%'
WHERE r.is_active = 1
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p2 ON p2.id = rp.permission_id WHERE p2.`key` LIKE 'calendar.%');
