/** The attached-terminal browser module: the shared loop and panel over a host request route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { BrowserView } from "./browser-views.ts";
import { operatorPanel, type OperatorPanelHost } from "./operator-panel.ts";
import { readPanelRequest } from "./panel-protocol.ts";
import type { StashEntry } from "./store.ts";

type JsonValue = Parameters<OperatorPanelHost["request"]>[0];
const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text, italic: (t: string) => t, strikethrough: (t: string) => t, underline: (t: string) => t } as unknown as OperatorPanelHost["theme"];
const flush = async () => { for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve)); };

function entry(id: string, title: string, state: "open" | "active" | "closed" = "open"): StashEntry {
	return { meta: { id, title, created: "20260724T120000Z", project: "/tmp/project", branch: "main", tags: [], state }, path: `/tmp/${id}.md`, preview: `# ${title}\n\nbody of ${id}`, previewTruncated: false };
}

function hostFixture(entries: StashEntry[], answers: Partial<Record<string, (request: Record<string, unknown>) => unknown>> = {}) {
	const requests: Record<string, unknown>[] = [];
	const notices: Array<{ text: string; type?: string }> = [];
	const inputs: string[] = [];
	let closed = 0;
	const view: BrowserView = { scope: "recent", query: "", cursor: undefined, nextCursor: null, entries, hasMore: false, coverage: undefined, stale: false };
	const host: OperatorPanelHost = {
		target: { id: "conversation-1" }, theme, tui: { requestRender() {} }, rows: () => 24,
		request: async (data) => {
			const request = data as Record<string, unknown>;
			requests.push(request);
			const custom = answers[String(request.op)];
			if (custom) return { text: "custom", data: custom(request) as JsonValue };
			if (request.op === "recent") return { text: "recent", data: { op: "recent", view } as unknown as JsonValue };
			if (request.op === "preview") return { text: "preview", data: { op: "preview", entry: entries.find((item) => item.meta.id === request.id) } as unknown as JsonValue };
			if (request.op === "pickup") return { text: "pickup", data: { op: "pickup", id: request.id, text: `Stash ${String(request.id)} is active and queued for pickup (submission 9).` } as JsonValue };
			throw new Error(`unexpected ${String(request.op)}`);
		},
		dialogs: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => inputs.shift(),
			notify: (text, type) => { notices.push({ text, type }); },
		},
		close: () => { closed++; },
	};
	return { host, requests, notices, inputs, closed: () => closed };
}

function clickLabel(instance: ReturnType<ReturnType<typeof operatorPanel>["open"]>, label: string, width = 80) {
	const lines = instance.render(width).map(stripVTControlCharacters);
	const y = lines.findIndex((line) => line.includes(label));
	assert.ok(y >= 0, `${label} is visible:\n${lines.join("\n")}`);
	const x = lines[y].indexOf(label) + 1;
	return instance.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: lines.length, shift: false, alt: false, ctrl: false } as never);
}

test("the browser opens on the host's recent view and picks up only through the labelled control", async () => {
	const f = hostFixture([entry("20260724T120000Z-one", "First effort"), entry("20260724T110000Z-two", "Second effort")]);
	const instance = operatorPanel().open(f.host);
	assert.match(instance.render(80).join("\n"), /Read stashes/);
	await flush();
	const lines = instance.render(100).map(stripVTControlCharacters);
	assert.ok(lines.some((line) => line.includes("First effort")), lines.join("\n"));
	assert.deepEqual(f.requests[0], { op: "recent" });
	assert.ok(f.requests.some((request) => request.op === "preview"), "selection reads the exact artifact through the host");
	assert.equal(f.closed(), 0);
	clickLabel(instance, "[Pick up]", 100);
	await flush();
	assert.ok(f.requests.some((request) => request.op === "pickup" && request.id === "20260724T120000Z-one"));
	assert.ok(f.notices.some((notice) => /queued for pickup/.test(notice.text)));
	assert.equal(f.closed(), 1, "a delivered pickup returns to the conversation");
	instance.dispose();
});

test("a cancelled note sends nothing and a submitted empty note means a plain pickup", async () => {
	const f = hostFixture([entry("20260724T120000Z-one", "First effort")]);
	f.inputs.push(undefined as never, "");
	const instance = operatorPanel().open(f.host);
	await flush();
	clickLabel(instance, "[Pick up + note]", 100);
	await flush();
	assert.equal(f.requests.filter((request) => request.op === "pickup").length, 0, "cancelling the note dialog returns to the browser");
	assert.equal(f.closed(), 0);
	assert.ok(instance.render(100).join("\n").includes("First effort"), "the browser is back");
	clickLabel(instance, "[Pick up + note]", 100);
	await flush();
	const pickup = f.requests.find((request) => request.op === "pickup");
	assert.ok(pickup && pickup.note === undefined, "an empty answer is a plain pickup");
	assert.equal(f.closed(), 1);
	instance.dispose();
});

test("Close leaves every record untouched and returns; disposal ends the loop without closing again", async () => {
	const f = hostFixture([entry("20260724T120000Z-one", "First effort")]);
	const instance = operatorPanel().open(f.host);
	await flush();
	clickLabel(instance, "[Close]", 100);
	await flush();
	assert.equal(f.closed(), 1);
	assert.deepEqual(f.requests.map((request) => request.op).filter((op) => op !== "recent" && op !== "preview"), []);
	const again = operatorPanel().open(hostFixture([entry("x", "X")]).host);
	await flush();
	again.dispose();
	await flush();
	assert.throws(() => readPanelRequest({ op: "pickup", id: "../x" }), /stash id/);
});

test("a failed read is reported, not shown as an empty store", async () => {
	const f = hostFixture([], { recent: () => { throw new Error("store unreadable"); } });
	const instance = operatorPanel().open(f.host);
	await flush();
	assert.ok(f.notices.some((notice) => /store unreadable/.test(notice.text) && notice.type === "error"), JSON.stringify(f.notices));
	assert.equal(f.closed(), 1);
	instance.dispose();
});
