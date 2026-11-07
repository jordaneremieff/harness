#!/usr/bin/env node

// Proves that extension entrypoints actually load.
//
// `pi --help --offline --extension <path>` exits 0 even when an extension
// factory throws, so it cannot be used as a load gate. This uses Pi's public
// discovery and load API in isolated cwd and agent directories, then checks
// that every requested entrypoint resolved and that Pi reported no errors.

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface LoadCheckOptions {
	readonly cwd?: string;
	readonly agentDir?: string;
}

function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = error.message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function resolved(path: string): string {
	const absolute = resolve(path);
	return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export async function checkExtensionLoad(entrypoints: string[], options: LoadCheckOptions = {}) {
	const owned: string[] = [];
	const privateDirectory = (prefix: string): string => {
		const directory = mkdtempSync(join(tmpdir(), prefix));
		owned.push(directory);
		return directory;
	};
	const cwd = options.cwd ?? privateDirectory("pi-load-check-cwd-");
	const agentDir = options.agentDir ?? privateDirectory("pi-load-check-agent-");
	try {
		const result = await discoverAndLoadExtensions(entrypoints, cwd, agentDir);
		const loaded = result.extensions.map((extension) => resolved(extension.resolvedPath));
		const expected = [...new Set(entrypoints.map(resolved))];
		const failures = result.errors.map((entry) => ({
			path: entry.path,
			message: errorMessage(entry.error),
		}));
		const missing = expected.filter((path) => !loaded.includes(path));
		return {
			status: failures.length > 0 || missing.length > 0 ? "fail" : "pass",
			loaded: loaded.length,
			expected: expected.length,
			failures,
			missing,
		};
	} finally {
		for (const directory of owned) rmSync(directory, { recursive: true, force: true });
	}
}

async function main() {
	const entrypoints = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
	if (entrypoints.length === 0) {
		throw new Error("Usage: extension-load-check.mts <entrypoint> [entrypoint...]");
	}
	const outcome = await checkExtensionLoad(entrypoints.map((path) => resolve(path)));
	for (const failure of outcome.failures) {
		console.error(`${failure.path}: ${failure.message}`);
	}
	for (const path of outcome.missing) {
		console.error(`${path}: Pi did not load the requested extension entrypoint`);
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
