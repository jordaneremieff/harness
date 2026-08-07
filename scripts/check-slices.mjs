#!/usr/bin/env node
// check-slices.mjs — repo gate for the vertical-slice architecture rules.
//
// Enforces the AGENTS.md invariants that npm test cannot see:
//   1. every extension under extensions/ is a complete vertical slice:
//      index.ts with a default-export factory, README.md, and at least one
//      colocated *.test.mts;
//   2. no extension imports a sibling: no `from "../"`, no absolute import,
//      no path that reaches into another extension's directory;
//   3. no `*.config.json` overlay is tracked by git;
//   4. no hardcoded counts of tests, tools, or files in tracked docs
//      (AGENTS.md: "Do not hardcode counts ... in durable documentation").
//
// Dependency-free by design (node builtins only), mirroring the established
// pattern of skills/harness/scripts/validate-skill.mjs.
//
// Exit status: 0 when all rules hold, 1 listing every violation otherwise.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionsRoot = join(root, "extensions");

const failures = [];
const fail = (message) => failures.push(message);

// --- rule 1: extension anatomy -----------------------------------------

for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const slice = join(extensionsRoot, entry.name);
  const label = `extensions/${entry.name}`;

  const indexFile = join(slice, "index.ts");
  if (!existsSync(indexFile)) {
    fail(`${label}: missing index.ts (every extension registers via index.ts)`);
  } else {
    const source = readFileSync(indexFile, "utf8");
    if (!/\bexport\s+default\b/.test(source)) {
      fail(`${label}: index.ts has no default export (the Pi factory contract)`);
    }
  }
  if (!existsSync(join(slice, "README.md"))) {
    fail(`${label}: missing README.md (every extension documents its own surface)`);
  }
  const tests = readdirSync(slice).filter((name) => name.endsWith(".test.mts"));
  if (tests.length === 0) {
    fail(`${label}: no colocated *.test.mts file`);
  }
}

// --- rule 2: no sibling imports ----------------------------------------

const sourceFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && /\.(ts|mts|mjs)$/.test(entry.name)) sourceFiles.push(path);
  }
};
if (existsSync(extensionsRoot)) walk(extensionsRoot);

const specifierPattern = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

for (const file of sourceFiles) {
  const rel = relative(root, file);
  const sliceName = rel.split(/[\\/]/)[1];
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1];
    if (specifier.startsWith("../")) {
      fail(`${rel}: import "${specifier}" escapes the extension slice`);
    } else if (specifier.startsWith("/")) {
      fail(`${rel}: absolute import "${specifier}"`);
    } else if (/^extensions\//.test(specifier)) {
      fail(`${rel}: import "${specifier}" reaches into extensions/ by path`);
    } else {
      const cross = specifier.match(/\/extensions\/([^/]+)\//);
      if (cross && cross[1] !== sliceName) {
        fail(`${rel}: import "${specifier}" reaches into extension "${cross[1]}"`);
      }
    }
  }
}

// --- rule 3: no tracked per-extension overlay ---------------------------

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
for (const line of tracked.split("\n")) {
  if (line.endsWith(".config.json")) {
    fail(`tracked per-extension overlay: ${line}`);
  }
}

// --- rule 4: no hardcoded counts in tracked docs -----------------------

const countPattern = /\b\d+\s+(test|tests|tool|tools|file|files)\b/g;
for (const doc of tracked.split("\n")) {
  if (!doc.endsWith(".md")) continue;
  const text = readFileSync(join(root, doc), "utf8");
  for (const match of text.matchAll(countPattern)) {
    fail(`${doc}: hardcoded count "${match[0]}"`);
  }
}

// --- report -------------------------------------------------------------

if (failures.length > 0) {
  console.error(`check-slices: ${failures.length} violation(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "check-slices: ok — extension anatomy, slice isolation, overlay tracking, doc counts",
);
