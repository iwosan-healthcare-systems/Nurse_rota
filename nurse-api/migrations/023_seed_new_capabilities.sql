-- Extends the capabilities matrix (see 010_seed_capabilities.sql) with the 16
-- new keys introduced when the backend's 36 hardcoded requireRole(...) calls
-- were migrated to the new requireCapability(...) middleware (see
-- nurse-api/middleware/capability.js and src/routes/_app/permissions.tsx).
-- Also fixes two pre-existing inconsistencies found during that migration:
--   - delete_staff was [admin] only, but the backend endpoint it now gates
--     (DELETE /nurses/:id) has always actually allowed hr_admin too — widened
--     to match real existing access rather than newly restricting it.
--   - print_staff_list / print_schedule / view_reports were missing
--     service_support here, even though the frontend's own cap() fallback
--     defaults and permissions.tsx's DEFAULT_CAPABILITIES already included
--     it — this DB seed was simply stale. Added to match.
-- Running this again is safe (ON CONFLICT replaces the value), same as 010.
INSERT INTO portal_settings (key, value)
VALUES (
  'capabilities',
  '[
    {"key":"view_dashboard",        "roles":["admin","cno","chief_matron","head_nurse","hr_admin","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"view_rota",             "roles":["admin","cno","chief_matron","head_nurse","hr_admin","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"edit_rota",             "roles":["admin","chief_matron","head_nurse"]},
    {"key":"auto_generate",         "roles":["admin","head_nurse"]},
    {"key":"manage_staff",          "roles":["admin","hr_admin"]},
    {"key":"delete_staff",          "roles":["admin","hr_admin"]},
    {"key":"edit_target_hours",     "roles":["admin","cno"]},
    {"key":"manage_wards",          "roles":["admin","cno"]},
    {"key":"request_leave",         "roles":["admin","chief_matron","head_nurse","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"approve_leave",         "roles":["admin","chief_matron"]},
    {"key":"approve_matron_leave",  "roles":["admin","cno"]},
    {"key":"request_shift_switch",  "roles":["admin","chief_matron"]},
    {"key":"approve_shift_switch",  "roles":["admin","cno"]},
    {"key":"submit_approval",       "roles":["admin","head_nurse"]},
    {"key":"approve_chief_matron",  "roles":["admin","chief_matron"]},
    {"key":"approve_cno",           "roles":["admin","cno"]},
    {"key":"publish_rota",          "roles":["admin","cno"]},
    {"key":"revert_published",      "roles":["admin"]},
    {"key":"download_rota",         "roles":["admin","cno","chief_matron","head_nurse","hr_admin","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"print_staff_list",      "roles":["admin","cno","chief_matron","head_nurse","hr_admin","service_support"]},
    {"key":"print_schedule",        "roles":["admin","cno","chief_matron","head_nurse","hr_admin","service_support"]},
    {"key":"view_reports",          "roles":["admin","cno","chief_matron","head_nurse","hr_admin","service_support"]},
    {"key":"view_audit",            "roles":["admin"]},
    {"key":"manage_roles",          "roles":["admin"]},
    {"key":"request_locum",         "roles":["admin","chief_matron"]},
    {"key":"approve_locum",         "roles":["admin","cno"]},
    {"key":"send_locum_invites",    "roles":["admin","chief_matron"]},
    {"key":"respond_locum_invite",  "roles":["admin","cno","chief_matron","head_nurse","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"view_locum_hours",      "roles":["admin","cno","chief_matron","hr_admin"]},
    {"key":"view_locum_requests",   "roles":["admin","cno","chief_matron","head_nurse"]},

    {"key":"view_audit_logs",         "roles":["admin","cno","service_support"]},
    {"key":"manage_users",            "roles":["admin","cno","service_support"]},
    {"key":"delete_user_account",     "roles":["admin"]},
    {"key":"edit_user_profile",       "roles":["admin","cno"]},
    {"key":"bulk_create_users",       "roles":["admin"]},
    {"key":"review_locum_request",    "roles":["admin","cno","chief_matron"]},
    {"key":"view_profiles",           "roles":["admin","cno","chief_matron","hr_admin"]},
    {"key":"manage_rota_periods",     "roles":["admin","cno"]},
    {"key":"manage_period_hours",     "roles":["admin","cno","hr_admin"]},
    {"key":"manage_shift_logs",       "roles":["admin","cno","chief_matron","hr_admin"]},
    {"key":"edit_nurse_record",       "roles":["admin","hr_admin","head_nurse"]},
    {"key":"rotate_interns",          "roles":["admin","cno","chief_matron"]},
    {"key":"view_user_roles",         "roles":["admin","cno","hr_admin","service_support"]},
    {"key":"manage_user_roles",       "roles":["admin","cno","service_support"]},
    {"key":"edit_shift_assignments",  "roles":["admin","head_nurse"]},
    {"key":"manage_shift_assignments","roles":["admin","cno","chief_matron","head_nurse","hr_admin"]}
  ]'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
