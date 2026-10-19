import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { switchNoticeStart } = require("../nurse-api/lib/switch-notice-start");
const { validateSwitchNotice } = require("../nurse-api/lib/switch-notice-start");
const date = "2044-01-04";
const run = {
  id: "saved",
  configuration_snapshot: {
    timezone: "Asia/Kolkata",
    shifts: [{ code: "EV", name: "Evening", start: "20:30", end: "04:30", endDayOffset: 1 }],
  },
};
const dbFor = (assignment, runs = [run]) => ({
  query: async (sql) => ({
    rows: sql.includes("FROM scheduling_runs")
      ? runs
      : assignment
        ? [{ shift_date: date, ...assignment }]
        : [],
  }),
});
test("notice accepts the exact saved-start boundary and rejects one millisecond too late", async () => {
  const source = dbFor({ shift: "EV", scheduling_run_id: "saved" });
  const db = {
    query: (sql, params) =>
      sql.includes("FROM leave_requests") ? { rows: [] } : source.query(sql, params),
  };
  const boundary = Date.parse("2044-01-03T15:00:00Z");
  await validateSwitchNotice(db, "nurse", date, 24, boundary);
  await assert.rejects(validateSwitchNotice(db, "nurse", date, 24, boundary + 1), {
    code: "SWITCH_MIN_NOTICE_NOT_MET",
  });
});
test("Sick and Emergency waive notice; ordinary leave does not", async () => {
  for (const type of ["Sick", "Emergency"]) {
    await validateSwitchNotice(
      {
        query: async (sql) => {
          assert.match(sql, /FROM leave_requests/);
          return { rows: [{ type }] };
        },
      },
      "nurse",
      date,
      24,
      Date.parse("2044-01-05T00:00:00Z"),
    );
  }
  const source = dbFor({ shift: "M" });
  await assert.rejects(
    validateSwitchNotice(
      {
        query: (sql, params) =>
          sql.includes("FROM leave_requests")
            ? { rows: [{ type: "Annual" }] }
            : source.query(sql, params),
      },
      "nurse",
      date,
      24,
      Date.parse("2044-01-05T00:00:00Z"),
    ),
    { code: "SWITCH_MIN_NOTICE_NOT_MET" },
  );
});
test("disabled notice rule does not query duty or leave data", async () => {
  await validateSwitchNotice({ query: () => assert.fail("No query expected") }, "nurse", date, 0);
});
test("invalid start or clock cannot silently pass notice validation", async () => {
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(validateSwitchNotice(db, "nurse", "not-a-date", 24), {
    code: "CONFIGURED_EDIT_INVALID",
  });
  await assert.rejects(validateSwitchNotice(db, "nurse", date, 24, NaN), {
    code: "CONFIGURED_EDIT_INVALID",
  });
});
test("switch notice uses immutable custom shift start and timezone, including planned leave", async () => {
  for (const assignment of [
    { shift: "EV", shift_definition_run_id: "saved" },
    { shift: "LEAVE", pre_leave_shift: "EV", scheduling_run_id: "saved" },
  ]) {
    const start = await switchNoticeStart(dbFor(assignment), "nurse", date);
    assert.equal(new Date(start).toISOString(), "2044-01-04T15:00:00.000Z");
  }
});
test("unresolved configured working shifts fail closed instead of inventing a start", async () => {
  await assert.rejects(
    switchNoticeStart(dbFor({ shift: "EV", scheduling_run_id: "saved" }, []), "nurse", date),
    { code: "CONFIGURED_EDIT_INVALID" },
  );
  await assert.rejects(
    switchNoticeStart(dbFor({ shift: "UNKNOWN", scheduling_run_id: "saved" }), "nurse", date),
    { code: "CONFIGURED_EDIT_INVALID" },
  );
});
test("legacy shift starts and conservative OFF or missing-duty fallback are retained", async () => {
  for (const [shift, expected] of [
    ["M", "07"],
    ["N", "16"],
    ["OFF", "23"],
    [null, "23"],
  ]) {
    const start = await switchNoticeStart(dbFor(shift ? { shift } : null), "nurse", date);
    assert.equal(
      new Date(start).toISOString(),
      expected === "23" ? "2044-01-03T23:00:00.000Z" : `2044-01-04T${expected}:00:00.000Z`,
    );
  }
});
