import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { AgentCatalog, hostMetadata, storageIdOf } from "./catalog.ts";
import { boundCatalogView, type CatalogViewRow } from "./catalog-view.ts";
import { hostPaths } from "./host-protocol.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "agent-catalog-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return {
		catalog: new AgentCatalog(root),
		input: {
			cwd: root,
			agentDir: root,
			packageDir: root,
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			ownerId: "owner",
		},
	};
}

it("publishes one complete handle seed without replacing creation defaults", (t) => {
	const { catalog, input } = fixture(t);
	const role = "😀".repeat(2000);
	const first = catalog.createHandled({ ...input, name: "Archive" }, "archive", role);
	const reused = catalog.createHandled({ ...input, name: "Changed", ownerId: "another" }, "archive", "new role");
	assert.equal(first.created, true);
	assert.equal(reused.created, false);
	assert.equal(reused.record.storageId, first.record.storageId);
	assert.equal(reused.record.name, "Archive");
	assert.equal(catalog.read(first.record.storageId).view?.profileSeed?.role, role);
	assert.equal(reused.record.ownerId, input.ownerId);
	assert.equal("view" in hostMetadata(reused.record), false);
	assert.equal(readdirSync(catalog.root).filter((name) => name.endsWith(".claim")).length, 0);
});

it("retains a continuation for each prefetched catalog record", async (t) => {
	const { catalog, input } = fixture(t);
	for (let index = 0; index < 12; index++) catalog.create({ ...input, name: `record-${index}` });
	const page = await catalog.page({ limit: 12 });
	assert.equal(page.recordCursors.length, 12);
	const next = await catalog.page({ cursor: page.recordCursors[4] ?? undefined });
	assert.deepEqual(next.records.map((record) => record.storageId), page.records.slice(5).map((record) => record.storageId));
	const frozen = page.records.map((record) => record.recoveryDue);
	catalog.markRecoveryDue(page.records[5].storageId, true);
	assert.deepEqual(page.records.map((record) => record.recoveryDue), frozen, "a collected batch is independent of subsequent observations");
});

it("bounds a discovery batch and binds continuations only to query and cwd", async (t) => {
	const { catalog, input } = fixture(t);
	for (let index = 0; index < 33; index++) catalog.create(input);
	utimesSync(catalog.root, 1, 1);
	const page = await catalog.page({ limit: 32 });
	assert.equal(page.records.length, 32);
	assert.equal(page.coverage.complete, false);
	assert.ok(page.nextCursor);
	catalog.create(input);
	const next = await catalog.page({ cursor: page.nextCursor });
	assert.equal(next.coverage.complete, true);
	assert.equal(next.records.some((record) => page.records.some((previous) => previous.storageId === record.storageId)), false);
	await assert.rejects(catalog.page({ cursor: page.nextCursor, query: "different" }), /query or cwd/u);
	await assert.rejects(catalog.page({ cursor: page.nextCursor, cwd: "/different" }), /query or cwd/u);
	await assert.rejects(catalog.page({ limit: 33 }), /Catalog limit/u);
});

it("continues strictly after the last name through publication, creation, and removal", async (t) => {
	const { catalog, input } = fixture(t);
	const candidates = Array.from({ length: 12 }, (_, index) => ({ request: `record-${index}`, record: catalog.create(input, `record-${index}`) }))
		.sort((a, b) => a.record.storageId < b.record.storageId ? -1 : 1);
	const behind = candidates[0];
	const ahead = candidates[candidates.length - 1];
	assert.equal(catalog.discardUnopened(behind.record), "removed");
	assert.equal(catalog.discardUnopened(ahead.record), "removed");
	const existing = candidates.slice(1, -1).map(({ record }) => record.storageId);
	const first = await catalog.page({ limit: 3 });
	assert.ok(first.nextCursor);
	assert.deepEqual(first.records.map((record) => record.storageId), existing.slice(0, 3));
	assert.equal(catalog.discardUnopened(first.records[2]), "removed");
	const writer = new AgentCatalog(input.cwd);
	writer.markRecoveryDue(existing[3], true);
	writer.create(input, behind.request);
	writer.create(input, ahead.request);
	const seen = first.records.map((record) => record.storageId);
	let cursor: string | null = first.nextCursor;
	for (let pageIndex = 0; cursor && pageIndex < 10; pageIndex++) {
		const page = await catalog.page({ limit: 3, cursor });
		seen.push(...page.records.map((record) => record.storageId));
		cursor = page.nextCursor;
	}
	assert.equal(cursor, null);
	assert.deepEqual(seen, [...existing, ahead.record.storageId]);
	assert.ok((await catalog.page()).records.some((record) => record.storageId === behind.record.storageId));
});

