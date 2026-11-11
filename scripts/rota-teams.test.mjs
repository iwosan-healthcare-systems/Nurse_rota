import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const load = async (file) =>
  import(
    `data:text/javascript;base64,${Buffer.from(
      ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    ).toString("base64")}`
  );
const { splitByCategory, dutyPeriod, dutyTotals, printRowsHtml, printRowsAoa, locationSwitchKind } =
  await load("src/lib/rota-teams.ts");
const client = await load("src/lib/ward-assessment.ts");
const server = createRequire(import.meta.url)("../nurse-api/lib/ward-assessment.js");

const staff = [
  { id: "a", role: "Nurse" },
  { id: "b", role: "Nursing Assistant" },
  { id: "c", role: "Nurse Assistant - Day" },
  { id: "d", role: "Head Nurse" },
];

test("teams list nurses first, then nursing assistants, keeping order", () => {
  assert.deepEqual(
    splitByCategory(staff).map((g) => [g.category, g.staff.map((s) => s.id)]),
    [
      ["nurse", ["a", "d"]],
      ["na", ["b", "c"]],
    ],
  );
  assert.deepEqual(splitByCategory([{ id: "x", role: "Nurse" }]).length, 1);
});

test("day or night comes from saved shift times, then built-in codes", () => {
  const def = (start, endDayOffset) => ({ start, endDayOffset });
  assert.equal(dutyPeriod({ shift: "E", scheduled_shift: def("11:30", 0) }), "day");
  assert.equal(dutyPeriod({ shift: "X", scheduled_shift: def("19:00", 0) }), "night");
  assert.equal(dutyPeriod({ shift: "L", scheduled_shift: def("16:59", 0) }), "day");
  assert.equal(dutyPeriod({ shift: "Z", scheduled_shift: def("17:00", 0) }), "night");
  assert.equal(dutyPeriod({ shift: "Y", scheduled_shift: def("08:00", 1) }), "night");
  assert.equal(dutyPeriod({ shift: "N" }), "night");
  assert.equal(dutyPeriod({ shift: "NC" }), "night");
  assert.equal(dutyPeriod({ shift: "MWC" }), "day");
  for (const shift of ["OFF", "LEAVE"]) assert.equal(dutyPeriod({ shift }), null);
  assert.equal(dutyPeriod(undefined), null);
});

test("on-duty totals count each category per day and night", () => {
  const cells = { "a|d1": "M", "d|d1": "N", "b|d1": "M", "c|d1": "OFF", "a|d2": "LEAVE" };
  const cellOf = (id, date) =>
    cells[`${id}|${date}`] ? { shift: cells[`${id}|${date}`] } : undefined;
  const totals = dutyTotals(staff, ["d1", "d2"], cellOf);
  assert.deepEqual(totals, {
    nurse: { day: [1, 0], night: [1, 0] },
    na: { day: [1, 0], night: [0, 0] },
  });
  const html = printRowsHtml(staff, ["d1", "d2"], cellOf, (s) => `<tr><td>${s.id}</td></tr>`);
  assert.ok(html.indexOf("Nurses · 2") < html.indexOf("Nursing assistants · 2"));
  assert.match(html, /Nursing assistants on duty · Day<\/td><td>1<\/td><td>0<\/td>/);
  const rows = printRowsAoa(staff, ["d1", "d2"], cellOf, (s) => [s.id]);
  assert.deepEqual(rows[0], ["Nurses (2)"]);
  assert.deepEqual(rows.at(-1), ["Nursing assistants on duty · Night", "", "", 0, 0]);
});

test("ICU, HDU, NICU and SCBU wards in any facility get the unit census questions", () => {
  for (const ward of ["ICU", "NICU", "scbu", "HDU", "Adult ICU", "ICU & CathLab"]) {
    assert.equal(client.unitKindOf(ward), "critical", ward);
    assert.equal(server.unitKindOf(ward), "critical", ward);
  }
  for (const ward of ["GOPD", "Male Ward", "PICUx", "Paediatrics"]) {
    assert.equal(client.unitKindOf(ward), "general", ward);
    assert.equal(server.unitKindOf(ward), "general", ward);
  }
  assert.deepEqual(
    client.ASSESSMENT_QUESTIONS.general.map((q) => q.field),
    ["ward_patients", "nurses_in_ward", "nurse_interns", "ews_over_3"],
  );
});

