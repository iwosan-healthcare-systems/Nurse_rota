-- Add Study Leave and Compassionate Leave to the leave_type enum.
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Study Leave';
ALTER TYPE leave_type ADD VALUE IF NOT EXISTS 'Compassionate Leave';
