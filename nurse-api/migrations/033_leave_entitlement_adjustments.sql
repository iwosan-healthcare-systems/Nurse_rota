-- Manual leave-entitlement adjustments — for leave taken BEFORE this system
-- existed (or any other case a real request was never submitted through the
-- app), so admin/HR can credit those days against a staff member's balance
-- without inventing a fake leave_requests row to represent it. Kept as a
-- fully separate table so a manual adjustment can never be confused with a
-- genuine app-submitted request — the entitlement math (lib/leave-
-- entitlements.js) sums both sources for the total used, but always reports
-- them as two distinct numbers, and the frontend always labels which is
-- which.
--
-- Append-only by design (confirmed with the user) — no UPDATE/DELETE route
-- will ever be built against this table. A mistaken entry is corrected by
-- adding a new row with a negative `days` value and a reason explaining the
-- correction, not by editing/removing the original — same reasoning as
-- audit_logs never being mutated elsewhere in this app.
CREATE TABLE leave_entitlement_adjustments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nurse_id         UUID NOT NULL REFERENCES nurses(id) ON DELETE CASCADE,
  type             TEXT NOT NULL,       -- one of LEAVE_ENTITLEMENTS' tracked keys (Annual, Sick, ...)
  days             NUMERIC NOT NULL,    -- positive to add usage; negative to correct a prior entry
  period_year      INTEGER NOT NULL,    -- calendar year this counts against
  period_month     INTEGER,             -- 1-12, only meaningful for month-period types (Sick); NULL for year-period types
  reason           TEXT NOT NULL,
  created_by       UUID REFERENCES profiles(id),
  created_by_name  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leave_entitlement_adjustments_lookup
  ON leave_entitlement_adjustments (nurse_id, type, period_year, period_month);
