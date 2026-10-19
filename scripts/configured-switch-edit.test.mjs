import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
const require = createRequire(new URL("../nurse-api/package.json", import.meta.url));
const guard = require("./lib/configured-switch-guard");
const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
test("request creation rejects malformed dates before database access", async () => {
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(new URL("../nurse-api/routes/leave-requests.js", import.meta.url), "utf8"),
    {
      module,
      require: (name) => {
        if (name === "express") return require("express");
        if (name === "../lib/configured-scheduler") return require("./lib/configured-scheduler");
        if (name === "../middleware/auth") return { requireRole: () => (req, res, next) => next() };
        if (name === "../db")
          return {
            query: () => assert.fail("Must reject before database access"),
            connect: () => assert.fail("Must not connect"),
          };
        return {};
      },
    },
  );
  const handler = module.exports.stack.find(
    (layer) => layer.route?.path === "/" && layer.route.methods.post,
  ).route.stack[0].handle;
  for (const date of ["2044-02-30", "2044-01-04T00:00:00Z", "tomorrow", 20440104, null]) {
    for (const field of ["from_date", "to_date"]) {
      let status;
      const res = {
        status: (value) => {
          status = value;
          return res;
        },
        json: () => {},
      };
      await handler(
        {
          body: {
            nurse_name: "Test",
            type: "Swap",
            from_date: "2044-01-04",
            to_date: "2044-01-04",
            [field]: date,
          },
        },
        res,
        (error) => {
          throw error;
        },
      );
      assert.equal(status, 400);
    }
  }
});
for (const [label, body] of [
  ["leave-cover edit without leave", { reason: `SHIFT_SWITCH|${b}|Partner|M|OFF|LEAVE_COVER` }],
  ["stale duty edit", { reason: `SHIFT_SWITCH|${b}|Partner|N|OFF` }],
  ["late notice edit", { reason: `SHIFT_SWITCH|${b}|Partner|M|OFF|NOTE:Changed` }],
  ["invalid date edit", { from_date: "2044-02-30" }],
  ["null date edit", { to_date: null }],
  ["timestamp date edit", { from_date: "2044-01-04T00:00:00Z" }],
])
  test(`pending configured switch PATCH rolls back ${label}`, async () => {
    const queries = [];
    let released = false;
    const client = {
      release: () => {
        released = true;
      },
      query: async (sql) => {
        queries.push(sql);
        if (sql.includes("FROM leave_requests"))
          return {
            rows: [
              {
                id: "request",
                nurse_id: a,
                type: "Swap",
                status: "Pending",
                from_date: "2044-01-04",
                to_date: "2044-01-04",
                reason: `SHIFT_SWITCH|${b}|Partner|M|OFF`,
              },
            ],
          };
        if (sql.includes("FROM shift_assignments"))
          return {
            rows: [
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
                scheduling_run_id: "run",
              },
            ],
          };
        assert.ok(["BEGIN", "ROLLBACK"].includes(sql), `Unexpected mutation: ${sql}`);
        return { rows: [] };
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      readFileSync(new URL("../nurse-api/routes/leave-requests.js", import.meta.url), "utf8"),
      {
        module,
        console: { error: () => {} },
        require: (name) => {
          if (name === "express") return require("express");
          if (name === "../db") return { connect: async () => client };
          if (name === "../lib/configured-switch-guard") return guard;
          if (name === "../lib/configured-scheduler") return require("./lib/configured-scheduler");
          if (name === "../lib/leave-settings")
            return { getShiftSwitchMinNoticeHours: async () => 24 };
          if (name === "../lib/switch-notice-start")
            return {
              validateSwitchNotice: async (db, nurseId, date, hours) => {
                assert.equal(db, client);
                assert.equal(nurseId, a);
                assert.equal(date, "2044-01-04");
                assert.equal(hours, 24);
                throw Object.assign(new Error("Insufficient notice"), {
                  code: "SWITCH_MIN_NOTICE_NOT_MET",
                });
              },
            };
          if (name === "../middleware/auth")
            return { requireRole: () => (req, res, next) => next() };
          return {};
        },
      },
    );
    const handler = module.exports.stack.find(
      (layer) => layer.route?.path === "/:id" && layer.route.methods.patch,
    ).route.stack[0].handle;
    let status, payload;
    const res = {
      status: (value) => {
        status = value;
        return res;
      },
      json: (value) => {
        payload = value;
      },
    };
    await handler(
      { user: { userId: a, roles: ["admin"] }, params: { id: "request" }, body },
      res,
      (error) => {
        throw error;
      },
    );
    assert.equal(
      status,
      label.includes("date edit") ? 400 : label === "late notice edit" ? 422 : 409,
    );
    assert.ok(payload.error);
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(released, true);
  });
