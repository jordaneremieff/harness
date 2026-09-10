import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveLoaderPath } from "./extension-load-check.mts";

test("loader discovery supports the current bundled CLI layout", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-loader-layout-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dist = join(root, "installed", "dist");
	const binary = join(dist, "bundle", "cli.js");
	const loader = join(dist, "core", "extensions", "loader.js");
	await mkdir(join(dist, "bundle"), { recursive: true });
	await mkdir(join(dist, "core", "extensions"), { recursive: true });
	await writeFile(binary, "");
	await writeFile(loader, "");
	assert.equal(resolveLoaderPath(root, { binaryPath: binary }), await realpath(loader));

	const local = join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"core",
		"extensions",
		"loader.js",
	);
	await mkdir(join(local, ".."), { recursive: true });
	await writeFile(local, "");
	assert.equal(resolveLoaderPath(root, { binaryPath: binary }), local);
});
