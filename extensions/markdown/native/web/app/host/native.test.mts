import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts } from "../../test/load.mts";
function bridge() {
	return scripts(["app/host/native.ts"]).reader as ReaderNamespace;
}
test("classic host sends exact versioned envelopes and matches reply IDs", async () => {
	const api = bridge();
	const host = api.createNativeHost((m) => ({ v: 1, type: "reply", id: m.id, ok: true, generation: 0, blocks: [] }));
	const reply = (await host.request("render", { generation: 0 })) as Record<string, unknown>;
	assert.equal(reply.generation, 0);
	host.dispose();
});
test("unknown version, type and command refuse without dispatch", () => {
	const api = bridge(),
		host = api.createNativeHost(() => undefined);
	let count = 0;
	host.on("command", () => count++);
	assert.equal(api.receive({ v: 2, type: "command", name: "undo" }), false);
	assert.equal(api.receive({ v: 1, type: "invented" }), false);
	for (const type of ["toString", "constructor", "__proto__"]) {
		assert.equal(api.receive({ v: 1, type }), false);
		assert.throws(() => api.bridge.page({ v: 1, type }));
	}
	assert.equal(api.receive({ v: 1, type: "command", name: "invented" }), false);
	assert.equal(count, 0);
	host.dispose();
});
test("malformed and mismatched replies reject requests", async () => {
	const api = bridge(),
		host = api.createNativeHost(() => ({ v: 1, type: "reply", id: "wrong", ok: true }));
	await assert.rejects(host.request("render", { generation: 0 }), /Unexpected reader reply/);
	host.dispose();
});
test("disposal rejects pending requests", async () => {
	const api = bridge(),
		host = api.createNativeHost(() => new Promise(() => {}));
	const pending = host.request("render", { generation: 0 });
	host.dispose();
	await assert.rejects(pending, /disposed/);
});
test("ready and format use the current command vocabulary", () => {
	const api = bridge();
	assert.equal(api.bridge.page({ v: 1, type: "ready", version: "reader", capabilities: { lock: true } }).v, 1);
	assert.equal(
		api.bridge.native({ v: 1, type: "command", name: "format", args: { command: "heading", level: 2 } }).type,
		"command",
	);
	assert.throws(() =>
		api.bridge.native({ v: 1, type: "command", name: "format", args: { command: "heading", level: 7 } }),
	);
});
test("ordinary messages enforce their exact byte bound", () => {
	const api = bridge(),
		base = { v: 1, type: "command", name: "copy", args: { text: "" } };
	const overhead = Buffer.byteLength(JSON.stringify(base));
	base.args.text = "a".repeat(256 * 1024 - overhead);
	assert.equal(api.bridge.page(base).type, "command");
	base.args.text += "a";
	assert.throws(() => api.bridge.page(base), /byte limit/);
});
function documentMessage(source = "") {
	return {
		v: 1,
		type: "document",
		source,
		generation: 0,
		meta: {
			documentId: "fixture",
			kind: "published",
			title: "Fixture",
			shortId: "fixture",
			revision: 1,
			revisions: [],
			digest: "fixture",
			provenance: {},
			capturedSource: false,
		},
		settings: {
			lock: "reading",
			textSize: 1,
			textSizeSteps: [0.9, 1, 1.1],
			codeWrap: true,
			appearance: "system",
			outlineWidth: 240,
			outlineOpen: true,
		},
		blocks: [] as ReaderBlock[],
		headings: [],
		chrome: "pane",
		live: true,
	};
}
test("document source uses raw UTF-8 rather than escaped JSON bytes", () => {
	const api = bridge(),
		message = documentMessage("é".repeat(1024 * 1024));
	assert.equal(api.bridge.native(message).type, "document");
	message.source += "é";
	assert.throws(() => api.bridge.native(message), /byte limit/);
	const escaped = documentMessage('"'.repeat(2 * 1024 * 1024));
	assert.equal(api.bridge.native(escaped).type, "document");
});
test("document blocks and matching render replies have a separate exact JSON bound", () => {
	const api = bridge(),
		message = documentMessage(),
		block = { key: "b", start: 0, end: 0, type: "paragraph", html: "", map: [] };
	message.blocks = [block];
	const overhead = Buffer.byteLength(JSON.stringify(message.blocks));
	block.html = "a".repeat(16 * 1024 * 1024 - overhead);
	assert.equal(api.bridge.native(message).type, "document");
	assert.equal(
		api.bridge.reply({ v: 1, type: "reply", id: "r", ok: true, generation: 0, blocks: message.blocks }, "r", "render", {
			generation: 0,
		}).generation,
		0,
	);
	assert.throws(
		() => api.bridge.native({ v: 1, type: "renderResult", generation: 0, blocks: message.blocks }),
		/byte limit/,
	);
	block.html += "a";
	assert.throws(() => api.bridge.native(message), /byte limit/);
});
test("review HTML has the large bound only for a matching review request", () => {
	const api = bridge(),
		message = {
			v: 1,
			type: "reply",
			id: "review",
			ok: true,
			summary: {
				base: 1,
				target: 2,
				changedRegions: 0,
				addedLines: 0,
				removedLines: 0,
				assetChanges: 0,
				partial: false,
				line: "Fixture",
			},
			html: "a".repeat(16 * 1024 * 1024),
		};
	assert.equal(typeof api.bridge.reply(message, "review", "query", { kind: "review" }).html, "string");
	assert.throws(() => api.bridge.reply(message, "other", "query", { kind: "review" }), /Unexpected reader reply/);
	assert.throws(() => api.bridge.reply(message, "review", "query", { kind: "details" }), /byte limit/);
	message.html += "a";
	assert.throws(() => api.bridge.reply(message, "review", "query", { kind: "review" }), /byte limit/);
});
test("edits use their exact compact JSON bound independently of metadata", () => {
	const api = bridge(),
		n = 512 * 1024,
		edits = [
			{ start: 0, end: n, expected: "a".repeat(n), text: "x".repeat(2 * 1024 * 1024) },
			{ start: n, end: 2 * n, expected: "a".repeat(n), text: "x".repeat(2 * 1024 * 1024) },
		];
	const excess = Buffer.byteLength(JSON.stringify(edits)) - 5 * 1024 * 1024;
	edits[1].text = edits[1].text.slice(0, edits[1].text.length - excess);
	const page = { v: 1, type: "edits", baseGeneration: 0, generation: 1, origin: "person", edits };
	assert.equal(api.bridge.page(page).type, "edits");
	assert.equal(
		api.bridge.native({ v: 1, type: "agentApply", baseGeneration: 0, operationId: "agent", edits }).type,
		"agentApply",
	);
	edits[1].text += "x";
	assert.throws(() => api.bridge.page(page), /byte limit/);
});
test("large document groups do not enlarge the remaining metadata allowance", () => {
	const api = bridge(),
		message = { ...documentMessage("é".repeat(1024 * 1024)), padding: "" };
	const rest: Record<string, unknown> = { ...message };
	delete rest.source;
	delete rest.blocks;
	message.padding = "a".repeat(256 * 1024 - Buffer.byteLength(JSON.stringify(rest)));
	assert.equal(api.bridge.native(message).type, "document");
	message.padding += "a";
	assert.throws(() => api.bridge.native(message), /byte limit/);
});
test("text settings use positive multipliers and ordered multiplier steps", () => {
	const api = bridge();
	const valid = { v: 1, type: "command", name: "applySettings", args: { textSize: 1.1, textSizeSteps: [0.9, 1, 1.1] } };
	assert.equal(api.bridge.native(valid).type, "command");
	assert.throws(() => api.bridge.native({ ...valid, args: { textSize: 0 } }));
	assert.throws(() => api.bridge.native({ ...valid, args: { textSizeSteps: [1, 0.9] } }));
	assert.throws(() => api.bridge.native({ ...valid, args: { textSizeSteps: [1, 1] } }));
	const doc = documentMessage();
	const incomplete = { ...doc, settings: { lock: "reading", textSize: 1 } };
	assert.throws(() => api.bridge.native(incomplete));
});
test("block maps refuse malformed source ranges and block order", () => {
	const api = bridge(),
		message = documentMessage("abc");
	message.blocks = [{ key: "b", start: 0, end: 3, type: "paragraph", html: "abc", map: [[0, 3, 0, 4]] }];
	assert.throws(() => api.bridge.native(message), /inline map/);
	message.blocks = [
		{ key: "b", start: 0, end: 3, type: "paragraph", html: "abc" },
		{ key: "b", start: 1, end: 2, type: "paragraph", html: "b" },
	];
	assert.throws(() => api.bridge.native(message), /blocks/);
});
