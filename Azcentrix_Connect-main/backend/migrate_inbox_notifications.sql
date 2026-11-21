-- Inbox & Notifications (prototype v17) – run against EACH tenant database.
-- The backend also creates these tables automatically on startup
-- (app.services.inbox_service.ensure_inbox_schema_all_tenants), so this script is
-- only needed for manual / DBA-controlled deployments.  Idempotent.

CREATE TABLE IF NOT EXISTS mail_threads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject VARCHAR(500) NOT NULL DEFAULT '',
  message_count INT NOT NULL DEFAULT 0,
  last_message_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  thread_id INT NULL,
  owner_user_id INT NOT NULL,
  folder VARCHAR(20) NOT NULL DEFAULT 'Inbox',
  prev_folder VARCHAR(20) NULL,
  sender_user_id INT NULL,
  from_email VARCHAR(255) NOT NULL DEFAULT '',
  from_name VARCHAR(255) NULL,
  from_mailbox VARCHAR(255) NULL,
  to_emails TEXT NULL,
  cc_emails TEXT NULL,
  bcc_emails TEXT NULL,
  subject VARCHAR(500) NOT NULL DEFAULT '',
  body TEXT NULL,
  account_name VARCHAR(300) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  is_starred TINYINT(1) NOT NULL DEFAULT 0,
  is_internal TINYINT(1) NOT NULL DEFAULT 0,
  link_module VARCHAR(30) NULL,
  link_record_id INT NULL,
  link_label VARCHAR(300) NULL,
  in_reply_to_id INT NULL,
  track_opens TINYINT(1) NOT NULL DEFAULT 1,
  open_count INT NOT NULL DEFAULT 0,
  click_count INT NOT NULL DEFAULT 0,
  tracking_token VARCHAR(64) NULL UNIQUE,
  scheduled_at DATETIME NULL,
  sent_at DATETIME NULL,
  delivery_status VARCHAR(20) NULL,
  delivery_error VARCHAR(500) NULL,
  assigned_to_user_id INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  KEY idx_mail_messages_owner_folder (owner_user_id, folder, deleted_at),
  KEY idx_mail_messages_thread (thread_id),
  KEY idx_mail_messages_scheduled (folder, scheduled_at),
  KEY idx_mail_messages_link (link_module, link_record_id),
  CONSTRAINT fk_mail_messages_thread FOREIGN KEY (thread_id) REFERENCES mail_threads(id) ON DELETE SET NULL,
  CONSTRAINT fk_mail_messages_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mail_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_mail_messages_assignee FOREIGN KEY (assigned_to_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id INT NOT NULL,
  kind VARCHAR(5) NOT NULL DEFAULT 'to',
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NULL,
  user_id INT NULL,
  KEY idx_mail_recipients_message (message_id),
  CONSTRAINT fk_mail_recipients_message FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_mail_recipients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id INT NOT NULL,
  document_key VARCHAR(120) NULL,
  file_name VARCHAR(300) NOT NULL,
  file_url VARCHAR(500) NULL,
  size_kb INT NULL,
  KEY idx_mail_attachments_message (message_id),
  CONSTRAINT fk_mail_attachments_message FOREIGN KEY (message_id) REFERENCES mail_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  subject VARCHAR(500) NULL,
  body TEXT NOT NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mail_templates_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_delivery_preferences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  pref_key VARCHAR(40) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  channels JSON NULL,
  digest_time VARCHAR(5) NULL,
  last_sent_on DATE NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notification_delivery_pref_user_key (user_id, pref_key),
  CONSTRAINT fk_notification_delivery_pref_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Starter e-mail templates (prototype v17 "Template & AI" list)
INSERT INTO mail_templates (name, subject, body, is_system, sort_order)
SELECT * FROM (
  SELECT 'Bid submission acknowledgement' AS name, 'Bid submission acknowledgement' AS subject,
         'Dear {{contact}},\n\nWe acknowledge the tender {{tender_no}} – {{title}}. Our submission will reach you before the deadline.\n\nRegards,\n{{sender}}' AS body, 1 AS is_system, 0 AS sort_order
  UNION ALL SELECT 'Quotation follow-up', 'Quotation follow-up',
         'Dear {{contact}},\n\nFollowing up on our quotation {{ref}} for {{title}} (value {{value}}). Happy to clarify anything.\n\nRegards,\n{{sender}}', 1, 1
  UNION ALL SELECT 'Meeting request', 'Meeting request',
         'Dear {{contact}},\n\nCould we meet this week to discuss {{title}}? I can come to your office.\n\nRegards,\n{{sender}}', 1, 2
  UNION ALL SELECT 'Thank you after visit', 'Thank you after visit',
         'Dear {{contact}},\n\nThank you for your time today. As discussed, I will share the technical proposal for {{title}} shortly.\n\nRegards,\n{{sender}}', 1, 3
) seed WHERE NOT EXISTS (SELECT 1 FROM mail_templates);

-- Sidebar: "Inbox & Notifications" in the Main group right after Dashboards (prototype v17 Home group)
UPDATE modules SET label = 'Inbox & Notifications', section = 'main', sort_order = 15 WHERE `key` = 'notifications';

-- Daily digest bookkeeping (for tables created before this column existed)
ALTER TABLE notification_delivery_preferences ADD COLUMN IF NOT EXISTS last_sent_on DATE NULL;
