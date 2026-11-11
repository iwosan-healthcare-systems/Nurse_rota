// Locum request "ward assessment": critical-care units (any ward whose name
// contains ICU, HDU, NICU or SCBU, in any facility) answer unit census
// questions; every other ward answers ward census questions. Mirrors
// src/lib/ward-assessment.ts.
const FIELDS = {
  critical: [
    "icu_patients",
    "hdu_patients",
    "nicu_patients",
    "scbu_patients",
    "nurses_in_ward",
    "nurse_interns",
  ],
  general: ["ward_patients", "nurses_in_ward", "nurse_interns", "ews_over_3"],
};
const ALL_FIELDS = [...new Set([...FIELDS.critical, ...FIELDS.general])];

function unitKindOf(ward) {
  return /\b(ICU|HDU|NICU|SCBU)\b/i.test(ward ?? "") ? "critical" : "general";
}

// { unitKind, values: {field: number|null}, missing: [field] } for a request body.
function readAssessment(ward, body) {
  const unitKind = unitKindOf(ward);
  const values = Object.fromEntries(ALL_FIELDS.map((f) => [f, null]));
  const missing = [];
  for (const field of FIELDS[unitKind]) {
    const value = Number(body[field]);
    if (body[field] === undefined || body[field] === "" || !Number.isInteger(value) || value < 0)
      missing.push(field);
    else values[field] = value;
  }
  return { unitKind, values, missing };
}

module.exports = { unitKindOf, readAssessment, ASSESSMENT_FIELDS: ALL_FIELDS };
