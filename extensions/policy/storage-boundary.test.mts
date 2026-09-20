/** Nonregular storage paths must return health evidence rather than wait for a peer. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

it("refuses FIFO rule and telemetry files without a blocked reader, writer, or panel", {
	skip: process.platform === "win32",
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "policy-storage-type-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await chmod(dir, 0o700);
	await execute("mkfifo", ["-m", "600", join(dir, "rules.jsonl"), join(dir, "2026-09-20.jsonl")], {
		timeout: 5000,
		maxBuffer: 16384,
	});
	const script = `
		import { RuleRegistry } from ${JSON.stringify(new URL("./local-rules.ts", import.meta.url).href)};
		import { appendRecord } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
		import { readRecentActivity, readFireSummary } from ${JSON.stringify(new URL("./panel.ts", import.meta.url).href)};
		import { constants } from "node:fs";
		import { open } from "node:fs/promises";
		const dir = process.argv[1];
		const registry = new RuleRegistry(dir, { onNotice() {} });
		const snapshot = await registry.snapshot();
		const writeError = await appendRecord(dir, { at: "2026-09-20T12:00:00" });
		const reader = await open(dir + "/2026-09-20.jsonl", constants.O_RDONLY | constants.O_NONBLOCK);
		const connectedWriteError = await appendRecord(dir, { at: "2026-09-20T12:00:00" });
		await reader.close();
		const activity = await readRecentActivity(dir);
		const fires = await readFireSummary(dir);
		console.log(JSON.stringify({ health: snapshot.health, rules: snapshot.records.size, writeError, connectedWriteError, activity, partial: fires.partial }));
	`;
	const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", script, dir], {
		timeout: 10000,
		killSignal: "SIGKILL",
		maxBuffer: 16384,
	});
	const result = JSON.parse(stdout);
	assert.equal(result.health.status, "degraded");
	assert.match(result.health.message, /regular non-symlink file/);
	assert.equal(result.rules, 0);
	assert.ok(result.writeError, "A FIFO is never a successful telemetry append");
	assert.match(result.connectedWriteError, /not a regular file/);
	assert.equal(result.activity.partial, true);
	assert.equal(result.activity.bytesRead, 0);
	assert.equal(result.partial, true);
});
