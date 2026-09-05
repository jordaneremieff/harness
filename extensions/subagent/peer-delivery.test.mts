import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

it("exchanges peer evidence through full Pi sessions without a parent relay", async () => {
	const coverage = mkdtempSync(join(tmpdir(), "subagent-peer-coverage-"));
	try {
		const { stdout, stderr } = await promisify(execFile)(
			process.execPath,
			[join(dirname(fileURLToPath(import.meta.url)), "peer-delivery-child.mts")],
			{ encoding: "utf8", timeout: 45_000, maxBuffer: 1_000_000, env: { ...process.env, NODE_V8_COVERAGE: coverage } },
		);
		assert.match(stdout, /peer delivery child: PASS/, `${stdout}\n${stderr}`);
	} finally {
		rmSync(coverage, { recursive: true, force: true });
	}
});
