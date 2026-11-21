-- Customers & Contacts – Customer 360 (prototype v17) – run against EACH tenant database.
-- The backend creates these tables automatically on startup
-- (app.services.customer360_service.ensure_schema_all_tenants); this script is for manual / DBA-controlled
-- deployments. The existing customers / customer_contacts tables are not changed. Idempotent.

CREATE TABLE IF NOT EXISTS customer_profiles (
  customer_id INT NOT NULL PRIMARY KEY,
  hierarchy_level VARCHAR(40) NULL,            -- Head Office | LHO / Regional Office | Zone | Divisional Office | Branch / Site
  kam_mode VARCHAR(30) NULL,                   -- Own KAM | Inherit from parent
  plan_goal TEXT NULL,                         -- Account plan: Goals this year
  plan_strategy TEXT NULL,                     --               Engagement strategy
  plan_risks TEXT NULL,                        --               Risks
  plan_white_space TEXT NULL,                  --               White-space opportunities
  plan_updated_by INT NULL,
  plan_updated_at DATETIME NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_profiles_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_profiles_user FOREIGN KEY (plan_updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS customer_contact_roles (
  contact_id INT NOT NULL PRIMARY KEY,
  customer_id INT NOT NULL,
  buying_role VARCHAR(30) NOT NULL,            -- Decision maker | Influencer | User | Gatekeeper
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_customer_contact_roles_customer_id (customer_id),
  CONSTRAINT fk_customer_contact_roles_contact FOREIGN KEY (contact_id) REFERENCES customer_contacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_contact_roles_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
