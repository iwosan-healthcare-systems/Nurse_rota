// Start an isolated, disposable local PostgreSQL instance. Never reads .env.
// Usage: node scripts/test-scheduling-postgres.mjs [path-to-postgres-bin]
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const bin =
  process.argv[2] ||
  (process.platform === "win32" ? "C:/Program Files/PostgreSQL/17/bin" : "/usr/bin");
const executable = (name) => path.join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(executable("initdb")))
  throw new Error("Pass the directory containing initdb and pg_ctl.");
const root = realpathSync(tmpdir());
const directory = mkdtempSync(path.join(root, "nurse-rota-scheduling-test-"));
const data = path.join(directory, "data");
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const run = (command, args, extra = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...extra });
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
};
let started = false;
try {
  run(executable("initdb"), [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
  ]);
  run(
    executable("pg_ctl"),
    [
      "-D",
      data,
      "-l",
      path.join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ],
    { stdio: "ignore" },
  );
  started = true;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      fileURLToPath(
        new URL(
          `./${process.env.POSTGRES_TEST_FILE || "scheduling-postgres.integration.mjs"}`,
          import.meta.url,
        ),
      ),
    ],
    {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        SCHEDULING_TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  if (started) run(executable("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  // Only remove the exact directory we just created, inside the OS temp root.
  const resolved = realpathSync(directory);
  if (
    path.dirname(resolved) !== root ||
    !path.basename(resolved).startsWith("nurse-rota-scheduling-test-")
  )
    throw new Error("Unexpected temporary directory; refusing cleanup");
  rmSync(resolved, { recursive: true, force: true });
}
