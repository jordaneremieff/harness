import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readSettings } from "./settings.ts";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "proof-settings-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("defaults, with the meter path derived from the package root", async () => {
	await withDir(async (dir) => {
		const { values, diagnostics } = readSettings({ agentDir: dir, env: {} });
		assert.deepEqual(diagnostics, []);
		assert.equal(values.enabled, true);
		assert.equal(values.meterPath, join(packageRoot, "skills", "draft", "scripts", "meter.mts"));
		assert.equal(values.timeoutMs, 5000);
		assert.equal(values.maxChars, 20000);
		assert.equal(values.notifyBand, "amber");
		assert.equal(values.maxFindings, 12);
		assert.equal(values.minScoredFindings, 2);
	});
});

test("environment values override the document", async () => {
	await withDir(async (dir) => {
		await writeFile(join(dir, "harness.json"), JSON.stringify({ version: 1, proof: { timeoutMs: 900, notifyBand: "red" } }));
		const { values } = readSettings({ agentDir: dir, env: { PI_PROOF_TIMEOUT_MS: "1200", PI_PROOF_ENABLED: "false", PI_PROOF_METER_PATH: "meter.mts" } });
		assert.equal(values.timeoutMs, 1200);
		assert.equal(values.notifyBand, "red");
		assert.equal(values.enabled, false);
		assert.equal(values.meterPath, join(dir, "meter.mts"));
	});
});

test("invalid values fall back to defaults with a diagnostic", async () => {
	await withDir(async (dir) => {
		const { values, diagnostics } = readSettings({
			agentDir: dir,
			env: { PI_PROOF_TIMEOUT_MS: "5", PI_PROOF_NOTIFY_BAND: "purple", PI_PROOF_MAX_FINDINGS: "1.5", PI_PROOF_ENABLED: "maybe" },
		});
		assert.equal(values.timeoutMs, 5000);
		assert.equal(values.notifyBand, "amber");
		assert.equal(values.maxFindings, 12);
		assert.equal(values.enabled, true);
		assert.deepEqual(diagnostics.map((item) => item.code), ["invalid", "invalid", "invalid", "invalid"]);
	});
});
