-- Bids & Tenders (prototype v17) – tenant database migration. Run once per tenant database.
-- The backend applies the same on startup (bid_service.ensure_schema_all_tenants); this file is for manual deployments.
-- Existing tables are reused unchanged except tender_consignees, which gains qty_share.

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
        KEY ix_workflow_record_stages_stage (stage_id, workflow),   -- FK index; also serves the per-stage counts
        CONSTRAINT fk_workflow_record_stages_stage FOREIGN KEY (stage_id) REFERENCES workflow_stages (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE tender_consignees ADD COLUMN IF NOT EXISTS qty_share VARCHAR(20) NULL;
CREATE TABLE IF NOT EXISTS bid_flows (
	workflow VARCHAR(40) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	is_default BOOL NOT NULL, 
	sort_order INTEGER NOT NULL, 
	is_active BOOL NOT NULL, 
	created_at DATETIME DEFAULT now(), 
	PRIMARY KEY (workflow)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_profiles (
	tender_id INTEGER NOT NULL, 
	flow VARCHAR(40), 
	category_id INTEGER, 
	location_id INTEGER, 
	oem_id INTEGER, 
	bid_validity_days INTEGER, 
	overhead_pct NUMERIC(6, 2), 
	contingency_pct NUMERIC(6, 2), 
	margin_pct NUMERIC(6, 2), 
	quoted_price NUMERIC(18, 2), 
	synced_at DATETIME, 
	synced_by INTEGER, 
	tech_cutoff_pct NUMERIC(6, 2), 
	pbg_pct NUMERIC(6, 2), 
	delivery_period VARCHAR(200), 
	ld_terms VARCHAR(300), 
	po_ack BOOL NOT NULL, 
	price_status VARCHAR(20), 
	price_request_id INTEGER, 
	stage_entered_at DATETIME, 
	pending_stage_id INTEGER, 
	approval_request_id INTEGER, 
	checklist JSON, 
	lost_reason VARCHAR(120), 
	lost_note TEXT, 
	reminders JSON, 
	updated_at DATETIME DEFAULT now(), 
	PRIMARY KEY (tender_id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_corrigenda (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	tender_id INTEGER NOT NULL, 
	number VARCHAR(80) NOT NULL, 
	description TEXT NOT NULL, 
	corr_date DATE NOT NULL, 
	created_by INTEGER, 
	created_at DATETIME DEFAULT now(), 
	PRIMARY KEY (id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_checklist_items (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	tender_id INTEGER NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	label VARCHAR(300) NOT NULL, 
	position INTEGER NOT NULL, 
	ok BOOL NOT NULL, 
	document_id VARCHAR(40), 
	document_name VARCHAR(300), 
	updated_by INTEGER, 
	updated_at DATETIME DEFAULT now(), 
	PRIMARY KEY (id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_tech_scores (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	tender_id INTEGER NOT NULL, 
	criterion VARCHAR(300) NOT NULL, 
	max_marks NUMERIC(8, 2) NOT NULL, 
	awarded NUMERIC(8, 2), 
	remark VARCHAR(500), 
	position INTEGER NOT NULL, 
	updated_by INTEGER, 
	updated_at DATETIME DEFAULT now(), 
	PRIMARY KEY (id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_competitor_prices (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	tender_id INTEGER NOT NULL, 
	competitor_id INTEGER NOT NULL, 
	amount NUMERIC(18, 2) NOT NULL, 
	created_by INTEGER, 
	created_at DATETIME DEFAULT now(), 
	updated_at DATETIME DEFAULT now(), 
	PRIMARY KEY (id), 
	CONSTRAINT uq_bid_competitor UNIQUE (tender_id, competitor_id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bid_negotiation_rounds (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	tender_id INTEGER NOT NULL, 
	round_no INTEGER NOT NULL, 
	our_price NUMERIC(18, 2) NOT NULL, 
	note TEXT, 
	created_by INTEGER, 
	created_at DATETIME DEFAULT now(), 
	PRIMARY KEY (id), 
	FOREIGN KEY(tender_id) REFERENCES tenders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE bid_profiles ADD COLUMN IF NOT EXISTS flow VARCHAR(40) NULL;

-- Tender & bid flows (prototype STDFLOW / FLSEED) – only where the flow's workflow doesn't exist yet. The default flow uses the key
-- 'tender'; if the platform already pushed a 'tender' workflow it is kept as the default flow.
INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
  SELECT 'tender', 1, 'std_tender', 'Tech → Commercial → RA → Award', 'Bids & Tenders defaults', NOW() FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'tender');
INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT * FROM (
  SELECT 'tender' AS workflow, 1 AS revision, 0 AS position, 'Tender Published' AS name, 'open' AS kind, 1 AS sla_days, 'None' AS gate, NULL AS owner_role, NULL AS checklist
  UNION ALL
  SELECT 'tender', 1, 1, 'Go / No-Go', 'open', 3, 'Approval', 'Sales Head', NULL
  UNION ALL
  SELECT 'tender', 1, 2, 'Document Purchase', 'open', 2, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 3, 'Pre-bid Meeting', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 4, 'Bid Preparation', 'open', 10, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 5, 'Technical Bid Submitted', 'open', 1, 'Checklist', 'Bid Manager', '["EMD furnished", "Tech bid uploaded", "Power of attorney attached"]'
  UNION ALL
  SELECT 'tender', 1, 6, 'Technical Evaluation', 'open', 15, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 7, 'Commercial Bid Opened', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 8, 'Reverse Auction', 'open', 2, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 9, 'Award / LOI', 'open', 7, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 10, 'Won', 'won', 0, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender', 1, 11, 'Lost', 'lost', 0, 'None', NULL, NULL
) s WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'tender');
INSERT INTO bid_flows (workflow, name, is_default, sort_order, is_active)
  SELECT 'tender', 'Tech → Commercial → RA → Award', 1, 0, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM bid_flows WHERE workflow = 'tender');
INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
  SELECT 'tender_tca', 1, 'std_tender_tca', 'Tech → Commercial → Award', 'Bids & Tenders defaults', NOW() FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'tender_tca');
INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT * FROM (
  SELECT 'tender_tca' AS workflow, 1 AS revision, 0 AS position, 'Tender Published' AS name, 'open' AS kind, 1 AS sla_days, 'None' AS gate, NULL AS owner_role, NULL AS checklist
  UNION ALL
  SELECT 'tender_tca', 1, 1, 'Go / No-Go', 'open', 3, 'Approval', 'Sales Head', NULL
  UNION ALL
  SELECT 'tender_tca', 1, 2, 'Document Purchase', 'open', 2, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 3, 'Bid Preparation', 'open', 10, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 4, 'Technical Bid Submitted', 'open', 1, 'Checklist', 'Bid Manager', '["EMD furnished", "Tech bid uploaded"]'
  UNION ALL
  SELECT 'tender_tca', 1, 5, 'Technical Evaluation', 'open', 15, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 6, 'Commercial Bid Opened', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 7, 'Award / LOI', 'open', 7, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 8, 'Won', 'won', 0, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_tca', 1, 9, 'Lost', 'lost', 0, 'None', NULL, NULL
) s WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'tender_tca');
INSERT INTO bid_flows (workflow, name, is_default, sort_order, is_active)
  SELECT 'tender_tca', 'Tech → Commercial → Award', 0, 1, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM bid_flows WHERE workflow = 'tender_tca');
INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
  SELECT 'tender_qcbs', 1, 'std_tender_qcbs', 'Two-cover · QCBS', 'Bids & Tenders defaults', NOW() FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'tender_qcbs');
INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT * FROM (
  SELECT 'tender_qcbs' AS workflow, 1 AS revision, 0 AS position, 'Tender Published' AS name, 'open' AS kind, 1 AS sla_days, 'None' AS gate, NULL AS owner_role, NULL AS checklist
  UNION ALL
  SELECT 'tender_qcbs', 1, 1, 'Go / No-Go', 'open', 3, 'Approval', 'Sales Head', NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 2, 'Bid Preparation', 'open', 10, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 3, 'Technical Bid Submitted', 'open', 1, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 4, 'Technical Evaluation (QCBS)', 'open', 20, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 5, 'Commercial Bid Opened', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 6, 'Combined Scoring', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 7, 'Award / LOI', 'open', 7, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 8, 'Won', 'won', 0, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_qcbs', 1, 9, 'Lost', 'lost', 0, 'None', NULL, NULL
) s WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'tender_qcbs');
INSERT INTO bid_flows (workflow, name, is_default, sort_order, is_active)
  SELECT 'tender_qcbs', 'Two-cover · QCBS', 0, 2, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM bid_flows WHERE workflow = 'tender_qcbs');
INSERT INTO workflow_definitions (workflow, revision, template_key, template_name, applied_by, applied_at)
  SELECT 'tender_gem', 1, 'std_tender_gem', 'Single-cover · GeM / e-procurement', 'Bids & Tenders defaults', NOW() FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM workflow_definitions WHERE workflow = 'tender_gem');
INSERT INTO workflow_stages (workflow, revision, position, name, kind, sla_days, gate, owner_role, checklist)
SELECT * FROM (
  SELECT 'tender_gem' AS workflow, 1 AS revision, 0 AS position, 'Tender Published' AS name, 'open' AS kind, 1 AS sla_days, 'None' AS gate, NULL AS owner_role, NULL AS checklist
  UNION ALL
  SELECT 'tender_gem', 1, 1, 'Go / No-Go', 'open', 2, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 2, 'Bid Preparation', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 3, 'Bid Submitted', 'open', 1, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 4, 'Evaluation', 'open', 10, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 5, 'Award / LOI', 'open', 5, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 6, 'Won', 'won', 0, 'None', NULL, NULL
  UNION ALL
  SELECT 'tender_gem', 1, 7, 'Lost', 'lost', 0, 'None', NULL, NULL
) s WHERE NOT EXISTS (SELECT 1 FROM workflow_stages WHERE workflow = 'tender_gem');
INSERT INTO bid_flows (workflow, name, is_default, sort_order, is_active)
  SELECT 'tender_gem', 'Single-cover · GeM / e-procurement', 0, 3, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM bid_flows WHERE workflow = 'tender_gem');

-- Bids & Tenders settings (defaults, checklists, technical criteria) – editable from /api/v1/bids/config/settings.
INSERT INTO settings (`key`, value, type, category, label, description)
  SELECT 'bids_config', '{"gst_pct": 18, "emd_default_pct": 2, "overhead_pct": 8, "contingency_pct": 2, "margin_pct": 12, "cutoff_pct": 70, "pbg_pct": 5, "bid_validity_days": 120, "reminder_days": [7, 3, 1], "emd_alert_days": 30, "auto_advance": true, "block_submission_on_gaps": true, "eligibility": ["Average annual turnover \u2265 30% of the estimate (last 3 FY)", "Similar work executed worth \u2265 40% of estimate", "Valid OEM authorisation for main equipment", "No debarment / blacklisting declaration", "Valid GST and PAN registration"], "documents": ["Tender fee receipt", "EMD / BG", "Power of attorney", "Technical compliance sheet", "Price schedule (BoQ)", "Integrity pact"], "tech_criteria": [["Prior experience in similar works", 20], ["Financial turnover & net worth", 15], ["Technical compliance matrix", 25], ["OEM authorisation & MAF", 10], ["Project team & methodology", 15], ["Delivery & commissioning schedule", 10], ["Quality certifications (ISO / BIS)", 5]]}', 'json', 'tenders', 'Bids & Tenders settings', 'Defaults, checklists and evaluation criteria for Bids & Tenders' FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM settings WHERE `key` = 'bids_config');

-- Existing tenders get the default flow and a stage automatically the first time Bids & Tenders lists them
-- (won / lost results, legacy status and step).
