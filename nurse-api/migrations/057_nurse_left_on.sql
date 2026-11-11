-- Last working day of staff removed from the rota partway through a month.
-- They are inactive (left out of new rotas) and keep their shifts up to this
-- day, so the month they left still shows and counts them for those days.
ALTER TABLE nurses ADD COLUMN IF NOT EXISTS left_on DATE;
CREATE INDEX IF NOT EXISTS nurses_left_on_idx ON nurses (left_on) WHERE left_on IS NOT NULL;
