import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { captureSnapshot } from "./snapshot-capture.ts";
import { RetainedReadError } from "./retained-errors.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "snapshot-capture-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "source.sqlite");
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('committed WAL evidence');");
	return { root, path, db };
}

function sourceState(path: string) {
	return ["", "-wal", "-shm", "-journal"].map((suffix) => {
		const file = `${path}${suffix}`;
		if (!existsSync(file)) return { suffix, absent: true };
		const s = lstatSync(file, { bigint: true });
		return { suffix, hash: createHash("sha256").update(readFileSync(file)).digest("hex"), dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeNs, ctime: s.ctimeNs };
	});
}

const options = () => ({ maxSourceBytes: 512 * 1024 * 1024, deadline: Date.now() + 30000 });
function code(expected: string) { return (error: unknown) => error instanceof RetainedReadError && error.code === expected; }

it("captures uncheckpointed WAL without copying SHM or mutating any source identity", async (t) => {
	const f = fixture(t);
	t.after(() => f.db.close());
	const before = sourceState(f.path);
	let scratch: string | undefined;
	const copy = await captureSnapshot(f.path, { ...options(), onDirectory: (path) => { scratch = path; } });
	assert.ok(scratch);
	assert.equal(readFileSync(f.path).includes(Buffer.from("committed WAL evidence")), false);
	const captured = new DatabaseSync(join(scratch, "snapshot.sqlite"));
	try { assert.deepEqual(captured.prepare("SELECT value FROM retained").all().map((row) => row.value), ["committed WAL evidence"]); }
	finally { captured.close(); await copy.storage.close(BACKGROUND_CONTEXT); await copy.cleanup?.(); }
	assert.deepEqual(sourceState(f.path), before);
});

it("keeps an idle database without sidecars and rejects a nonempty journal unchanged", async (t) => {
	const f = fixture(t);
	f.db.close();
	assert.equal(existsSync(`${f.path}-wal`), false);
	const before = sourceState(f.path);
	const copy = await captureSnapshot(f.path, options());
	await copy.storage.close(BACKGROUND_CONTEXT);
	await copy.cleanup?.();
	assert.deepEqual(sourceState(f.path), before);
	writeFileSync(`${f.path}-journal`, "unsupported journal");
	const journalState = sourceState(f.path);
	await assert.rejects(captureSnapshot(f.path, options()), code("source_unreadable"));
	assert.deepEqual(sourceState(f.path), journalState);
});

it("refuses scratch inside the retained root before it creates a directory", async (t) => {
	const f = fixture(t); f.db.close();
	const before = sourceState(f.path);
	let created = false;
	await assert.rejects(captureSnapshot(f.path, { ...options(), sourceRoot: tmpdir(), onDirectory: () => { created = true; } }), code("source_unreadable"));
	const alias = join(f.root, "root-alias");
	symlinkSync(tmpdir(), alias);
	await assert.rejects(captureSnapshot(f.path, { ...options(), sourceRoot: alias, onDirectory: () => { created = true; } }), code("source_unreadable"));
	assert.equal(created, false);
	assert.deepEqual(sourceState(f.path), before);
});

it("removes scratch when a source close rejects before ownership transfer", async (t) => {
	const f = fixture(t); f.db.close();
	const before = sourceState(f.path);
	let scratch: string | undefined;
	let closes = 0;
	await assert.rejects(captureSnapshot(f.path, { ...options(), onDirectory: (path) => { scratch = path; }, closeSource: async (handle) => { closes++; await handle.close(); throw new Error("Synthetic close rejection"); } }), code("source_unreadable"));
	assert.ok(scratch);
	assert.equal(existsSync(scratch), false);
	assert.equal(closes, 1);
	assert.deepEqual(sourceState(f.path), before);
});

type CaptureRace = "create-wal" | "remove-wal" | "replace-wal" | "remove-main" | "replace-main" | "truncate-main" | "grow-main";

