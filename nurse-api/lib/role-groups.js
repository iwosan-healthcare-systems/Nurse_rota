// Facility-wide scheduling groups (matron, head/coverage, porter, intern) for a
// staff role. An activated configuration's role approvalGroup is authoritative;
// facilities without one keep the legacy role-name matching.
const legacy = require("./auto-schedule.generated");

function legacyRoleGroup(role) {
  if (legacy.isMatron(role)) return "matron";
  if (legacy.isGlobalHead(role)) return "head";
  if (legacy.isPorterType(role)) return "porter";
  if (legacy.isInternType(role)) return "intern";
  return null;
}

function snapshotRoleGroups(configuration) {
  const groups = {};
  for (const role of configuration?.roles ?? [])
    groups[role.name.trim().toLowerCase()] =
      role.approvalGroup === "ward" ? null : role.approvalGroup;
  return groups;
}

// { [legacy facility name]: { [lowercased role name]: group|null } } for every
// facility whose configuration is active on `date`.
async function activeRoleGroups(db, date) {
  // Required lazily: scheduling-policy itself uses this module's resolvers.
  const { policyAt } = require("./scheduling-policy");
  const { rows: facilities } = await db.query(
    "SELECT id,legacy_facility FROM scheduling_facilities ORDER BY legacy_facility",
  );
  const result = {};
  for (const facility of facilities) {
    const policy = await policyAt(db, facility.id, date);
    if (policy?.state !== "active") continue;
    const {
      rows: [run],
    } = await db.query("SELECT configuration_snapshot FROM scheduling_runs WHERE id=$1", [
      policy.source_run_id,
    ]);
    if (run) result[facility.legacy_facility] = snapshotRoleGroups(run.configuration_snapshot);
  }
  return result;
}

function roleGroupResolver(groups) {
  return (role, facility) => {
    const configured = groups[facility];
    const key = String(role ?? "")
      .trim()
      .toLowerCase();
    if (configured && Object.hasOwn(configured, key)) return configured[key];
    return legacyRoleGroup(role);
  };
}

module.exports = { legacyRoleGroup, snapshotRoleGroups, activeRoleGroups, roleGroupResolver };
