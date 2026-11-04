import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { OperatorView, ViewHost } from "../../operator-ui/index.ts";
import type { AccessError, AccessPage, AccessRequest } from "./access.ts";
import type { BrowserEntry } from "./inventory.ts";
import { pillarsView } from "./operator-view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const digest = "a".repeat(64);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const page = (over: Partial<AccessPage> = {}): AccessPage => ({ schema: "pillars-source", resource: "governance", referenceBodyDigest: digest, bodyBytes: 96, offset: 0, endOffset: 48, text: "body", ...over });
const entries: BrowserEntry[] = [
	{ resource: "inventory", title: "Pillars", type: "inventory", index: "Portable design doctrine for agent-assisted work." },
	{ resource: "governance", title: "Pillars Governance", type: "governance", index: "Operating rules for the pillar corpus." },
	{ resource: "pattern-frame-inspection", title: "Frame Inspection", type: "pattern", index: "At an option set, name the frame, test whether it binds, step out if not." },
];

function open(read: (request: AccessRequest) => Promise<AccessPage | AccessError>) {
	const calls: AccessRequest[] = [];
	const host: ViewHost = {
		theme,
		target: { id: "session", label: "This session · work" },
		signal: new AbortController().signal,
		requestRender: () => {},
		notify: () => {},
		push: () => {},
		back: () => {},
		focusActions: () => {},
		close: () => {},
	};
	const view: OperatorView = pillarsView(host, {
		inventory: async () => entries,
		read: async (request) => {
			calls.push(request);
			return read(request);
		},
	});
	const screen = (width = 120) => (view.render(width, 30) ?? []).map((line) => stripVTControlCharacters(line)).join("\n");
	const action = (label: string) => {
		const found = view.actions?.().find((candidate) => candidate.label === label);
		assert.ok(found, `no ${label}`);
		return found;
	};
	return { view, calls, screen, action };
}

test("the inventory lists every source read-only; selecting reads its first page and shows the complete digest", async () => {
	const v = open(async (request) => page({ resource: request.resource ?? "inventory", text: `${request.resource} text` }));
	await turn();
	const first = v.screen();
	assert.match(first, /3 sources · read-only/);
	assert.ok(first.includes("Frame Inspection"));
	assert.deepEqual(v.calls, [{ resource: "inventory" }], "the first listed source reads on selection");
	v.view.handleInput("\u001b[B");
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance" });
	// A wide window keeps the whole digest on one detail row.
	const detail = v.screen(200);
	assert.ok(detail.includes(`SHA-256: ${digest}`), "the digest is complete");
	assert.ok(detail.includes("governance text"));
	assert.deepEqual(v.view.actions?.().map((action) => action.label), ["Read more", "Read again"], "no judgment action starts from here");
});

test("Read more carries the exact offset and digest of the pages shown; Read again starts from the first page", async () => {
	const pages = [page({ text: "first ", nextOffset: 48 }), page({ text: "second", offset: 48, endOffset: 96 }), page({ text: "again" })];
	const v = open(async (request) => (request.resource === "inventory" ? page({ resource: "inventory" }) : (pages.shift() ?? page())));
	await turn();
	v.view.handleInput("\u001b[B");
	await turn();
	assert.ok(v.screen().includes("Read more continues at byte 48 of 96"));
	v.action("Read more").run();
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance", offset: 48, referenceBodyDigest: digest });
	assert.ok(v.screen().includes("first second"));
	assert.equal(typeof v.action("Read more").disabled, "string", "the whole source is shown");
	v.action("Read again").run();
	await turn();
	assert.deepEqual(v.calls.at(-1), { resource: "governance" });
	assert.ok(v.screen().includes("again"));
	assert.ok(!v.screen().includes("first second"), "a fresh read never mixes revisions");
});

test("a source error shows its code and stops further pages; the filter narrows the inventory", async () => {
	const error: AccessError = { schema: "pillars-source-error", code: "source_changed", message: "The source changed; omit both continuation fields for a fresh read." };
	const v = open(async (request) => (request.offset === undefined ? page({ resource: "inventory", nextOffset: 48 }) : error));
	await turn();
	v.action("Read more").run();
	await turn();
	assert.ok(v.screen().includes("source_changed"));
	assert.equal(typeof v.action("Read more").disabled, "string");
	for (const key of "frame") v.view.handleInput(key);
	const filtered = v.screen();
	assert.match(filtered, /1 of 3 sources match/);
	assert.ok(!filtered.includes("Pillars Governance ·"));
});
