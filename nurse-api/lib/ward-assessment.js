// Locum request "ward assessment": critical-care units (any ward whose name
// contains ICU, HDU, NICU or SCBU, in any facility) answer unit census
// questions for the unit types in their own name only (an ICU is asked about
// ICU patients, an "ICU/HDU" ward about both); every other ward answers ward
// census questions. Mirrors src/lib/ward-assessment.ts.
const UNIT_FIELDS = {
  ICU: "icu_patients",
  HDU: "hdu_patients",
  NICU: "nicu_patients",
  SCBU: "scbu_patients",
};
const GENERAL_FIELDS = ["ward_patients", "nurses_in_ward", "nurse_interns", "ews_over_3"];
const ALL_FIELDS = [
  ...new Set([...Object.values(UNIT_FIELDS), "nurses_in_ward", "nurse_interns", ...GENERAL_FIELDS]),
];

// The critical-care unit types named in a ward, e.g. "ICU & CathLab" -> ["ICU"].
// Whole words only, so "NICU" is not also read as "ICU".
function unitTypesOf(ward) {
  return Object.keys(UNIT_FIELDS).filter((type) =>
    new RegExp(`\\b${type}\\b`, "i").test(ward ?? ""),
  );
}

function unitKindOf(ward) {
  return unitTypesOf(ward).length ? "critical" : "general";
}

// The questions a ward must answer.
function assessmentFieldsFor(ward) {
  const types = unitTypesOf(ward);
  return types.length
    ? [...types.map((type) => UNIT_FIELDS[type]), "nurses_in_ward", "nurse_interns"]
    : GENERAL_FIELDS;
}

// { unitKind, values: {field: number|null}, missing: [field] } for a request body.
function readAssessment(ward, body) {
  const unitKind = unitKindOf(ward);
  const values = Object.fromEntries(ALL_FIELDS.map((f) => [f, null]));
  const missing = [];
  for (const field of assessmentFieldsFor(ward)) {
    const value = Number(body[field]);
    if (body[field] === undefined || body[field] === "" || !Number.isInteger(value) || value < 0)
      missing.push(field);
    else values[field] = value;
  }
  return { unitKind, values, missing };
}

module.exports = {
  unitKindOf,
  unitTypesOf,
  assessmentFieldsFor,
  readAssessment,
  ASSESSMENT_FIELDS: ALL_FIELDS,
};
