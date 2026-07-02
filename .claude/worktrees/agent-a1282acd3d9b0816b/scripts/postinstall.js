#!/usr/bin/env node
// Re-applies two fixes after every npm/bun install:
//
// 1. Patches @tanstack/router-plugin code-splitter to use double-quoted import
//    paths. The project folder contains an apostrophe ("Ekene's Files") which
//    breaks the single-quoted template strings the plugin generates.
//
// 2. Creates Windows .cmd / .ps1 shims for binaries installed by bun (which
//    only creates Unix symlinks, so "vite", "eslint", "prettier" are invisible
//    to Windows CMD / PowerShell without these wrappers).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const binDir = join(root, "node_modules", ".bin");

// ── 1. Patch compilers.js ────────────────────────────────────────────────────
const compilersPath = join(
  root,
  "node_modules",
  "@tanstack",
  "router-plugin",
  "dist",
  "esm",
  "core",
  "code-splitter",
  "compilers.js",
);

if (existsSync(compilersPath)) {
  let src = readFileSync(compilersPath, "utf8");
  const bad = "import('${splitUrl}')";
  const good = 'import("${splitUrl}")';
  const count = src.split(bad).length - 1;
  if (count > 0) {
    src = src.split(bad).join(good);
    writeFileSync(compilersPath, src);
    console.log(`[postinstall] Patched compilers.js (${count} occurrence${count > 1 ? "s" : ""})`);
  } else {
    console.log("[postinstall] compilers.js already patched – skipping");
  }
} else {
  console.warn("[postinstall] compilers.js not found – skipping patch");
}

// ── 2. Windows .cmd / .ps1 shims ────────────────────────────────────────────
const shims = {
  vite: join(root, "node_modules", "vite", "bin", "vite.js"),
  eslint: join(root, "node_modules", "eslint", "bin", "eslint.js"),
  prettier: join(root, "node_modules", "prettier", "bin", "prettier.cjs"),
};

for (const [name, absTarget] of Object.entries(shims)) {
  if (!existsSync(absTarget)) {
    console.warn(`[postinstall] ${name} binary not found at ${absTarget} – skipping`);
    continue;
  }
  const cmdPath = join(binDir, `${name}.cmd`);
  const ps1Path = join(binDir, `${name}.ps1`);

  if (!existsSync(cmdPath)) {
    const cmd = `@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=node"\r\n"%NODE_EXE%" "${absTarget}" %*\r\nENDLOCAL\r\n`;
    writeFileSync(cmdPath, cmd, "ascii");
    console.log(`[postinstall] Created ${cmdPath}`);
  }
  if (!existsSync(ps1Path)) {
    writeFileSync(ps1Path, `& node "${absTarget}" @args\n`, "utf8");
    console.log(`[postinstall] Created ${ps1Path}`);
  }
}

console.log("[postinstall] Done.");
