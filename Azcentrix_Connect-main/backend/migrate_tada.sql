-- Migration: TA/DA module — add missing columns and tables
-- Run this against every tenant database
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS checks)

-- ── 1. tada_claims: add all columns that may be missing ──────────────────────
ALTER TABLE tada_claims
  ADD COLUMN IF NOT EXISTS `claim_type`               VARCHAR(50)   DEFAULT 'travel'    AFTER `claim_date`,
  ADD COLUMN IF NOT EXISTS `travel_date_from`         DATE                               AFTER `claim_type`,
  ADD COLUMN IF NOT EXISTS `travel_date_to`           DATE                               AFTER `travel_date_from`,
  ADD COLUMN IF NOT EXISTS `num_days`                 INT                                AFTER `travel_date_to`,
  ADD COLUMN IF NOT EXISTS `from_city`                VARCHAR(100)                       AFTER `num_days`,
  ADD COLUMN IF NOT EXISTS `to_city`                  VARCHAR(100)                       AFTER `from_city`,
  ADD COLUMN IF NOT EXISTS `purpose`                  VARCHAR(500)                       AFTER `to_city`,
  ADD COLUMN IF NOT EXISTS `mode_of_travel`           VARCHAR(100)                       AFTER `purpose`,
  ADD COLUMN IF NOT EXISTS `da_rate_per_day`          DECIMAL(10,2)                      AFTER `mode_of_travel`,
  ADD COLUMN IF NOT EXISTS `da_total`                 DECIMAL(12,2)                      AFTER `da_rate_per_day`,
  ADD COLUMN IF NOT EXISTS `expense_mode`             VARCHAR(50)                        AFTER `da_total`,
  ADD COLUMN IF NOT EXISTS `cost_center`              VARCHAR(100)                       AFTER `expense_mode`,
  ADD COLUMN IF NOT EXISTS `budget_code`              VARCHAR(100)                       AFTER `cost_center`,
  ADD COLUMN IF NOT EXISTS `department`               VARCHAR(100)                       AFTER `budget_code`,
  ADD COLUMN IF NOT EXISTS `manager_rejection_reason` TEXT                               AFTER `manager_approved_at`,
  ADD COLUMN IF NOT EXISTS `accounts_status`          ENUM('pending','approved','rejected','paid') DEFAULT 'pending' AFTER `manager_rejection_reason`,
  ADD COLUMN IF NOT EXISTS `accounts_approval_id`     INT                                AFTER `accounts_status`,
  ADD COLUMN IF NOT EXISTS `accounts_approved_by`     INT                                AFTER `accounts_approval_id`,
  ADD COLUMN IF NOT EXISTS `accounts_approved_at`     DATETIME                           AFTER `accounts_approved_by`,
  ADD COLUMN IF NOT EXISTS `accounts_rejection_reason` TEXT                              AFTER `accounts_approved_at`,
  ADD COLUMN IF NOT EXISTS `payment_date`             DATE                               AFTER `accounts_rejection_reason`,
  ADD COLUMN IF NOT EXISTS `payment_reference`        VARCHAR(100)                       AFTER `payment_date`,
  ADD COLUMN IF NOT EXISTS `payment_mode`             ENUM('Bank Transfer','Cheque','Cash','UPI') AFTER `payment_reference`;

-- ── 2. tada_line_items: fix category enum to include space variants ───────────
-- MySQL requires modifying the whole column definition to change ENUM values
ALTER TABLE tada_line_items
  MODIFY COLUMN `category` ENUM(
    'Transport Fare','Auto/Cab','Auto / Cab','Fuel','Accommodation',
    'Meals','Daily Allowance','Communication',
    'Toll/Parking','Toll / Parking','Visa/Passport','Miscellaneous'
  ) NOT NULL;

-- ── 3. activity_logs: add icon/color columns if missing (needed for TA/DA save) ─
ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS `icon`  VARCHAR(10)  DEFAULT '📌'      AFTER `description`,
  ADD COLUMN IF NOT EXISTS `color` VARCHAR(20)  DEFAULT '#EFF6FF' AFTER `icon`;

-- ── 4. tada_attachments: create table if it doesn't exist ────────────────────
CREATE TABLE IF NOT EXISTS `tada_attachments` (
  `id`           INT          AUTO_INCREMENT PRIMARY KEY,
  `claim_id`     INT          NOT NULL,
  `line_item_id` INT          NULL COMMENT 'FK to tada_line_items — NULL = claim-level (legacy)',
  `file_name`    VARCHAR(300) NOT NULL,
  `file_url`     VARCHAR(500) NOT NULL COMMENT 'Relative path: /media/tada_attachments/<uuid>.<ext>',
  `file_size_kb` INT          NULL,
  `doc_type`     VARCHAR(100) NOT NULL DEFAULT 'Receipt' COMMENT 'Receipt | Invoice | Ticket | Hotel Bill | Other',
  `uploaded_by`  INT          NULL,
  `created_at`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`claim_id`)     REFERENCES `tada_claims`(`id`)      ON DELETE CASCADE,
  FOREIGN KEY (`line_item_id`) REFERENCES `tada_line_items`(`id`)  ON DELETE CASCADE,
  FOREIGN KEY (`uploaded_by`)  REFERENCES `users`(`id`)            ON DELETE SET NULL,
  INDEX `idx_tada_att_claim`    (`claim_id`),
  INDEX `idx_tada_att_lineitem` (`line_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
