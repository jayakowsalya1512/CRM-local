-- Migration: Add no_of_consignee column to tenders table
-- Run this on EACH tenant database (e.g. digitcrm_<slug>)
-- Example: mysql -u root -p digitcrm_yourslug < migrate_no_of_consignee.sql

ALTER TABLE `tenders`
  ADD COLUMN IF NOT EXISTS `no_of_consignee` INT NULL
  COMMENT 'Number of consignees for PO';
