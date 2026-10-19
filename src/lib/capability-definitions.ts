import type { AppRole, SystemRole } from "@/lib/auth-context";

// Used only as the default "everyone" role list for capabilities that have no
// DB entry yet — the tag-assignment UI's actual role list comes from the
// dynamic role registry (useAuth().allRoles), minus admin (see below).
export const SYSTEM_ROLES: SystemRole[] = [
  "admin",
  "cno",
  "chief_matron",
  "head_nurse",
  "hr_admin",
  "service_support",
  "nurse",
  "surgical_nurse",
  "porter",
  "nursing_assistant",
];

export type Capability = { key: string; label: string; roles: AppRole[] };

// The permission catalogue and its built-in role lists, shared by the
// Permissions settings and new-hospital setup.
export const DEFAULT_CAPABILITIES: Capability[] = [
  { key: "view_dashboard", label: "View Dashboard", roles: SYSTEM_ROLES },
  { key: "view_rota", label: "View Rota", roles: SYSTEM_ROLES },
  {
    key: "edit_rota",
    label: "Edit Rota (manual cell changes)",
    roles: ["admin", "head_nurse"],
  },
  {
    key: "auto_generate",
    label: "Manually Trigger Rota Generation (normally automatic at T-19)",
    roles: ["admin"],
  },
  {
    key: "manage_staff",
    label: "Manage Staff (create / edit)",
    roles: ["admin", "hr_admin"],
  },
  { key: "delete_staff", label: "Delete Staff", roles: ["admin", "hr_admin"] },
  { key: "edit_target_hours", label: "Set Staff Target Hours", roles: ["admin", "cno"] },
  {
    key: "manage_wards",
    label: "Manage Wards & Staffing Ratios",
    roles: ["admin", "cno"],
  },
  {
    key: "request_leave",
    label: "Request Leave",
    roles: [
      "admin",
      "chief_matron",
      "head_nurse",
      "nurse",
      "surgical_nurse",
      "porter",
      "nursing_assistant",
    ],
  },
  {
    key: "approve_leave",
    label: "Approve / Reject Leave",
    roles: ["admin", "chief_matron"],
  },
  {
    key: "approve_matron_leave",
    label: "Approve / Reject Matron's Leave",
    roles: ["admin", "cno"],
  },
  {
    key: "request_shift_switch",
    label: "Request Shift Switch (Chief Matron initiates)",
    roles: ["admin", "chief_matron"],
  },
  {
    key: "approve_shift_switch",
    label: "Approve / Reject Shift Switch (CNO approves)",
    roles: ["admin", "cno"],
  },
  {
    key: "submit_approval",
    label: "Submit Rota for Approval",
    roles: ["admin", "head_nurse"],
  },
  { key: "approve_rota", label: "Approve Rota (CNO review step)", roles: ["admin", "cno"] },
  { key: "publish_rota", label: "Publish Rota", roles: ["admin", "cno"] },
  { key: "revert_published", label: "Revert Published Rota to Draft", roles: ["admin"] },
  {
    key: "request_rota_edit_access",
    label: "Request Rota Edit Access (Head Nurse)",
    roles: ["admin", "head_nurse"],
  },
  {
    key: "grant_rota_edit_access",
    label: "Grant / Decline Rota Edit Access Requests (CNO)",
    roles: ["admin", "cno"],
  },
  {
    key: "manage_leave_entitlements",
    label: "Adjust Leave Entitlements (manual credit for pre-system leave)",
    roles: ["admin", "hr_admin"],
  },
  {
    key: "manage_leave_entitlement_caps",
    label: "Change Leave Entitlement Caps (per individual or job role)",
    roles: ["admin"],
  },
  {
    key: "view_all_leave_requests",
    label: "View All Leave & Shift-Switch Requests (not just own)",
    roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "service_support"],
  },
  { key: "download_rota", label: "Download Published Rota (Excel / PDF)", roles: SYSTEM_ROLES },
  {
    key: "print_staff_list",
    label: "Print Staff Directory (by facility / ward)",
    roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "service_support"],
  },
  {
    key: "print_schedule",
    label: "Print / Download Published Schedule",
    roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "service_support"],
  },
  {
    key: "view_reports",
    label: "View Reports",
    roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin", "service_support"],
  },
  { key: "view_audit", label: "View Audit Log", roles: ["admin", "service_support"] },
  { key: "manage_roles", label: "Assign / Revoke Roles", roles: ["admin", "service_support"] },
  {
    key: "view_scheduling_configuration",
    label: "View Scheduling Configuration",
    roles: ["admin", "cno", "chief_matron"],
  },
  {
    key: "manage_scheduling_configuration",
    label: "Manage Scheduling Configuration Drafts",
    roles: ["admin", "cno"],
  },
  {
    key: "request_locum",
    label: "Initiate Locum Shift Request",
    roles: ["admin", "chief_matron"],
  },
  {
    key: "approve_locum",
    label: "Approve / Decline Locum Request (CNO)",
    roles: ["admin", "cno"],
  },
  {
    key: "send_locum_invites",
    label: "Send Locum Invites to OFF Nurses",
    roles: ["admin", "chief_matron"],
  },
  {
    key: "respond_locum_invite",
    label: "Accept / Decline a Locum Invite (Nurse)",
    roles: SYSTEM_ROLES,
  },
  {
    key: "view_locum_hours",
    label: "View Locum Hours Tracking",
    roles: ["admin", "cno", "chief_matron", "hr_admin"],
  },
  {
    key: "view_locum_requests",
    label: "View Locum Request Status",
    roles: ["admin", "cno", "chief_matron", "head_nurse"],
  },
  {
    key: "view_audit_logs",
    label: "View Audit Logs (API)",
    roles: ["admin", "cno", "service_support"],
  },
  {
    key: "manage_users",
    label: "Manage User Accounts (create / ban / reset password)",
    roles: ["admin", "cno", "service_support"],
  },
  { key: "delete_user_account", label: "Delete User Account", roles: ["admin"] },
  { key: "edit_user_profile", label: "Edit User Profile (name / email)", roles: ["admin", "cno"] },
  { key: "bulk_create_users", label: "Bulk-Create Logins from Staff List", roles: ["admin"] },
  {
    key: "review_locum_request",
    label: "Review Locum Request (CNO approve/decline)",
    roles: ["admin", "cno", "chief_matron"],
  },
  {
    key: "view_profiles",
    label: "View User Profiles List",
    roles: ["admin", "cno", "chief_matron", "hr_admin"],
  },
  {
    key: "manage_rota_periods",
    label: "Manage Rota Periods (auto-end / auto-close)",
    roles: ["admin", "cno"],
  },
  {
    key: "manage_period_hours",
    label: "Manage Period Hours Archive",
    roles: ["admin", "cno", "hr_admin"],
  },
  {
    key: "manage_shift_logs",
    label: "Bulk-Manage Shift Logs",
    roles: ["admin", "cno", "chief_matron", "hr_admin"],
  },
  {
    key: "edit_nurse_record",
    label: "Edit Individual Staff Record",
    roles: ["admin", "hr_admin", "head_nurse"],
  },
  {
    key: "rotate_interns",
    label: "Rotate Interns Between Wards",
    roles: ["admin", "cno", "chief_matron"],
  },
  {
    key: "view_user_roles",
    label: "View User Role Assignments",
    roles: ["admin", "cno", "hr_admin", "service_support"],
  },
  {
    key: "manage_user_roles",
    label: "Grant / Revoke User Roles",
    roles: ["admin", "cno", "service_support"],
  },
  {
    key: "edit_shift_assignments",
    label: "Create / Delete Individual Shift Cells",
    roles: ["admin", "head_nurse"],
  },
  {
    key: "manage_shift_assignments",
    label: "Bulk-Manage Shift Assignments",
    roles: ["admin", "cno", "head_nurse", "hr_admin"],
  },
];
