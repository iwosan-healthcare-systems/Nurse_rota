-- Locum request ward assessment questions. Critical-care units (wards named
-- ICU, HDU, NICU or SCBU) record unit census; other wards record ward census
-- and patients with an EWS above 3. Requests made before this keep their
-- original answers (nurses in ward, ventilated patients, HDU nurses).
ALTER TABLE locum_requests ADD COLUMN unit_kind TEXT CHECK (unit_kind IN ('critical', 'general'));
ALTER TABLE locum_requests ADD COLUMN icu_patients INTEGER CHECK (icu_patients >= 0);
ALTER TABLE locum_requests ADD COLUMN hdu_patients INTEGER CHECK (hdu_patients >= 0);
ALTER TABLE locum_requests ADD COLUMN nicu_patients INTEGER CHECK (nicu_patients >= 0);
ALTER TABLE locum_requests ADD COLUMN scbu_patients INTEGER CHECK (scbu_patients >= 0);
ALTER TABLE locum_requests ADD COLUMN ward_patients INTEGER CHECK (ward_patients >= 0);
ALTER TABLE locum_requests ADD COLUMN nurse_interns INTEGER CHECK (nurse_interns >= 0);
ALTER TABLE locum_requests ADD COLUMN ews_over_3 INTEGER CHECK (ews_over_3 >= 0);
ALTER TABLE locum_requests ALTER COLUMN ventilated_patients DROP NOT NULL;
ALTER TABLE locum_requests ALTER COLUMN hdu_nurses DROP NOT NULL;
