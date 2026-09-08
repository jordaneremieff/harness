import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("real sessions deliver completion before conclusions and stop superseded work", { timeout: 60000 }, () => {
	const child = spawnSync(
		process.execPath,
		[join(dirname(fileURLToPath(import.meta.url)), "completion-delivery-child.mts")],
		{
			encoding: "utf8",
			timeout: 55000,
			maxBuffer: 512 * 1024,
		},
	);
	assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stdout}\n${child.stderr}`);
	assert.match(child.stdout, /completion delivery child: PASS/);
});
