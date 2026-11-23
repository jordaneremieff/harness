import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts, plain } from "./load.mts";
function setup(source = "abcdef", captured = false) {
	const api = scripts([
		"app/host/native.ts",
		"app/core/exact.ts",
		"app/core/source-model.ts",
		"test/fixtures.ts",
		"test/host-memory.ts",
	]).reader as ReaderNamespace & {
		fixtures: { document(source: string): ReaderDocument; render(source: string): ReaderBlock[] };
	};
	const payload = api.fixtures.document(source);
	payload.meta.capturedSource = captured;
	return { api, payload, host: api.createMemoryHost(payload, api.fixtures.render) };
}
const change = (host: ReaderMemoryHost, edits: ReaderEdit[], base = 0) => ({
	presentation: host.document.presentation,
	baseGeneration: base,
	generation: base + 1,
	origin: "person",
	edits,
});
test("the first accepted change creates a copy and retains the exact recovery source", () => {
	const { payload, host } = setup("a\r\nb", true);
	host.send("lock", { lock: "writing", copy: true });
	assert.equal(Boolean(host.draft), false);
	host.send("edits", change(host, [{ start: 0, end: 1, text: "A", expected: "a" }]));
	assert.equal(host.source, "A\r\nb");
	assert.equal(payload.source, "a\r\nb");
	assert.equal(host.mirror.originalSource, "a\r\nb");
	assert.equal(host.draft?.source, "A\r\nb");
	assert.equal(host.document.meta.capturedSource, false);
	assert.deepEqual(Buffer.from(host.recovery().source), Buffer.from(host.source));
	host.dispose();
});
test("wrong generation and expected text never change the mirror", () => {
	const { host } = setup();
	host.send("edits", change(host, [{ start: 1, end: 3, text: "XY", expected: "bc" }], 4));
	assert.equal(host.source, "abcdef");
	assert.equal(host.generation, 0);
	host.send("edits", change(host, [{ start: 1, end: 3, text: "XY", expected: "zz" }]));
	assert.equal(host.source, "abcdef");
	assert.equal(host.generation, 0);
	assert.deepEqual(plain(host.sent.map((m) => m.type)), ["edits", "edits"]);
	assert.equal(host.inbound.filter((m) => m.type === "refused").length, 2);
	host.dispose();
});
test("unordered and overlapping edits refuse at the transport boundary", () => {
	const { host } = setup();
	assert.throws(() =>
		host.send(
			"edits",
			change(host, [
				{ start: 2, end: 4, text: "X", expected: "cd" },
				{ start: 1, end: 2, text: "Y", expected: "b" },
			]),
		),
	);
	assert.equal(host.source, "abcdef");
	assert.throws(() =>
		host.send(
			"edits",
			change(host, [
				{ start: 1, end: 3, text: "X", expected: "bc" },
				{ start: 2, end: 4, text: "Y", expected: "cd" },
			]),
		),
	);
	assert.equal(host.generation, 0);
	host.dispose();
});
test("ordered edits compose through an independent mirror application", () => {
	const { host } = setup();
	host.send(
		"edits",
		change(host, [
			{ start: 0, end: 2, text: "A", expected: "ab" },
			{ start: 4, end: 6, text: "F", expected: "ef" },
		]),
	);
	assert.equal(host.source, "AcdF");
	assert.equal(host.generation, 1);
	host.dispose();
});
test("agentApply does not change the mirror before the page sends its edits", () => {
	const { host } = setup();
	const edits = [{ start: 0, end: 1, text: "A", expected: "a" }];
	let received = false;
	host.on("agentApply", () => {
		received = true;
		assert.equal(host.source, "abcdef");
	});
	assert.equal(host.emit("agentApply", { operationId: "agent", baseGeneration: 0, edits }), true);
	assert.equal(received, true);
	assert.equal(host.source, "abcdef");
	host.send("edits", { ...change(host, edits), origin: "agent", operationId: "agent" });
	assert.equal(host.source, "Abcdef");
	host.dispose();
});
test("document replacement updates the mirror before delivery and retains the original capture", () => {
	const { api, host } = setup();
	host.on("document", (m) => assert.equal(host.source, (m as ReaderDocument).source));
	assert.equal(host.emit("document", api.fixtures.document("new source")), true);
	assert.equal(host.source, "new source");
	assert.equal(host.mirror.originalSource, "abcdef");
	assert.equal(host.recovery().source, "new source");
	assert.equal(host.emit("unknown"), false);
	host.dispose();
});
test("render, queries and custom image staging return validated replies", async () => {
	const { host } = setup();
	const rendered = (await host.request("render", { generation: 0 })) as { generation: number; blocks: ReaderBlock[] };
	assert.equal(rendered.generation, 0);
	assert.equal(rendered.blocks.length, 1);
	const details = (await host.request("query", { kind: "details" })) as { rows: unknown[] };
	assert.ok(details.rows.length > 0);
	host.respond("command", () => ({ generation: 0, edits: [{ start: 0, end: 0, text: "![x](asset)", expected: "" }] }));
	const image = (await host.request("command", {
		name: "pickImage",
		args: { generation: 0, range: { start: 0, end: 0 } },
	})) as { edits: ReaderEdit[] };
	assert.equal(image.edits.length, 1);
	assert.equal(host.source, "abcdef");
	host.dispose();
});
test("settings retain native multipliers without source changes", () => {
	const { host } = setup();
	assert.equal(host.document.settings.textSize, 1);
	host.send("command", { name: "saveSettings", args: { patch: { textSize: 1.1 } } });
	assert.equal(host.document.settings.textSize, 1.1);
	assert.equal(host.recovery().settings.textSize, 1.1);
	host.emit("command", { name: "applySettings", args: { textSize: 1.2 } });
	assert.equal(host.document.settings.textSize, 1.2);
	assert.equal(host.source, "abcdef");
	assert.equal(host.generation, 0);
	host.dispose();
});
test("review, source search and store replies match their current shapes", async () => {
	const { host } = setup();
	const review = (await host.request("query", { kind: "review", against: "base" })) as { summary: { line: string } };
	assert.equal(review.summary.line, "No changes.");
	const library = (await host.request("query", {
		kind: "library",
		collection: "drafts",
		match: "source",
		query: "needle",
	})) as { store: { label: string }; coverage: { total: number } };
	assert.equal(library.store.label, "Fixture");
	assert.equal(library.coverage.total, 0);
	const choice = (await host.request("command", { name: "chooseStore" })) as { changed: boolean };
	assert.equal(choice.changed, false);
	host.dispose();
});
test("listeners unsubscribe and disposal rejects later work", async () => {
	const { host } = setup();
	let count = 0;
	const off = host.on("ack", () => count++);
	off();
	host.send("edits", change(host, [{ start: 0, end: 1, text: "A", expected: "a" }]));
	assert.equal(count, 0);
	host.dispose();
	assert.equal(host.emit("command", { name: "undo" }), false);
	assert.throws(() => host.send("lock", { lock: "reading", copy: false }), /disposed/);
	await assert.rejects(host.request("render", { generation: 1 }), /disposed/);
});
