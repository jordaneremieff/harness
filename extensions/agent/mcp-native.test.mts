import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";

const serverPath = join(import.meta.dirname, "testdata", "mcp-server", "server.mts");

let baseAgentDir: string;
let previousAgentDir: string | undefined;
before(() => {
	baseAgentDir = mkdtempSync(join(tmpdir(), "agent-mcp-config-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = baseAgentDir;
});
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(baseAgentDir, { recursive: true, force: true });
});

/** Test-side end of the fixture server's event socket: start, handshake, and exit arrive as events. */
async function observeServer() {
	const slots = new Map<string, { promise: Promise<string>; resolve: (payload: string) => void }>();
	const slot = (name: string) => {
		let entry = slots.get(name);
		if (!entry) {
			let resolve!: (payload: string) => void;
			const promise = new Promise<string>((yes) => { resolve = yes; });
			entry = { promise, resolve };
			slots.set(name, entry);
		}
		return entry;
	};
	let connection: Socket | undefined;
	let pid: number | undefined;
	let exited = false;
	let markExited!: () => void;
	const gone = new Promise<void>((yes) => { markExited = yes; });
	const server = createServer((socket) => {
		connection = socket;
		let pending = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			pending += chunk;
			for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
				const [name, ...payload] = pending.slice(0, end).split(" ");
				if (name === "started") pid = Number(payload[0]);
				slot(name).resolve(payload.join(" "));
				pending = pending.slice(end + 1);
			}
		});
		socket.on("error", () => undefined);
		socket.on("close", () => { exited = true; markExited(); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		port: address.port,
		event: (name: string) => slot(name).promise,
		get exited() { return exited; },
		gone,
		/** Stops a server that is still running, so a test never leaves a process behind. */
		async terminate() {
			if (exited || pid === undefined) return;
			try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
			await gone;
		},
		async stop() {
			connection?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

interface McpWorkerContext {
	f: Awaited<ReturnType<typeof fixture>>;
	worker: AgentWorkerSession;
	events: Awaited<ReturnType<typeof observeServer>>;
	/** Model requests in order; `responses` scripts the replies, otherwise the fixture answers "DONE". */
	contexts: TranscriptContext[];
}

/** A managed worker whose agent directory configures one stdio MCP server, the fixture, named `dev-docs`. */
async function withMcpWorker(t: TestContext, mode: "silent" | "respond", body: (context: McpWorkerContext) => Promise<void>, responses?: AssistantMessage["content"][]) {
	const events = await observeServer();
	const f = await fixture();
	let worker: AgentWorkerSession | undefined;
	t.after(async () => {
		await worker?.close();
		await events.terminate();
		process.env.PI_CODING_AGENT_DIR = baseAgentDir;
		await f.close();
		await events.stop();
	});
	await f.worker.close();
	const contexts = responses ? script(f, responses) : f.requests;
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "dev-docs": {
		command: process.execPath, args: [serverPath], description: "Search the product docs",
		env: { MCP_FIXTURE_EVENTS_PORT: String(events.port), MCP_FIXTURE_MODE: mode },
	} } }));
	process.env.PI_CODING_AGENT_DIR = f.agentDir;
	worker = await AgentWorkerSession.create({ ...f.options });
	await body({ f, worker, events, contexts });
}

/** Replaces the fixture provider's stream: request N answers with `responses[N]`, then with "DONE". */
function script(f: Awaited<ReturnType<typeof fixture>>, responses: AssistantMessage["content"][]): TranscriptContext[] {
	const contexts: TranscriptContext[] = [];
	const stream = (_model: unknown, context: TranscriptContext) => {
		const content = responses[contexts.length] ?? [{ type: "text", text: "DONE" }];
		contexts.push(structuredClone(context));
		const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
		const message: AssistantMessage = { role: "assistant", content, api: testModel.api, provider: testModel.provider, model: testModel.id, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message }); events.push({ type: "done", reason: stopReason, message }); events.end(message);
		return events;
	};
	const provider = f.runtime.getRegisteredNativeProvider(testModel.provider);
	assert.ok(provider);
	f.runtime.registerNativeProvider({ ...provider, stream, streamSimple: stream });
	return contexts;
}

