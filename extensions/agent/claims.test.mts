import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { CLAIM_BYTES, classifyProcessClaim, observeClaim, observeClaimAsync, readClaimFile } from "./claims.ts";
it("async observation shares diagnostic, missing, invalid, and bounded claim behavior", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	const live = { ...identity, host: hostname(), pid: process.pid, createdAt: new Date().toISOString() };
	assert.deepEqual(await observeClaimAsync(path, identity), { kind: "absent" });
	for (const value of [
		live,
		{ ...live, sessionId: "other" },
		{ ...live, host: "another-host" },
		"invalid JSON",
		" ".repeat(CLAIM_BYTES + 1),
	]) {
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
		assert.deepEqual(await observeClaimAsync(path, identity), observeClaim(path, identity));
	}
	writeFileSync(path, JSON.stringify(live).padEnd(CLAIM_BYTES, " "));
	assert.equal((await observeClaimAsync(path, identity)).kind, "unknown");
	assert.deepEqual(readClaimFile(path).claim, live);
	const directory = join(root, "directory");
	mkdirSync(directory);
	assert.deepEqual(await observeClaimAsync(directory, identity), observeClaim(directory, identity));
});
it("native diagnostic observation never probes process presence", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	const probe = t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("not running"), { code: "ESRCH" });
	});
	writeFileSync(
		path,
		JSON.stringify({ ...identity, host: hostname(), pid: 12345, createdAt: new Date().toISOString() }),
	);
	assert.deepEqual(await observeClaimAsync(path, identity), { kind: "unknown", label: hostname(), error: "Native claim metadata does not establish a live writer" });
	assert.deepEqual(await observeClaimAsync(path, identity), observeClaim(path, identity));
	assert.equal(probe.mock.callCount(), 0);
});

it("process-lock classification keeps its separate live and dead contract", (t) => {
	const identity = { sessionId: "process-lock", cwd: process.cwd() };
	const claim = { ...identity, host: hostname(), pid: 12345, createdAt: new Date().toISOString() };
	const probe = t.mock.method(process, "kill", (): true => true);
	assert.deepEqual(classifyProcessClaim(claim, identity), { kind: "live", label: "PID 12345" });
	probe.mock.mockImplementation(() => { throw Object.assign(new Error("not running"), { code: "ESRCH" }); });
	assert.deepEqual(classifyProcessClaim(claim, identity), { kind: "dead", label: "PID 12345" });
	assert.equal(probe.mock.callCount(), 2);
});
