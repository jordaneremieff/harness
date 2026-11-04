/** The attached-terminal stash browser: the shared view over a host request route. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { JsonValue, OperatorView, PanelHost } from "../../operator-ui/index.ts";
import type { BrowserView } from "./browser-views.ts";
import { operatorPanel } from "./operator-panel.ts";
import { readPanelRequest } from "./panel-protocol.ts";
import type { StashEntry } from "./store.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const identity = (text: string) => text;
const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: identity, italic: identity, strikethrough: identity, underline: identity } as unknown as PanelHost["theme"];
const flush = async () => {
	for (let round = 0; round < 10; round++) await new Promise((resolve) => setImmediate(resolve));
};

function entry(id: string, title: string, state: "open" | "active" | "closed" = "open"): StashEntry {
	return { meta: { id, title, created: "20260724T120000Z", project: "/tmp/project", branch: "main", tags: [], state }, path: `/tmp/${id}.md`, preview: `# ${title}\n\nbody of ${id}`, previewTruncated: false };
}

/** A panel host over a fake route, with the nested views a frame would keep. */
function hostFixture(entries: StashEntry[], answers: Partial<Record<string, (request: Record<string, unknown>) => unknown>> = {}, target = "conversation-1") {
	const requests: Record<string, unknown>[] = [];
	const notices: string[] = [];
	let closed = 0;
	const view: BrowserView = { scope: "recent", query: "", cursor: undefined, nextCursor: null, entries, hasMore: false, coverage: undefined, stale: false };
	const layers: Array<{ view: OperatorView; controller: AbortController }> = [];
	const request = async (data: JsonValue) => {
		const asked = data as Record<string, unknown>;
		requests.push(asked);
		const custom = answers[String(asked.op)];
		if (custom) return { text: "custom", data: custom(asked) as JsonValue };
		if (asked.op === "recent") return { text: "recent", data: { op: "recent", view } as unknown as JsonValue };
		if (asked.op === "preview") return { text: "preview", data: { op: "preview", entry: entries.find((item) => item.meta.id === asked.id) } as unknown as JsonValue };
		if (asked.op === "pickup") return { text: "pickup", data: { op: "pickup", id: asked.id, text: `Stash ${String(asked.id)} is active and queued for pickup (submission 9).` } as JsonValue };
		throw new Error(`unexpected ${String(asked.op)}`);
	};
	const host = (controller: AbortController): PanelHost => ({
		theme,
		target: { id: target, label: "Reviewer · work" },
		signal: controller.signal,
		requestRender: () => {},
		notify: (text) => notices.push(text),
		push: (open) => {
			const child = new AbortController();
			layers.push({ view: open(host(child)), controller: child });
		},
		back: () => {
			const index = layers.findIndex((layer) => layer.controller === controller);
			for (const layer of layers.splice(Math.max(1, index))) layer.controller.abort();
		},
		focusActions: () => {},
		close: () => {
			closed++;
		},
		request,
	});
	layers.push({ view: operatorPanel().open(host(new AbortController())), controller: new AbortController() });
	const top = () => layers.at(-1)?.view;
	return {
		requests,
		notices,
		closed: () => closed,
		depth: () => layers.length,
		screen: () => (top()?.render(120, 20) ?? []).map((line) => stripVTControlCharacters(line)).join("\n"),
		act(label: string) {
			const action = top()?.actions?.().find((candidate) => candidate.label === label);
			assert.ok(action, `no ${label}: ${top()?.actions?.().map((candidate) => candidate.label).join(", ")}`);
			assert.equal(action.disabled, undefined, `${label}: ${action.disabled}`);
			action.run();
		},
	};
}

test("the browser opens on the host's recent view and picks up only through the labelled control", async () => {
	const f = hostFixture([entry("20260724T120000Z-one", "First effort"), entry("20260724T110000Z-two", "Second effort")], {}, "pickup-target");
	assert.match(f.screen(), /Reading stashes/);
	await flush();
	assert.ok(f.screen().includes("First effort"), f.screen());
	assert.deepEqual(f.requests[0], { op: "recent" });
	assert.ok(f.requests.some((request) => request.op === "preview"), "selection reads the exact artifact through the host");
	assert.ok(!f.requests.some((request) => request.op === "pickup"), "selection never picks up");
	f.act("Pick up");
	await flush();
	assert.ok(f.requests.some((request) => request.op === "pickup" && request.id === "20260724T120000Z-one"));
	assert.ok(f.notices.some((notice) => /queued for pickup/.test(notice)), "the receipt shows in the browser");
	assert.equal(f.closed(), 0, "the handover goes to the selected agent; the browser stays with the receipt");
});

test("a cancelled note sends nothing and a submitted empty note means a plain pickup", async () => {
	const f = hostFixture([entry("20260724T120000Z-one", "First effort")], {}, "note-target");
	await flush();
	f.act("Pick up with note…");
	f.act("Cancel");
	assert.equal(f.requests.filter((request) => request.op === "pickup").length, 0, "cancelling the note returns to the browser");
	assert.equal(f.depth(), 1);
	f.act("Pick up with note…");
	f.act("Pick up");
	await flush();
	const pickup = f.requests.find((request) => request.op === "pickup");
	assert.ok(pickup && pickup.note === undefined, "an empty note is a plain pickup");
	assert.equal(f.depth(), 1, "the note form leaves after the pickup");
});

test("a failed read is shown in the view, not as an empty store, and the request union refuses unsafe ids", async () => {
	const f = hostFixture([], { recent: () => { throw new Error("store unreadable"); } }, "failed-target");
	await flush();
	assert.match(f.screen(), /The stash store could not be read; Refresh retries: store unreadable/);
	assert.doesNotMatch(f.screen(), /No stashes yet/);
	assert.throws(() => readPanelRequest({ op: "pickup", id: "../x" }), /stash id/);
});
