-- Remove any duplicate invite rows left behind by the earlier batch-send bug,
-- then enforce one invite per nurse per locum request going forward.
DELETE FROM locum_invites li
USING locum_invites li2
WHERE li.id > li2.id
  AND li.locum_request_id = li2.locum_request_id
  AND li.nurse_id = li2.nurse_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_locum_invites_request_nurse
  ON locum_invites (locum_request_id, nurse_id);
