import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

for (const outcome of ["pass", "failure", "timeout"] as const) {
	it(`detached evidence ${outcome === "pass" ? "stays absent on success" : `survives ${outcome} before cleanup`}`, () => {
		const root = mkdtempSync(join(tmpdir(), "agent-evidence-"));
		const evidenceRoot = join(root, "evidence");
		mkdirSync(evidenceRoot);
		const log = join(evidenceRoot, "child.log");
		writeFileSync(log, `${"x".repeat(9000)}child log tail`);
		const record = join(evidenceRoot, "run.json");
		writeFileSync(record, '{"state":"running"}');
		const fixture = join(root, "fixture.mts");
		writeFileSync(fixture, `
import { it } from "node:test";
import { watch, writeFileSync } from "node:fs";
import { detachedTestEvidence } from ${JSON.stringify(new URL("./test-detached-evidence.mts", import.meta.url).href)};
it("fixture", { timeout: 100 }, async (t) => {
	const root = ${JSON.stringify(evidenceRoot)};
	const evidence = detachedTestEvidence(t, root, { log: ${JSON.stringify(log)}, record: ${JSON.stringify(record)}, missing: root + "/missing" }, () => ({ stage: "await child exit" }));
	const watcher = watch(root, () => {});
	t.after(() => { watcher.close(); writeFileSync(${JSON.stringify(log)}, "cleanup replaced log"); });
	if (${JSON.stringify(outcome)} === "timeout") await new Promise(() => {});
	if (${JSON.stringify(outcome)} === "failure") {
		try { throw new Error("fixture assertion failed"); }
		catch (error) { evidence.capture(error); throw error; }
	}
	evidence.complete();
});
`);
		try {
			const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", fixture], { encoding: "utf8", timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
			assert.ifError(result.error);
			assert.equal(result.status, outcome === "pass" ? 0 : 1, result.stdout + result.stderr);
			const evidenceFile = join(evidenceRoot, "failure-evidence.json");
			assert.equal(existsSync(evidenceFile), outcome !== "pass");
			if (outcome === "pass") {
				assert.doesNotMatch(result.stdout, /Detached test evidence retained/u);
			} else {
				const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
				assert.equal(evidence.snapshot.stage, "await child exit");
				assert.equal(evidence.files.record.text, '{"state":"running"}');
				assert.match(evidence.files.log.text, /child log tail$/u);
				assert.equal(Buffer.byteLength(evidence.files.log.text), 8192);
				assert.equal(evidence.files.log.omittedBytes, 9000 + "child log tail".length - 8192);
				assert.match(evidence.files.missing.error, /ENOENT/u);
				assert.equal(readFileSync(log, "utf8"), "cleanup replaced log");
				assert.match(result.stdout, /Detached test evidence retained/u);
				assert.match(result.stdout, outcome === "timeout" ? /test timed out/u : /fixture assertion failed/u);
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
