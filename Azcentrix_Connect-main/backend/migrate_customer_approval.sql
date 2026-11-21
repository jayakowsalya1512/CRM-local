-- Migration: Customer approval workflow
-- Run this against every tenant database

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NULL;

-- Mark all existing customers as approved/active
-- (they were created before the approval workflow existed)
UPDATE customers
SET is_active = TRUE, approval_status = 'approved'
WHERE is_active = FALSE AND approval_status IS NULL;
