import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { useAuth, type AppRole, type SystemRole } from "@/lib/auth-context";
import { Check, X, ShieldAlert, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/permissions")({
  head: () => ({
    meta: [
      { title: "Permissions — Nurses Rota" },
      { name: "description", content: "Manage user roles and view the role permission matrix." },
    ],
  }),
  component: PermissionsPage,
});

// Used only as the default "everyone" role list for capabilities that have no
// DB entry yet — the table's actual displayed columns come from the dynamic
// role list (useAuth().allRoles) inside PermissionsPage. A newly created
// custom role starts with none of these either, until an admin explicitly
// grants it via the matrix — nothing here auto-includes custom roles.
const SYSTEM_ROLES: SystemRole[] = [
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

type Capability = { key: string; label: string; roles: AppRole[] };

const DEFAULT_CAPABILITIES: Capability[] = [
  { key: "view_dashboard", label: "View Dashboard", roles: SYSTEM_ROLES },
  { key: "view_rota", label: "View Rota", roles: SYSTEM_ROLES },
  {
    key: "edit_rota",
    label: "Edit Rota (manual cell changes)",
    roles: ["admin", "chief_matron", "head_nurse"],
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
  { key: "approve_rota", label: "Approve Rota (HR review step)", roles: ["admin", "hr_admin"] },
  { key: "publish_rota", label: "Publish Rota", roles: ["admin", "cno"] },
  { key: "revert_published", label: "Revert Published Rota to Draft", roles: ["admin"] },
  {
    key: "request_rota_edit_access",
    label: "Request Rota Edit Access (Head Nurse)",
    roles: ["admin", "head_nurse"],
  },
  {
    key: "grant_rota_edit_access",
    label: "Grant / Decline Rota Edit Access Requests (HR)",
    roles: ["admin", "hr_admin"],
  },
  {
    key: "manage_leave_entitlements",
    label: "Adjust Leave Entitlements (manual credit for pre-system leave)",
    roles: ["admin", "hr_admin"],
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
  { key: "respond_locum_invite", label: "Accept / Decline a Locum Invite (Nurse)", roles: SYSTEM_ROLES },
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
  { key: "view_audit_logs", label: "View Audit Logs (API)", roles: ["admin", "cno", "service_support"] },
  { key: "manage_users", label: "Manage User Accounts (create / ban / reset password)", roles: ["admin", "cno", "service_support"] },
  { key: "delete_user_account", label: "Delete User Account", roles: ["admin"] },
  { key: "edit_user_profile", label: "Edit User Profile (name / email)", roles: ["admin", "cno"] },
  { key: "bulk_create_users", label: "Bulk-Create Logins from Staff List", roles: ["admin"] },
  { key: "review_locum_request", label: "Review Locum Request (CNO approve/decline)", roles: ["admin", "cno", "chief_matron"] },
  { key: "view_profiles", label: "View User Profiles List", roles: ["admin", "cno", "chief_matron", "hr_admin"] },
  { key: "manage_rota_periods", label: "Manage Rota Periods (auto-end / auto-close)", roles: ["admin", "cno"] },
  { key: "manage_period_hours", label: "Manage Period Hours Archive", roles: ["admin", "cno", "hr_admin"] },
  { key: "manage_shift_logs", label: "Bulk-Manage Shift Logs", roles: ["admin", "cno", "chief_matron", "hr_admin"] },
  { key: "edit_nurse_record", label: "Edit Individual Staff Record", roles: ["admin", "hr_admin", "head_nurse"] },
  { key: "rotate_interns", label: "Rotate Interns Between Wards", roles: ["admin", "cno", "chief_matron"] },
  { key: "view_user_roles", label: "View User Role Assignments", roles: ["admin", "cno", "hr_admin", "service_support"] },
  { key: "manage_user_roles", label: "Grant / Revoke User Roles", roles: ["admin", "cno", "service_support"] },
  { key: "edit_shift_assignments", label: "Create / Delete Individual Shift Cells", roles: ["admin", "head_nurse"] },
  { key: "manage_shift_assignments", label: "Bulk-Manage Shift Assignments", roles: ["admin", "cno", "chief_matron", "head_nurse", "hr_admin"] },
];

const CAPABILITIES_CHANGED_EVENT = "capabilities-changed";

function mergeCapabilities(saved: { key: string; roles: AppRole[] }[]): Capability[] {
  return DEFAULT_CAPABILITIES.map((cap) => {
    const found = saved.find((s) => s.key === cap.key);
    return found ? { ...cap, roles: found.roles } : cap;
  });
}

function PermissionsPage() {
  const navigate = useNavigate();
  const { isAdmin, loading, allRoles, roleLabel } = useAuth();
  const ROLES = allRoles.map((r) => r.key);

  const [capabilities, setCapabilities] = useState<Capability[]>(DEFAULT_CAPABILITIES);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Capability[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && !isAdmin) navigate({ to: "/" });
  }, [loading, isAdmin, navigate]);

  useEffect(() => {
    api
      .get<{ key: string; value: { key: string; roles: AppRole[] }[] }>(
        "/portal-settings/capabilities",
      )
      .then(({ value }) => {
        if (value) setCapabilities(mergeCapabilities(value));
      })
      .catch(() => {
        /* non-critical */
      });
  }, []);

  function startEdit() {
    setDraft(capabilities.map((c) => ({ ...c, roles: [...c.roles] })));
    setEditing(true);
  }

  function cancelEdit() {
    setDraft([]);
    setEditing(false);
  }

  async function saveEdit() {
    const payload = draft.map((c) => ({ key: c.key, roles: c.roles }));
    setSaving(true);
    try {
      await api.put("/portal-settings/capabilities", { value: payload });
      window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
      setCapabilities(draft);
      setEditing(false);
      toast.success("Permissions saved");
    } catch (e: unknown) {
      toast.error("Failed to save: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  async function resetDefaults() {
    if (!confirm("Reset all capabilities to system defaults?")) return;
    setSaving(true);
    try {
      await api.put("/portal-settings/capabilities", { value: [] });
      window.dispatchEvent(new Event(CAPABILITIES_CHANGED_EVENT));
      setCapabilities(DEFAULT_CAPABILITIES);
      setDraft([]);
      setEditing(false);
      toast.success("Permissions reset to defaults");
    } catch (e: unknown) {
      toast.error("Failed to reset: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  function toggleRole(capKey: string, role: AppRole) {
    setDraft((prev) =>
      prev.map((cap) => {
        if (cap.key !== capKey) return cap;
        const has = cap.roles.includes(role);
        return { ...cap, roles: has ? cap.roles.filter((r) => r !== role) : [...cap.roles, role] };
      }),
    );
  }

  const activeCaps = editing ? draft : capabilities;

  if (!isAdmin) {
    return (
      <div className="py-20 text-center">
        <ShieldAlert className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">Administrator access required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Permissions" subtitle="Role capability matrix" />

      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Role capability matrix</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              What each role is allowed to do in the system.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={saving}
                  className="h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={resetDefaults}
                  disabled={saving}
                  title="Reset to defaults"
                  className="h-8 w-8 grid place-items-center rounded-md border bg-card hover:bg-muted text-muted-foreground disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={startEdit}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border bg-card text-xs hover:bg-muted"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
              </>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-3 font-medium sticky left-0 bg-muted/40 z-10">
                  Capability
                </th>
                {ROLES.map((r) => (
                  <th key={r} className="px-3 py-3 font-medium text-center whitespace-nowrap">
                    {roleLabel(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeCaps.map((cap) => (
                <tr key={cap.key} className="border-t">
                  <td className="px-4 py-2.5 font-medium sticky left-0 bg-card z-10">
                    {cap.label}
                  </td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-3 py-2.5 text-center">
                      {editing ? (
                        <label className="inline-grid place-items-center h-8 w-8 cursor-pointer">
                          <input
                            type="checkbox"
                            aria-label={`${cap.label} — ${roleLabel(r)}`}
                            checked={cap.roles.includes(r)}
                            onChange={() => toggleRole(cap.key, r)}
                            className="h-4 w-4 accent-primary cursor-pointer"
                          />
                        </label>
                      ) : cap.roles.includes(r) ? (
                        <Check className="h-4 w-4 text-emerald-600 inline" />
                      ) : (
                        <X className="h-4 w-4 text-muted-foreground/40 inline" />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing ? (
          <p className="px-5 py-3 border-t text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20">
            Editing mode — check or uncheck roles for each capability, then save.
          </p>
        ) : (
          <p className="px-5 py-3 border-t text-xs text-muted-foreground">
            Capabilities are enforced server-side. Changes here update the reference matrix.
          </p>
        )}
      </section>
    </div>
  );
}
