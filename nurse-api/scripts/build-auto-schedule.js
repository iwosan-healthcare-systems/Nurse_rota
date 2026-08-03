// Ports src/lib/auto-schedule.ts into a plain CommonJS file nurse-api can
// require() directly, so the cron-driven auto-generate job (see
// jobs/auto-generate-rota.js) can call generateSchedule() without a browser.
//
// auto-schedule.ts has zero `import` statements — it's a pure, self-contained
// module — so a straight type-stripping transpile (no module resolution
// needed) is enough; no bundler, no runtime TS dependency in nurse-api.
//
// Run whenever src/lib/auto-schedule.ts changes:
//   node nurse-api/scripts/build-auto-schedule.js
// (also exposed as `npm run build:auto-schedule` from the repo root, since
// the `typescript` package used here lives in the root's node_modules).
//
// The output is checked into git — same convention as src/routeTree.gen.ts —
// so a deployed nurse-api never needs this script or a TS toolchain at
// runtime; it just requires the already-generated file.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const srcPath = path.join(__dirname, "../../src/lib/auto-schedule.ts");
const outPath = path.join(__dirname, "../lib/auto-schedule.generated.js");

const src = fs.readFileSync(srcPath, "utf8");
const { outputText, diagnostics } = ts.transpileModule(src, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    removeComments: false,
  },
  fileName: "auto-schedule.ts",
  reportDiagnostics: true,
});

if (diagnostics && diagnostics.length) {
  console.error(`[build-auto-schedule] ${diagnostics.length} diagnostic(s) during transpile:`);
  for (const d of diagnostics) {
    console.error(" -", ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  }
  process.exit(1);
}

const banner =
  "// AUTO-GENERATED — do not edit by hand.\n" +
  "// Source: src/lib/auto-schedule.ts — regenerate with `npm run build:auto-schedule`.\n\n";

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, banner + outputText);
console.log(`[build-auto-schedule] wrote ${path.relative(process.cwd(), outPath)}`);
