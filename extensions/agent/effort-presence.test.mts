import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } from "./primary-channel.ts";
import { discoverPrimaryLocation, readRelatedEfforts, type PrimaryIntentClaim } from "./effort-presence.ts";

function rootFor(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "efforts-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".primaries"));
	return root;
}
function intent(paths = ["extensions/agent"], branches = ["topic"]): PrimaryIntentClaim {
	return { purpose: "Effort awareness", integration: "Compose the change", authority: "The operator requested the change", scope: { paths, branches }, contactThread: "storage/thread", updatedAt: "2026-10-04T10:00:00Z" };
}
function record(root: string, fields: Record<string, unknown> = {}): string {
	const id = typeof fields.id === "string" ? fields.id : randomUUID();
	writeFileSync(primaryEndpointPath(root, id), JSON.stringify({ id, version: PRIMARY_ENDPOINT_VERSION, serverId: randomUUID(), cwd: "/work/topic", hostname: hostname(), pid: process.pid, socketPath: join(root, "missing.sock"), startedAt: "2026-10-04T09:00:00Z", ...fields }));
	return id;
}
const self = () => ({ id: randomUUID(), cwd: "/work/topic", intentClaim: intent() });

it("uses the canonical common Git directory for separate worktrees", async (t) => {
	const root = rootFor(t);
	const repository = join(root, "repository");
	const worktree = join(root, "worktree");
	mkdirSync(repository);
	const git = (args: string[]) => execFileSync("git", args, { cwd: repository, timeout: 3000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
	git(["init", "-q"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"]);
	git(["worktree", "add", "-q", "-b", "effort", worktree]);
	const main = await discoverPrimaryLocation(repository);
	const linked = await discoverPrimaryLocation(worktree);
	assert.equal(main.cwd, realpathSync(repository));
	assert.equal(main.repository, realpathSync(join(repository, ".git")));
	assert.equal(linked.repository, main.repository);
	record(root, { cwd: linked.cwd, repository: linked.repository });
	const page = await readRelatedEfforts(root, { id: randomUUID(), ...main });
	assert.equal(page.efforts[0]?.relationship, "repository");
	assert.deepEqual(await discoverPrimaryLocation(root), { cwd: realpathSync(root), repositoryState: "outside-git" });
});

it("excludes proven dead records and retains distinct foreign unknown and incompatible efforts", async (t) => {
	const root = rootFor(t);
	const dead = spawnSync(process.execPath, ["-e", ""], { timeout: 3000 });
	assert.ok(dead.pid);
	const deadId = record(root, { pid: dead.pid, version: "different" });
	const unknown = record(root, { hostname: "remote-host" });
	const incompatible = record(root, { version: "different" });
	const live = record(root);
	const unrelated = record(root, { cwd: "/elsewhere" });
	const reader = self();
	record(root, { id: reader.id });
	const page = await readRelatedEfforts(root, reader);
	assert.deepEqual(new Map(page.efforts.map((row) => [row.id, row.liveness])), new Map([[unknown, "unknown"], [incompatible, "incompatible"], [live, "live"], [unrelated, "live"]]));
	assert.deepEqual(page.coverage, { visited: 6, unreadable: 0, dead: 1, unrelated: 1, omitted: 0, complete: true, reasons: [] });
	for (const id of [deadId, unknown, incompatible, unrelated]) assert.ok(existsSync(primaryEndpointPath(root, id)));
});

it("classifies permission-denied process probes as unknown rather than dead", async (t) => {
	const root = rootFor(t);
	record(root);
	t.mock.method(process, "kill", () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
	const page = await readRelatedEfforts(root, self());
	assert.equal(page.efforts[0]?.liveness, "unknown");
	assert.equal(page.coverage.dead, 0);
});

it("matches cwd independently from Git and labels exact or prefix scope overlap as claim-derived", async (t) => {
	const root = rootFor(t);
	const id = record(root, { intentClaim: intent(["extensions/agent/manager.ts", "extensions/agent-other", "glob*"], ["topic", "other"]) });
	record(root, { repository: "/work/git-common" });
	const page = await readRelatedEfforts(root, self());
	assert.equal(page.efforts.length, 2);
	const declared = page.efforts.find((row) => row.id === id);
	assert.deepEqual(declared?.overlap, { basis: "intentClaim", paths: ["extensions/agent/manager.ts"], branches: ["topic"] });
	assert.equal(declared?.relationship, "cwd");
	const gitPage = await readRelatedEfforts(root, { ...self(), repository: "/different/git" });
	assert.equal(gitPage.efforts.length, 2);
	assert.ok(gitPage.efforts.every((row) => row.relationship === "cwd"));
});

it("reports malformed optional intent as unreadable without pretending the directory is empty", async (t) => {
	const root = rootFor(t);
	record(root, { intentClaim: { purpose: "incomplete" } });
	record(root, { repository: 12 });
	writeFileSync(join(root, ".primaries", `${randomUUID()}.json`), "not JSON");
	const page = await readRelatedEfforts(root, self());
	assert.deepEqual(page.coverage, { visited: 3, unreadable: 3, dead: 0, unrelated: 0, omitted: 0, complete: false, reasons: ["unreadable"] });
	assert.equal(page.efforts.length, 0);
});

it("bounds visits and results and reports exact visited omissions", async (t) => {
	const root = rootFor(t);
	for (let index = 0; index < 270; index += 1) record(root);
	const page = await readRelatedEfforts(root, self());
	assert.equal(page.coverage.visited, 256);
	assert.equal(page.efforts.length, 20);
	assert.equal(page.coverage.omitted, 236);
	assert.equal(page.coverage.complete, false);
	assert.deepEqual(page.coverage.reasons, ["result-limit", "visit-limit"]);
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16384);
});

it("bounds serialized pages with large intent claims", async (t) => {
	const root = rootFor(t);
	const large = { ...intent(), purpose: "界".repeat(1024), integration: "i".repeat(2048), authority: "a".repeat(2048) };
	for (let index = 0; index < 8; index += 1) record(root, { intentClaim: large });
	const page = await readRelatedEfforts(root, self());
	assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16384);
	assert.ok(page.coverage.omitted > 0);
	assert.ok(page.coverage.reasons.includes("byte-limit"));
});

it("reports missing roots as complete empty pages and unreadable roots as incomplete", async (t) => {
	const root = rootFor(t);
	const empty = await readRelatedEfforts(join(root, "absent"), self());
	assert.equal(empty.coverage.complete, true);
	assert.equal(empty.coverage.visited, 0);
	const blocked = join(root, "blocked");
	writeFileSync(blocked, "not a directory");
	const page = await readRelatedEfforts(blocked, self());
	assert.equal(page.coverage.complete, false);
	assert.deepEqual(page.coverage.reasons, ["directory-unreadable"]);
});

it("reports failed Git discovery explicitly instead of outside-git or unrelated", async (t) => {
	const root = rootFor(t);
	const previous = process.env.PATH;
	process.env.PATH = "";
	let location: Awaited<ReturnType<typeof discoverPrimaryLocation>>;
	try { location = await discoverPrimaryLocation(root); }
	finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
	assert.equal(location.repositoryState, "unknown");
	assert.deepEqual(await discoverPrimaryLocation(join(root, "missing")), { cwd: join(root, "missing"), repositoryState: "unknown" });
	record(root);
	const page = await readRelatedEfforts(root, { id: randomUUID(), ...location });
	assert.equal(page.coverage.unrelated, 0);
	assert.equal(page.coverage.omitted, 0);
	assert.equal(page.efforts.length, 1);
	assert.equal(page.coverage.complete, false);
	assert.deepEqual(page.coverage.reasons, ["repository-unknown"]);
	const unknownRecord = rootFor(t);
	record(unknownRecord, { repositoryState: "unknown" });
	assert.deepEqual((await readRelatedEfforts(unknownRecord, self())).coverage.reasons, ["repository-unknown"]);
});

it("uses declared intent alone for repository, cwd and machine purposes", async (t) => {
	const root = rootFor(t);
	const observedPurpose = { source: "interactive-input", text: "Later remark is not the work" };
	const repository = record(root, { repository: "/work/common", observedPurpose, intentClaim: intent() });
	const cwd = record(root, { observedPurpose, intentClaim: intent() });
	const machine = record(root, { cwd: "/other/project", observedPurpose, intentClaim: intent() });
	const page = await readRelatedEfforts(root, { ...self(), repository: "/work/common" });
	assert.equal(page.efforts.length, 3);
	for (const row of page.efforts) assert.equal(row.observedPurpose, undefined);
	assert.deepEqual(page.efforts.find((row) => row.id === repository)?.intentClaim, intent());
	assert.equal(page.efforts.find((row) => row.id === cwd)?.relationship, "cwd");
	assert.equal(page.efforts.find((row) => row.id === machine)?.purposeClaim, intent().purpose);
	assert.equal(JSON.stringify(page).includes(observedPurpose.text), false);
});

it("labels fallback origin only without intent and clears without retaining a stale declared competitor", async (t) => {
	const root = rootFor(t);
	const reader = self();
	for (const source of ["session-name", "interactive-input"]) {
		const observedPurpose = { source, text: `Known origin from ${source}` };
		const id = record(root, { observedPurpose, intentClaim: intent() });
		assert.equal((await readRelatedEfforts(root, reader)).efforts.find((row) => row.id === id)?.observedPurpose, undefined);
		record(root, { id, observedPurpose });
		const row = (await readRelatedEfforts(root, reader)).efforts.find((value) => value.id === id);
		assert.deepEqual(row?.observedPurpose, observedPurpose);
		assert.equal(row?.intentClaim, undefined);
		assert.equal(row?.purposeClaim, undefined);
	}
	const unknown = record(root, { intentClaim: intent() });
	record(root, { id: unknown });
	const row = (await readRelatedEfforts(root, reader)).efforts.find((value) => value.id === unknown);
	assert.equal(row?.intentClaim, undefined);
	assert.equal(row?.observedPurpose, undefined);
});


it("lists all local efforts, exposes machine purpose only, and marks declared gate plans", async (t) => {
	const root = rootFor(t);
	const claim = { ...intent(), scope: { ...intent().scope, fullGate: true } };
	const machine = record(root, { cwd: "/other/project", repository: "/other/common", intentClaim: claim });
	const related = record(root, { repository: "/work/common", intentClaim: claim });
	record(root, { cwd: "/foreign/project", hostname: "foreign", intentClaim: claim });
	const page = await readRelatedEfforts(root, { ...self(), repository: "/work/common" });
	const distant = page.efforts.find((row) => row.id === machine);
	assert.equal(distant?.relationship, "machine");
	assert.equal(distant?.purposeClaim, claim.purpose);
	assert.equal(distant?.contactThreadClaim, claim.contactThread);
	assert.equal(distant?.intentUpdatedAt, claim.updatedAt);
	assert.equal(distant?.intentClaim, undefined);
	assert.equal(distant?.overlap, undefined);
	assert.deepEqual(distant?.sharedSubstrates, ["machine-gates"]);
	const shared = page.efforts.find((row) => row.id === related);
	assert.equal(shared?.relationship, "repository");
	assert.deepEqual(shared?.sharedSubstrates, ["repository", "cwd", "machine-gates"]);
	assert.deepEqual(shared?.intentClaim, claim);
	assert.equal(page.coverage.unrelated, 1);
	assert.equal(page.efforts.length, 2);
});

it("does not claim a shared machine gate for foreign-host records", async (t) => {
	const root = rootFor(t);
	const claim = { ...intent(), scope: { ...intent().scope, fullGate: true } };
	record(root, { hostname: "foreign-host", repository: "/work/common", intentClaim: claim });
	const page = await readRelatedEfforts(root, { ...self(), repository: "/work/common", intentClaim: claim });
	assert.equal(page.efforts[0]?.liveness, "unknown");
	assert.deepEqual(page.efforts[0]?.sharedSubstrates, ["repository", "cwd"]);
});
