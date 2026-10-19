import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const {
  configuredShiftReminders,
  escapeReminderHtml,
} = require("../nurse-api/lib/configured-shift-reminders");
const cell = {
  id: "a1",
  nurse_id: "n1",
  shift: "E",
  shift_date: "2044-01-04",
  shift_definition_run_id: "r1",
  name: "Demo",
  email: "demo@example.invalid",
  profile_id: "p1",
};
const run = {
  id: "r1",
  configuration_snapshot: {
    timezone: "Asia/Kolkata",
    shifts: [
      {
        code: "E",
        name: "Evening <duty>",
        start: "20:00",
        end: "04:00",
        endDayOffset: 1,
        breakMinutes: 30,
        creditedMinutes: 450,
      },
    ],
  },
};
const db = (runs = [run]) => ({
  query: async (sql) => ({ rows: sql.includes("FROM scheduling_runs") ? runs : [cell] }),
});

test("configured start reminders use the saved timezone and include the exact lead boundary", async () => {
  for (const [now, count] of [
    ["2044-01-04T14:14:59Z", 0],
    ["2044-01-04T14:15:00Z", 1],
    ["2044-01-04T14:30:00Z", 0],
  ]) {
    const result = await configuredShiftReminders(db(), "start", 15, new Date(now));
    assert.equal(result.rows.length, count);
    if (count) assert.equal(result.rows[0].scheduled_shift.name, "Evening <duty>");
  }
});
test("late reminders stop at the saved overnight end", async () => {
  for (const [now, count] of [
    ["2044-01-04T17:29:59Z", 0],
    ["2044-01-04T17:30:00Z", 1],
    ["2044-01-04T22:29:59Z", 1],
    ["2044-01-04T22:30:00Z", 0],
  ])
    assert.equal(
      (await configuredShiftReminders(db(), "missed", 3, new Date(now))).rows.length,
      count,
    );
});
test("missing saved definitions skip reminders with an actionable assignment identifier", async () => {
  const result = await configuredShiftReminders(
    db([]),
    "start",
    15,
    new Date("2044-01-04T14:15:00Z"),
  );
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors[0].assignmentId, "a1");
});
test("invalid reminder thresholds fail closed", async () => {
  for (const threshold of [-1, NaN, Infinity])
    await assert.rejects(configuredShiftReminders(db(), "start", threshold));
  assert.equal(escapeReminderHtml('<a title="x">&\''), "&lt;a title=&quot;x&quot;&gt;&amp;&#39;");
});

for (const kind of ["start", "missed"])
  test(`${kind} job sends saved labels once and escapes configured text`, async () => {
    const sent = [],
      keys = new Set(),
      sqls = [],
      errors = [];
    const pool = {
      query: async (sql, params) => {
        sqls.push(sql);
        if (sql.includes("INSERT INTO notification_state")) {
          const key = params.join(":");
          const rowCount = keys.has(key) ? 0 : 1;
          keys.add(key);
          return { rowCount };
        }
        return { rows: [] };
      },
    };
    const module = { exports: {} };
    const deps = {
      "node-cron": {},
      "../lib/tenant-context": require("../nurse-api/lib/tenant-context.js"),
      "../db": pool,
      "../lib/mailer": {
        sendMail: async (data) => sent.push(data),
        portalUrl: () => "https://example.invalid/shift",
      },
      "../lib/shift-reminder-settings": {
        getShiftReminderSettings: async () => ({
          upcoming_shift_minutes: 15,
          missed_shift_hours: 3,
        }),
      },
      "../lib/configured-shift-reminders": {
        escapeReminderHtml,
        configuredShiftReminders: async () => ({
          rows: [{ ...cell, scheduled_shift: { name: "Evening <duty>" } }],
          errors: [],
        }),
      },
    };
    vm.runInNewContext(
      readFileSync(
        new URL(`../nurse-api/jobs/auto-shift-${kind}-reminder.js`, import.meta.url),
        "utf8",
      ),
      {
        module,
        require: (name) => deps[name],
        console: { log: () => {}, error: (...args) => errors.push(args) },
      },
    );
    const execute =
      module.exports[kind === "start" ? "runSendReminderEmails" : "runSendMissedReminderEmails"];
    await execute();
    await execute();
    assert.deepEqual(errors, []);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Evening <duty>/);
    assert.match(sent[0].bodyHtml, /Evening &lt;duty&gt;/);
    assert.ok(
      sqls.some((sql) =>
        sql.includes("COALESCE(sa.shift_definition_run_id,sa.scheduling_run_id) IS NULL"),
      ),
    );
  });
