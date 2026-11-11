// Iwosan Lagoon Hospital, the original deployment (migration 049). Its rules are
// the scheduling defaults and the built-in generator; other hospitals schedule
// only with the configuration they save for each facility.
const LAGOON_HOSPITAL_ID = "00000000-0000-4000-8000-000000000001";

// Facilities with no hospital predate tenancy and belong to Lagoon.
function usesLagoonDefaults(hospitalId) {
  return hospitalId == null || hospitalId === LAGOON_HOSPITAL_ID;
}

module.exports = { LAGOON_HOSPITAL_ID, usesLagoonDefaults };
