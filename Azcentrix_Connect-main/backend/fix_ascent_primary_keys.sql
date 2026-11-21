-- Repairs digitcrm_ascent: 16 tables lost PRIMARY KEY + AUTO_INCREMENT on `id`,
-- so new rows were inserted with id = 0 and /api/v1/alerts(/badge) returns 500
-- (StaleDataError: UPDATE expected 5 rows, 198 matched).
-- Only rows with id = 0 are renumbered (above the current MAX); other ids are unchanged.
-- Run once:  mysql -u <user> -p digitcrm_ascent < fix_ascent_primary_keys.sql

USE digitcrm_ascent;

-- 1) give the id = 0 rows unique ids
SET @n = (SELECT COALESCE(MAX(id), 0) FROM activity_logs);
UPDATE activity_logs SET id = (@n := @n + 1) WHERE id = 0;
SET @n = (SELECT COALESCE(MAX(id), 0) FROM alerts);
UPDATE alerts SET id = (@n := @n + 1) WHERE id = 0;
SET @n = (SELECT COALESCE(MAX(id), 0) FROM tada_line_items);
UPDATE tada_line_items SET id = (@n := @n + 1) WHERE id = 0;

-- 2) restore primary key + auto increment
ALTER TABLE activity_logs                  MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE alerts                         MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE alert_rules                    MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE api_logs                       MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approvals                      MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_auto_approve_settings MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_escalation_rules      MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_escalation_settings   MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_requests              MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_request_steps         MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_responses             MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_rule_steps            MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE approval_workflows             MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE tada_attachments               MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE tada_line_items                MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
ALTER TABLE tender_boq_items               MODIFY id INT(11) NOT NULL AUTO_INCREMENT, ADD PRIMARY KEY (id);
