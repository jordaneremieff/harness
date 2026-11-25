import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
	CLAIM_BYTES,
	claimFilePresent,
	classifyClaim,
	classifyProcessClaim,
	observeClaim,
	observeClaimAsync,
	readClaimFile,
} from "./claims.ts";
import type { ProcessStartSource } from "./process-start.ts";
it("async observation shares diagnostic, missing, invalid, and bounded claim behavior", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	const live = {
		...identity,
		token: "writer",
		host: hostname(),
		pid: process.pid,
		createdAt: new Date().toISOString(),
	};
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
	probe.mock.mockImplementation(() => {
		throw Object.assign(new Error("not running"), { code: "ESRCH" });
	});
	assert.deepEqual(classifyProcessClaim(claim, identity), { kind: "dead", label: "PID 12345" });
	assert.equal(probe.mock.callCount(), 2);
});

it("an empty claim file records no serving host", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	writeFileSync(path, "");
	assert.deepEqual(observeClaim(path, identity), { kind: "absent" });
	assert.deepEqual(await observeClaimAsync(path, identity), { kind: "absent" });
	assert.equal(readClaimFile(path).claim, undefined);
	assert.equal(claimFilePresent(path), true, "the file itself is still present for guarded cleanup");
	assert.equal(claimFilePresent(join(root, "missing.lock")), false);
});

it("a running process that holds the writer's PID is the writer only when it started before the record", async (t) => {
	const identity = { sessionId: "native", cwd: process.cwd() };
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "claim.lock");
	t.mock.method(process, "kill", (): true => true);
	const started: ProcessStartSource = {
		platform: "darwin",
		readFile: () => undefined,
		psStart: async () => "Tue Nov 24 11:55:00 2026",
	};
	const record = (token: string, createdAt: string) => {
		const claim = { ...identity, token, host: hostname(), pid: 4242, createdAt };
		writeFileSync(path, JSON.stringify(claim));
		return claim;
	};
	const writer = record("writer-started-before", "2026-11-24T12:00:00.000Z");
	assert.deepEqual(classifyClaim(writer, identity), {
		kind: "unknown",
		label: "PID 4242",
		error: "A process with the writer's PID 4242 is running; no answer from its host confirmed it",
	});
	assert.deepEqual(await observeClaimAsync(path, identity, started), {
		kind: "unknown",
		label: "PID 4242",
		error: "The writer process (PID 4242) is still running; no answer from its host confirmed it",
	});
	assert.match(
		(classifyClaim(writer, identity) as { error: string }).error,
		/^The writer process/,
		"a synchronous reader uses the comparison that the async reader made",
	);
	const reused = record("writer-ended-before-the-pid-was-reused", "2026-11-24T11:00:00.000Z");
	const dead = { kind: "dead", label: "PID 4242", writerId: "writer-ended-before-the-pid-was-reused" };
	assert.deepEqual(await observeClaimAsync(path, identity, started), dead);
	assert.deepEqual(classifyClaim(reused, identity), dead, "a reused PID stays reused for the synchronous reader");
	const unread = record("writer-whose-pid-holder-has-no-start", "2026-11-24T11:00:00.000Z");
	const noStart: ProcessStartSource = { ...started, psStart: async () => undefined };
	const unproven = {
		kind: "unknown",
		label: "PID 4242",
		error: "A process with the writer's PID 4242 is running; no answer from its host confirmed it",
	};
	assert.deepEqual(await observeClaimAsync(path, identity, noStart), unproven, "an unread start proves nothing");
	assert.deepEqual(classifyClaim(unread, identity), unproven);
});

it("native end evidence validates generation, host, token and canonical time order", (t) => {
	const identity = { sessionId: "native", cwd: process.cwd() };
	const claim = { ...identity, token: "writer", host: hostname(), pid: 12345, createdAt: "2026-01-01T00:00:00.000Z" };
	const probe = t.mock.method(process, "kill", (): true => true);
	assert.equal(
		classifyClaim(claim, identity).kind,
		"unknown",
		"a present PID without a start comparison proves nothing",
	);
	probe.mock.mockImplementation(() => {
		throw Object.assign(new Error("denied"), { code: "EPERM" });
	});
	assert.deepEqual(
		classifyClaim(claim, identity),
		{ kind: "dead", label: "PID 12345", writerId: "writer" },
		"a process of another user is not the writer of this user's private lease",
	);
	probe.mock.mockImplementation(() => {
		throw Object.assign(new Error("failed"), { code: "EIO" });
	});
	assert.equal(classifyClaim(claim, identity).kind, "unknown");
	const before = probe.mock.callCount();
	const end = { ...claim, endedAt: "2026-01-01T00:00:01.000Z" };
	assert.deepEqual(classifyClaim(end, identity), {
		kind: "dead",
		label: "PID 12345",
		writerId: "writer",
		endedAt: end.endedAt,
	});
	for (const invalid of [
		{ ...end, host: "foreign-host" },
		{ ...end, token: "" },
		{ ...end, token: "x".repeat(257) },
		{ ...end, endedAt: "2025-12-31T23:59:59.000Z" },
		{ ...end, endedAt: "2026-01-01" },
		{ ...end, endedAt: null },
	])
		assert.equal(classifyClaim(invalid, identity).kind, "unknown");
	assert.equal(probe.mock.callCount(), before, "invalid or clean-end metadata never needs a process probe");
});
