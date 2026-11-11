// Locum request "ward assessment" questions. Critical-care units (any ward whose
// name contains ICU, HDU, NICU or SCBU, in any facility) answer unit census
// questions; every other ward answers ward census questions. Mirrors
// nurse-api/lib/ward-assessment.js.

export type AssessmentField =
  | "icu_patients"
  | "hdu_patients"
  | "nicu_patients"
  | "scbu_patients"
  | "ward_patients"
  | "nurses_in_ward"
  | "nurse_interns"
  | "ews_over_3";

export type UnitKind = "critical" | "general";

export function unitKindOf(ward: string | null | undefined): UnitKind {
  return /\b(ICU|HDU|NICU|SCBU)\b/i.test(ward ?? "") ? "critical" : "general";
}

export const ASSESSMENT_QUESTIONS: Record<
  UnitKind,
  { field: AssessmentField; question: string; label: string }[]
> = {
  critical: [
    {
      field: "icu_patients",
      question: "How many ICU patients are in the unit?",
      label: "ICU patients",
    },
    {
      field: "hdu_patients",
      question: "How many HDU patients are in the unit?",
      label: "HDU patients",
    },
    {
      field: "nicu_patients",
      question: "How many NICU patients are in the unit?",
      label: "NICU patients",
    },
    {
      field: "scbu_patients",
      question: "How many SCBU patients are in the unit?",
      label: "SCBU patients",
    },
    { field: "nurses_in_ward", question: "How many nurses are in the unit?", label: "Nurses" },
    {
      field: "nurse_interns",
      question: "How many nurse interns are in the unit?",
      label: "Nurse interns",
    },
  ],
  general: [
    { field: "ward_patients", question: "How many patients are on the ward?", label: "Patients" },
    { field: "nurses_in_ward", question: "How many nurses are on the ward?", label: "Nurses" },
    {
      field: "nurse_interns",
      question: "How many nurse interns are on the ward?",
      label: "Nurse interns",
    },
    {
      field: "ews_over_3",
      question: "How many patients have an EWS greater than 3?",
      label: "Patients with EWS > 3",
    },
  ],
};

type AssessmentRecord = Partial<Record<AssessmentField, number | null>> & {
  unit_kind?: UnitKind | null;
  ventilated_patients?: number | null;
  hdu_nurses?: number | null;
};

/** The answers shown in the app: only the current questions. Requests made with the
 * earlier form (no unit_kind) show none here; their answers stay in the database and
 * in the Locum Requests export (see assessmentExportColumns). */
export function assessmentAnswers(request: AssessmentRecord): { label: string; value: number }[] {
  if (!request.unit_kind) return [];
  return ASSESSMENT_QUESTIONS[request.unit_kind].map((q) => ({
    label: q.label,
    value: request[q.field] ?? 0,
  }));
}

/** One spreadsheet column per question, current and earlier; blank where not asked. */
export function assessmentExportColumns(
  request: AssessmentRecord,
): Record<string, number | string> {
  const kind = request.unit_kind;
  const asked = (field: AssessmentField) =>
    kind && ASSESSMENT_QUESTIONS[kind].some((q) => q.field === field) ? (request[field] ?? "") : "";
  return {
    "Assessment Form":
      kind === "critical" ? "ICU/HDU/NICU/SCBU" : kind === "general" ? "Ward" : "Earlier form",
    "ICU Patients": asked("icu_patients"),
    "HDU Patients": asked("hdu_patients"),
    "NICU Patients": asked("nicu_patients"),
    "SCBU Patients": asked("scbu_patients"),
    "Ward Patients": asked("ward_patients"),
    "Nurses in Ward": request.nurses_in_ward ?? "",
    "Nurse Interns": asked("nurse_interns"),
    "Patients with EWS > 3": asked("ews_over_3"),
    "Ventilated Patients (earlier form)": kind ? "" : (request.ventilated_patients ?? ""),
    "HDU Nurses (earlier form)": kind ? "" : (request.hdu_nurses ?? ""),
  };
}

/** Column widths matching assessmentExportColumns. */
export const ASSESSMENT_EXPORT_WIDTHS = [18, 12, 12, 12, 12, 13, 14, 13, 20, 30, 24];
