import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.ts";
import register from "./ordinary-entry.ts";
import { matchesSchema } from "./schema-check.ts";

interface RegisteredTool {
	name: string;
	parameters: { type?: string; properties?: Record<string, unknown> };
	execute(
		callId: string,
		input: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}
function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ordinary-adapter-")));
	const saved = new Map(["PI_AGENT_DIR", "PI_AGENT_SESSIONS_DIR"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_DIR = root;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const tools: RegisteredTool[] = [];
	register({
		events: { on: () => () => {}, emit() {} },
		on() {},
		getThinkingLevel: () => "off",
		registerTool: (tool: RegisteredTool) => tools.push(tool),
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root,
		sessionManager: {
			getSessionId: () => "00000000-0000-4000-8000-000000000002",
			getSessionName: () => "primary",
			getEntries: () => [],
		},
		modelRegistry: { find: () => undefined, getAll: () => [] },
	} as unknown as ExtensionContext;
	t.after(async () => {
		const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
			Symbol.for("pi.extension.agent.owners")
		];
		await owners.managers.get(root)?.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return {
		tools,
		execute: (name: string, input: Record<string, unknown>) => {
			const tool = tools.find((item) => item.name === name);
			assert.ok(tool);
			return tool.execute("exact-call", input, undefined, undefined, ctx);
		},
	};
}
const conversation = {
	conversationId: 1,
	identity: "producer",
	busy: false,
	lastText: "full retained text",
	live: null,
	inbox: null,
	agent: { thinkingLevel: "off", extensions: [], tools: [], instructions: "FULL_INSTRUCTIONS" },
	tasks: [],
	submissions: [],
};

it("reads current effort awareness without publishing an ordinary intent", async (t) => {
	const f = fixture(t);
	const publish = t.mock.method(AgentManager.prototype, "publishIntent", () => {
		throw new Error("read must not publish");
	});
	const { details } = await f.execute("agent_intent", { action: "read" });
	const { awareness } = details as { awareness: { self: { id: string }; presence: { coverage: object } } };
	assert.equal(awareness.self.id, "00000000-0000-4000-8000-000000000002");
	assert.ok(awareness.presence.coverage);
	assert.equal(publish.mock.callCount(), 0);
});

it("applies compact selected status and preserves explicit full detail", async (t) => {
	const f = fixture(t);
	t.mock.method(AgentManager.prototype, "status", async () => ({ conversation }));
	const compact = await f.execute("agent_status", { sessionId: "producer" });
	assert.equal((compact.details as { format: string }).format, "compact");
	assert.equal(JSON.stringify(compact).includes("FULL_INSTRUCTIONS"), false);
	assert.ok(
		JSON.stringify(await f.execute("agent_status", { sessionId: "producer", detail: true })).includes(
			"FULL_INSTRUCTIONS",
		),
	);
	assert.deepEqual((await f.execute("agent_status", {})).details, { conversation });
	for (const input of [
		{ detail: false },
		{ sessionId: "producer", detail: false },
		{ view: "fleet", detail: false },
		{ view: "storage-page", storageId: "11111111-2222-3333-4444-555555555555", detail: false },
	])
		await f.execute("agent_status", input);
	for (const input of [
		{ detail: true },
		{ sessionId: "", detail: true },
		{ sessionId: "producer", detail: "true" },
		{ view: "fleet", detail: true },
		{ view: "storage-page", storageId: "producer", detail: true },
	])
		await assert.rejects(f.execute("agent_status", input), /detail requires/u);
});
it("forwards receipt cursors and renders result pages as readable answer text", async (t) => {
	const f = fixture(t);
	const inputs: Record<string, unknown>[] = [];
	t.mock.method(AgentManager.prototype, "control", async (_method: string, input: Record<string, unknown>) => {
		inputs.push(input);
		return {
			view: "result",
			sessionId: "producer",
			conversationId: 1,
			status: "done",
			submissionId: 2,
			requestId: "task",
			answerEntryId: 20,
			answer: "First line\nSecond line",
			usage: { models: {}, tools: {} },
			offset: 0,
			nextOffset: null,
			truncated: false,
			receiptGroup: {
				recipient: "recipient",
				results: [{ sessionId: "producer", submissionId: 2 }],
				complete: true,
				next: null,
			},
		};
	});
	const inspect = f.tools.find((tool) => tool.name === "agent_inspect");
	assert.ok(inspect?.parameters.properties?.receiptCursor);
	const output = await f.execute("agent_inspect", {
		sessionId: "producer",
		view: "result",
		submissionId: 2,
		receiptCursor: "captured",
	});
	assert.equal(inputs[0].receiptCursor, "captured");
	assert.ok(output.content[0].type === "text" && output.content[0].text.startsWith("First line\nSecond line"));
	assert.equal((output.structuredContent as { answer: string }).answer, "First line\nSecond line");
	await assert.rejects(
		f.execute("agent_inspect", { sessionId: "producer", view: "history", receiptCursor: "captured" }),
		/receiptCursor requires/u,
	);
});
it("accepts and forwards exact result references with their native request identity", async (t) => {
	const f = fixture(t),
		inputs: Record<string, unknown>[] = [];
	t.mock.method(AgentManager.prototype, "control", async (_method: string, input: Record<string, unknown>) => {
		inputs.push(input);
		return {
			view: "result",
			sessionId: "producer",
			conversationId: 1,
			status: "unavailable",
			reason: "No retained result",
			usage: { models: {}, tools: {} },
		};
	});
	const tool = f.tools.find((item) => item.name === "agent_inspect");
	assert.ok(tool);
	const reference = { sessionId: "producer", view: "result", submissionId: 2, requestId: "task" };
	assert.equal(matchesSchema(tool.parameters, reference), true);
	assert.equal(matchesSchema(tool.parameters, { ...reference, requestId: "" }), false);
	await f.execute("agent_inspect", reference);
	assert.deepEqual(inputs, [reference]);
	await assert.rejects(f.execute("agent_inspect", { ...reference, view: "history" }), /requestId.*result view/u);
	assert.equal(inputs.length, 1, "a non-result request never reaches the host");
});

it("rejects native receipt continuation selectors on an ordinary primary", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ordinary-inspect-"));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	await assert.rejects(
		manager.observePrimary("ordinary", { receiptCursor: "captured" }),
		/does not support receiptCursor/u,
	);
});
it("continues the view that an ordinary primary cursor names", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "ordinary-inspect-"));
	const manager = new AgentManager({ root, agentDir: root, packageDir: root });
	t.after(async () => {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	});
	const cursor = { version: 1, sessionId: "ordinary", view: "history" };
	await assert.rejects(
		manager.observePrimary("ordinary", { view: "activity", cursor }),
		/continues a history read of the ordinary session\. Omit view or pass view "history"/u,
	);
	// Without a view the cursor's view applies, so the read proceeds to the endpoint lookup.
	await assert.rejects(manager.observePrimary("ordinary", { cursor }), /endpoint of an ordinary session/u);
	await assert.rejects(
		manager.observePrimary("ordinary", { view: "history", cursor }),
		/endpoint of an ordinary session/u,
	);
});
it("keeps successful report sender receipts free of recipient bodies", async (t) => {
	const f = fixture(t);
	t.mock.method(AgentManager.prototype, "control", async () => ({
		sourceId: "report",
		ownerId: "recipient",
		senderIdentity: "sender",
		requestId: "exact",
		createdAt: 1,
		acknowledged: true,
		message: "RECIPIENT_BODY",
		answer: "RECIPIENT_BODY",
	}));
	const output = await f.execute("agent_send", { sessionId: "recipient", mode: "report", message: "RECIPIENT_BODY" });
	assert.equal(JSON.stringify(output).includes("RECIPIENT_BODY"), false);
	assert.equal((output.details as { acknowledged: boolean }).acknowledged, true);
});
it("registers object-root thread inputs and forwards participation and read cursors", async (t) => {
	const f = fixture(t),
		dispatched: Record<string, unknown>[] = [];
	t.mock.method(AgentManager.prototype, "collaborate", async (input: Record<string, unknown>) => {
		dispatched.push(input);
		return { accepted: true };
	});
	const tool = f.tools.find((item) => item.name === "agent_collaborate");
	assert.ok(tool);
	assert.equal(tool.parameters.type, "object");
	assert.ok(tool.parameters.properties?.participation);
	assert.equal("contribution" in (tool.parameters.properties ?? {}), false);
	const threadId = "00000000-0000-4000-8000-000000000001/00000000000000000000000000000001";
	await f.execute("agent_collaborate", { action: "join", threadId, participation: "" });
	assert.equal(dispatched[0].participation, "");
	assert.equal(dispatched[0].message, undefined);
	await f.execute("agent_collaborate", { action: "read", threadId, after: 0, knownFrameRevision: 1 });
	assert.equal(dispatched[1].after, 0);
	assert.equal(dispatched[1].knownFrameRevision, 1);
	assert.equal(dispatched.length, 2);
});
it("loads the ordinary entry without resolving the Durable runtime", () => {
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { registerHooks } from 'node:module';
		let durable = 0;
		registerHooks({resolve(specifier, context, next) {
			if (specifier.startsWith('@earendil-works/pi-durable')) durable++;
			return next(specifier, context);
		}});
		await import(process.argv[1]);
		console.log(JSON.stringify({durable}));
	`,
			new URL("./ordinary-entry.ts", import.meta.url).href,
		],
		{ encoding: "utf8", timeout: 20000, maxBuffer: 16384 },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { durable: 0 });
});
