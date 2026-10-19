import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  configuredStart,
  creditedAttendanceHours,
} = require("../nurse-api/lib/configured-attendance");
const definition = {
  startsAt: "2044-01-04T19:00:00.000Z",
  endsAt: "2044-01-05T03:30:00.000Z",
  breakMinutes: 30,
  creditedMinutes: 480,
};
test("configured sign-in uses server time and frozen end instead of client-supplied hours", () => {
  const start = configuredStart(
    definition,
    { started_at: "1999-01-01", expected_end_at: "2099-01-01", hours_logged: 999, is_late: true },
    { now: new Date("2044-01-04T18:50:00Z") },
  );
  assert.equal(start.started_at, definition.startsAt);
  assert.equal(start.expected_end_at, definition.endsAt);
  assert.equal(start.hours_logged, null);
  assert.equal(start.is_late, false);
});
test("after-midnight sign-in retains the previous day's overnight window", () => {
  const start = configuredStart(definition, {}, { now: new Date("2044-01-05T01:00:00Z") });
  assert.equal(start.expected_end_at, definition.endsAt);
  assert.equal(start.late_minutes, 360);
});
test("configured sign-in rejects early, ended and forged completed attendance", () => {
  for (const instant of ["2044-01-04T18:44:59Z", definition.endsAt])
    assert.throws(
      () => configuredStart(definition, {}, { now: new Date(instant) }),
      (e) => e.status === 409,
    );
  assert.throws(
    () =>
      configuredStart(
        definition,
        { ended_at: definition.endsAt },
        { now: new Date(definition.startsAt) },
      ),
    (e) => e.status === 400,
  );
});
test("missed attendance is permitted only after the configured window and always credits zero", () => {
  assert.throws(
    () => configuredStart(definition, { is_missed: true }, { now: new Date(definition.startsAt) }),
    (e) => e.status === 409,
  );
  const missed = configuredStart(
    definition,
    { is_missed: true, hours_logged: 99 },
    { now: new Date(definition.endsAt) },
  );
  assert.equal(missed.hours_logged, 0);
  assert.equal(missed.ended_at, definition.endsAt);
});
test("attendance credits deduct the break once, clip to the window and cap the saved allowance", () => {
  assert.equal(creditedAttendanceHours(definition, definition.startsAt, definition.endsAt), 8);
  assert.equal(
    creditedAttendanceHours(definition, "2044-01-04T18:00:00Z", "2044-01-05T05:00:00Z"),
    8,
  );
  assert.equal(creditedAttendanceHours(definition, "2044-01-04T20:00:00Z", definition.endsAt), 7);
  assert.equal(creditedAttendanceHours(definition, definition.startsAt, "2044-01-04T19:15:00Z"), 0);
  assert.equal(
    creditedAttendanceHours(
      { ...definition, creditedMinutes: 420 },
      definition.startsAt,
      definition.endsAt,
    ),
    7,
  );
});
