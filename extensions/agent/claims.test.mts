import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { CLAIM_BYTES, observeClaim, observeClaimAsync, readClaimFile } from "./claims.ts";
it("async observation shares live, missing, invalid, and bounded claim behavior", async (t) => {
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
	assert.equal((await observeClaimAsync(path, identity)).kind, "live");
	assert.deepEqual(readClaimFile(path).claim, live);
	const directory = join(root, "directory");
	mkdirSync(directory);
	assert.deepEqual(await observeClaimAsync(directory, identity), observeClaim(directory, identity));
});
it("async observation preserves dead process classification", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const identity = { sessionId: "claim-test", cwd: root };
	const path = join(root, "claim.lock");
	t.mock.method(process, "kill", () => {
		throw Object.assign(new Error("not running"), { code: "ESRCH" });
	});
	writeFileSync(
		path,
		JSON.stringify({ ...identity, host: hostname(), pid: 12345, createdAt: new Date().toISOString() }),
	);
	assert.deepEqual(await observeClaimAsync(path, identity), { kind: "dead", label: "PID 12345" });
	assert.deepEqual(await observeClaimAsync(path, identity), observeClaim(path, identity));
});
