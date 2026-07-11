-- Normalize ward name capitalization across the nurses table.
-- Inconsistent casing ("ICU & Cathlab" vs "ICU & CathLab") caused duplicate entries
-- in ward dropdowns because the Set dedup is case-sensitive.
-- Using case-insensitive REPLACE via REGEXP_REPLACE so all variants are caught.

UPDATE nurses
SET ward = REGEXP_REPLACE(ward, 'ICU & [Cc]ath[Ll]ab', 'ICU & CathLab', 'g')
WHERE ward ~* 'ICU & CathLab';
