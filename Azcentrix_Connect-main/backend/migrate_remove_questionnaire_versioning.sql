-- Migration: Remove questionnaire versioning (version_no / questionnaire_version)
-- Run this on EACH tenant database (e.g. digitcrm_<slug>)
-- Example: mysql -u root -p digitcrm_yourslug < migrate_remove_questionnaire_versioning.sql
--
-- Safe to run even if a tenant DB has no customer_questionnaires rows yet;
-- MySQL will simply drop the (now-redundant) version columns/constraint.
--
-- If a tenant ever used "New Version" and a customer has answer rows against
-- more than one version of the same questionnaire, the ADD UNIQUE KEY below
-- will fail with a duplicate-entry error (the whole ALTER TABLE statement is
-- atomic, so nothing is left half-applied). In that case, first decide which
-- customer_questionnaires row per (customer_id, questionnaire_id) to keep and
-- delete/merge the others before re-running this script.

ALTER TABLE `questionnaires`
  DROP COLUMN `version_no`;

ALTER TABLE `customer_questionnaires`
  DROP INDEX `uq_customer_questionnaire_version`,
  DROP COLUMN `questionnaire_version`,
  ADD UNIQUE KEY `uq_customer_questionnaire` (`customer_id`, `questionnaire_id`);
