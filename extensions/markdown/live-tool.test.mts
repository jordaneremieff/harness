import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import type { LiveBridge } from "./live-bridge.ts";
import { createNativeLiveTool, liveSourcePage } from "./live-tool.ts";
import type { LiveResult } from "./live-protocol.ts";
import { responseDigest } from "./responses.ts";

test("live source pages preserve exact UTF-16 continuation and all source bytes", () => {
	const source = `${"a".repeat(65535)}🧭${"b".repeat(65536)}\nend`;
	const result: Extract<LiveResult, { status: "ok" }> = { status: "ok", source, generation: 8, digest: responseDigest(source), assets: [{ reference: "./image.svg", digest: responseDigest("image") }] };
	const pages: string[] = [];
	let offset = 0;
	for (let step = 0; step < 4; step++) {
		const page = liveSourcePage(result, { op: "read", offset, baseGeneration: 8, baseDigest: result.digest });
		assert.equal(page.status, "ok");
		if (page.status !== "ok") throw new Error("No source page");
		assert.equal(page.offset, offset);
		assert.equal(page.totalChars, source.length);
		assert.equal(page.totalBytes, Buffer.byteLength(source));
		assert.equal(page.digest, result.digest);
		assert.deepEqual(page.assets, result.assets);
		assert.ok(Buffer.byteLength(page.source) <= 65536);
		if (step === 0) assert.equal(Buffer.byteLength(page.source), 65535, "a page does not split a surrogate pair");
		pages.push(page.source);
		if (page.nextOffset === null) break;
		assert.equal(page.nextOffset, offset + page.source.length);
		offset = page.nextOffset;
	}
	assert.ok(pages.join("") === source, "no source bytes disappear between pages");
	assert.equal(liveSourcePage(result, { op: "read", offset: 65535, baseGeneration: 9, baseDigest: result.digest }).status, "stale");
	assert.equal(liveSourcePage(result, { op: "read", offset: 65535, baseGeneration: 8, baseDigest: responseDigest("changed") }).status, "stale");
	assert.equal(liveSourcePage(result, { op: "read", offset: 65535 }).status, "stale");
	assert.throws(() => liveSourcePage(result, { op: "read", offset: 65536, baseGeneration: 8, baseDigest: result.digest }), /boundary/u);
	assert.throws(() => liveSourcePage(result, { op: "read", offset: source.length + 1, baseGeneration: 8, baseDigest: result.digest }), /boundary/u);
	assert.equal(liveSourcePage({ ...result, source: "short", generation: 9, digest: responseDigest("short") }, { op: "read", offset: 65535, baseGeneration: 8, baseDigest: result.digest }).status, "stale", "a shorter changed source requires a fresh read, not an invalid-page report");
});
test("the native tool retains a full escaped page beyond the host's default output bound", { timeout: 10000 }, async () => {
	const source = "\u0000".repeat(65536);
	const result = { status: "ok", source, generation: 1, digest: responseDigest(source), assets: [] } as const;
	const bridge = { execute: async () => result } as unknown as LiveBridge;
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(Durable.defineExtension({ name: "markdown", tools: [createNativeLiveTool(Durable, async () => bridge)] }));
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([fauxAssistantMessage(fauxToolCall("markdown_live", { op: "read", handle: "exact-test-handle" }), { stopReason: "toolUse" }), fauxAssistantMessage("Read complete.")]);
		await (await conversation.submit({ type: "input", content: "Read the exact buffer." }, context)).wait(context);
		const entry = (await conversation.entries({}, 20, undefined, context)).items.find((item) => Durable.ToolResultEntry.is(item));
		const message = entry?.model?.[0];
		assert.ok(message?.role === "toolResult" && !message.isError);
		const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		assert.ok(Buffer.byteLength(text) > 65536);
		const page = JSON.parse(text);
		assert.ok(page.source === source, "the host receives every byte of the escaped source page");
		assert.equal(page.nextOffset, null);
		assert.equal(page.totalBytes, 65536);
	} finally { await harness.close(context); }
});
test("an empty live source and native failures remain exact", () => {
	const page = liveSourcePage({ status: "ok", source: "", generation: 0, digest: responseDigest(""), assets: [] }, { op: "read" });
	assert.ok(page.status === "ok" && page.source === "" && page.nextOffset === null && page.totalBytes === 0);
	assert.deepEqual(liveSourcePage({ status: "busy", message: "Composition is active." }, { op: "read" }), { status: "busy", message: "Composition is active." });
});
