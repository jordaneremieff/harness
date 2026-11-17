import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { createPublishTool, createNativePublishTool } from "./publish.ts";
import { createReadTool, createNativeReadTool } from "./read.ts";
import { MarkdownStore } from "./store.ts";
import { withLiveShow } from "./live-launch.ts";
import { materializeAndReveal, openScratchpad, selectStored, type RevealRuntime } from "./reveal.ts";
const config = { version: 1 as const, endpoint: "http://127.0.0.1:12345", token: "ab".repeat(32) };
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "markdown-live-launch-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
	const app = join(root, "Reader.app");
	await mkdir(join(app, "Contents", "Resources"), { recursive: true });
	await writeFile(join(app, "Contents", "Resources", "build.json"), JSON.stringify({ contract: 1, pane: 1, paneOpen: 1, live: 1 }));
	return { root, app, store: new MarkdownStore(join(root, "store")) };
}
async function checkLaunch(argv: string[], text: string) {
	assert.equal(argv.at(-2), "--live");
	const path = argv.at(-1);
	assert.ok(path);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
	assert.ok(!text.includes(config.token), "the tool output carries a private path, never its token");
	await rm(path);
}
test("ordinary publication and read show commands carry private one-use connections without revealing tokens", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	const calls: ExtensionContext[] = [];
	const connection = async (ctx: ExtensionContext) => { calls.push(ctx); return config; };
	const ctx = { cwd: f.root, sessionManager: { getSessionId: () => "exact-ordinary" } } as unknown as ExtensionToolContext;
	const published = await createPublishTool({ store: f.store, app: f.app, connection }).execute("publish", { title: "Live", text: "# Exact\n" }, new AbortController().signal, undefined, ctx);
	assert.equal(published.details?.ok, true);
	const result = published.details;
	assert.ok(result?.ok && result.show);
	await checkLaunch(result.show, JSON.stringify(published));
	const read = await createReadTool({ store: f.store, app: f.app, connection }).execute("read", { document: result.documentId }, new AbortController().signal, undefined, ctx);
	assert.ok(read.details?.ok && read.details.op === "read" && read.details.show);
	await checkLaunch(read.details.show, JSON.stringify(read));
	assert.deepEqual(calls, [ctx, ctx]);
	assert.equal((await f.store.get(result.documentId)).source, "# Exact\n");
});
test("native publication and read prepare show commands from their actual calling conversation", { timeout: 10000 }, async (t) => {
	const f = await fixture(t);
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	try {
		const selected = await f.store.create({ title: "Selected", source: "# Selected\n", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() } });
		const calls: string[] = [];
		const connection = async (id: Durable.ConversationId) => { calls.push(String(id)); return config; };
		registry.install(Durable.defineExtension({ name: "markdown", tools: [createNativePublishTool({ durable: Durable, harness, cwd: f.root }, { store: f.store, app: f.app, connection }), createNativeReadTool(Durable, { store: f.store, app: f.app, connection })] }));
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("markdown_publish", { title: "Native live", text: "# Native\n" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("markdown_read", { document: selected.document.id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready."),
		]);
		assert.equal((await (await conversation.submit({ type: "input", content: "Prepare both commands." }, context)).wait(context)).status, "done");
		const results = (await conversation.entries({}, 30, undefined, context)).items.filter((entry) => Durable.ToolResultEntry.is(entry));
		assert.equal(results.length, 2);
		for (const entry of results) {
			const message = entry.model?.[0];
			assert.ok(message?.role === "toolResult" && !message.isError);
			const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
			const match = /run (\[[^\n]+\]) as the program/u.exec(text);
			assert.ok(match, text);
			await checkLaunch(JSON.parse(match[1]) as string[], text);
		}
		assert.deepEqual(calls, [String(conversation.id), String(conversation.id)]);
	} finally { await harness.close(context); }
});
test("pane and editor openers accept live versions 1 and 2 without changing their launch contracts", async (t) => {
	const f = await fixture(t);
	const previous = process.env.PI_MARKDOWN_APP;
	process.env.PI_MARKDOWN_APP = f.app;
	t.after(() => { if (previous === undefined) delete process.env.PI_MARKDOWN_APP; else process.env.PI_MARKDOWN_APP = previous; });
	const stored = await f.store.create({ title: "Exact", source: "captured", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() } });
	const saved = await selectStored(f.store.root, stored.document.id);
	for (const live of [1, 2, 3]) {
		await writeFile(join(f.app, "Contents", "Resources", "build.json"), JSON.stringify({ contract: 1, pane: 1, paneOpenRequest: 1, editorOpen: 1, live }));
		let dispatches = 0;
		const runtime: RevealRuntime = { platform: "darwin", acceptanceMs: 5, run: async (_exe, args, options) => {
			if (args[1] === "capture") return { stdout: "null" };
			dispatches++;
			const payload = JSON.parse(options.input ?? "null");
			await checkLaunch(payload.argv, JSON.stringify(payload));
			return { stdout: JSON.stringify({ version: 1, outcome: "created", detail: "Created.", receipt: { opaque: "pane" } }) };
		} };
		const result = await materializeAndReveal(async () => saved, new AbortController().signal, { gui: true, runtime, live: config });
		if (live === 1 || live === 2) {
			assert.equal(result.state, "not-confirmed");
			await openScratchpad(new AbortController().signal, { runtime, live: config });
			assert.equal(dispatches, 2);
		} else {
			assert.equal(result.state, "reveal-failed");
			await assert.rejects(openScratchpad(new AbortController().signal, { runtime, live: config }), /cannot connect/u);
			assert.equal(dispatches, 0);
		}
	}
});
test("show attaches live versions 1 and 2 but refuses unknown capabilities", async (t) => {
	const f = await fixture(t);
	for (const live of [1, 2, 3, undefined]) {
		await writeFile(join(f.app, "Contents", "Resources", "build.json"), JSON.stringify({ contract: 1, pane: 1, live }));
		let calls = 0;
		const outcome = await withLiveShow({ show: ["reader", "--pane", "document"] }, f.app, async () => { calls++; return config; });
		if (live === 1 || live === 2) {
			assert.ok(outcome.show);
			await checkLaunch(outcome.show, JSON.stringify(outcome));
			assert.equal(calls, 1);
		} else {
			assert.equal(outcome.show, undefined);
			assert.equal(calls, 0);
		}
	}
});
test("a missing live app or closed conversation preserves the successful document outcome", async (t) => {
	const f = await fixture(t);
	const outcome: { ok: boolean; show?: string[]; showUnavailable?: string } = { ok: true, show: ["reader", "--pane", "document"] };
	const missing = await withLiveShow(outcome, join(f.root, "missing.app"), async () => config);
	assert.equal(missing.ok, true); assert.equal(missing.show, undefined);
	const closed = await withLiveShow(outcome, f.app, async () => { throw new Error("closed"); });
	assert.equal(closed.ok, true); assert.equal(closed.show, undefined);
	assert.match(closed.showUnavailable ?? "", /exact invoking conversation/u);
});
