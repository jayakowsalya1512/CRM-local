-- Leads (prototype v17) – run against EACH tenant database.
-- The backend creates these automatically on startup (app.services.lead360_service.ensure_schema_all_tenants);
-- this script is for manual / DBA-controlled deployments. The existing leads / lead_products / lead_sources /
-- products / customers / customer_contacts tables are NOT changed and no master data is copied. Idempotent.

-- "Contact person" chosen from the customer's contacts (the lead row still keeps contact_person / mobile / email).
CREATE TABLE IF NOT EXISTS lead_contact_links (
  lead_id INT NOT NULL PRIMARY KEY,
  contact_id INT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_lead_contact_links_contact_id (contact_id),
  CONSTRAINT fk_lead_contact_links_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_contact_links_contact FOREIGN KEY (contact_id) REFERENCES customer_contacts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Drawer → Notes tab (@mentions notify the mentioned users).
CREATE TABLE IF NOT EXISTS lead_notes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  body TEXT NOT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY ix_lead_notes_lead_id (lead_id),
  CONSTRAINT fk_lead_notes_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_notes_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Lead scoring rules (tenant setting, editable as JSON). source_points is keyed by lead_sources.id;
-- stage_points by lead workflow status. hot_threshold drives the "Hot (score ≥ N)" saved view.
INSERT INTO settings (`key`, `value`, `type`, `category`, `label`, `description`)
SELECT 'lead_scoring_rules',
       '{"base": 20, "value_bands": [[10000000, 25], [1000000, 15], [1, 5]], "customer_linked": 10, "contact_linked": 10, "source_points": {}, "follow_up_set": 10, "follow_up_overdue": -10, "activity_points": 5, "activity_cap": 15, "activity_days": 30, "stage_points": {"Qualified": 10, "Opportunity Created": 20, "Converted": 25, "Lost": -100}, "hot_threshold": 75, "high_value": 10000000}',
       'json', 'leads', 'Lead scoring rules',
       'Points used for the lead score (0-99): base, value bands, linked customer / contact, source points by lead-source id, follow-up, recent activity and stage. hot_threshold drives the Hot view.'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE `key` = 'lead_scoring_rules');

-- Lost reasons offered when a lead moves to a lost stage (prototype "Lost reasons"); required = a reason must be chosen.
INSERT INTO settings (`key`, `value`, `type`, `category`, `label`, `description`)
SELECT 'lead_lost_reasons', '{"required": true, "reasons": ["Price", "Technical", "Eligibility", "Delivery", "Relationship"]}',
       'json', 'leads', 'Lead lost reasons', 'Reasons offered when a lead is moved to a lost stage; required = a reason must be chosen.'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE `key` = 'lead_lost_reasons');

-- Lead workflow stages (prototype v17 board): New · Contacted · Qualified · Proposal Pending · Nurturing · Converted · Disqualified.
-- Additive: Contacted / Proposal Pending / Nurturing are added; the existing values stay (New = Assigned,
-- Converted = Opportunity Created + Converted, Disqualified = Lost) so Deals, reports and dashboards are unchanged.
-- The backend applies this on startup (lead360_service._ensure_status_enum); no rows are modified.
ALTER TABLE leads MODIFY COLUMN status
  ENUM('Assigned','Contacted','Qualified','Proposal Pending','Nurturing','Opportunity Created','Converted','Lost')
  NOT NULL DEFAULT 'Assigned';
