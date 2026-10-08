import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Dirent, FSWatcher } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AgentCatalog, deriveEndpoint, readClaim } from "./catalog.mts";
import { CACHE_BYTES, CACHE_ROWS, decodeRecord, readJson, readRecord, RECORD_BYTES } from "./catalog-record.mts";
import type { CatalogRecord } from "./catalog-record.mts";
import { retainedRows } from "./catalog-state.mts";
import type { CatalogUpdate } from "./catalog-state.mts";
import { CatalogInventory, SEGMENT_ENTRIES } from "./catalog-worker.mts";

const storageId = "00000000-0000-4000-8000-000000000001";
const stamp = "2026-01-01T00:00:00.000Z";
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const store = await mkdtemp(join(tmpdir(), "catalog-"));
	await mkdir(join(store, "durable"), { mode: 0o700 });
	t.after(() => rm(store, { recursive: true, force: true }));
	const record: CatalogRecord = {
		storageId,
		cwd: store,
		agentDir: store,
		packageDir: store,
		storagePath: join(store, "durable", `${storageId}.sqlite`),
		model: { provider: "example", modelId: "example" },
		thinkingLevel: "high",
		createdAt: stamp,
	};
	return { store, root: join(store, "durable"), record };
}
function summary(record: CatalogRecord, id = record.storageId) {
	return {
		id,
		storageId: record.storageId,
		cwd: record.cwd,
		modifiedAt: 1,
		owner: "here",
		state: "working",
		cost: 1,
		partial: false,
		currentTool: { name: "read", argument: "file" },
	};
}
function publication(record: CatalogRecord, extra = {}) {
	return {
		storageId: record.storageId,
		updatedAt: stamp,
		rows: [summary(record)],
		coverage: { complete: true, omitted: 0 },
		...extra,
	};
}
async function save(root: string, record: unknown, id = storageId) {
	await writeFile(join(root, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
}
async function saveClaim(record: CatalogRecord, patch: Record<string, unknown> = {}) {
	const claimPath = deriveEndpoint(record).claimPath;
	await mkdir(dirname(claimPath), { recursive: true, mode: 0o700 });
	await writeFile(
		claimPath,
		JSON.stringify({
			sessionId: record.storageId,
			cwd: record.cwd,
			host: "fixture",
			pid: 123,
			createdAt: stamp,
			extra: true,
			...patch,
		}),
		{ mode: 0o600 },
	);
	return claimPath;
}
const fakeWatcher = () =>
	({
		on() {
			return this;
		},
		close() {},
	}) as unknown as FSWatcher;
function inventory(store: string) {
	const updates: CatalogUpdate[] = [];
	const worker = new CatalogInventory(store, (update) => updates.push(update), { watchDirectory: fakeWatcher });
	return { worker, updates };
}
function coded(code: string): never {
	throw Object.assign(new Error("fixture"), { code });
}

test("strict metadata identity, database path, text, flags, and independent inputs", async (t) => {
	const { root, record } = await fixture(t);
	assert.equal(decodeRecord(record, storageId, root).storageId, storageId);
	const bad = [
		{ ...record, storageId: "other" },
		{ ...record, storagePath: join(root, "other.sqlite") },
		{ ...record, storagePath: `${join(root, `../durable/${storageId}.sqlite`)}/` },
		{ ...record, cwd: "relative" },
		{ ...record, agentDir: "relative" },
		{ ...record, packageDir: "relative" },
		{ ...record, cwd: `/bad\0path` },
		{ ...record, name: "x".repeat(257) },
		{ ...record, model: { ...record.model, provider: "x".repeat(513) } },
		{ ...record, model: { ...record.model, unknown: true } },
		{ ...record, trust: "yes" },
		{ ...record, recoveryDue: 1 },
		{ ...record, thinkingLevel: "unknown" },
		{ ...record, unexpected: true },
		{ ...record, independent: { inputDigest: "bad", projectTrusted: true } },
		{ ...record, independent: { inputDigest: "a".repeat(64), projectTrusted: true, extra: true } },
	];
	for (const value of bad) assert.throws(() => decodeRecord(value, storageId, root));
	assert.doesNotThrow(() =>
		decodeRecord(
			{
				...record,
				name: "",
				ownerId: "owner",
				independent: { inputDigest: "a".repeat(64), projectTrusted: false },
				threads: { opaque: true },
			},
			storageId,
			root,
		),
	);
	assert.throws(() => decodeRecord({ ...record, storageId: "../bad" }, "../bad", root));
});

test("catalog JSON reads refuse oversized, malformed, nonregular, symlink and invalid UTF-8 files", async (t) => {
	const { root, record, store } = await fixture(t);
	await save(root, record);
	assert.equal((await readRecord(root, storageId)).record.cwd, record.cwd);
	const path = join(root, `${storageId}.json`);
	await writeFile(path, Buffer.alloc(RECORD_BYTES + 1, 32));
	await assert.rejects(readRecord(root, storageId));
	await writeFile(path, "{");
	await assert.rejects(readRecord(root, storageId));
	await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));
	await assert.rejects(readJson(path, RECORD_BYTES));
	await rm(path);
	await mkdir(path);
	await assert.rejects(readRecord(root, storageId));
	await rm(path, { recursive: true });
	const real = join(store, "record.json");
	await writeFile(real, JSON.stringify(record));
	await symlink(real, path);
	await assert.rejects(readRecord(root, storageId));
	await rm(path);
	const socket = createServer();
	t.after(async () => {
		await new Promise<void>((resolve) => socket.close(() => resolve()));
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.listen(join(store, "s"), resolve);
	});
	await assert.rejects(readJson(join(store, "s"), RECORD_BYTES));
});

