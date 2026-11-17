import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts, plain } from "../../test/load.mts";
const { reader } = scripts(["app/core/exact.ts"]);
const { Doc, LineMap, applyEdits, diff } = reader.exact;
const edit = (
	d: ReaderExactDocument,
	start: number,
	end: number,
	text: string,
	origin: "person" | "agent" = "person",
	options: ReaderApplyOptions = {},
) => d.apply([{ start, end, text, expected: d.source.slice(start, end) }], origin, options);
const normal = (s: string) => s.replace(/\r\n|\r/g, "\n");
test("generated display edits preserve untouched bytes and exact history", () => {
	let seed = 0x5eed,
		widened = 0;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	const pick = <T,>(a: T[]) => a[Math.floor(random() * a.length)];
	for (let k = 0; k < 3000; k++) {
		let s = "";
		for (let j = 0, n = 2 + Math.floor(random() * 24); j < n; j++)
			s += pick(["a", "é", "😀", " ", "\n", "\r\n", "\r", "**", "#"]);
		const map = new LineMap(s);
		let a = Math.floor(random() * (map.display.length + 1)),
			b = Math.min(map.display.length, a + Math.floor(random() * 4));
		while (a > 0 && (map.display.charCodeAt(a) & 0xfc00) === 0xdc00) a--;
		while (b < map.display.length && (map.display.charCodeAt(b) & 0xfc00) === 0xdc00) b++;
		const text = pick(["", "z", "\n", "x\ny", "😀"]),
			e = map.toSourceEdit({ start: a, end: b, text }),
			d = new Doc(s);
		d.apply([e], "person", { blockId: "b" });
		assert.equal(normal(d.source), map.display.slice(0, a) + text + map.display.slice(b));
		assert.equal(d.source.slice(0, e.start), s.slice(0, e.start));
		assert.equal(d.source.slice(e.start + e.text.length), s.slice(e.end));
		const changed = d.source;
		assert.equal(d.undo(null)?.status, "ok");
		assert.deepEqual(Buffer.from(d.source), Buffer.from(s));
		assert.equal(d.redo(null)?.status, "ok");
		assert.deepEqual(Buffer.from(d.source), Buffer.from(changed));
		if (e.start !== map.toSource(a) || e.end !== map.toSource(b)) widened++;
	}
	assert.ok(widened > 0);
});
test("wrong generations, wrong expected text, unordered edits and overlapping edits change nothing", () => {
	const d = new Doc("abc def", 7);
	assert.equal(edit(d, 0, 1, "A", "agent", { baseGeneration: 6 }).status, "stale");
	assert.throws(() => d.apply([{ start: 0, end: 1, text: "A", expected: "no" }], "agent"), /Expected text/);
	assert.throws(
		() =>
			applyEdits(d.source, [
				{ start: 4, end: 5, text: "D", expected: "d" },
				{ start: 0, end: 1, text: "A", expected: "a" },
			]),
		{ name: "RangeError" },
	);
	assert.throws(
		() =>
			applyEdits(d.source, [
				{ start: 0, end: 3, text: "A", expected: "abc" },
				{ start: 2, end: 4, text: "", expected: "c " },
			]),
		{ name: "RangeError" },
	);
	assert.equal(d.source, "abc def");
	assert.equal(d.generation, 7);
});
test("block-scoped undo groups typing around disjoint agent changes", () => {
	const d = new Doc("ab\r\n\r\nremote");
	edit(d, 1, 1, "x", "person", { blockId: "one", now: 0 });
	edit(d, 7, 13, "REMOTE", "agent", { id: "agent", now: 10 });
	edit(d, 2, 2, "y", "person", { blockId: "one", now: 50 });
	const typed = d.source;
	assert.equal(d.undo("one")?.operations?.length, 2);
	assert.equal(d.source, "ab\r\n\r\nREMOTE");
	assert.equal(d.redo("one")?.status, "ok");
	assert.equal(d.source, typed);
});
test("word boundaries, pauses and different blocks separate undo groups", () => {
	const d = new Doc("ab ZZ");
	edit(d, 1, 1, "x", "person", { blockId: "a", now: 0 });
	edit(d, 2, 2, " ", "person", { blockId: "a", now: 10 });
	edit(d, 3, 3, "y", "person", { blockId: "a", now: 20 });
	edit(d, d.source.length, d.source.length, "!", "person", { blockId: "b", now: 30 });
	edit(d, 4, 4, "z", "person", { blockId: "a", now: 2000 });
	d.undo("a");
	assert.equal(d.source, "ax yb ZZ!");
	d.undo("a");
	assert.equal(d.source, "ax b ZZ!");
	d.undo("b");
	assert.equal(d.source, "ax b ZZ");
});
test("backspace grouping and repeated undo redo restore source", () => {
	const d = new Doc("abc remote");
	edit(d, 1, 2, "", "person", { blockId: "a", now: 0 });
	edit(d, 0, 1, "", "person", { blockId: "a", now: 20 });
	d.undo("a");
	assert.equal(d.source, "abc remote");
	d.redo("a");
	assert.equal(d.source, "c remote");
	d.undo("a");
	assert.equal(d.source, "abc remote");
});
test("named multi-edit undo commutes through later deltas", () => {
	const d = new Doc("one\r\ntwo\r\nthree");
	d.apply(
		[
			{ start: 0, end: 3, text: "ONE!", expected: "one" },
			{ start: 10, end: 15, text: "THREE!", expected: "three" },
		],
		"agent",
		{ id: "A" },
	);
	edit(d, 6, 6, "😀", "person", { blockId: "b" });
	edit(d, d.source.length, d.source.length, " tail", "agent", { id: "B" });
	assert.equal(d.undoAgent("A").status, "ok");
	assert.equal(d.source, "one\r\n😀two\r\nthree tail");
	d.undo(null);
	d.undo("b");
	assert.equal(d.source, "one\r\ntwo\r\nthree");
});
test("selective overlap refusal is atomic", () => {
	const d = new Doc("abc def");
	d.apply(
		[
			{ start: 0, end: 3, text: "ABC", expected: "abc" },
			{ start: 4, end: 7, text: "DEF", expected: "def" },
		],
		"agent",
		{ id: "A" },
	);
	edit(d, 1, 2, "!", "person", { blockId: "a" });
	const before = d.source,
		g = d.generation,
		records = JSON.stringify(d.records);
	assert.equal(d.undoAgent("A").status, "refused");
	assert.equal(d.source, before);
	assert.equal(d.generation, g);
	assert.equal(JSON.stringify(d.records), records);
	d.undo("a");
	assert.equal(d.undoAgent("A").status, "ok");
	assert.equal(d.source, "abc def");
});
test("an open block remains held without typing, focus or a clock limit", () => {
	const d = new Doc("abc\n\nremote");
	d.setActive("a", { start: 0, end: 3 });
	d.caretPresent = false;
	assert.deepEqual(plain(d.heldRange(999999)), { start: 0, end: 3 });
	assert.equal(edit(d, 1, 2, "!", "agent", { now: 999999 }).status, "busy");
	assert.equal(d.source, "abc\n\nremote");
	d.setActive(null, null);
	assert.equal(d.heldRange(), null);
	assert.equal(edit(d, 1, 2, "!", "agent").status, "ok");
});
test("disjoint edits shift the held range without consuming block history", () => {
	const d = new Doc("head\n\nblock");
	d.setActive("b", { start: 6, end: 11 });
	edit(d, 8, 8, "x", "person", { now: 10 });
	edit(d, 0, 0, "PRE", "agent", { now: 20 });
	edit(d, 12, 12, "y", "person", { now: 30 });
	assert.deepEqual(plain(d.heldRange()), { start: 9, end: 16 });
	assert.equal(d.undo("b")?.operations?.length, 2);
	assert.equal(d.source, "PREhead\n\nblock");
});
test("redos in separate blocks commute through each other and an agent", () => {
	const d = new Doc("ab cd");
	edit(d, 1, 1, "XX", "person", { blockId: "a" });
	edit(d, d.source.length, d.source.length, "YY", "person", { blockId: "b" });
	d.undo("a");
	d.undo("b");
	edit(d, 0, 0, "PRE", "agent");
	assert.equal(d.redo("a")?.status, "ok");
	assert.equal(d.redo("b")?.status, "ok");
	assert.equal(d.source, "PREaXXb cdYY");
});
test("every selective removal order of disjoint operations restores exact bytes", () => {
	const base = ["zero", "one", "two", "three", "four"],
		orders: number[][] = [];
	function perm(a: number[], rest: number[]) {
		if (!rest.length) {
			orders.push(a);
			return;
		}
		rest.forEach((x, i) => {
			perm(
				[...a, x],
				rest.filter((_, j) => j !== i),
			);
		});
	}
	perm([], [0, 1, 2, 3, 4]);
	assert.equal(orders.length, 120);
	for (const order of orders) {
		const d = new Doc(base.join("\r\n")),
			current = [...base];
		for (let i = 0; i < 5; i++) {
			const p = d.source.indexOf(base[i]);
			edit(d, p, p + base[i].length, `😀${base[i].toUpperCase()}!`, "agent", { id: `agent${i}` });
			current[i] = `😀${base[i].toUpperCase()}!`;
		}
		for (const i of order) {
			assert.equal(d.undoAgent(`agent${i}`).status, "ok");
			current[i] = base[i];
			assert.equal(d.source, current.join("\r\n"));
		}
		assert.deepEqual(Buffer.from(d.source), Buffer.from(base.join("\r\n")));
	}
});
test("CR and LF seams preserve separate display breaks", () => {
	const s = "a\rX\n\n",
		m = new LineMap(s, "\r");
	assert.equal(normal(applyEdits(s, [m.toSourceEdit({ start: 2, end: 3, text: "\n" })]).source), "a\n\n\n\n");
});
test("invalid batches and duplicate IDs refuse atomically without events", () => {
	const d = new Doc("abc def", 4);
	let events = 0;
	d.listeners.add(() => events++);
	assert.throws(() =>
		d.apply(
			[
				{ start: 0, end: 1, text: "A", expected: "a" },
				{ start: 4, end: 7, text: "DEF", expected: "bad" },
			],
			"person",
		),
	);
	assert.throws(() => d.apply([], "person"));
	assert.throws(() =>
		d.apply(
			[
				{ start: 0, end: 0, text: "A", expected: "" },
				{ start: 0, end: 0, text: "B", expected: "" },
			],
			"person",
		),
	);
	assert.equal(d.source, "abc def");
	assert.equal(d.generation, 4);
	assert.equal(d.records.length, 0);
	assert.equal(events, 0);
	edit(d, 0, 1, "A", "agent", { id: "same" });
	const before = JSON.stringify(d.records);
	assert.throws(() => edit(d, 1, 2, "B", "agent", { id: "same" }), /Duplicate/);
	assert.equal(d.source, "Abc def");
	assert.equal(JSON.stringify(d.records), before);
	assert.equal(d.generation, 5);
	assert.equal(events, 1);
});
test("thread IDs exist only on changes whose caller supplies one", () => {
	const d = new Doc("abc");
	const changes: ReaderCoreChange[] = [];
	d.listeners.add((change) => changes.push(change));
	edit(d, 0, 1, "A", "agent", { id: "one", threadId: "thread" });
	edit(d, 1, 2, "B", "agent", { id: "two" });
	assert.equal(changes[0].threadId, "thread");
	assert.equal(Object.hasOwn(changes[1], "threadId"), false);
	d.undo(null);
	assert.equal(Object.hasOwn(changes[2], "threadId"), false);
	assert.equal(d.redos[0].operationId, "two");
	d.redo(null);
	assert.equal(d.records.at(-1)?.id, "two");
});
test("diff never splits surrogate pairs", () =>
	assert.deepEqual(plain(diff("a😀b", "a😁b")), { start: 1, end: 3, text: "😁" }));
