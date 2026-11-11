import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { CLAIM_BYTES, classifyClaim, classifyProcessClaim, observeClaim, observeClaimAsync, readClaimFile } from "./claims.ts";
it("async observation shares diagnostic, missing, invalid, and bounded claim behavior", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	const live = { ...identity, token: "writer", host: hostname(), pid: process.pid, createdAt: new Date().toISOString() };
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
it("same-host absence ends only the recorded native generation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	const probe = t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("not running"), { code: "ESRCH" });
	});
	writeFileSync(
		path,
		JSON.stringify({ ...identity, token: "writer", host: hostname(), pid: 12345, createdAt: new Date().toISOString() }),
	);
	assert.deepEqual(await observeClaimAsync(path, identity), { kind: "dead", label: "PID 12345", writerId: "writer" });
	assert.deepEqual(await observeClaimAsync(path, identity), observeClaim(path, identity));
	assert.equal(probe.mock.callCount(), 3);
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

it("native end evidence validates generation, host, token and canonical time order", (t) => {
	const identity = { sessionId: "native", cwd: process.cwd() };
	const claim = { ...identity, token: "writer", host: hostname(), pid: 12345, createdAt: "2026-01-01T00:00:00.000Z" };
	const probe = t.mock.method(process, "kill", (): true => true);
	assert.equal(classifyClaim(claim, identity).kind, "unknown", "a present or reused PID proves no native liveness");
	probe.mock.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
	assert.equal(classifyClaim(claim, identity).kind, "unknown");
	probe.mock.mockImplementation(() => { throw Object.assign(new Error("failed"), { code: "EIO" }); });
	assert.equal(classifyClaim(claim, identity).kind, "unknown");
	const before = probe.mock.callCount();
	const end = { ...claim, endedAt: "2026-01-01T00:00:01.000Z" };
	assert.deepEqual(classifyClaim(end, identity), { kind: "dead", label: "PID 12345", writerId: "writer", endedAt: end.endedAt });
	for (const invalid of [{ ...end, host: "foreign-host" }, { ...end, token: "" }, { ...end, token: "x".repeat(257) }, { ...end, endedAt: "2025-12-31T23:59:59.000Z" }, { ...end, endedAt: "2026-01-01" }, { ...end, endedAt: null }])
		assert.equal(classifyClaim(invalid, identity).kind, "unknown");
	assert.equal(probe.mock.callCount(), before, "invalid or clean-end metadata never needs a process probe");
});
