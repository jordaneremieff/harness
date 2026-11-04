import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import { browserEntries, PillarsBrowser, type SourceReader } from "./browser.ts";

const digest = "a".repeat(64);
const page = (over: Partial<AccessPage> = {}): AccessPage => ({
	schema: "pillars-source",
	resource: "governance",
	referenceBodyDigest: digest,
	bodyBytes: 96,
	offset: 0,
	endOffset: 48,
	text: "body",
	...over,
});
const entries = [
	{ resource: "inventory", title: "Pillars", type: "inventory", index: "Portable design doctrine for agent-assisted work." },
	{ resource: "governance", title: "Pillars Governance", type: "governance", index: "Operating rules for the pillar corpus." },
	{ resource: "pattern-frame-inspection", title: "Frame Inspection", type: "pattern", index: "At an option set, name the frame, test whether it binds, step out if not." },
	{ resource: "heuristic-verification-reach", title: "Verification Reach", type: "heuristic", index: "Verify that the evidence reached the claim's actual subject." },
];
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function mouse(type: TuiMouseEvent["type"], x: number, y: number, width = 80, wheelDelta?: number): TuiMouseEvent {
	return {
		type,
		button: type === "wheel" ? "none" : "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...(wheelDelta === undefined ? {} : { wheelDelta }),
	};
}
function harness(read: SourceReader) {
	const calls: AccessRequest[] = [];
	const state = { rows: 24, closed: 0 };
	const browser = new PillarsBrowser({
		entries,
		read: async (request, signal) => {
			calls.push(request);
			return read(request, signal);
		},
		size: () => ({ columns: 80, rows: state.rows }),
		requestRender: () => {},
		close: () => {
			state.closed++;
		},
	});
	return { browser, calls, state };
}
const rowOf = (rows: string[], text: string) => {
	const index = rows.findIndex((row) => row.includes(text));
	assert.ok(index >= 0, text);
	return index;
};

test("inventory rows quote the source index statements with canonical titles and types", async () => {
	const catalog = {
		resources: [
			{ resourceClass: "inventory" as const, resourceId: "inventory", path: "README.md" },
			{ resourceClass: "governance" as const, resourceId: "governance", path: "GOVERNANCE.md" },
			{ resourceClass: "entry" as const, resourceId: "pattern-frame-inspection", path: "pattern.md" },
		],
	};
	const read: SourceReader = async () =>
		page({
			resource: "inventory",
			text: "### Patterns\n\n| Pattern | Structure |\n|---|---|\n| [Frame Inspection](pattern-frame-inspection.md) | At an option set, name the frame. |\n",
		});
	assert.deepEqual(await browserEntries(catalog, read), [
		{ resource: "inventory", title: "Pillars", type: "inventory", index: "" },
		{ resource: "governance", title: "Pillars Governance", type: "governance", index: "" },
		{ resource: "pattern-frame-inspection", title: "Frame Inspection", type: "pattern", index: "At an option set, name the frame." },
	]);
});

test("open reads the selection, continuation carries the exact offset and digest, and Back returns to the inventory", async () => {
	const pages = [
		page({ resource: "governance", text: "first ", nextOffset: 48, endOffset: 48 }),
		page({ resource: "governance", text: "second", offset: 48, endOffset: 96 }),
	];
	const { browser, calls, state } = harness(async () => pages.shift() ?? page());
	assert.match(browser.render(80)[0] ?? "", /read-only inventory/);
	browser.handleInput("\x1b[B");
	browser.handleInput("\r");
	await settle();
	assert.deepEqual(calls, [{ resource: "governance" }]);
	const body = browser.render(80);
	assert.ok(body.join("").includes("SHA-256:"));
	assert.ok(body.join("").includes(digest), "the digest stays complete across wrapped rows");
	assert.ok(body.join("\n").includes("[More]"));
	browser.handleInput("m");
	await settle();
	assert.deepEqual(calls[1], { resource: "governance", offset: 48, referenceBodyDigest: digest });
	assert.ok(browser.render(80).join("\n").includes("first second"));
	browser.handleInput("\x1b");
	const inventory = browser.render(80).join("\n");
	assert.match(inventory, /read-only inventory/);
	assert.match(inventory, /› Pillars Governance/);
	assert.equal(calls.length, 2);
	assert.equal(state.closed, 0);
});

