-- Service Support (and HR Admin — bundled the same way as print_staff_list/
-- print_schedule/view_reports already are) could not see the full Leave &
-- Requests list: /leave's "see everything" gate was driven purely by the
-- *approval* capabilities (approve_leave, approve_shift_switch,
-- approve_matron_leave), so a role that should only ever VIEW leave/switch
-- requests (not approve them) had no way to see them at all — only its own.
-- New view_all_leave_requests capability separates visibility from approval
-- power.
--
-- Unlike the earlier 010/023/026 capability-seed migrations, this does NOT
-- replace the whole portal_settings.capabilities blob wholesale — since
-- admins can now customize the capability→role matrix via the Permissions UI
-- (custom system roles), a wholesale replace here would silently discard any
-- of those customizations. Instead this only APPENDS the new key if it isn't
-- already present, leaving every existing entry (customized or not) untouched.
UPDATE portal_settings
SET value = value || '[{"key":"view_all_leave_requests","roles":["admin","cno","chief_matron","head_nurse","hr_admin","service_support"]}]'::jsonb
WHERE key = 'capabilities'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value) elem WHERE elem->>'key' = 'view_all_leave_requests'
  );
