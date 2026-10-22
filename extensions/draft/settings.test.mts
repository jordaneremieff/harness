import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "draft-settings-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("reply check defaults", async () => {
	await withDir(async (dir) => {
		const { values, diagnostics } = readSettings({ agentDir: dir, env: {} });
		assert.deepEqual(diagnostics, []);
		assert.equal(values.enabled, true);
		assert.equal(values.maxChars, 20000);
		assert.equal(values.notifyBand, "amber");
		assert.equal(values.maxFindings, 12);
		assert.equal(values.minScoredFindings, 2);
	});
});

test("environment values override the document", async () => {
	await withDir(async (dir) => {
		await writeFile(
			join(dir, "harness.json"),
			JSON.stringify({ version: 1, draft: { maxChars: 900, notifyBand: "red" } }),
		);
		const { values } = readSettings({ agentDir: dir, env: { PI_DRAFT_MAX_CHARS: "1200", PI_DRAFT_ENABLED: "false" } });
		assert.equal(values.notifyBand, "red");
		assert.equal(values.enabled, false);
		assert.equal(values.maxChars, 1200);
	});
});

test("invalid values fall back to defaults with a diagnostic", async () => {
	await withDir(async (dir) => {
		const { values, diagnostics } = readSettings({
			agentDir: dir,
			env: {
				PI_DRAFT_MAX_CHARS: "5",
				PI_DRAFT_NOTIFY_BAND: "purple",
				PI_DRAFT_MAX_FINDINGS: "1.5",
				PI_DRAFT_ENABLED: "maybe",
			},
		});
		assert.equal(values.notifyBand, "amber");
		assert.equal(values.maxFindings, 12);
		assert.equal(values.enabled, true);
		assert.deepEqual(
			diagnostics.map((item) => item.code),
			["invalid", "invalid", "invalid", "invalid"],
		);
	});
});
