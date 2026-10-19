const { policyAt } = require("./scheduling-policy");
const { zonedInstant, validDate } = require("./configured-scheduler");

const LEGACY = {
  timezone: "Africa/Lagos",
  shifts: [
    { code: "M", name: "Morning", start: "08:00" },
    { code: "N", name: "Night", start: "17:00" },
  ],
};

// Locum duties follow the shift definitions of the activated configuration that
// governs the date; facilities without one keep the legacy Morning/Night pair.
async function locumShiftOptions(db, facilityName, date) {
  if (!validDate(date)) {
    const error = new Error("Use a valid shift date");
    error.status = 400;
    throw error;
  }
  let source = "legacy";
  let config = LEGACY;
  const {
    rows: [facility],
  } = await db.query("SELECT id FROM scheduling_facilities WHERE legacy_facility=$1", [
    facilityName,
  ]);
  const policy = facility ? await policyAt(db, facility.id, date) : null;
  if (policy?.state === "active") {
    const {
      rows: [run],
    } = await db.query("SELECT configuration_snapshot FROM scheduling_runs WHERE id=$1", [
      policy.source_run_id,
    ]);
    if (run?.configuration_snapshot?.shifts?.length) {
      source = "configured";
      config = run.configuration_snapshot;
    }
  }
  const shifts = [];
  for (const shift of config.shifts) {
    try {
      shifts.push({
        code: shift.code,
        name: shift.name,
        startsAt: new Date(zonedInstant(date, shift.start, config.timezone)).toISOString(),
      });
    } catch {
      // A start that does not exist on this date (e.g. a DST gap) cannot be requested.
    }
  }
  return { source, timezone: config.timezone, shifts };
}

module.exports = { locumShiftOptions };
