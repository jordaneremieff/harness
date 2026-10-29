import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

test("unknown fields and an invalid selected note switch share the diagnostic bound", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "registry-notes-settings-"));
	try {
		const registry = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`unknown${i}`, true]));
		writeFileSync(join(agentDir, "harness.json"), JSON.stringify({ version: 1, registry }));
		const snapshot = readSettings({ agentDir, env: { PI_REGISTRY_NOTES: "invalid" } });
		assert.equal(snapshot.diagnostics.length, 257);
		assert.equal(snapshot.diagnostics[256].code, "coverage");
		assert.equal(snapshot.values.notes, true);
		assert.equal(snapshot.records[0].status, "invalid");
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});