it("bounds visits through nonmatching entries and preserves corrupt-record accounting", async (t) => {
	const { catalog, input } = fixture(t);
	const corrupt = catalog.create(input);
	writeFileSync(catalog.path(corrupt.storageId), "x".repeat(32_769));
	for (let index = 0; index < 260; index++) writeFileSync(join(catalog.root, `other-${index}`), "");
	const first = await catalog.page({ query: "absent" });
	assert.equal(first.coverage.visited, 256);
	assert.equal(first.coverage.skipped, 1);
	assert.equal(first.records.length, 0);
	assert.equal(first.coverage.complete, false);
	assert.ok(first.nextCursor);
	catalog.create(input);
	const next = await catalog.page({ cursor: first.nextCursor, query: "absent" });
	assert.equal(next.coverage.visited, 5);
	assert.equal(next.coverage.complete, true);
});

it("refuses malformed catalog cursors even when the catalog is absent", async (t) => {
	const { catalog } = fixture(t);
	for (const value of [null, {}, { binding: "[]", offset: 2 }, { binding: "[]", after: "../record" }]) {
		const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
		await assert.rejects(catalog.page({ cursor }), /Invalid catalog cursor/u);
	}
});

it("deduplicates a spawn request by owner and request identity", (t) => {
	const { catalog, input } = fixture(t);
	const first = catalog.create(input, "request");
	assert.deepEqual(catalog.create(input, "request"), first);
	assert.deepEqual(hostMetadata(catalog.read(first.storageId)), hostMetadata(first));
	assert.equal(storageIdOf(`${first.storageId}:12`), first.storageId);
	assert.notEqual(catalog.create(input, "other").storageId, first.storageId);
	assert.notEqual(catalog.create({ ...input, ownerId: "other" }, "request").storageId, first.storageId);
	assert.throws(() => catalog.create({ ...input, name: "changed" }, "request"), /different agent configuration/u);
});

it("reuses immutable creation metadata across Pi installations without rewriting the record", (t) => {
	const { catalog, input } = fixture(t);
	const first = catalog.create(input, "same-request");
	const before = readFileSync(catalog.path(first.storageId), "utf8");
	const callerPackageDir = join(input.cwd, "caller-installation");
	const reused = catalog.createTracked({ ...input, packageDir: callerPackageDir }, "same-request");
	assert.equal(reused.created, false);
	assert.deepEqual(reused.record, first);
	assert.deepEqual(hostMetadata(reused.record, callerPackageDir), { ...hostMetadata(first), packageDir: callerPackageDir });
	assert.equal(hostMetadata(reused.record).packageDir, input.packageDir);
	for (const changed of [
		{ cwd: join(input.cwd, "other-cwd") },
		{ agentDir: join(input.cwd, "other-agent") },
		{ model: { ...input.model, modelId: "other-model" } },
		{ thinkingLevel: "high" },
		{ name: "other-name" },
		{ trust: true },
	]) assert.throws(() => catalog.create({ ...input, packageDir: callerPackageDir, ...changed }, "same-request"), /different agent configuration/u);
	assert.equal(readFileSync(catalog.path(first.storageId), "utf8"), before);
});

it("validates metadata before publishing a catalog record", (t) => {
	const { catalog, input } = fixture(t);
	assert.throws(() => catalog.create({ ...input, thinkingLevel: "unknown" }), /reasoning level/u);
	assert.throws(() => catalog.create({ ...input, cwd: "relative" }), /absolute path/u);
	assert.throws(() => catalog.create({ ...input, model: { provider: "", modelId: "model" } }), /empty/u);
	assert.deepEqual(readdirSync(catalog.root), []);
});