test("the API requires every question for the ward's kind as a whole number", () => {
  const ok = server.readAssessment("NICU", {
    icu_patients: 0,
    hdu_patients: 2,
    nicu_patients: "5",
    scbu_patients: 1,
    nurses_in_ward: 4,
    nurse_interns: 1,
  });
  assert.equal(ok.unitKind, "critical");
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.values.nicu_patients, 5);
  assert.equal(ok.values.ews_over_3, null, "Other kinds' questions stay empty");
  const general = server.readAssessment("GOPD", { ward_patients: 10, nurses_in_ward: 3 });
  assert.deepEqual(general.missing, ["nurse_interns", "ews_over_3"]);
  assert.deepEqual(
    server.readAssessment("GOPD", {
      ward_patients: -1,
      nurses_in_ward: 1.5,
      nurse_interns: "",
      ews_over_3: 0,
    }).missing,
    ["ward_patients", "nurses_in_ward", "nurse_interns"],
  );
});

test("only the current questions show in the app; earlier answers stay in the export", () => {
  const earlier = { nurses_in_ward: 3, ventilated_patients: 2, hdu_nurses: 1 };
  assert.deepEqual(client.assessmentAnswers(earlier), []);
  const old = client.assessmentExportColumns(earlier);
  assert.equal(old["Assessment Form"], "Earlier form");
  assert.equal(old["Nurses in Ward"], 3);
  assert.equal(old["Ventilated Patients (earlier form)"], 2);
  assert.equal(old["HDU Nurses (earlier form)"], 1);
  assert.equal(old["ICU Patients"], "");
  assert.equal(Object.keys(old).length, client.ASSESSMENT_EXPORT_WIDTHS.length);

  const ward = {
    unit_kind: "general",
    ward_patients: 12,
    nurses_in_ward: 4,
    ews_over_3: 2,
    ventilated_patients: null,
  };
  assert.deepEqual(
    client.assessmentAnswers(ward).map((a) => a.value),
    [12, 4, 0, 2],
  );
  const cols = client.assessmentExportColumns(ward);
  assert.equal(cols["Assessment Form"], "Ward");
  assert.equal(cols["Ward Patients"], 12);
  assert.equal(cols["Patients with EWS > 3"], 2);
  assert.equal(cols["Nurse Interns"], "");
  assert.equal(cols["ICU Patients"], "", "Unit questions are blank for ward requests");
  assert.equal(cols["Ventilated Patients (earlier form)"], "");
});

test("switches between locations are labelled shift for shift, shift for off, or leave cover", () => {
  const sw = (a, b, ...flags) => ["SHIFT_SWITCH", "id", "Name", a, b, ...flags].join("|");
  assert.equal(
    locationSwitchKind(sw("M", "N", "INTER_WARD", "DIRECT", "INTER_FACILITY")),
    "shift-for-shift",
  );
  assert.equal(locationSwitchKind(sw("M", "OFF", "INTER_WARD", "INTER_FACILITY")), "shift-to-off");
  assert.equal(locationSwitchKind(sw("OFF", "N", "INTER_WARD", "INTER_FACILITY")), "shift-to-off");
  assert.equal(locationSwitchKind(sw("M", "OFF", "LEAVE_COVER", "INTER_FACILITY")), "leave-cover");
  assert.equal(locationSwitchKind(sw("M", "N", "INTER_WARD")), null);
  assert.equal(
    locationSwitchKind(sw("M", "N", "NOTE:INTER_FACILITY")),
    null,
    "Notes are not flags",
  );
  assert.equal(locationSwitchKind("Annual leave"), null);
});
