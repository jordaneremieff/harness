import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { PlaceBook, PLACE_FILE_MAX_BYTES, type PlaceBinding } from "./places.ts";

const date = "2026-01-01T00:00:00.000Z";
function serialized(places: PlaceBinding[]) { return `${JSON.stringify({ places }, null, 2)}\n`; }

it("admits the exact UTF-8 boundary and preserves readable bytes on overflow", () => {
	const root = mkdtempSync(join(tmpdir(), "place-capacity-"));
	try {
		const book = new PlaceBook(root);
		const row = { area: "/work/a", sessionId: "session", boundAt: date, topic: "" };
		row.topic = "x".repeat(PLACE_FILE_MAX_BYTES - Buffer.byteLength(serialized([row])));
		writeFileSync(book.file, serialized([row]));
		assert.equal(readFileSync(book.file).length, PLACE_FILE_MAX_BYTES);
		const before = readFileSync(book.file);
		assert.throws(() => book.bind("/work/b", "next", "界".repeat(256)), /proposed book exceeds/u);
		assert.deepEqual(readFileSync(book.file), before);
		assert.equal(book.readState().kind, "ok");
		assert.equal(book.unbind("/work/a")?.sessionId, "session");
		book.bind("/work/a", "session", row.topic);
		assert.equal(readFileSync(book.file).length, PLACE_FILE_MAX_BYTES);
		assert.throws(() => book.bind("/work/a", "session", `${row.topic}界`), /exceeds/u);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("refuses cumulative ordinary rows before the admitted effect and keeps the lock through admission", async () => {
	const root = mkdtempSync(join(tmpdir(), "place-admission-"));
	try {
		const book = new PlaceBook(root), rows: PlaceBinding[] = [];
		let last = "";
		for (let index = 0; ; index += 1) {
			const row = { area: `/work/${String(index).padStart(6, "0")}`, sessionId: "a".repeat(36), topic: "界".repeat(256), boundAt: date };
			if (Buffer.byteLength(serialized([...rows, row])) > PLACE_FILE_MAX_BYTES) break;
			rows.push(row); last = serialized(rows);
		}
		writeFileSync(book.file, last);
		let effects = 0;
		await assert.rejects(book.withArea("/work/new", async (_existing, admit) => {
			admit("b".repeat(36), "界".repeat(256));
			effects += 1;
			return { sessionId: "b".repeat(36), topic: "界".repeat(256), value: null };
		}), /exceeds/u);
		assert.equal(effects, 0);
		assert.equal(readFileSync(book.file, "utf8"), last);
		assert.equal(book.read().length, rows.length);
		await book.withArea("/short", async (_existing, admit) => {
			admit("s");
			assert.throws(() => book.bind("/other", "o"), /locked/u);
			return { sessionId: "s", value: null };
		});
		assert.equal(book.readState().kind, "ok");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects a real FIFO without a writer under an external subprocess deadline", () => {
	const root = mkdtempSync(join(tmpdir(), "place-fifo-"));
	try {
		mkdirSync(root, { recursive: true });
		const fifo = spawnSync("mkfifo", [join(root, "places.json")], { timeout: 2000, encoding: "utf8" });
		assert.equal(fifo.status, 0, fifo.stderr);
		const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `import { PlaceBook } from ${JSON.stringify(new URL("./places.ts", import.meta.url).href)}; console.log(JSON.stringify(new PlaceBook(process.argv[1]).readState()));`, root], { timeout: 3000, encoding: "utf8" });
		assert.equal(child.error, undefined);
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout), { kind: "corrupt", reason: "the path is not a regular file" });
	} finally { rmSync(root, { recursive: true, force: true }); }
});
