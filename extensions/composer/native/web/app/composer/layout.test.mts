import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const empty = { draft: 32, editorPadding: 8, line: 24, chrome: 104, queue: 0, images: 0, gap: 4 };
const source = stripTypeScriptTypes(readFileSync(new URL("./layout.ts", import.meta.url), "utf8"));
function load(globals: Record<string, unknown> = {}) {
	const scope = globals as { composerLayout: {
		stack(parts: typeof empty, viewport: number): { height: number; visibleRows: number; tight: boolean };
		mount(input: { value: string }, report: (height: number) => void): () => void;
	} };
	runInNewContext(source, scope);
	return scope.composerLayout;
}
const { stack } = load();

test("one editor row always sits above the toolbar, even before the native resize", () => {
	assert.equal(stack(empty, 112).visibleRows, 1);
	assert.equal(stack(empty, 136).visibleRows, 1);
	assert.equal(stack(empty, 112).height, 136);
	assert.equal(stack(empty, 600).height, 136);
});

test("fit includes draft images but not the queue, even in a clipped pane", () => {
	const draft = { ...empty, images: 42, draft: 80 };
	const busy = { ...draft, queue: 28 };
	assert.equal(stack(draft, 240).height, 230);
	assert.equal(stack(busy, 240).height, 230);
	assert.equal(stack(busy, 120).height, 230);
	assert.equal(stack(draft, 240).visibleRows, 3);
	assert.equal(stack(busy, 240).visibleRows, 2);
	assert.equal(stack(busy, 120).tight, true);
});

test("a manually enlarged editor gains whole visible rows without inflating fitted height", () => {
	const tall = stack(empty, 400), shorter = stack(empty, 150);
	assert.ok(tall.visibleRows > shorter.visibleRows);
	assert.equal(tall.height, shorter.height);
	assert.ok(tall.visibleRows * empty.line <= 400 - empty.chrome);
	const long = stack({ ...empty, draft: 12 * empty.line + empty.editorPadding }, 400);
	assert.equal(tall.visibleRows, long.visibleRows);
	assert.ok(tall.height < long.height);
	assert.equal(stack(empty, 800).visibleRows, 12);
	assert.equal(stack({ ...empty, draft: 1000 }, 800).height, 400);
});

function page() {
	const geometry = { viewport: 136, footer: 26, queue: 0, images: 0, wrap: 1 };
	let tight = false;
	const properties = new Map<string, string>();
	const box = (height: () => number) => ({ getBoundingClientRect: () => ({ height: height() }) });
	const flags = new Map<string, boolean>();
	let scroll = () => {};
	const input = { value: "", scrollTop: 0, scrollHeight: 32, clientHeight: 32, addEventListener(_event: string, fn: () => void) { scroll = fn; } };
	const measure = {
		value: "",
		getBoundingClientRect() {
			const rows = this.value ? this.value.split("\n").length * geometry.wrap : 1;
			return { height: rows * 24 + (tight ? 0 : 8) };
		},
	};
	const nodes = {
		".composer": {
			...box(() => geometry.viewport),
			removeAttribute: () => { tight = false; },
			toggleAttribute: (_: string, next: boolean) => { tight = next; },
			style: { setProperty: (key: string, value: string) => properties.set(key, value) },
		},
		"#measure": measure,
		".edit-area": { toggleAttribute: (name: string, on: boolean) => flags.set(name, on) },
		".panel": {},
		".writer": {},
		".shelf": box(() => 32),
		"footer.status": box(() => geometry.footer),
		".queued": box(() => geometry.queue),
		".images": box(() => geometry.images),
	};
	const observed: unknown[] = [];
	let resized = () => {};
	const { mount } = load({
		document: { querySelector: (key: keyof typeof nodes) => nodes[key] },
		getComputedStyle(node: unknown) {
			const writer = node === nodes[".writer"], panel = node === nodes[".panel"];
			const pads = writer ? [12, 4] : panel ? [8, 4] : [4, 0];
			const pad = `${pads[Number(tight)]}px`, border = writer ? "1px" : "0px";
			return { paddingTop: pad, paddingBottom: pad, borderTopWidth: border, borderBottomWidth: border,
				lineHeight: "24px", rowGap: writer ? "4px" : "normal" };
		},
		ResizeObserver: class {
			constructor(callback: () => void) { resized = callback; }
			observe(node: unknown) { observed.push(node); }
		},
	});
	const heights: number[] = [];
	const sync = mount(input, (height) => heights.push(height));
	return {
		geometry, heights, sync, input, flags, scroll, resize() { resized(); },
		type(value: string) { input.value = value; sync(); },
		get tight() { return tight; },
		get rows() { return Number(properties.get("--visible-rows")); },
		observed, nodes,
	};
}

test("sync posts draft growth immediately, holds after deletion, and resets once on clear", () => {
	const view = page();
	view.sync();
	view.type("one\ntwo\nthree");
	assert.deepEqual(view.heights, [136, 184]);
	view.type(" ");
	assert.deepEqual(view.heights, [136, 184]);
	view.geometry.images = 42;
	view.resize();
	view.type("");
	view.resize();
	view.geometry.images = 0;
	view.resize();
	assert.deepEqual(view.heights, [136, 184, 136]);
	view.type("one\ntwo");
	assert.deepEqual(view.heights, [136, 184, 136, 160]);
});

test("the draft stops posting growth after twelve rows", () => {
	const view = page();
	view.type(`${"line\n".repeat(11)}last`);
	view.type(`${"line\n".repeat(12)}last`);
	assert.deepEqual(view.heights, [400]);
});

test("manual height and transient UI affect visible rows without posting a new fit", () => {
	const view = page();
	view.sync();
	assert.deepEqual(view.observed, [view.nodes[".composer"], view.nodes[".queued"], view.nodes[".images"]]);
	view.geometry.viewport = 400;
	view.resize();
	assert.equal(view.rows, 12);
	view.geometry.queue = 52;
	view.resize();
	assert.equal(view.rows, 9);
	view.geometry.viewport = 100;
	view.resize();
	assert.equal(view.rows, 1);
	assert.equal(view.tight, true);
	view.geometry.queue = 0;
	view.geometry.viewport = 136;
	view.resize();
	assert.equal(view.tight, false);
	assert.deepEqual(view.heights, [136]);
});

test("sync remeasures wrap and reserved footer rows without shrinking a nonempty draft", () => {
	const view = page();
	view.type("a long line");
	view.geometry.footer = 50;
	view.geometry.wrap = 3;
	view.resize();
	assert.deepEqual(view.heights, [136, 208]);
	view.geometry.wrap = 2;
	view.sync();
	assert.deepEqual(view.heights, [136, 208]);
	view.type("");
	assert.deepEqual(view.heights, [136, 208, 160]);
});

test("the editor fades only edges that hide more draft text", () => {
	const view = page();
	const check = (top: boolean, bottom: boolean) => {
		assert.equal(view.flags.get("data-clipped-top"), top);
		assert.equal(view.flags.get("data-clipped-bottom"), bottom);
	};
	view.sync(); check(false, false);
	view.input.scrollHeight = 320;
	view.sync(); check(false, true);
	view.input.scrollTop = 48;
	view.scroll(); check(true, true);
	view.input.scrollTop = 288;
	view.scroll(); check(true, false);
	view.input.scrollTop = 0;
	view.scroll(); check(false, true);
});
