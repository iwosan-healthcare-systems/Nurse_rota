import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { guardLegacySwitchApproval } = require("../nurse-api/lib/configured-switch-guard");
const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const request = { nurse_id: a, reason: `SHIFT_SWITCH|${b}|Partner|M|OFF` };
const { guardConfiguredSwitchRequest } = require("../nurse-api/lib/configured-switch-guard");
const datedRequest = { ...request, from_date: "2044-01-04", to_date: "2044-01-04" };
const cells = [
  {
    nurse_id: a,
    shift: "M",
    ward: "ICU",
    facility: "Hospital",
    status: "published",
    scheduling_run_id: "run",
  },
  {
    nurse_id: b,
    shift: "OFF",
    ward: "ICU",
    facility: "Hospital",
    status: "published",
    shift_definition_run_id: "run",
  },
];
test("configured request guard accepts same-ward published duties and leaves legacy requests alone", async () => {
  await guardConfiguredSwitchRequest(
    {
      query: async (sql, params) => {
        assert.deepEqual(params, [[a, b], datedRequest.from_date, datedRequest.to_date]);
        return { rows: cells };
      },
    },
    datedRequest,
  );
  await guardConfiguredSwitchRequest({ query: async () => ({ rows: [] }) }, datedRequest);
});
test("configured request guard rejects unsupported or stale combinations before request creation", async () => {
  for (const patch of [
    { shift_definition_run_id: null },
    { ward: null },
    { ward: "Other" },
    { facility: "Other" },
    { shift: "LEAVE" },
    { status: "draft" },
    { shift: "N" },
  ])
    await assert.rejects(
      guardConfiguredSwitchRequest(
        { query: async () => ({ rows: [cells[0], { ...cells[1], ...patch }] }) },
        datedRequest,
      ),
      { code: "CONFIGURED_EDIT_INVALID" },
    );
  for (const patch of [{ reason: `${request.reason}|LEAVE_COVER` }, { to_date: "2044-01-05" }])
    await assert.rejects(
      guardConfiguredSwitchRequest(
        { query: async () => ({ rows: cells }) },
        { ...datedRequest, ...patch },
      ),
      { code: "CONFIGURED_EDIT_INVALID" },
    );
  await assert.rejects(
    guardConfiguredSwitchRequest({ query: async () => ({ rows: [cells[0]] }) }, datedRequest),
    /Both duties/,
  );
});
test("configured request guard accepts inter-ward exchanges and leave cover", async () => {
  const otherWard = [cells[0], { ...cells[1], ward: "Theatre" }];
  await assert.rejects(
    guardConfiguredSwitchRequest({ query: async () => ({ rows: otherWard }) }, datedRequest),
    /inter-ward/,
  );
  await guardConfiguredSwitchRequest(
    { query: async () => ({ rows: otherWard }) },
    { ...datedRequest, reason: `${request.reason}|INTER_WARD` },
  );
  const onLeave = [{ ...cells[0], shift: "LEAVE", pre_leave_shift: "EVE" }, otherWard[1]];
  await guardConfiguredSwitchRequest(
    { query: async () => ({ rows: onLeave }) },
    { ...datedRequest, reason: `SHIFT_SWITCH|${b}|Partner|EVE|OFF|LEAVE_COVER` },
  );
  await assert.rejects(
    guardConfiguredSwitchRequest(
      { query: async () => ({ rows: onLeave }) },
      { ...datedRequest, reason: `SHIFT_SWITCH|${b}|Partner|M|OFF|LEAVE_COVER` },
    ),
    /no longer matches/,
  );
  await assert.rejects(
    guardConfiguredSwitchRequest(
      { query: async () => ({ rows: [onLeave[0], cells[1]] }) },
      datedRequest,
    ),
    /leave-cover/,
  );
});
test("legacy switch guard scopes both participants and rejects configured participation", async () => {
  const db = {
    query: async (sql, params) => {
      assert.deepEqual(params, [[a, b], "2026-10-12", "2026-10-12"]);
      return { rows: [{ id: "configured" }] };
    },
  };
  await assert.rejects(
    guardLegacySwitchApproval(db, request, "2026-10-12", "2026-10-12"),
    /atomic reviewed/,
  );
  await guardLegacySwitchApproval(
    { query: async () => ({ rows: [] }) },
    request,
    "2026-10-12",
    "2026-10-12",
  );
});
test("malformed partner data cannot bypass the switch guard", async () => {
  await assert.rejects(
    guardLegacySwitchApproval(
      { query: () => assert.fail("must not query") },
      { ...request, reason: "invalid" },
      "2026-10-12",
      "2026-10-12",
    ),
    /cannot be verified/,
  );
});
