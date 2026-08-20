import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = join(
	dirname(fileURLToPath(import.meta.url)),
	"check-slices.mts",
);

test("ignores a tracked document deleted from the working tree", () => {
	const root = mkdtempSync(join(tmpdir(), "check-slices-deletion-"));
	try {
		const scripts = join(root, "scripts");
		const extension = join(root, "extensions", "example");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(extension, { recursive: true });
		copyFileSync(sourceScript, join(scripts, "check-slices.mts"));
		writeFileSync(
			join(extension, "index.ts"),
			"export default function () {}\n",
		);
		writeFileSync(join(extension, "README.md"), "# Example\n");
		writeFileSync(join(extension, "index.test.mts"), "// fixture\n");
		const removed = join(extension, "DESIGN.md");
		writeFileSync(removed, "# Retired design\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["add", "."], { cwd: root });
		rmSync(removed);

		const result = spawnSync(
			process.execPath,
			[join(scripts, "check-slices.mts")],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /check-slices: ok/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
