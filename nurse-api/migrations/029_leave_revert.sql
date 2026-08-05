-- Lets an admin undo an already-Approved leave request, restoring the nurse's
-- original shift assignments and reversing any hours already credited for it.
-- Distinct from 'Rejected' (a request that was never approved in the first
-- place) — this is an approved request being actively undone after the fact,
-- and keeping it as its own status preserves an honest history instead of
-- rewriting what actually happened.
ALTER TYPE leave_status ADD VALUE IF NOT EXISTS 'Reverted';

-- Kept separate from review_note (the original approval note) so reverting
-- never overwrites the record of why it was approved in the first place.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS revert_reason TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reverted_by UUID;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;
