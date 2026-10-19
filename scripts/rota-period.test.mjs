import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/rota-window.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { addDaysYmd, rememberRotaPeriod, rotaPeriodEndFor, rotaPeriodLabel, rotaToday } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("calendar-month periods are labelled by month; other periods by their dates", () => {
  assert.equal(rotaPeriodLabel("2027-01-01", "2027-01-31"), "January 2027");
  assert.equal(rotaPeriodLabel("2028-02-01", "2028-02-29"), "February 2028");
  assert.equal(rotaPeriodLabel("2026-10-19", "2026-10-31"), "19 Oct – 31 Oct 2026");
  assert.equal(rotaPeriodLabel("2026-09-21", "2026-10-18"), "21 Sept – 18 Oct 2026");
  assert.match(rotaToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test("period ends: month end from the 1st, 28 days for legacy starts, server answers win", () => {
  assert.equal(rotaPeriodEndFor("2027-02-01"), "2027-02-28");
  assert.equal(rotaPeriodEndFor("2026-12-01T00:00:00Z"), "2026-12-31");
  assert.equal(rotaPeriodEndFor("2026-09-21"), "2026-10-18");
  rememberRotaPeriod("2026-10-19", "2026-10-31");
  assert.equal(rotaPeriodEndFor("2026-10-19"), "2026-10-31");
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysYmd("2027-03-01", -1), "2027-02-28");
});

function archiveFixture({ locked = true, period = true, failArchive = false, ready = true } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("pg_try_advisory")) return { rows: [{ locked }] };
      if (sql.includes("WITH published")) {
        return { rows: period ? [{ period_start: "2026-08-24", period_end: "2026-09-20" }] : [] };
      }
      if (sql.includes("SELECT n.id AS nurse_id")) {
        return { rows: [{ nurse_id: "nurse-1", total_hours: 150, total_shifts: 12 }] };
      }
      if (failArchive && sql.includes("INSERT INTO nurse_period_hours"))
        throw new Error("archive failed");
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(new URL("../nurse-api/lib/auto-close-period.js", import.meta.url), "utf8"),
    {
      module,
      require: (name) =>
        name === "../db"
          ? { connect: async () => client }
          : {
              periodShiftReadiness: async () => ({
                ready,
                reason: "A scheduled shift has not ended",
                assignmentId: "a1",
              }),
            },
    },
  );
  return { close: module.exports.closeCompletedPeriod, calls, released: () => released };
}

test("closure finalizes logs before aggregating and preserves new-period hours", async () => {
  const f = archiveFixture();
  assert.equal((await f.close()).closed, true);
  const sql = f.calls.map((c) => c.sql);
  assert.equal(sql[0], "BEGIN");
  assert.ok(
    sql.findIndex((s) => s.includes("SET ended_at")) <
      sql.findIndex((s) => s.includes("SELECT n.id")),
  );
  const archive = f.calls.find((c) => c.sql.includes("INSERT INTO nurse_period_hours"));
  assert.deepEqual(Array.from(archive.params), ["nurse-1", "2026-08-24", "2026-09-20", 150, 12]);
  assert.match(
    sql.find((s) => s.includes("UPDATE nurses")),
    /sl.shift_date > \(SELECT MAX\(period_end\)/,
  );
  assert.equal(sql.at(-1), "COMMIT");
  assert.equal(f.released(), true);
});

test("closure rolls back without resetting counters when archiving fails", async () => {
  const f = archiveFixture({ failArchive: true });
  await assert.rejects(f.close(), /archive failed/);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
  assert.equal(
    f.calls.some((c) => c.sql.includes("UPDATE nurses")),
    false,
  );
  assert.equal(f.released(), true);
});

test("an unfinished saved shift holds the archive without changing logs or counters", async () => {
  const f = archiveFixture({ ready: false });
  const result = await f.close();
  assert.equal(result.closed, false);
  assert.equal(result.assignmentId, "a1");
  assert.equal(
    f.calls.some((c) => /UPDATE|INSERT/.test(c.sql)),
    false,
  );
  assert.equal(f.calls.at(-1).sql, "COMMIT");
  assert.equal(f.released(), true);
});

test("overlapping jobs and no eligible period produce no data changes", async () => {
  for (const options of [{ locked: false }, { period: false }]) {
    const f = archiveFixture(options);
    assert.equal((await f.close()).closed, false);
    assert.equal(
      f.calls.some((c) => /^(UPDATE|INSERT)/.test(c.sql.trim())),
      false,
    );
    assert.equal(f.released(), true);
  }
});

test("archive candidates use full periods, wait for overnight shifts and catch up oldest-first", async () => {
  const f = archiveFixture({ period: false });
  await f.close();
  const sql = f.calls.find((c) => c.sql.includes("WITH published")).sql;
  assert.match(sql, /rota_period_start\(d\) AS period_start, rota_period_end\(d\) AS period_end/);
  assert.match(sql, /\(period_end \+ 1\)::timestamp AT TIME ZONE 'Africa\/Lagos'/);
  assert.match(sql, /sl.expected_end_at > NOW\(\)/);
  assert.match(sql, /nph.period_end = periods.period_end/);
  assert.match(sql, /ORDER BY periods.period_end ASC/);
});
