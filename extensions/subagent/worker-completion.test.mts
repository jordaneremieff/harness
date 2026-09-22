import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("worker submission settles after the complete batch without another provider request", { timeout: 60000 }, () => {
	const child = spawnSync(
		process.execPath,
		[join(dirname(fileURLToPath(import.meta.url)), "worker-completion-child.mts")],
		{
			encoding: "utf8",
			timeout: 55000,
			maxBuffer: 512 * 1024,
		},
	);
	assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
	assert.match(child.stdout, /worker completion child: PASS/);
});
