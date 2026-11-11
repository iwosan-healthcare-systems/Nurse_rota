-- Lagoon's last 28-day rota period is the one holding 15 Nov 2026 (19 Oct –
-- 15 Nov). The rest of November (16–30 Nov) is a short transition period that
-- Lagoon fills by hand, and calendar months start on 1 Dec 2026.
--
-- Migration 053 inferred the cutover from the latest assignment, so a draft for
-- 16 Nov – 13 Dec (or a hand-filled rota to 30 Nov) would otherwise have kept
-- 16 Nov – 13 Dec as one more 28-day period. The end stays on Lagoon's own
-- 28-day boundary.
UPDATE hospitals
SET legacy_period_until =
  legacy_period_anchor + ((('2026-11-15'::date - legacy_period_anchor) / 28) + 1) * 28 - 1
WHERE id = '00000000-0000-4000-8000-000000000001'
  AND legacy_period_anchor IS NOT NULL
  AND legacy_period_anchor <= '2026-11-15'::date;