it("reports corrupt metadata as skipped without losing valid records", async (t) => {
	const { catalog, input } = fixture(t);
	const valid = catalog.create({ ...input, name: "Valid" });
	const corrupt = catalog.create(input);
	writeFileSync(catalog.path(corrupt.storageId), JSON.stringify({ ...corrupt, thinkingLevel: "unknown" }));
	const page = await catalog.page();
	assert.deepEqual(page.records, [valid]);
	assert.equal(page.coverage.skipped, 1);
	assert.deepEqual(page.skippedStorageIds, [corrupt.storageId]);
	assert.equal(page.coverage.complete, true);
	assert.throws(() => catalog.read(corrupt.storageId), /reasoning level/u);
});

it("tracks whether a create wrote the record and keeps dedup results", (t) => {
	const { catalog, input } = fixture(t);
	const first = catalog.createTracked(input, "request");
	assert.equal(first.created, true);
	const second = catalog.createTracked(input, "request");
	assert.equal(second.created, false, "a request ID reuse does not own a new record");
	assert.deepEqual(second.record, first.record);
	assert.deepEqual(catalog.create(input, "request"), first.record, "create still returns the record");
});

it("discards an unopened created record exactly once", (t) => {
	const { catalog, input } = fixture(t);
	const { record, created } = catalog.createTracked(input, "request");
	assert.equal(created, true);
	assert.equal(existsSync(record.storagePath), false, "the host never created storage");
	assert.equal(catalog.discardUnopened(record), "removed");
	assert.equal(existsSync(catalog.path(record.storageId)), false);
	assert.deepEqual(readdirSync(catalog.root), []);
	assert.equal(catalog.discardUnopened(record), "record-changed", "a second discard is refused");
});

it("keeps a record when its storage file exists", (t) => {
	const { catalog, input } = fixture(t);
	const { record } = catalog.createTracked(input, "request");
	writeFileSync(record.storagePath, "");
	assert.equal(catalog.discardUnopened(record), "storage-present");
	assert.equal(existsSync(catalog.path(record.storageId)), true);
});

it("keeps a record while a live or unknown writer claim exists", (t) => {
	const { catalog, input } = fixture(t);
	const live = catalog.createTracked(input, "live").record;
	writeClaim(live, process.pid);
	assert.equal(catalog.discardUnopened(live), "writer-present");
	assert.equal(existsSync(catalog.path(live.storageId)), true);

	const foreign = catalog.createTracked(input, "foreign").record;
	writeClaim(foreign, process.pid, "another-host");
	assert.equal(catalog.discardUnopened(foreign), "writer-present");
	assert.equal(existsSync(catalog.path(foreign.storageId)), true);

	const invalid = catalog.createTracked(input, "invalid").record;
	const paths = hostPaths(invalid);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: "bad" }));
	assert.equal(catalog.discardUnopened(invalid), "writer-present");
	assert.equal(existsSync(catalog.path(invalid.storageId)), true);
});

it("recovers a proven dead local claim and discards the record", (t) => {
	const { catalog, input } = fixture(t);
	const { record } = catalog.createTracked(input, "request");
	const helper = spawnSync(process.execPath, ["-e", ""]);
	assert.ok(helper.pid, "the helper process has a pid");
	const claim = writeClaim(record, helper.pid);
	assert.equal(catalog.discardUnopened(record), "removed");
	assert.equal(existsSync(catalog.path(record.storageId)), false);
	assert.equal(existsSync(claim), true, "the dead claim is left for the next acquire");
});

it("keeps a record whose bytes changed after create", (t) => {
	const { catalog, input } = fixture(t);
	const { record } = catalog.createTracked(input, "request");
	writeFileSync(catalog.path(record.storageId), `${JSON.stringify({ ...record, name: "Changed" })}\n`);
	assert.equal(catalog.discardUnopened(record), "record-changed");
	assert.equal(existsSync(catalog.path(record.storageId)), true);
});

it("writes a bounded view and keeps host identity comparison unchanged", (t) => {
	const { catalog, input } = fixture(t);
	const first = catalog.createTracked(input, "request");
	assert.equal(first.record.view, undefined, "a new record has no projection");
	const row: CatalogViewRow = {
		id: first.record.storageId,
		storageId: first.record.storageId,
		cwd: input.cwd,
		modifiedAt: 1,
		owner: "here",
		state: "idle",
		cost: 0,
		partial: false,
	};
	const view = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [row], rootId: first.record.storageId });
	const updated = catalog.updateView(first.record.storageId, view);
	assert.deepEqual(updated.view, view);
	assert.deepEqual(catalog.read(first.record.storageId).view, view);
	assert.deepEqual(hostMetadata(updated), hostMetadata(first.record), "the projection does not change host metadata");
	assert.equal(catalog.createTracked(input, "request").created, false, "spawn dedup ignores the projection");
	assert.ok(Buffer.byteLength(`${JSON.stringify(catalog.read(first.record.storageId))}\n`, "utf8") <= 32 * 1024);
});

