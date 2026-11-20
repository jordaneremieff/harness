import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("ignored visibility defaults to show and selects environment before JSON booleans", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "explorer-settings-"));
	try {
		const file = join(agentDir, "harness.json");
		const read = (raw?: string) => readSettings({ agentDir, env: { PI_EXPLORER_SHOW_IGNORED: raw } });
		assert.equal(read().values.showIgnored, true);
		await writeFile(file, JSON.stringify({ version: 1, explorer: { showIgnored: false } }));
		assert.equal(read().values.showIgnored, false);
		for (const raw of ["1", "true"]) assert.equal(read(raw).values.showIgnored, true);
		for (const raw of ["0", "false"]) assert.equal(read(raw).values.showIgnored, false);
		const invalidEnv = read("");
		assert.equal(invalidEnv.values.showIgnored, true);
		assert.equal(invalidEnv.diagnostics[0]?.source, "env");
		await writeFile(file, JSON.stringify({ version: 1, explorer: { showIgnored: "false" } }));
		const invalidFile = read();
		assert.equal(invalidFile.values.showIgnored, true);
		assert.equal(invalidFile.diagnostics[0]?.source, "file");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
