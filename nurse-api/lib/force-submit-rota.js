const pool = require("../db");

// Mirrors leave-requests.js's facilityWideGroupSlug / shift-assignments.js's
// roleGroupOf — kept as its own small copy here rather than a shared import,
// matching this codebase's existing convention (each of those two files also
// carries its own copy).
function roleGroupOf(role) {
  if (!role) return null;
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role) || /^coverage\s*nurse\s*-\s*day$/i.test(role))
    return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  return null;
}

// Resolves the candidate nurse_ids for a unit (a ward, or a facility-wide
// role_group). For a ward, every nurse in the facility is returned — the
// actual ward scoping happens against shift_assignments.ward downstream
// (authoritative per-row), not against the nurse's own "home ward" field.
// Shared by forceSubmitUnit below and by the three lifecycle cron jobs via
// getUnitPeriod (lib/rota-period-dates.js), which need the same candidate
// set to determine a unit's own current period.
async function resolveUnitNurseIds({ facility, ward, roleGroup }) {
  const { rows: nurseRows } = await pool.query("SELECT id, role FROM nurses WHERE facility = $1", [
    facility,
  ]);
  return ward
    ? nurseRows.map((n) => n.id)
    : nurseRows.filter((n) => roleGroupOf(n.role) === roleGroup).map((n) => n.id);
}

// Force-submits a draft rota unit (a ward, or a facility-wide role_group) for
// HR review, running the exact same safety guards the manual submit endpoint
// enforces (PATCH /shift-assignments in routes/shift-assignments.js:
// PENDING_LEAVES_EXIST, UNAPPLIED_LEAVE_EXISTS) — shared by the T-17
// auto-submit cron job (jobs/auto-submit-draft.js) and by HR declining an
// edit-access request (routes/rota-edit-requests.js), which also
// force-submits the as-is draft rather than leaving it stuck.
//
// Returns { submitted: true, count } on success, or
// { submitted: false, reason: 'PENDING_LEAVES_EXIST'|'UNAPPLIED_LEAVE_EXISTS'|'NO_NURSES', count: 0 }
// without writing anything if a guard blocks it or the unit is empty.
async function forceSubmitUnit({ facility, ward, roleGroup, periodStart, periodEnd }) {
  const nurseIds = await resolveUnitNurseIds({ facility, ward, roleGroup });
  if (!nurseIds.length) return { submitted: false, reason: "NO_NURSES", count: 0 };

  const { rows: pendingLeaves } = await pool.query(
    `SELECT 1 FROM leave_requests
      WHERE nurse_id = ANY($1) AND status = 'Pending' AND type != 'Swap'
        AND from_date <= $3 AND to_date >= $2
      LIMIT 1`,
    [nurseIds, periodStart, periodEnd],
  );
  if (pendingLeaves.length) return { submitted: false, reason: "PENDING_LEAVES_EXIST", count: 0 };

  const { rows: unflipped } = await pool.query(
    `SELECT 1 FROM shift_assignments sa
       JOIN leave_requests lr
         ON lr.nurse_id = sa.nurse_id AND lr.status = 'Approved' AND lr.type != 'Swap'
        AND sa.shift_date BETWEEN lr.from_date AND lr.to_date
      WHERE sa.nurse_id = ANY($1) AND sa.status = 'draft' AND sa.shift != 'LEAVE'
        AND sa.shift_date BETWEEN $2 AND $3
      LIMIT 1`,
    [nurseIds, periodStart, periodEnd],
  );
  if (unflipped.length) return { submitted: false, reason: "UNAPPLIED_LEAVE_EXISTS", count: 0 };

  const wardClause = ward ? "AND sa.ward = $4" : "AND sa.ward IS NULL";
  const params = ward
    ? [nurseIds, periodStart, periodEnd, ward]
    : [nurseIds, periodStart, periodEnd];
  const { rowCount } = await pool.query(
    `UPDATE shift_assignments sa
        SET status = 'submitted', updated_at = NOW(), updated_by_name = 'System (auto-submitted)'
      WHERE sa.nurse_id = ANY($1) AND sa.shift_date BETWEEN $2 AND $3
        AND sa.status = 'draft' ${wardClause}`,
    params,
  );
  return { submitted: true, count: rowCount };
}

// Returns true when the most recent rota_transitions row for this unit+period
// is a revert to draft (HR sent a submitted/cno_approved rota back), as
// opposed to a draft that's freshly generated and never submitted. Used to
// tell the T-17 auto-submit sweep (jobs/auto-submit-draft.js) not to
// immediately re-grab a rota HR just rejected, and to let the edit-access
// request route (routes/rota-edit-requests.js) allow a fresh request for
// that specific case even outside the normal T-19..T-17 window.
async function wasRevertedToDraft({ facility, ward, roleGroup, periodStart }) {
  const unitClause = ward ? "ward = $2" : "role_group = $2";
  const { rows } = await pool.query(
    `SELECT event_type, status FROM rota_transitions
      WHERE facility = $1 AND ${unitClause} AND period_start = $3
      ORDER BY transitioned_at DESC LIMIT 1`,
    [facility, ward || roleGroup, periodStart],
  );
  return rows.length > 0 && rows[0].event_type === "revert" && rows[0].status === "draft";
}

module.exports = { forceSubmitUnit, roleGroupOf, wasRevertedToDraft, resolveUnitNurseIds };
