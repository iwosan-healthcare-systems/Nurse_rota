import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/switch-rest.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { switchRestIssue } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const duty = (shift, startsAt, endsAt) => ({ shift, scheduled_shift: { startsAt, endsAt } });
test("saved intervals allow rest even when legacy codes imply a conflict", () => {
  const morning = duty("M", "2044-01-04T10:00:00Z", "2044-01-04T18:00:00Z");
  const night = duty("N", "2044-01-03T18:00:00Z", "2044-01-04T06:00:00Z");
  assert.equal(switchRestIssue(morning, [night]), null);
});
test("custom codes detect touching and overlapping shifts on either side", () => {
  const proposed = duty("EV", "2044-01-04T20:00:00+05:30", "2044-01-05T04:00:00+05:30");
  for (const other of [
    duty("EARLY", "2044-01-04T06:00:00Z", "2044-01-04T14:30:00Z"),
    duty("LATE", "2044-01-04T22:30:00Z", "2044-01-05T06:00:00Z"),
    duty("X", "2044-01-04T16:00:00Z", "2044-01-04T17:00:00Z"),
  ])
    assert.match(switchRestIssue(proposed, [other]), /no rest/);
});
test("unavailable or invalid working intervals fail closed", () => {
  const valid = duty("EV", "2044-01-04T10:00:00Z", "2044-01-04T18:00:00Z");
  for (const invalid of [
    { shift: "X" },
    { ...valid, shift_definition_error: "Missing run" },
    duty("X", "invalid", "invalid"),
  ]) {
    assert.match(switchRestIssue(invalid, []), /unavailable/);
    assert.match(switchRestIssue(valid, [invalid]), /unavailable/);
  }
});
test("OFF and leave do not count as working intervals", () => {
  const valid = duty("EV", "2044-01-04T10:00:00Z", "2044-01-04T18:00:00Z");
  assert.equal(switchRestIssue(valid, [{ ...valid, shift: "LEAVE" }, { shift: "OFF" }]), null);
  assert.equal(switchRestIssue({ shift: "OFF" }, [{ shift: "unknown" }]), null);
});
