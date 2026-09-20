import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const ignoreFile = new URL("../.npmignore", import.meta.url);

test("the install archive excludes local evaluation and session state", { timeout: 35_000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "harness-package-test-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "packed");
		mkdirSync(source);
		mkdirSync(destination);
		writeFileSync(join(source, "package.json"), JSON.stringify({ name: "package-fixture", version: "1.0.0" }));
		writeFileSync(join(source, ".npmignore"), readFileSync(ignoreFile));
		writeFileSync(join(source, "README.md"), "Package fixture.\n");
		writeFileSync(join(source, "runtime.ts"), "export const enabled = true;\n");
		for (const path of [".evals/run/execution.json", ".pi/session.json", "dump/probe.txt", "output.log", "capture.zip"]) {
			const file = join(source, path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "synthetic local state\n");
		}
		const packed = spawnSync(
			"npm",
			["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", destination],
			{
				cwd: source,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
					NPM_CONFIG_CACHE: join(root, "cache"),
				},
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 1024 * 1024,
			},
		);
		assert.equal(packed.error, undefined);
		assert.equal(packed.status, 0, packed.stderr);
		const [archive] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
		assert.ok(archive);
		assert.ok(existsSync(join(destination, archive.filename)));
		assert.deepEqual(
			archive.files.map((file) => file.path).sort(),
			["README.md", "package.json", "runtime.ts"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