test("regular JSON reads admit exactly the bound and close on parser failure", async (t) => {
	const { store } = await fixture(t);
	const path = join(store, "bound.json");
	await writeFile(path, `"${"a".repeat(98)}"`);
	assert.equal((await readJson(path, 100)).bytes, 100);
	await assert.rejects(readJson(path, 99));
	await writeFile(path, "false");
	assert.equal((await readJson(path, 100)).value, false);
});

test("endpoint hashes bind cwd and storage; socket paths use the documented byte limit", async (t) => {
	const { record } = await fixture(t);
	const endpoint = deriveEndpoint(record);
	const sha = (value: string) => createHash("sha256").update(value).digest("hex");
	const hash = sha(`pi.agent.host\0${storageId}\0${record.cwd}`);
	assert.equal(
		endpoint.serverId,
		`${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${((Number.parseInt(hash[16] ?? "", 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
	);
	assert.equal(
		endpoint.claimPath,
		join(
			record.agentDir,
			"durable-hosts",
			sha(`${storageId}\0${record.cwd}`),
			".claims",
			`${sha(JSON.stringify([record.cwd, storageId]))}.lock`,
		),
	);
	assert.equal(deriveEndpoint({ ...record, cwd: `${record.cwd}/.` }).serverId, endpoint.serverId);
	assert.notEqual(deriveEndpoint({ ...record, storageId: "other" }).serverId, endpoint.serverId);
	const long = deriveEndpoint({ ...record, agentDir: `/${"é".repeat(100)}` });
	assert.ok(Buffer.byteLength(long.socketPath) <= 100);
	assert.ok(!long.socketPath.startsWith("/é"));
});

test("claim probes classify success and EPERM live, ESRCH dead, foreign and unexpected unknown", async (t) => {
	const { record } = await fixture(t);
	assert.equal((await readClaim(record)).state, "absent");
	await saveClaim(record);
	for (const [code, state] of [
		["", "live"],
		["EPERM", "live"],
		["ESRCH", "dead"],
		["EIO", "unknown"],
	]) {
		let calls = 0;
		const result = await readClaim(record, {
			hostname: "fixture",
			pidProbe: (pid) => {
				calls++;
				assert.equal(pid, 123);
				if (code) coded(code);
			},
		});
		assert.equal(result.state, state);
		assert.equal(calls, 1);
	}
	assert.equal(
		(await readClaim(record, { hostname: "foreign", pidProbe: () => assert.fail("Foreign PID was probed") })).state,
		"unknown",
	);
});

test("invalid claim identities, timestamps, PID types and bounds are unknown", async (t) => {
	const { record } = await fixture(t);
	for (const patch of [
		{ sessionId: "other" },
		{ cwd: `${record.cwd}/.` },
		{ createdAt: "2026-01-01" },
		{ pid: "123" },
		{ pid: 0 },
		{ pid: -1 },
		{ pid: 2147483648 },
		{ pid: 1.5 },
		{ host: "bad\nname" },
	]) {
		await saveClaim(record, patch);
		assert.equal(
			(await readClaim(record, { hostname: "fixture", pidProbe: () => assert.fail("Invalid PID was probed") })).state,
			"unknown",
		);
	}
});

test("claim file bounds and no-follow regular-file checks preserve unknown ownership", async (t) => {
	const { record, store } = await fixture(t);
	const path = await saveClaim(record);
	await writeFile(path, " ".repeat(16385));
	assert.equal((await readClaim(record)).state, "unknown");
	await writeFile(path, "{");
	assert.equal((await readClaim(record)).state, "unknown");
	await rm(path);
	await mkdir(path);
	assert.equal((await readClaim(record)).state, "unknown");
	await rm(path, { recursive: true });
	const real = join(store, "claim.json");
	await writeFile(real, "{}");
	await symlink(real, path);
	assert.equal((await readClaim(record)).state, "unknown");
});

test("documented empty publication fixture decodes without a fabricated unavailable row", async (t) => {
	const { root, record } = await fixture(t);
	const doc = await readFile(new URL("../../docs/agent-host-contract.md", import.meta.url), "utf8");
	const match = /### Fixture: empty-publication\s+```json\s+([^`]+)```/u.exec(doc);
	assert.ok(match);
	const parsed = decodeRecord({ ...record, view: JSON.parse(match[1] ?? "") }, storageId, root);
	assert.deepEqual(retainedRows(parsed, { state: "absent" }), []);
});

test("offline working rows become interrupted; unknown claims make owner unavailable", async (t) => {
	const { root, record } = await fixture(t);
	const decoded = decodeRecord({ ...record, view: publication(record) }, storageId, root);
	for (const state of ["absent", "dead", "unknown", "live"] as const) {
		const row = retainedRows(decoded, { state })[0];
		assert.ok(row);
		assert.equal(row.owner, state === "live" ? "here" : state === "unknown" ? "unavailable" : "unknown");
		assert.equal(row.state, state === "live" ? "working" : "interrupted");
		assert.equal(Boolean(row.currentTool), state === "live");
		assert.equal(row.cost, 1);
		assert.equal(row.publishedAt, stamp);
	}
	assert.equal(decoded.view?.rows[0]?.state, "working");
});

test("malformed and mismatched publications retain metadata but never become control rows", async (t) => {
	const { root, record } = await fixture(t);
	for (const view of [
		{},
		publication(record, { storageId: "other" }),
		publication(record, { rows: [{ ...summary(record), id: "other", storageId: "other" }] }),
		publication(record, { rows: [{ ...summary(record), state: "invented" }] }),
	]) {
		const decoded = decodeRecord({ ...record, view }, storageId, root);
		assert.equal(decoded.view, undefined);
		assert.ok(decoded.publicationError);
		const rows = retainedRows(decoded, { state: "absent" });
		assert.equal(rows[0]?.state, "unavailable");
		assert.equal(rows[0]?.partial, true);
	}
});

test("cached page/get never enumerate; refresh joins, cursors expire, and close is idempotent", async (t) => {
	const { store, root, record } = await fixture(t);
	await save(root, { ...record, view: publication(record) });
	const other = { ...record, storageId: "other", storagePath: join(root, "other.sqlite") };
	await save(root, { ...other, view: publication(other) }, "other");
	const catalog = new AgentCatalog({ store });
	t.after(() => catalog.close());
	assert.equal(catalog.page().scan.state, "not-started");
	assert.equal(catalog.get(storageId), undefined);
	const scan = catalog.refresh();
	assert.equal(scan, catalog.refresh());
	await scan;
	const page = catalog.page({ limit: 1 });
	assert.ok(page.nextCursor);
	assert.equal(catalog.page({ cursor: page.nextCursor, limit: 1 }).rows.length, 1);
	const captured = catalog.get(storageId);
	assert.ok(captured);
	captured.cwd = "changed";
	assert.equal(catalog.get(storageId)?.cwd, store);
	await rename(root, join(store, "moved"));
	assert.equal(catalog.page().rows.length, 2);
	assert.equal(catalog.get(storageId)?.cwd, store);
	await catalog.refresh();
	assert.equal(catalog.page().scan.state, "failed");
	await assert.rejects(catalog.refresh("wrong"));
	assert.throws(() => catalog.page({ limit: 0 }));
	assert.throws(() => catalog.page({ cursor: "bad" }));
	await catalog.close();
	await catalog.close();
	await assert.rejects(catalog.refresh());
});

test("bounded iterator preserves scanId continuation and closes on replacement/completion", async (t) => {
	const { store } = await fixture(t);
	let opens = 0,
		closes = 0,
		reads = 0;
	const updates: CatalogUpdate[] = [];
	const worker = new CatalogInventory(store, (update) => updates.push(update), {
		watchDirectory: fakeWatcher,
		openDirectory: async () => {
			opens++;
			let remaining = SEGMENT_ENTRIES + 1;
			return {
				read: async () => {
					reads++;
					return remaining-- > 0 ? ({ name: "ignored.sqlite" } as Dirent) : null;
				},
				close: async () => {
					closes++;
				},
			};
		},
	});
	t.after(() => worker.close());
	const first = await worker.refresh();
	assert.equal(first.visited, SEGMENT_ENTRIES);
	assert.equal(first.complete, false);
	assert.equal(first.state, "running");
	assert.equal(reads, SEGMENT_ENTRIES);
	await assert.rejects(worker.refresh("wrong"));
	assert.equal(reads, SEGMENT_ENTRIES);
	const next = await worker.refresh(first.scanId);
	assert.equal(next.complete, true);
	assert.equal(next.visited, SEGMENT_ENTRIES + 1);
	assert.equal(opens, 1);
	assert.equal(closes, 1);
	const third = await worker.refresh();
	assert.notEqual(third.scanId, first.scanId);
	await worker.refresh();
	assert.equal(closes, 2);
	assert.equal(opens, 3);
	await worker.close();
	assert.equal(closes, 3);
});

test("named hints reconcile known rows, unknown and dropped names mark stale without scans", async (t) => {
	const { store, root, record } = await fixture(t);
	await save(root, { ...record, view: publication(record) });
	const { worker, updates } = inventory(store);
	t.after(() => worker.close());
	await worker.refresh();
	await save(root, { ...record, name: "changed", view: publication(record) });
	worker.hint(`${storageId}.json`);
	await worker.settled();
	assert.equal(updates.at(-1)?.entries[0]?.record.name, "changed");
	assert.equal(updates.at(-1)?.scan.visited, 1);
	worker.hint("unknown.json");
	await worker.settled();
	assert.equal(updates.at(-1)?.stale, true);
	assert.equal(updates.at(-1)?.scan.visited, 1);
	await worker.refresh();
	assert.equal(updates.at(-1)?.stale, false);
	worker.hint(null);
	await worker.settled();
	assert.equal(updates.at(-1)?.stale, true);
	await rm(join(root, `${storageId}.json`));
	worker.hint(`${storageId}.json`);
	await worker.settled();
	assert.deepEqual(updates.at(-1)?.removed, [storageId]);
});

test("watch hints received during an iterator read replace the scanned publication", async (t) => {
	const { store, root, record } = await fixture(t);
	await save(root, { ...record, view: publication(record) });
	const updates: CatalogUpdate[] = [];
	let first = true;
	const worker = new CatalogInventory(store, (update) => updates.push(update), {
		watchDirectory: fakeWatcher,
		openDirectory: async () => ({
			read: async () => {
				if (first) {
					first = false;
					return { name: `${storageId}.json` } as Dirent;
				}
				await save(root, { ...record, name: "newer", view: publication(record) });
				worker.hint(`${storageId}.json`);
				return null;
			},
			close: async () => {},
		}),
	});
	t.after(() => worker.close());
	await worker.refresh();
	await worker.settled();
	assert.equal(updates.flatMap((update) => update.entries).at(-1)?.record.name, "newer");
});

test("cache row capacity reports omissions instead of unbounded retention", async (t) => {
	const { store, root, record } = await fixture(t);
	// Each catalog record stays small while total published rows exceeds cache capacity.
	const copies = Array.from({ length: 41 }, (_, index) => {
		const id = `storage-${index}`;
		const copy = { ...record, storageId: id, storagePath: join(root, `${id}.sqlite`) };
		return {
			...copy,
			view: publication(copy, {
				rows: Array.from({ length: 50 }, (_, n) => ({ ...summary(copy, n ? `${id}:${n + 1}` : id), state: "idle" })),
			}),
		};
	});
	await Promise.all(copies.map((copy) => save(root, copy, copy.storageId)));
	const catalog = new AgentCatalog({ store });
	t.after(() => catalog.close());
	const scan = await catalog.refresh();
	assert.ok(scan.omitted > 0);
	assert.equal(catalog.page().coverage.complete, false);
	let count = 0,
		cursor: string | undefined;
	do {
		const page = catalog.page({ cursor, limit: 100 });
		count += page.rows.length;
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	assert.ok(count <= CACHE_ROWS);
	assert.ok(Buffer.byteLength(JSON.stringify(copies)) < CACHE_BYTES);
});

test("skipped records and incomplete publication coverage remain visible", async (t) => {
	const { store, root, record } = await fixture(t);
	await save(root, { ...record, view: publication(record, { coverage: { complete: false, omitted: 2 } }) });
	await writeFile(join(root, "bad.json"), "{");
	const catalog = new AgentCatalog({ store });
	t.after(() => catalog.close());
	const scan = await catalog.refresh();
	assert.equal(scan.skipped, 1);
	assert.equal(scan.omitted, 2);
	assert.equal(scan.complete, true);
	assert.equal(catalog.page().coverage.complete, false);
});
