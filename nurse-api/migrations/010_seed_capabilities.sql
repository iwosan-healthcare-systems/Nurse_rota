-- Seed / update the canonical capabilities matrix in portal_settings.
-- Running this again is safe (ON CONFLICT replaces the value).
INSERT INTO portal_settings (key, value)
VALUES (
  'capabilities',
  '[
    {"key":"view_dashboard",        "roles":["admin","cno","chief_matron","head_nurse","hr_admin","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"view_rota",             "roles":["admin","cno","chief_matron","head_nurse","hr_admin","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"edit_rota",             "roles":["admin","chief_matron","head_nurse"]},
    {"key":"auto_generate",         "roles":["admin","head_nurse"]},
    {"key":"manage_staff",          "roles":["admin","hr_admin"]},
    {"key":"delete_staff",          "roles":["admin"]},
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
    {"key":"print_staff_list",      "roles":["admin","cno","chief_matron","head_nurse","hr_admin"]},
    {"key":"print_schedule",        "roles":["admin","cno","chief_matron","head_nurse","hr_admin"]},
    {"key":"view_reports",          "roles":["admin","cno","chief_matron","head_nurse","hr_admin"]},
    {"key":"view_audit",            "roles":["admin"]},
    {"key":"manage_roles",          "roles":["admin"]},
    {"key":"request_locum",         "roles":["admin","chief_matron"]},
    {"key":"approve_locum",         "roles":["admin","cno"]},
    {"key":"send_locum_invites",    "roles":["admin","chief_matron"]},
    {"key":"respond_locum_invite",  "roles":["admin","cno","chief_matron","head_nurse","nurse","surgical_nurse","porter","nursing_assistant"]},
    {"key":"view_locum_hours",      "roles":["admin","cno","chief_matron","hr_admin"]},
    {"key":"view_locum_requests",   "roles":["admin","cno","chief_matron","head_nurse"]}
  ]'::jsonb
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