it("persists the recovery marker independently of the view", (t) => {
	const { catalog, input } = fixture(t);
	const { record } = catalog.createTracked(input, "request");
	assert.equal(catalog.read(record.storageId).recoveryDue, undefined, "a missing marker stays absent");
	assert.equal(catalog.markRecoveryDue(record.storageId, true).recoveryDue, true);
	assert.equal(catalog.read(record.storageId).recoveryDue, true);
	assert.deepEqual(
		hostMetadata(catalog.read(record.storageId)),
		hostMetadata(record),
		"the marker does not change host metadata",
	);
	const view = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [] });
	catalog.updateView(record.storageId, view);
	const cleared = catalog.markRecoveryDue(record.storageId, false);
	assert.equal(cleared.recoveryDue, false);
	assert.deepEqual(cleared.view, view, "the marker preserves the view");
});

it("refuses view writes through a symlink, corrupt record, or wrong identity", (t) => {
	const { catalog, input } = fixture(t);
	const { record } = catalog.createTracked(input, "request");
	const other = catalog.createTracked(input, "other").record;
	writeFileSync(catalog.path(record.storageId), readFileSync(catalog.path(other.storageId)));
	assert.throws(
		() => catalog.markRecoveryDue(record.storageId, true),
		/invalid/u,
		"a stored identity mismatch is refused",
	);
	writeFileSync(catalog.path(record.storageId), "{ not json");
	assert.throws(
		() => catalog.updateView(record.storageId, boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [] })),
		/JSON/u,
		"a corrupt record is refused",
	);
	const victim = join(catalog.root, "victim.json");
	writeFileSync(victim, JSON.stringify(record));
	writeFileSync(catalog.path(record.storageId), JSON.stringify(record));
	unlinkSync(catalog.path(record.storageId));
	symlinkSync(victim, catalog.path(record.storageId));
	assert.throws(
		() => catalog.markRecoveryDue(record.storageId, true),
		/ELOOP|symbolic/u,
		"a symlinked record is refused",
	);
	assert.equal(readFileSync(victim, "utf8"), JSON.stringify(record), "the symlink target is unchanged");
});

it("rejects unknown cached states without losing the host's address", (t) => {
	const { catalog, input } = fixture(t);
	const record = catalog.create(input);
	const row = { id: record.storageId, storageId: record.storageId, cwd: record.cwd, modifiedAt: 1, owner: "unknown", state: "future-state", cost: 0, partial: false };
	writeFileSync(catalog.path(record.storageId), JSON.stringify({ ...record, view: { storageId: record.storageId, updatedAt: new Date().toISOString(), rows: [row], coverage: { complete: true, omitted: 0 } } }));
	const readable = catalog.read(record.storageId);
	assert.equal(readable.storagePath, record.storagePath);
	assert.deepEqual(readable.view?.rows, []);
	assert.match(readable.view?.unavailable ?? "", /unsupported.*future-state.*Restart this Pi/u);
});

it("refuses a view for another storage on publication and read", (t) => {
	const { catalog, input } = fixture(t);
	const record = catalog.create(input);
	const view = boundCatalogView({ updatedAt: "2026-01-01T00:00:00.000Z", rows: [], storageId: "another" });
	assert.throws(() => catalog.updateView(record.storageId, view), /storageId/u);
	writeFileSync(catalog.path(record.storageId), JSON.stringify({ ...record, view }));
	assert.throws(() => catalog.read(record.storageId), /storageId/u);
});

/** Write one shared-shape writer claim for the record's host path. */
function writeClaim(record: ReturnType<AgentCatalog["read"]>, pid: number, host = hostname()): string {
	const paths = hostPaths(record);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(
		paths.claim,
		JSON.stringify({
			token: "test",
			pid,
			host,
			sessionId: record.storageId,
			cwd: record.cwd,
			createdAt: new Date().toISOString(),
		}),
	);
	return paths.claim;
}