function mutateCaptureSource(path: string, race: CaptureRace, maxSourceBytes: number): void {
	if (race === "create-wal") writeFileSync(`${path}-wal`, "new WAL");
	if (race === "remove-wal") rmSync(`${path}-wal`);
	if (race === "replace-wal") { renameSync(`${path}-wal`, `${path}-wal.old`); writeFileSync(`${path}-wal`, readFileSync(`${path}-wal.old`)); }
	if (race === "remove-main") rmSync(path);
	if (race === "replace-main") { renameSync(path, `${path}.old`); writeFileSync(path, readFileSync(`${path}.old`)); }
	if (race === "truncate-main") truncateSync(path, 0);
	if (race === "grow-main") truncateSync(path, maxSourceBytes + 1);
}

for (const race of ["create-wal", "remove-wal", "replace-wal", "remove-main", "replace-main", "truncate-main", "grow-main"] as const) {
	it(`rejects ${race} during capture and closes all private handles`, async (t) => {
		const f = fixture(t);
		if (race === "remove-wal" || race === "replace-wal") t.after(() => f.db.close());
		else f.db.close();
		let fired = false;
		let scratch: string | undefined;
		const maxSourceBytes = lstatSync(f.path).size + (existsSync(`${f.path}-wal`) ? lstatSync(`${f.path}-wal`).size : 0) + 1024;
		await assert.rejects(captureSnapshot(f.path, { ...options(), maxSourceBytes, onDirectory: (path) => { scratch = path; }, onChunk: () => {
			if (fired) return;
			fired = true;
			mutateCaptureSource(f.path, race, maxSourceBytes);
		} }), code(race === "grow-main" ? "limit_exceeded" : "source_changed"));
		assert.equal(fired, true);
		assert.ok(scratch);
		assert.equal(existsSync(scratch), false);
	});
}

it("fails closed for source limits, corruption, directories, symlinks, and unreadable files", async (t) => {
	const f = fixture(t);
	f.db.close();
	await assert.rejects(captureSnapshot(f.path, { ...options(), maxSourceBytes: 1 }), code("limit_exceeded"));
	writeFileSync(f.path, "corrupt source content");
	await assert.rejects(captureSnapshot(f.path, options()), code("source_unreadable"));
	rmSync(f.path);
	mkdirSync(f.path);
	await assert.rejects(captureSnapshot(f.path, options()), code("source_unreadable"));
	rmSync(f.path, { recursive: true });
	const other = join(f.root, "other.sqlite");
	writeFileSync(other, "not SQLite");
	symlinkSync(other, f.path);
	await assert.rejects(captureSnapshot(f.path, options()), code("source_unreadable"));
	rmSync(f.path);
	writeFileSync(f.path, "not SQLite");
	chmodSync(f.path, 0);
	await assert.rejects(captureSnapshot(f.path, options()), code("source_unreadable"));
	chmodSync(f.path, 0o600);
});

it("cancels and times out at deterministic copy barriers without source mutation", async (t) => {
	const f = fixture(t);
	f.db.close();
	const before = sourceState(f.path);
	const controller = new AbortController();
	let scratch: string | undefined;
	await assert.rejects(captureSnapshot(f.path, { ...options(), signal: controller.signal, onDirectory: (path) => { scratch = path; }, onChunk: () => controller.abort() }), code("cancelled"));
	assert.ok(scratch);
	assert.equal(existsSync(scratch), false);
	await assert.rejects(captureSnapshot(f.path, { ...options(), deadline: 0 }), code("timeout"));
	const expired = { ...options(), onDirectory: (path: string) => { scratch = path; }, onChunk: () => { expired.deadline = 0; } };
	await assert.rejects(captureSnapshot(f.path, expired), code("timeout"));
	assert.ok(scratch);
	assert.equal(existsSync(scratch), false);
	assert.deepEqual(sourceState(f.path), before);
});
