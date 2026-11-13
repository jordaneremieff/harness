import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { OperatorView, ViewHost } from "../../operator-ui/index.ts";
import { markdownView, type MarkdownOperations, type MarkdownRow } from "./operator-view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, underline: (text: string) => text } as Theme;
const row = (id: string): MarkdownRow => ({ kind: "response", response: { entryId: id, preview: `Preview ${id}`, bytes: id === "substantial" ? 4096 : 100, timestamp: Date.now() - 15 * 60 * 1000, stop: "stop", completeness: { state: "complete" } } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(ops: MarkdownOperations) {
	const controller = new AbortController();
	const notices: string[] = [];
	const host: ViewHost = { theme, target: { id: "captured", label: "Selected conversation" }, signal: controller.signal, requestRender: () => {}, notify: (message) => notices.push(message), push: () => {}, back: () => {}, close: () => controller.abort() };
	return { view: markdownView(host, ops), controller, notices };
}
function action(view: OperatorView, id: string) {
	const candidate = view.actions?.().find((item) => item.id === id);
	assert.ok(candidate);
	assert.equal(candidate.disabled, undefined);
	candidate.run();
}
test("the view lists prior responses and exposes matching read, recent and published actions", async () => {
	const read: string[] = [];
	const f = fixture({ load: async () => ({ rows: [row("ack"), row("substantial")], coverage: "2 responses" }), read: async (item) => { read.push(item.kind === "response" ? item.response.entryId : "document"); return "opened"; }, latest: async () => "latest" });
	await tick();
	const screen = f.view.render(120, 24).join("\n");
	assert.match(screen, /substantial/u);
	assert.match(screen, /4\.0 KB · 15m/u);
	assert.match(screen, /100 B · 15m/u);
	assert.match(screen, /Preview only/u);
	assert.deepEqual(f.view.actions?.().slice(0, 4).map((item) => [item.id, item.key]), [["read", "enter"], ["latest", "l"], ["recent", "n"], ["published", "p"]]);
	assert.equal(read.length, 0, "list, render and initial selection do not reveal");
	action(f.view, "read");
	await tick();
	assert.deepEqual(read, ["ack"]);
	f.controller.abort();
});
test("selection change and view close abort acquisition and drop late outcomes", async () => {
	let release: () => void = () => {};
	let received: AbortSignal | undefined;
	const f = fixture({ load: async () => ({ rows: [row("one"), row("two")], coverage: "responses" }), read: async (_item, signal) => { received = signal; await new Promise<void>((resolve) => { release = resolve; }); return "late reveal notice"; }, latest: async () => "latest" });
	await tick();
	f.view.render(120, 24);
	action(f.view, "read");
	f.view.handleInput("\u001b[B");
	assert.equal(received?.aborted, true);
	release(); await tick();
	assert.ok(!f.notices.includes("late reveal notice"));
	action(f.view, "read");
	f.controller.abort();
	assert.equal(received?.aborted, true);
	release(); await tick();
	assert.ok(!f.notices.includes("late reveal notice"));
});
test("a published row shows the short stable ID, the revision and the age of its last change", async () => {
	const document: MarkdownRow = { kind: "document", root: "/store", storeId: "store", document: { id: "md-0123456789abcdef0123", title: "Release notes", revision: 3, bytes: 2048, kind: "published", digest: "sha256:0", updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } };
	const f = fixture({ load: async () => ({ rows: [document], coverage: "1 document" }), read: async () => "opened", latest: async () => "latest" });
	await tick();
	const screen = f.view.render(120, 24).join("\n");
	assert.match(screen, /md-01234567 · r3 · 2h {2}Release notes/u);
	f.controller.abort();
});
