import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

it("delivers a preflight event into its own leg and keeps a queued resume bounded", async () => {
	const coverage = mkdtempSync(join(tmpdir(), "subagent-activation-race-coverage-"));
	try {
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			[join(dirname(fileURLToPath(import.meta.url)), "activation-race-child.mts")],
			{ encoding: "utf8", timeout: 60_000, maxBuffer: 1_000_000, env: { ...process.env, NODE_V8_COVERAGE: coverage } },
		);
		assert.match(stdout, /activation race child: PASS/, `${stdout}\n${stderr}`);
	} finally {
		rmSync(coverage, { recursive: true, force: true });
	}
});
