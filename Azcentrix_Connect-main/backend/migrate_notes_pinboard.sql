-- Notes & Pinboard (prototype v17) – run against EACH tenant database.
-- The backend applies this automatically on startup (app.routers.notes_router.ensure_notes_schema_all_tenants)
-- and seeds the sidebar module (tenant_module_service); this script is for manual / DBA-controlled deployments.
-- Notes live in the existing sticky_notes table (also used by the Quick note and the note reminders). Idempotent.

ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_module VARCHAR(30) NULL;
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_record_id INT NULL;
ALTER TABLE sticky_notes ADD COLUMN IF NOT EXISTS link_label VARCHAR(300) NULL;
CREATE INDEX IF NOT EXISTS idx_sticky_notes_user_pin ON sticky_notes (user_id, pinned, updated_at);

-- Sidebar: "Notes & Pinboard" in the Main group after Calendar & Tasks (personal notes: no permission key)
INSERT INTO modules (`key`, label, icon, route, section, sort_order, parent_key, permission_key, is_active, is_system)
SELECT 'notes', 'Notes & Pinboard', 'StickyNote', '/notes', 'main', 17, NULL, NULL, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE `key` = 'notes');
