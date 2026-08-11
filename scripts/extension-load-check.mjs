#!/usr/bin/env node

// Proves that extension entrypoints actually load.
//
// `pi --help --offline --extension <path>` exits 0 even when an extension
// factory throws, so it cannot be used as a load gate. This runs Pi's own
// loader and fails on the error list the loader returns.

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export function resolveLoaderPath(repoRoot, options = {}) {
  const local = join(
    repoRoot,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
  );
  if (existsSync(local)) return local;
  const binary = options.binaryPath;
  if (!binary || !existsSync(binary)) return undefined;
  const candidate = join(dirname(realpathSync(binary)), "core", "extensions", "loader.js");
  return existsSync(candidate) ? candidate : undefined;
}

export async function checkExtensionLoad(entrypoints, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const loaderPath = resolveLoaderPath(repoRoot, options);
  if (!loaderPath) {
    return { status: "skipped", reason: "Pi extension loader not found", failures: [] };
  }
  const loader = await import(pathToFileURL(loaderPath).href);
  const runtime = loader.createExtensionRuntime();
  const result = await loader.loadExtensions(
    entrypoints,
    options.cwd ?? repoRoot,
    undefined,
    runtime,
  );
  const failures = (result.errors ?? []).map((entry) => ({
    path: entry.path,
    message: entry.error?.message ?? String(entry.error),
  }));
  return {
    status: failures.length > 0 ? "fail" : "pass",
    loaded: (result.extensions ?? []).length,
    failures,
  };
}

async function main() {
  const entrypoints = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  if (entrypoints.length === 0) {
    throw new Error("Usage: extension-load-check.mjs <entrypoint> [entrypoint...]");
  }
  const which = process.env.PATH?.split(":")
    .map((directory) => join(directory, "pi"))
    .find((candidate) => existsSync(candidate));
  const outcome = await checkExtensionLoad(entrypoints.map((path) => resolve(path)), {
    binaryPath: which,
  });
  if (outcome.status === "skipped") {
    console.error(outcome.reason);
    return;
  }
  for (const failure of outcome.failures) {
    console.error(`${failure.path}: ${failure.message}`);
  }
  if (outcome.status === "fail") process.exitCode = 1;
  else console.log(`Loaded ${outcome.loaded} extension${outcome.loaded === 1 ? "" : "s"}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
