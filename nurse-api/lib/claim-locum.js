const { configuredEditOptions } = require("./configured-assignment-edit");
const { validateTransitionRestContext } = require("./configured-transition-rest");

const conflict = (message) => {
  const error = new Error(message);
  error.code = "LOCUM_ROTA_CONFLICT";
  error.status = 409;
  return error;
};

// The accepted nurse's own published OFF cell becomes the locum duty in the same
// transaction as the claim, so an accepted invite can never leave the rota stale.
// Configured cells must allow the duty under their saved role and keep rest
// around neighbouring duties. Home-ward staffing is not assessed: the nurse is
// covering the requesting ward, not adding to their own.
async function flipRotaCell(db, request, nurseId, actor) {
  const {
    rows: [cell],
  } = await db.query(
    `SELECT *,shift_date::text FROM shift_assignments
     WHERE nurse_id=$1 AND status='published'
       AND shift_date=(SELECT shift_date FROM locum_requests WHERE id=$2) FOR UPDATE`,
    [nurseId, request.id],
  );
  if (!cell || cell.shift !== "OFF")
    throw conflict("Your published rota no longer shows you off duty on this date");
  const runId = cell.shift_definition_run_id ?? cell.scheduling_run_id;
  if (runId) {
    const {
      rows: [run],
    } = await db.query(
      "SELECT id,configuration_snapshot,input_snapshot FROM scheduling_runs WHERE id=$1",
      [runId],
    );
    const options = configuredEditOptions(cell, run);
    if (options.error || !options.shifts.some((s) => s.code === request.shift))
      throw conflict(
        options.error ?? `Your saved role does not allow the ${request.shift} shift for this locum`,
      );
    try {
      await validateTransitionRestContext(
        db,
        [{ ...cell, shift: request.shift }],
        new Map([[run.id, run]]),
      );
    } catch (error) {
      if (error.code === "CONFIGURED_EDIT_INVALID")
        throw conflict("Accepting this locum would leave you without rest between duties");
      throw error;
    }
  }
  await db.query(
    `UPDATE shift_assignments SET shift=$2,updated_by=$3,updated_by_name=$4,updated_at=NOW()
     WHERE id=$1`,
    [cell.id, request.shift, actor?.userId ?? null, actor?.name ?? null],
  );
}

async function claimLocum(pool, requestId, nurseId, nurseName, actor = null) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const {
      rows: [request],
    } = await db.query("SELECT * FROM locum_requests WHERE id=$1 FOR UPDATE", [requestId]);
    if (!request) {
      await db.query("ROLLBACK");
      return null;
    }
    const {
      rows: [invite],
    } = await db.query(
      "SELECT * FROM locum_invites WHERE locum_request_id=$1 AND nurse_id=$2 FOR UPDATE",
      [requestId, nurseId],
    );
    if (invite?.status === "accepted") {
      await db.query("COMMIT");
      return { ...request, already_claimed: true };
    }
    const {
      rows: [count],
    } = await db.query(
      "SELECT COUNT(*)::int AS accepted FROM locum_invites WHERE locum_request_id=$1 AND status='accepted'",
      [requestId],
    );
    if (
      request.status !== "invites_sent" ||
      !invite ||
      invite.status !== "pending" ||
      count.accepted >= request.nurses_needed
    ) {
      await db.query("ROLLBACK");
      return null;
    }
    await flipRotaCell(db, request, nurseId, actor);
    await db.query("UPDATE locum_invites SET status='accepted',responded_at=NOW() WHERE id=$1", [
      invite.id,
    ]);
    const {
      rows: [updated],
    } = await db.query(
      `UPDATE locum_requests SET status=$2,accepted_by_nurse_id=COALESCE(accepted_by_nurse_id,$3),
       accepted_by_nurse_name=COALESCE(accepted_by_nurse_name,$4),accepted_at=COALESCE(accepted_at,NOW()),updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [
        requestId,
        count.accepted + 1 >= request.nurses_needed ? "filled" : "invites_sent",
        nurseId,
        nurseName,
      ],
    );
    await db.query("COMMIT");
    return { ...updated, rota_updated: true };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
module.exports = { claimLocum };
