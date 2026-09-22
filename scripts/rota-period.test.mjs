import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/rota-window.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { currentRotaStart, rotaToday } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("current period stays put on its last day and advances on the next day", () => {
  assert.equal(currentRotaStart("2026-08-24", "2026-09-20"), "2026-08-24");
  assert.equal(currentRotaStart("2026-08-24", "2026-09-21"), "2026-09-21");
});

test("stale archives catch up across multiple periods without shifting the cycle", () => {
  assert.equal(currentRotaStart("2026-07-27", "2026-09-22"), "2026-09-21");
  assert.equal(currentRotaStart("2026-09-21", "2026-10-19"), "2026-10-19");
});

test("future schedules, timestamp dates, leap days and year changes preserve boundaries", () => {
  assert.equal(currentRotaStart("2026-10-19", "2026-09-22"), "2026-10-19");
  assert.equal(currentRotaStart("2026-08-24T00:00:00Z", "2026-09-22"), "2026-09-21");
  assert.equal(currentRotaStart("2024-02-05", "2024-03-04"), "2024-03-04");
  assert.equal(currentRotaStart("2025-12-15", "2026-01-12"), "2026-01-12");
  assert.match(rotaToday(), /^\d{4}-\d{2}-\d{2}$/);
});

function archiveFixture({ locked = true, period = true, failArchive = false } = {}) {
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
    { module, require: () => ({ connect: async () => client }) },
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
  assert.match(sql, /period_start \+ 27 AS period_end/);
  assert.match(sql, /1 day 8 hours/);
  assert.match(sql, /sl.expected_end_at > NOW\(\)/);
  assert.match(sql, /nph.period_end = periods.period_end/);
  assert.match(sql, /ORDER BY periods.period_end ASC/);
});