test("a row click only selects; the labelled Open control starts the read, and Close disposes", async () => {
	const { browser, calls, state } = harness(async () => page({ resource: "pattern-frame-inspection", text: "full body" }));
	const frame = rowOf(browser.render(80), "Frame Inspection");
	assert.deepEqual(browser.handleMouse(mouse("click", 2, frame)), { handled: true });
	assert.equal(calls.length, 0, "a row click must not read");
	assert.match(browser.render(80).join("\n"), /› Frame Inspection/);
	const after = browser.render(80);
	assert.deepEqual(browser.handleMouse(mouse("click", 1, rowOf(after, "[Open]"))), { handled: true });
	await settle();
	assert.deepEqual(calls, [{ resource: "pattern-frame-inspection" }]);
	const body = browser.render(80);
	assert.deepEqual(browser.handleMouse(mouse("click", 9, rowOf(body, "[Close]"))), { handled: true });
	assert.equal(state.closed, 1);
	browser.handleInput("\r");
	await settle();
	assert.equal(calls.length, 1, "input after close must not read");
});

test("stale geometry never acts: a click after resize without a re-render is dropped", async () => {
	const { browser, calls, state } = harness(async () => page({ resource: "governance" }));
	const openRow = rowOf(browser.render(80), "[Open]");
	state.rows = 30;
	assert.equal(browser.handleMouse(mouse("click", 1, openRow)), undefined);
	assert.equal(calls.length, 0);
	assert.equal(state.closed, 0);
	const rerendered = browser.render(80);
	assert.deepEqual(browser.handleMouse(mouse("click", 1, rowOf(rerendered, "[Open]"))), { handled: true });
	await settle();
	assert.deepEqual(calls, [{ resource: "inventory" }]);
});

test("the wheel scrolls the list without changing the selection or its read target", async () => {
	const { browser, calls } = harness(async () => page({ resource: "governance" }));
	browser.render(80);
	browser.handleInput("\x1b[B");
	browser.render(80);
	assert.deepEqual(browser.handleMouse(mouse("wheel", 2, 2, 80, 5)), { handled: true });
	browser.handleInput("\r");
	await settle();
	assert.deepEqual(calls, [{ resource: "governance" }], "wheel scrolling must not move the selection to another row");
});

test("source errors show their code without a judgment route, and long bodies wrap within the width", async () => {
	const error: AccessError = {
		schema: "pillars-source-error",
		code: "source_changed",
		message: "The source changed or the digest belongs to another body; omit both continuation fields for a fresh read.",
	};
	const { browser } = harness(async () => error);
	browser.render(80);
	browser.handleInput("\r");
	await settle();
	const failed = browser.render(80);
	assert.ok(failed.join("\n").includes("source_changed"));
	assert.ok(!failed.join("\n").includes("[More]"));
	assert.ok(failed.every((row) => visibleWidth(row) <= 80));
	const long = "§".repeat(300);
	const wide = new PillarsBrowser({
		entries,
		read: async () => page({ resource: "governance", text: long }),
		size: () => ({ columns: 40, rows: 24 }),
		requestRender: () => {},
		close: () => {},
	});
	wide.render(40);
	wide.handleInput("\x1b[B");
	wide.handleInput("\r");
	await settle();
	const rows = wide.render(40);
	assert.ok(rows.join("").length > long.length / 4, "the wrapped body must show the full text");
	assert.ok(rows.every((row) => visibleWidth(row) <= 40));
	for (const width of [20, 12]) {
		const narrow = new PillarsBrowser({
			entries,
			read: async () => page(),
			size: () => ({ columns: width, rows: 24 }),
			requestRender: () => {},
			close: () => {},
		});
		assert.ok(narrow.render(width).some((row) => row.includes("Resize")), "very small widths show a resize message");
	}
});