function systemSection(context: TranscriptContext, name: string): string | undefined {
	const system = context.messages.find((message) => message.role === "system");
	return system?.role === "system" ? (system as unknown as { sections?: Record<string, string> }).sections?.[name] : undefined;
}

function declaredTools(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((tool) => tool.name);
}

test("a server that never answers initialize does not block the first prompt", { timeout: 5000 }, async (t) => {
	await withMcpWorker(t, "silent", async ({ f, worker, events }) => {
		await events.event("initialize");
		assert.equal(events.exited, false, "the server is mid-handshake and stays silent");
		await worker.start("Start without the docs server.");
		await worker.waitForIdle();
		assert.equal(events.exited, false, "the prompt finished while the handshake was still pending");
		assert.equal(f.requests.length, 1);
		assert.match(systemSection(f.requests[0], "mcp_servers") ?? "", /^- mcp__dev_docs \(codemode\): Search the product docs$/m);
		assert.ok(declaredTools(f.requests[0]).includes("codemode"), "the configured server activates codemode before it connects");
		assert.equal(worker.lastErrorMessage(), undefined);
	});
});

test("a responsive server is reachable from codemode with normalized tool names", { timeout: 10000 }, async (t) => {
	const code = `const info = await describeNamespace("dev-docs");
		const listed = await tools.mcp__dev_docs__list_topics({});
		const routed = {};
		for (const name of info.tools.filter((tool) => tool.startsWith("mcp__dev_docs__lookup_doc"))) {
			routed[name] = (await tools[name]({ topic: "x" })).content[0].text;
		}
		return { info, listed: listed.content[0].text, routed };`;
	await withMcpWorker(t, "respond", async ({ worker, contexts }) => {
		const before = await worker.status();
		assert.ok(before.activeTools.includes("codemode"), "a configured server activates codemode");
		assert.ok(!before.activeTools.includes("tool_search"), "a codemode server does not activate tool_search");
		await worker.start("Look up the docs.");
		await worker.waitForIdle();
		assert.equal(contexts.length, 2, "one model request for the tool call, one for the result");
		const result = worker.sessionManager().getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "docs");
		assert.ok(result?.type === "message" && result.message.role === "toolResult");
		assert.equal(result.message.isError, false, JSON.stringify(result.message.content));
		const text = result.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).at(-1);
		assert.ok(text);
		const output = JSON.parse(text) as { info: { name: string; description: string; instructions: string; tools: string[] }; listed: string; routed: Record<string, string> };
		assert.equal(output.info.name, "mcp__dev_docs");
		assert.equal(output.info.description, "Search the product docs");
		assert.equal(output.info.instructions, "Documentation fixture server. Use lookup-doc with a topic string.");
		assert.equal(output.listed, "called list-topics {}", "the call reached the server process");

		const serverTools = (await worker.status()).tools.filter((name) => name.startsWith("mcp__dev_docs__"));
		const colliding = serverTools.filter((name) => name.startsWith("mcp__dev_docs__lookup_doc"));
		assert.equal(serverTools.length, 3);
		assert.ok(serverTools.includes("mcp__dev_docs__list_topics"), "an unambiguous name is only normalized");
		assert.equal(colliding.length, 2);
		for (const name of colliding) assert.match(name, /^mcp__dev_docs__lookup_doc_\w+$/, "names that collide after normalization carry a suffix");
		assert.deepEqual(Object.values(output.routed).sort(), ['called lookup-doc {"topic":"x"}', 'called lookup_doc {"topic":"x"}'], "each suffixed name reaches its own server tool");
		assert.deepEqual([...output.info.tools].sort(), [...serverTools].sort());

		for (const context of contexts) {
			assert.ok(declaredTools(context).includes("codemode"));
			assert.deepEqual(declaredTools(context).filter((name) => name.startsWith("mcp__")), [], "server tools stay out of the model's declarations");
		}
	}, [[{ type: "toolCall", id: "docs", name: "codemode", arguments: { code } }]]);
});

test("closing the worker stops the server process", { timeout: 10000 }, async (t) => {
	await withMcpWorker(t, "respond", async ({ worker, events }) => {
		await events.event("started");
		await worker.runCommand("mcp", "");
		assert.ok((await worker.status()).tools.includes("mcp__dev_docs__list_topics"), "the server connected");
		assert.equal(events.exited, false);
		await worker.close();
		await events.gone;
	});
});
