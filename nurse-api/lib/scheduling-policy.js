// Facility policy shared by administrator requests and recurring generation.
const { UUID } = require("./scheduling-configuration");
const { validDate, addDays } = require("./configured-scheduler");
const { persistRotaDraft, DraftConflict } = require("./persist-rota-draft");
const legacy = require("./auto-schedule.generated");
const { snapshotRoleGroups, legacyRoleGroup } = require("./role-groups");
// Shift codes, times, credits and role groups are consumed from saved definitions
// throughout attendance, leave, approvals and reporting. Dates, rota periods and
// legacy fallbacks remain anchored to Africa/Lagos, so other timezones stay blocked.
function isLiveCompatible(config) {
  return config.timezone === "Africa/Lagos";
}

async function policyAt(db, facilityId, startDate) {
  const {
    rows: [policy],
  } = await db.query(
    "SELECT *,effective_from::text,period_anchor::text FROM scheduling_policy_events WHERE facility_id=$1 AND effective_from<=$2 ORDER BY sequence DESC LIMIT 1",
    [facilityId, startDate],
  );
  return policy ?? null;
}
function createPolicyService({
  pool,
  transaction,
  facilityFor,
  generateRun,
  fail,
  assertId,
  assertBody,
}) {
  async function event(db, userId, facilityId, state, runId, effective, anchor) {
    // Change the locked row so an already-started repeatable-read generator
    // cannot acquire the lock later and continue from an obsolete policy snapshot.
    await db.query(
      "UPDATE scheduling_facilities SET policy_revision=policy_revision+1 WHERE id=$1",
      [facilityId],
    );
    const {
      rows: [saved],
    } = await db.query(
      `INSERT INTO scheduling_policy_events(facility_id,sequence,state,source_run_id,effective_from,period_anchor,created_by)
      SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,$4,$5,$6 FROM scheduling_policy_events WHERE facility_id=$1 RETURNING *`,
      [facilityId, state, runId, effective, anchor, userId],
    );
    await db.query("INSERT INTO audit_logs(action,actor_id,target) VALUES($1,$2,$3)", [
      `Scheduling policy ${state}`,
      userId,
      `Facility ${facilityId}; event ${saved.id}; source ${runId ?? "none"}; from ${effective}`,
    ]);
    return saved;
  }
  async function activate(userId, facilityId, runId, body) {
    assertId(runId);
    assertBody(body, []);
    return transaction(
      async (db) => {
        const facility = await facilityFor(db, userId, facilityId, true);
        const {
          rows: [run],
        } = await db.query("SELECT * FROM scheduling_runs WHERE id=$1 AND facility_id=$2", [
          runId,
          facilityId,
        ]);
        if (!run) fail(404, "Saved run not found");
        if (!isLiveCompatible(run.configuration_snapshot))
          fail(422, "Only the Africa/Lagos timezone can be activated");
        const start = run.result_snapshot.startDate;
        const {
          rows: [clock],
        } = await db.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS today");
        if (start <= clock.today) fail(422, "Activation must begin in a future rota period");
        const {
          rows: [epoch],
        } = await db.query(
          "SELECT MIN(a.shift_date)::text AS anchor FROM shift_assignments a JOIN nurses n ON n.id=a.nurse_id WHERE n.facility=$1 AND a.status='published'",
          [facility.legacy_facility],
        );
        const previous = await db.query(
          "SELECT period_anchor::text FROM scheduling_policy_events WHERE facility_id=$1 AND state='active' ORDER BY sequence LIMIT 1",
          [facilityId],
        );
        const anchor = epoch.anchor ?? previous.rows[0]?.period_anchor ?? start;
        if (((Date.parse(start) - Date.parse(anchor)) / 86400000) % 28 !== 0)
          fail(422, "Choose a 28-day boundary aligned with the facility published rota");
        const existing = await db.query(
          "SELECT 1 FROM shift_assignments a JOIN nurses n ON n.id=a.nurse_id WHERE n.facility=$1 AND a.shift_date>=$2 LIMIT 1",
          [facility.legacy_facility, start],
        );
        if (existing.rows.length)
          fail(
            409,
            "Future assignments already exist. Choose a clean future period; activation does not replace schedules.",
          );
        const pending = await db.query(
          "SELECT 1 FROM leave_requests l JOIN nurses n ON n.id=l.nurse_id WHERE n.facility=$1 AND l.status='Pending' AND l.from_date<=$3 AND l.to_date>=$2 LIMIT 1",
          [facility.legacy_facility, start, addDays(start, 27)],
        );
        if (pending.rows.length) fail(409, "Resolve pending leave before activation");
        const fresh = await generateRun(
          userId,
          facilityId,
          run.configuration_id,
          {
            revision: run.configuration_revision,
            startDate: start,
            anchorDate: run.result_snapshot.anchorDate,
          },
          false,
          db,
        );
        if (fresh.inputFingerprint !== run.input_fingerprint)
          fail(409, "Inputs changed; save and review a new run before activation");
        if (fresh.hasBlockingIssues) fail(422, "Resolve preview issues before activation");
        return event(db, userId, facilityId, "active", runId, start, anchor);
      },
      false,
      true,
    );
  }
  async function generate(
    db,
    {
      userId,
      facility,
      startDate,
      unit = "all",
      nurseIds,
      dryRun = false,
      automatic = false,
      fromDate = null,
    },
  ) {
    const policy = await policyAt(db, facility.id, startDate);
    if (!policy) return null;
    if (policy.state === "paused")
      return { handled: true, skipped: true, reason: "Configured generation is paused" };
    if (((Date.parse(startDate) - Date.parse(policy.period_anchor)) / 86400000) % 28 !== 0)
      fail(422, "Generation must start at the activated facility rota boundary");
    const {
      rows: [source],
    } = await db.query("SELECT * FROM scheduling_runs WHERE id=$1 AND facility_id=$2", [
      policy.source_run_id,
      facility.id,
    ]);
    const { rows: nurses } = await db.query(
      "SELECT id,role,ward FROM nurses WHERE facility=$1 AND is_active=true ORDER BY id",
      [facility.legacy_facility],
    );
    // Units follow the activated configuration's role groups (legacy matching for unlisted roles).
    const snapshotGroups = snapshotRoleGroups(source.configuration_snapshot);
    const roleGroup = (n) => {
      const key = String(n.role ?? "")
        .trim()
        .toLowerCase();
      return Object.hasOwn(snapshotGroups, key) ? snapshotGroups[key] : legacyRoleGroup(n.role);
    };
    let selected = nurses;
    if (nurseIds) selected = nurses.filter((n) => nurseIds.includes(n.id));
    else if (unit.startsWith("ward:")) {
      const {
        rows: [ward],
      } = await db.query("SELECT name FROM wards WHERE id=$1 AND facility=$2", [
        unit.slice(5),
        facility.legacy_facility,
      ]);
      if (!ward) fail(404, "Ward not found");
      selected = nurses.filter((n) => !roleGroup(n) && legacy.parseWards(n.ward)[0] === ward.name);
    } else if (unit.startsWith("group:"))
      selected = nurses.filter((n) => roleGroup(n) === unit.slice(6));
    if (!selected.length) fail(422, "No active staff in this scheduling unit");
    // A mid-period addition writes only from the joining date; earlier dates of
    // the period belong to schedules already reviewed for everyone else.
    const ids = selected.map((n) => n.id),
      end = addDays(startDate, 27),
      first = fromDate ?? startDate;
    await db.query("SELECT id FROM nurses WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
    const { rows: existing } = await db.query(
      "SELECT status FROM shift_assignments WHERE nurse_id=ANY($1::uuid[]) AND shift_date BETWEEN $2 AND $3 FOR UPDATE",
      [ids, first, end],
    );
    if (automatic && existing.length)
      return { handled: true, skipped: true, reason: "Assignments already exist" };
    if (fromDate && existing.length)
      fail(409, "This staff member already has assignments from that date; edit them in Rota");
    if (existing.some((a) => a.status !== "draft"))
      fail(409, "This unit already has submitted, approved or published shifts");
    const pending = await db.query(
      "SELECT 1 FROM leave_requests WHERE nurse_id=ANY($1::uuid[]) AND status='Pending' AND from_date<=$3 AND to_date>=$2 LIMIT 1",
      [ids, first, end],
    );
    if (pending.rows.length) fail(409, "Resolve pending leave before configured generation");
    const version = {
      id: source.configuration_id,
      version: source.configuration_version,
      revision: source.configuration_revision,
      configuration: source.configuration_snapshot,
    };
    const result = await generateRun(
      userId,
      facility.id,
      version.id,
      { revision: version.revision, startDate, anchorDate: source.result_snapshot.anchorDate },
      !dryRun,
      db,
      { facility, version, automatic },
    );
    const selectedSet = new Set(ids),
      wardIds = new Set(result.staff.filter((n) => selectedSet.has(n.id)).map((n) => n.wardId));
    const blocking = result.diagnostics.filter(
      (d) =>
        d.severity === "error" &&
        (d.nurseId ? selectedSet.has(d.nurseId) : d.wardId ? wardIds.has(d.wardId) : true),
    );
    if (blocking.length)
      fail(422, "Configured generation has blocking issues; review a preview", blocking);
    if (dryRun)
      return {
        handled: true,
        dryRun: true,
        written: 0,
        assignments: result.assignments.filter((a) => selectedSet.has(a.nurseId) && a.date >= first)
          .length,
      };
    const wards = new Map(result.wardDefinitions.map((w) => [w.id, w.name]));
    const assignments = result.assignments
      .filter((a) => selectedSet.has(a.nurseId) && a.date >= first)
      .map((a) => ({
        nurse_id: a.nurseId,
        shift_date: a.date,
        shift: a.shift,
        ward: wards.get(a.wardId) ?? null,
        pre_leave_shift: a.shift === "LEAVE" ? a.plannedShift : null,
        leave_type: a.leaveType,
      }));
    let saved;
    try {
      saved = await persistRotaDraft(db, {
        nurseIds: ids,
        startDate: first,
        endDate: end,
        assignments,
        actorName: automatic ? "System (configured scheduling)" : "Configured scheduling",
        runId: result.runId,
        onlyIfEmpty: automatic,
      });
    } catch (error) {
      if (error instanceof DraftConflict) fail(409, error.message);
      throw error;
    }
    await db.query("INSERT INTO audit_logs(action,actor_id,target) VALUES($1,$2,$3)", [
      "Active configuration generated",
      userId ?? null,
      `Policy ${policy.id}; run ${result.runId}; ${saved.written} cells${fromDate ? `; staff addition from ${fromDate}` : ""}`,
    ]);
    return { ...saved, handled: true, runId: result.runId, policyId: policy.id };
  }
  return {
    activateRun: activate,
    async initialAutomaticPeriod(facilityName) {
      const {
        rows: [policy],
      } = await pool.query(
        `SELECT p.state,p.effective_from::text FROM scheduling_policy_events p
         JOIN scheduling_facilities f ON f.id=p.facility_id WHERE f.legacy_facility=$1
         ORDER BY p.sequence DESC LIMIT 1`,
        [facilityName],
      );
      return policy?.state === "active"
        ? {
            periodStart: policy.effective_from,
            periodEnd: addDays(policy.effective_from, 27),
            hasActive: false,
          }
        : null;
    },
    async pauseScheduling(userId, facilityId, body) {
      assertBody(body, []);
      return transaction(async (db) => {
        await facilityFor(db, userId, facilityId, true);
        return event(db, userId, facilityId, "paused", null, "1900-01-01", "1900-01-01");
      });
    },
    async activePolicy(userId, facilityId, startDate) {
      if (!validDate(startDate)) fail(400, "Use a valid period start");
      await facilityFor(pool, userId, facilityId);
      return { policy: await policyAt(pool, facilityId, startDate) };
    },
    async generateActive(userId, facilityId, body) {
      assertBody(body, ["startDate", "unit"]);
      const validUnit =
        typeof body.unit === "string" &&
        (["all", "group:head", "group:matron", "group:porter", "group:intern"].includes(
          body.unit,
        ) ||
          (body.unit.startsWith("ward:") && UUID.test(body.unit.slice(5))));
      if (!validDate(body.startDate) || !validUnit)
        fail(400, "Choose a valid period and scheduling unit");
      return transaction(
        async (db) => {
          const facility = await facilityFor(db, userId, facilityId, true);
          const result = await generate(db, {
            userId,
            facility,
            startDate: body.startDate,
            unit: body.unit,
          });
          if (!result) fail(409, "No activated configuration for this period");
          if (result.skipped) fail(409, result.reason);
          return result;
        },
        false,
        true,
      );
    },
    // Active staff with no cells in the period: the people a mid-period addition can schedule.
    async addStaffCandidates(userId, facilityId, startDate) {
      if (!validDate(startDate)) fail(400, "Use a valid period start");
      const facility = await facilityFor(pool, userId, facilityId);
      const { rows } = await pool.query(
        `SELECT n.id,n.name,n.role,n.ward FROM nurses n
         WHERE n.facility=$1 AND n.is_active=true AND NOT EXISTS (
           SELECT 1 FROM shift_assignments a
           WHERE a.nurse_id=n.id AND a.shift_date BETWEEN $2::date AND $2::date+27)
         ORDER BY n.name`,
        [facility.legacy_facility, startDate],
      );
      return { staff: rows };
    },
    // Schedules one newly active staff member inside an already generated period,
    // using the activated configuration, from their first working date onward.
    async addStaffToPeriod(userId, facilityId, body) {
      assertBody(body, ["startDate", "nurseId", "fromDate"]);
      if (
        !validDate(body.startDate) ||
        !validDate(body.fromDate) ||
        typeof body.nurseId !== "string" ||
        !UUID.test(body.nurseId)
      )
        fail(400, "Choose a period, staff member and first date");
      if (body.fromDate < body.startDate || body.fromDate > addDays(body.startDate, 27))
        fail(422, "The first date must fall within the selected 28-day period");
      return transaction(
        async (db) => {
          const facility = await facilityFor(db, userId, facilityId, true);
          const {
            rows: [clock],
          } = await db.query("SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS today");
          if (body.fromDate < clock.today) fail(422, "The first date cannot be in the past");
          const {
            rows: [nurse],
          } = await db.query(
            "SELECT id FROM nurses WHERE id=$1 AND facility=$2 AND is_active=true",
            [body.nurseId, facility.legacy_facility],
          );
          if (!nurse) fail(404, "Active staff member not found in this facility");
          const result = await generate(db, {
            userId,
            facility,
            startDate: body.startDate,
            nurseIds: [nurse.id],
            fromDate: body.fromDate,
          });
          if (!result) fail(409, "No activated configuration for this period");
          if (result.skipped) fail(409, result.reason);
          return result;
        },
        false,
        true,
      );
    },
    async generateAutomaticUnit({ facilityName, startDate, nurseIds, dryRun = false }) {
      return transaction(
        async (db) => {
          const {
            rows: [facility],
          } = await db.query(
            "SELECT * FROM scheduling_facilities WHERE legacy_facility=$1 FOR UPDATE",
            [facilityName],
          );
          if (!facility) return null;
          return generate(db, { facility, startDate, nurseIds, dryRun, automatic: true });
        },
        false,
        true,
      );
    },
  };
}
module.exports = { createPolicyService, isLiveCompatible, policyAt };
