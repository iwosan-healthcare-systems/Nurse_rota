import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validateConfiguredEditState } = require("../nurse-api/lib/configured-assignment-edit");
test("configured duties must return to draft before edits and cannot detach their context", () => {
  const row = {
    shift_definition_run_id: "r",
    status: "published",
    ward: "A",
    shift_date: "2026-10-07",
  };
  for (const body of [
    { shift: "OFF" },
    { shift: "OFF", status: "draft" },
    { ward: null },
    { shift_date: "2026-10-08" },
  ])
    assert.throws(() => validateConfiguredEditState(row, body), /Return.*draft/);
  validateConfiguredEditState(row, { status: "draft" });
  validateConfiguredEditState({ ...row, status: "draft" }, { shift: "OFF" });
  for (const body of [{ ward: null }, { ward: "B" }, { shift_date: "2026-10-08" }])
    assert.throws(
      () => validateConfiguredEditState({ ...row, status: "draft" }, body),
      /reassignment/,
    );
});
const {
  configuredEditOptions,
  validateConfiguredEdit,
} = require("../nurse-api/lib/configured-assignment-edit");
const cell = {
  shift_definition_run_id: "r1",
  nurse_id: "n1",
  nurse_role: "Day role",
  status: "draft",
};
const run = {
  id: "r1",
  configuration_snapshot: {
    roles: [{ name: "Day role", allowedShifts: ["M"] }],
    shifts: [
      { code: "M", name: "Early duty" },
      { code: "N", name: "Night duty" },
    ],
  },
};
test("configured edit choices use saved role restrictions and include OFF", () => {
  assert.deepEqual(configuredEditOptions(cell, run).shifts, [
    { code: "M", name: "Early duty" },
    { code: "OFF", name: "Off duty" },
  ]);
  assert.equal(configuredEditOptions({}, null), null);
  assert.ok(configuredEditOptions(cell, null).error);
});
test("API validation rejects a defined but disallowed shift and missing saved role", async () => {
  const db = { query: async () => ({ rows: [run] }) };
  await validateConfiguredEdit(db, cell, { shift: "M" });
  await validateConfiguredEdit(db, cell, { shift: "OFF" });
  await assert.rejects(
    validateConfiguredEdit(db, cell, { shift: "N" }),
    (e) => e.code === "CONFIGURED_EDIT_INVALID",
  );
  await assert.rejects(
    validateConfiguredEdit(db, { ...cell, nurse_role: "Missing" }, { shift: "M" }),
    (e) => e.code === "CONFIGURED_EDIT_INVALID",
  );
  await validateConfiguredEdit(db, { ...cell, shift: "M" }, { status: "submitted" });
  await assert.rejects(
    validateConfiguredEdit(db, { ...cell, shift: "N" }, { status: "published" }),
    (e) => e.code === "CONFIGURED_EDIT_INVALID",
  );
  await validateConfiguredEdit(db, { ...cell, shift: "N" }, { status: "draft" });
});
