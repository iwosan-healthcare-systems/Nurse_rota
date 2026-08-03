const pool = require("../db");

// Mirrors leave-requests.js's facilityWideGroupSlug / shift-assignments.js's
// roleGroupOf — kept as its own small copy here rather than a shared import,
// matching this codebase's existing convention (each of those two files also
// carries its own copy).
function roleGroupOf(role) {
  if (!role) return null;
  if (/^matron$/i.test(role)) return "matron";
  if (/^(head|coverage)\s*nurse$/i.test(role)) return "head";
  if (/^porter(\s*-\s*day)?$/i.test(role)) return "porter";
  if (/nurse\s*intern|intern\s*nurse/i.test(role)) return "intern";
  return null;
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
  const { rows: nurseRows } = await pool.query("SELECT id, role FROM nurses WHERE facility = $1", [
    facility,
  ]);
  const nurseIds = ward
    ? nurseRows.map((n) => n.id)
    : nurseRows.filter((n) => roleGroupOf(n.role) === roleGroup).map((n) => n.id);
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
        SET status = 'submitted', updated_at = NOW()
      WHERE sa.nurse_id = ANY($1) AND sa.shift_date BETWEEN $2 AND $3
        AND sa.status = 'draft' ${wardClause}`,
    params,
  );
  return { submitted: true, count: rowCount };
}

module.exports = { forceSubmitUnit, roleGroupOf };
