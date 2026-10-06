import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import type { CreatedAgents } from "./agent-lineage.ts";
import type { readEffortAwareness } from "./effort-awareness.ts";
import { StatusOutputSchema, StatusToolOutputSchema } from "./observation-schema.ts";
import { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } from "./primary-channel.ts";
import { createDurableExecution, checkClassifierContext, checkImagesContext, loadMcpConfig } from "./durable-execution.ts";
import { reconcileDeliveries } from "./durable-controls.ts";
import { answerRuntime, CRASH_STORAGE_ID, declaredTool, declaredTools, executionFixture, fixtureModelId, fixtureProvider, fixtureServerPath, httpMcpServer, messageText, resourceListStream, toolResultBody, toolResultText, toolSearchStream, writeExecutionExtension } from "./durable-execution-fixture.mts";
import { createDurableServices } from "./durable-services.ts";
import { DurableHost } from "./durable-host.ts";
import { createAgentContribution } from "./durable-agents.ts";
import { testModel } from "./test-runtime.mts";

const fixturePath = fileURLToPath(new URL("./durable-execution-fixture.mts", import.meta.url));
const READY = Buffer.from("READY\n");

/** Byte bound for captured child output; oldest bytes drop first. */
const CAPTURE_LIMIT = 64 * 1024;

function appendBounded(buffer: Buffer, chunk: Buffer): Buffer {
	const next = Buffer.concat([buffer, chunk]);
	return next.length > CAPTURE_LIMIT ? next.subarray(next.length - CAPTURE_LIMIT) : next;
}

/** Resolve with the captured output once the child prints its readiness line. */
function readyFrom(child: ReturnType<typeof spawn>, timeoutMs = 20000): Promise<string> {
	return new Promise((resolve, reject) => {
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let settled = false;
		const detail = (message: string) => `${message}\nstdout=${stdout.toString("utf8")}\nstderr=${stderr.toString("utf8")}`;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(detail("fixture did not reach readiness")));
		}, timeoutMs);
		const onStdout = (chunk: Buffer) => {
			stdout = appendBounded(stdout, chunk);
			if (settled || !stdout.includes(READY)) return;
			settled = true;
			clearTimeout(timer);
			resolve(stdout.toString("utf8"));
		};
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBounded(stderr, chunk);
		});
		child.once("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(detail(`fixture exited before readiness: ${String(code)}`)));
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** A promise that settles once the child has already exited or does so next. */
function childDeath(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

it("blocks a nested codemode call through the ToolTask hooks and never executes it", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `try {
			const out = await tools.guarded({ marker: "blocked" });
			return { out };
		} catch (error) {
			return { error: String(error.message ?? error) };
		}`,
	});
	const guardedPath = join(f.root, "guarded.txt");
	(globalThis as Record<string, unknown>).__execFixture = { guardedPath };
	try {
		const result = await f.submit("call the guarded tool");
		const text = result.toolResults.map(toolResultText).join("\n");
		assert.match(text, /Tool call blocked: denied by policy/u);
		assert.equal(existsSync(guardedPath), false, "the policy hook prevented the tool from running");
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("hands a structured result to the script through details.structuredContent", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `const value = await tools.structured({});\nreturn value;` });
	const result = await f.submit("call the structured tool");
	const text = result.toolResults.map(toolResultText).join("\n");
	assert.match(text, /"answer":"42"/u);
});

it("returns admitted spawn and send references as native codemode objects", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const created = await tools.agent_spawn({ name: "idle-agent" });
			const spawned = await tools.agent_spawn({ name: "working-agent", prompt: "Reply with a result" });
			const sent = await tools.agent_send({ sessionId: created.sessionId, message: "Reply with another result" });
			return { created, spawned, sent };`,
		builtinExtensions: (host) => [createAgentContribution({ source: fileURLToPath(new URL("./index.ts", import.meta.url)) }).create(host)],
	});
	const result = await f.submit("Dispatch work and retain its exact references");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as Record<string, { sessionId: string; result?: { sessionId: string; submissionId: number; requestId: string } }>;
	assert.equal(output.created.result, undefined);
	assert.equal(output.spawned.result?.sessionId, output.spawned.sessionId);
	assert.equal(output.sent.result?.sessionId, output.created.sessionId);
	for (const dispatch of [output.spawned, output.sent]) {
		assert.ok(dispatch.result);
		assert.ok(Number.isSafeInteger(dispatch.result.submissionId));
		assert.ok(dispatch.result.submissionId > 0);
		assert.match(dispatch.result.requestId, /^agent-deliver:\d+$/u);
	}
	assert.notEqual(output.spawned.result?.submissionId, output.sent.result?.submissionId);
});

it("preserves native lineage and effort awareness together through codemode", { timeout: 30000 }, async (t) => {
	const peer = randomUUID();
	const label = "\u0001😀".repeat(60);
	const captured: ToolExecutionResult[] = [];
	const calls: Readonly<Record<string, unknown>>[] = [];
	const hostStatus = { conversations: [], live: false, storageId: "fixture-execution" };
	const f = await executionFixture(t, {
		code: `const before = await tools.agent_status({});
			for (let i = 0; i < 21; i++) await tools.agent_spawn({ name: ${JSON.stringify(label)} + i });
			return { before, combined: await tools.agent_status({}),
				selected: await tools.agent_status({ sessionId: ${JSON.stringify(peer)} }),
				fleet: await tools.agent_status({ view: "fleet" }) };`,
		builtinExtensions: (host) => {
			const sessionsRoot = join(host.agentDir, "sessions");
			const catalogRoot = join(sessionsRoot, "durable");
			mkdirSync(join(sessionsRoot, ".primaries"), { recursive: true });
			mkdirSync(catalogRoot);
			writeFileSync(primaryEndpointPath(sessionsRoot, peer), JSON.stringify({
				id: peer, version: PRIMARY_ENDPOINT_VERSION, serverId: randomUUID(),
				cwd: host.cwd, hostname: hostname(), pid: process.pid,
				socketPath: join(sessionsRoot, "missing.sock"), startedAt: "2026-10-04T09:00:00Z",
				intentClaim: { purpose: "Shared native status", integration: "Test structured observations", authority: "Fixture only", scope: { paths: ["extensions/agent"], branches: ["topic"] }, updatedAt: "2026-10-04T10:00:00Z" },
			}));
			return [createAgentContribution({
				source: fileURLToPath(new URL("./index.ts", import.meta.url)),
				dispatch: async (method, params) => { assert.equal(method, "status"); calls.push(params); return hostStatus; },
			}).create({ ...host, catalogRoot }), host.durable.defineExtension({
				name: "fixture.status-capture",
				hooks: [host.durable.hook(host.durable.ToolTask, { afterTool(call, result) {
					if (call.name === "agent_status") captured.push(result);
					return undefined;
				} })],
			})];
		},
	});
	const result = await f.submit("Read native lineage and current effort together");
	type Overview = typeof hostStatus & { createdAgents?: CreatedAgents; awareness?: Awaited<ReturnType<typeof readEffortAwareness>> };
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { before: Overview; combined: Overview; selected: Overview; fleet: Record<string, unknown> };
	assert.equal(captured.length, 4);
	for (const [index, value] of [output.before, output.combined, output.selected, output.fleet].entries()) {
		assert.equal(Value.Check(StatusToolOutputSchema, value), true, JSON.stringify([...Value.Errors(StatusToolOutputSchema, value)]));
		assert.deepEqual((captured[index]?.details as { structuredContent?: unknown })?.structuredContent, value, "codemode retains the native structured result");
		assert.notEqual(captured[index]?.isError, true);
	}
	assert.equal(output.before.createdAgents, undefined);
	assert.equal(output.before.awareness?.presence.efforts[0]?.id, peer);
	const combined = output.combined;
	assert.deepEqual({ conversations: combined.conversations, live: combined.live, storageId: combined.storageId }, hostStatus);
	assert.equal(combined.awareness?.presence.efforts[0]?.id, peer);
	assert.ok(combined.createdAgents !== undefined);
	assert.equal(combined.createdAgents.agents.length, 20);
	assert.equal(combined.createdAgents?.omitted, 1);
	assert.equal(combined.createdAgents.agents[0]?.name, `${label.slice(0, 160)}…`);
	assert.ok(combined.createdAgents.agents.every((child) => child.kind === "conversation" && child.identity.startsWith(`${hostStatus.storageId}:`)));
	const combinedText = messageText(captured[1]);
	assert.deepEqual(JSON.parse(combinedText.split("\n\nCreated agents")[0] ?? ""), { ...hostStatus, awareness: combined.awareness });
	assert.ok(combinedText.includes("Created agents (newest first; retained creation labels):"));
	assert.ok(combinedText.includes(JSON.stringify(combined.createdAgents.agents[0]?.name)));
	assert.ok(combinedText.endsWith("1 more omitted."));
	assert.equal(Value.Check(StatusOutputSchema, combined), false, "the host wire schema is not widened");
	assert.deepEqual(output.selected, hostStatus);
	assert.equal(output.fleet.view, "fleet");
	assert.equal("awareness" in output.fleet, false);
	assert.equal("lineage" in output.fleet, false);
	assert.deepEqual(calls, [{}, {}, { sessionId: peer }]);
});

it("omits model headers from every codemode catalog lookup and retains sampling metadata", { timeout: 30000 }, async (t) => {
	const provider = "catalog-fixture";
	const id = "catalog-model";
	const samplingParamsByThinkingLevel = { off: { temperature: 0.2 }, high: { topP: 0.8 } };
	const headers = { "X-Fixture-Auth": "synthetic-header-value" };
	const f = await executionFixture(t, {
		code: `return {
			listed: await models.getModelsOfType("chat", "${provider}"),
			available: await models.getAvailableOfType("chat", "${provider}"),
			exact: await models.getModelOfType("chat", "${provider}", "${id}"),
			missing: (await models.getModelOfType("chat", "${provider}", "absent")) === undefined,
		};`,
	});
	const runtime = f.services.services.modelRuntime;
	const stream = () => { throw new Error("Catalog lookup must not request model output"); };
	runtime.registerNativeProvider({
		id: provider, name: "Catalog fixture", getModels: () => [{ ...testModel, provider, id, headers, samplingParamsByThinkingLevel }],
		auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});
	const result = await f.submit("inspect the model catalog");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { listed: Record<string, unknown>[]; available: Record<string, unknown>[]; exact: Record<string, unknown>; missing: boolean };
	assert.equal(output.listed.length, 1);
	assert.equal(output.available.length, 1);
	assert.equal(output.missing, true, "an unknown model remains undefined in the script");
	for (const model of [...output.listed, ...output.available, output.exact]) {
		assert.equal(Object.hasOwn(model, "headers"), false, "scripts receive no model headers");
		assert.equal(model.provider, provider);
		assert.equal(model.id, id);
		assert.equal(model.api, testModel.api);
		assert.deepEqual(model.samplingParamsByThinkingLevel, samplingParamsByThinkingLevel);
	}
	assert.deepEqual(runtime.getModel(provider, id)?.headers, headers, "catalog projection leaves provider headers intact");
});

it("throws a native agent error without data to codemode with its text", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `try {
			return { caught: false, value: await tools.agent_status({ sessionId: "target" }) };
		} catch (error) {
			return { caught: true, error: error.message };
		}`,
		builtinExtensions: (host) => [createAgentContribution({
			source: fileURLToPath(new URL("./index.ts", import.meta.url)),
			dispatch: async () => { throw new Error("target stream unavailable"); },
		}).create(host)],
	});
	const result = await f.submit("read the target status");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { caught: boolean; error?: string; value?: unknown };
	assert.equal(output.caught, true, "the agent failure rejects the nested script call");
	assert.match(output.error ?? "", /Status of target failed: target stream unavailable/u);
	assert.equal(output.value, undefined, "the error is not an empty structured value");
});

it("keeps a data-bearing native tool error as a codemode result", { timeout: 30000 }, async (t) => {
	const failure = { outcome: "failed", error: "target is busy" };
	const f = await executionFixture(t, {
		code: `return await tools.data_error({});`,
		builtinExtensions: (host) => [host.durable.defineExtension({
			name: "fixture.data-error",
			tools: [{
				...host.durable.defineTool({
					name: "data_error", description: "Return an error with structured data.", parameters: Type.Object({}), replay: "safe",
					execute: async () => ({ content: [{ type: "text" as const, text: "target is busy" }], isError: true, details: { structuredContent: failure } }),
				}),
				outputSchema: Type.Object({ outcome: Type.String(), error: Type.String() }),
			}],
		})],
	});
	const result = await f.submit("read the structured error");
	assert.deepEqual(JSON.parse(toolResultBody(result.toolResults.at(-1))), failure);
	const details = result.toolResults.at(-1)?.details as unknown as CodemodeToolDetails;
	assert.equal(details.calls[0].status, "error");
	assert.equal(details.calls[0].error, "target is busy");
});

it("applies an afterTool ToolTask hook to a nested codemode result", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `const value = await tools.structured({});\nreturn value;` });
	(globalThis as Record<string, unknown>).__execFixture = { rewriteStructured: true };
	try {
		const result = await f.submit("call the structured tool");
		const text = toolResultBody(result.toolResults.at(-1));
		assert.match(text, /"answer":"rewritten"/u);
		assert.doesNotMatch(text, /"answer":"42"/u);
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("reaches a stdio MCP server from codemode with normalized names and structured results", { timeout: 60000 }, async (t) => {
	const code = `const info = await describeNamespace("dev-docs");
		const listed = await tools.mcp__dev_docs__list_topics({});
		const routed = {};
		for (const name of info.tools.filter((tool) => tool.startsWith("mcp__dev_docs__lookup_doc"))) {
			routed[name] = (await tools[name]({ topic: "x" })).content[0].text;
		}
		return { info, listed: listed.content[0].text, result: listed, routed };`;
	const f = await executionFixture(t, {
		code,
		mcpServers: {
			"dev-docs": {
				command: process.execPath,
				args: [fixtureServerPath],
				description: "Search the product docs",
				env: { MCP_FIXTURE_MODE: "respond" },
			},
		},
	});
	const result = await f.submit("look up the docs");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as {
		info: { name: string; description: string; instructions: string; tools: string[] };
		listed: string;
		result: { content: { type: string; text: string }[]; isError?: boolean };
		routed: Record<string, string>;
	};
	assert.equal(output.info.name, "mcp__dev_docs");
	assert.equal(output.info.description, "Search the product docs");
	assert.equal(output.info.instructions, "Documentation fixture server. Use lookup-doc with a topic string.");
	assert.equal(output.listed, "called list-topics {}", "the call reached the server process");
	assert.equal(output.result.content[0]?.text, "called list-topics {}", "the script received the CallToolResult");
	const colliding = Object.keys(output.routed);
	assert.equal(colliding.length, 2, "both tools that normalize to one name stay reachable");
	for (const name of colliding) assert.match(name, /^mcp__dev_docs__lookup_doc_\w+$/u, "colliding names carry a suffix");
	assert.deepEqual(Object.values(output.routed).sort(), ['called lookup-doc {"topic":"x"}', 'called lookup_doc {"topic":"x"}']);
	assert.ok(declaredTools(f.requests[0]).includes("codemode"), "the configured server activates codemode");
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), [], "server tools stay out of the model's declarations");
});

function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** One named prompt section of the request's system message. */
function systemSection(request: { messages: readonly { role?: string; content?: unknown; sections?: unknown }[] }, name: string): string | undefined {
	const system = request.messages.find((message) => message.role === "system");
	const sections = system?.sections;
	if (sections === null || typeof sections !== "object") return undefined;
	return (sections as Record<string, string>)[name];
}

it("activates tool_search for a deferred server and loads matching tools for the next request", { timeout: 60000 }, async (t) => {
	const f = await executionFixture(t, {
		settings: { defaultTools: [] },
		mcpServers: {
			"dev-docs": {
				command: process.execPath,
				args: [fixtureServerPath],
				description: "Search the product docs",
				env: { MCP_FIXTURE_MODE: "respond" },
				exposure: "deferred",
			},
		},
		stream: toolSearchStream("list topics"),
	});
	const result = await f.submit("find the docs tools");
	assert.match(toolResultText(result.toolResults[0]), /mcp__dev_docs__list_topics/u);
	assert.ok(declaredTools(f.requests[0]).includes("tool_search"), "the deferred server activates tool_search");
	assert.ok(!declaredTools(f.requests[0]).includes("codemode"), "codemode stays inactive without codemode exposure or settings");
	assert.match(systemSection(f.requests[0], "mcp_servers") ?? "", /^- mcp__dev_docs \(tool_search\): Search the product docs$/mu);
	assert.ok(declaredTools(f.requests[1]).includes("mcp__dev_docs__list_topics"), "the loaded tool is declared on the next request");
});

it("hides direct tool declarations in codemode only mode while scripts still reach them", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const value = await tools.structured({});\nreturn value;`,
		settings: { defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" } },
	});
	const result = await f.submit("call the structured tool");
	assert.match(toolResultBody(result.toolResults.at(-1)), /"answer":"42"/u);
	assert.deepEqual(declaredTools(f.requests[0]).sort(), ["codemode", "tool_search"]);
	const description = declaredTool(f.requests[0], "codemode")?.description ?? "";
	assert.match(description, /### `structured`/u);
	assert.match(description, /### `read`/u);
});

it("sends stored OAuth tokens to an HTTP server and reads its resources", { timeout: 60000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const f = await executionFixture(t, {
		code: `const tool = await tools.mcp__remote_docs__echo({ value: "hi" });
			const listed = await tools.list_mcp_resources({});
			const read = await tools.read_mcp_resource({ server: "remote-docs", uri: "docs://readme" });
			return { tool, listed, read };`,
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	});
	const result = await f.submit("call the remote server");
	const body = toolResultBody(result.toolResults.at(-1));
	assert.ok(body.startsWith("{"), body);
	const output = JSON.parse(body) as {
		tool: { content: { text: string }[] };
		listed: { resources: { server: string; uri: string }[] };
		read: { contents: { uri: string; text: string }[] };
	};
	assert.equal(output.tool.content[0]?.text, "echo hi");
	assert.equal(output.listed.resources[0]?.server, "remote-docs");
	assert.equal(output.listed.resources[0]?.uri, "docs://readme");
	assert.equal(output.read.contents[0]?.text, "hello resource");
});

it("preserves nested call IDs, compact argument previews, errors, and rounded durations", { timeout: 30000 }, async (t) => {
	const error = "e".repeat(501);
	const value = "v".repeat(220);
	const f = await executionFixture(t, {
		code: `await tools.structured({}); try { await tools.preview_error({ value: ${JSON.stringify(value)} }); } catch {} return "done";`,
		builtinExtensions: (host) => [host.durable.defineExtension({
			name: "fixture.preview-error",
			tools: [host.durable.defineTool({
				name: "preview_error", description: "Reject with controlled text.", parameters: Type.Object({ value: Type.String() }), replay: "safe",
				execute: async () => { throw new Error(error); },
			})],
		})],
	});
	const result = await f.submit("inspect call previews");
	const details = result.toolResults.at(-1)?.details as unknown as CodemodeToolDetails;
	assert.deepEqual(details.calls.map((call) => call.id), ["codemode-call/1", "codemode-call/2"]);
	assert.equal(details.calls[0].args, "{}");
	assert.equal(details.calls[0].status, "ok");
	assert.equal(details.calls[0].error, undefined);
	assert.equal(details.calls[0].cost, undefined);
	const failed = details.calls[1];
	const json = JSON.stringify({ value });
	assert.equal(failed.args, `${json.slice(0, 197)}...`);
	assert.equal(failed.args.length, 200);
	assert.equal(failed.status, "error");
	assert.equal(failed.error?.length, 500);
	assert.ok(failed.error?.endsWith("..."));
	for (const call of details.calls) assert.ok(Number.isInteger(call.durationMs) && (call.durationMs ?? -1) >= 0);
});

it("records model cost including zero, failures, cancellation, and supplied JSON arguments", { timeout: 30000 }, async (t) => {
	const model = { provider: "fixture", id: "classifier" };
	const context = { state: { value: "x".repeat(210) }, questions: { q: { type: "bool", instructions: "Check", criteria: { true: "yes", false: "no" } } } };
	const f = await executionFixture(t, {
		code: `await tools.structured({}); for (let i = 0; i < 6; i++) { try { await models.classify(${JSON.stringify(model)}, ${JSON.stringify(context)}); } catch {} } return "done";`,
	});
	const runtime = f.services.services.modelRuntime;
	runtime.getModelOfType = (() => model) as typeof runtime.getModelOfType;
	let index = 0;
	const usage = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
	runtime.classify = (async () => {
		const current = index++;
		if (current === 2) throw new Error("rejected ".repeat(80));
		if (current === 3) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		return { api: "fixture-classifier", provider: model.provider, model: model.id, answers: {}, timestamp: Date.now(), stopReason: current === 4 ? "error" : current === 5 ? "aborted" : "stop", errorMessage: current === 4 ? "failed ".repeat(90) : undefined, usage: usage(current === 0 ? 0 : 0.02) };
	}) as typeof runtime.classify;
	const result = await f.submit("inspect model call records");
	const details = result.toolResults.at(-1)?.details as unknown as CodemodeToolDetails;
	assert.deepEqual(details.calls.map((call) => call.id), Array.from({ length: 7 }, (_, i) => `codemode-call/${i + 1}`));
	const calls = details.calls.slice(1);
	assert.deepEqual(calls.map((call) => call.status), ["ok", "ok", "error", "cancelled", "error", "cancelled"]);
	assert.deepEqual(calls.map((call) => call.cost), [0, 0.02, undefined, undefined, 0.02, 0.02]);
	const args = JSON.stringify([model, context]);
	for (const call of calls) {
		assert.equal(call.name, "models.classify");
		assert.equal(call.args, `${args.slice(0, 197)}...`);
		assert.ok(Number.isInteger(call.durationMs));
	}
	assert.equal(calls[2].error, `${"rejected ".repeat(80).slice(0, 497)}...`);
	assert.equal(calls[3].error, "aborted");
	assert.equal(calls[4].error, `${"failed ".repeat(90).slice(0, 497)}...`);
	assert.equal(result.toolResults.at(-1)?.usage?.cost.total, 0.06);
});

it("records image model JSON arguments and cost without duplicating usage", { timeout: 30000 }, async (t) => {
	const model = { provider: "fixture", id: "image" };
	const context = { input: [{ type: "text", text: "Draw a square" }] };
	const f = await executionFixture(t, { code: `await models.generateImages(${JSON.stringify(model)}, ${JSON.stringify(context)}); return "done";` });
	const runtime = f.services.services.modelRuntime;
	runtime.getModelOfType = (() => model) as typeof runtime.getModelOfType;
	runtime.generateImages = (async () => ({ api: "fixture-image", provider: model.provider, model: model.id, timestamp: Date.now(), output: [], stopReason: "stop", usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.1 } } })) as typeof runtime.generateImages;
	const result = await f.submit("inspect image call records");
	const details = result.toolResults.at(-1)?.details as unknown as CodemodeToolDetails;
	assert.deepEqual(details.calls.map(({ durationMs, ...call }) => {
		assert.ok(Number.isInteger(durationMs)); return call;
	}), [{ id: "codemode-call/1", name: "models.generateImages", args: JSON.stringify([model, context]), status: "ok", cost: 0.1 }]);
	assert.equal(result.toolResults.at(-1)?.usage?.cost.total, 0.1);
});

it("validates model contexts against the public contract", () => {
	assert.throws(() => checkClassifierContext({ state: {}, questions: {} }), /context\.questions/u);
	assert.throws(() => checkClassifierContext({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: "nope" } } }), /criteria/u);
	assert.throws(() => checkImagesContext({ prompt: "x" }), /context\.input/u);
	assert.throws(() => checkImagesContext({ input: [{ type: "image", data: 1 }] }), /context\.input\[0\]/u);
});

it("rejects invalid model arguments with the public contract's error text", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `try { await models.classify({}, {}); return "no error"; } catch (error) { return String(error.message ?? error); }` });
	const result = await f.submit("call classify badly");
	assert.match(toolResultBody(result.toolResults.at(-1)), /needs a classifier model/u);
});

it("declares direct resource tools and serves a model-issued resource listing", { timeout: 60000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const f = await executionFixture(t, {
		stream: resourceListStream(),
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs", exposure: "direct" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	});
	assert.ok(f.services.registry.snapshot().tools().some(({ tool }) => tool.name === "list_mcp_resources"), "fixture installation completes direct resource registration");
	const result = await f.submit("list the resources");
	assert.ok(declaredTools(f.requests[0]).includes("list_mcp_resources"));
	assert.match(toolResultText(result.toolResults.at(-1)), /docs:\/\/readme/u);
});

it("keeps fixture registration pending until the server supplies its tools", { timeout: 30000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const server = await httpMcpServer(token, { beforeResponse: async (method) => {
		if (method === "tools/list") { entered.resolve(); await release.promise; }
	} });
	t.after(() => server.close());
	let registered = false;
	const completion = executionFixture(t, {
		mcpServers: { "held-docs": { url: server.url, exposure: "direct" } },
		mcpAuth: { [`mcp__held_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	}).then((fixture) => { registered = true; return fixture; });
	await entered.promise;
	assert.equal(registered, false, "the server still holds its tool list");
	release.resolve();
	const f = await completion;
	assert.equal(registered, true);
	assert.ok(f.services.registry.snapshot().tools().some(({ tool }) => tool.name === "mcp__held_docs__echo"));
});

function mcpConfigFixture(t: { after(fn: () => void): void }, globalServers: Record<string, unknown>, projectServers: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "durable-mcp-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const source = join(agentDir, "mcp.json");
	const override = join(cwd, ".pi", "mcp.json");
	writeFileSync(source, JSON.stringify({ mcpServers: globalServers }));
	writeFileSync(override, JSON.stringify({ mcpServers: projectServers }));
	return { agentDir, cwd, source, override };
}

it("applies trusted project selection without replacing global transport and auth", (t) => {
	const base = {
		url: "https://example.com/mcp",
		headers: { "X-Account": "synthetic-account" },
		auth: { provider: "synthetic-provider" },
		description: "Project documentation",
		exposure: "direct",
		toolExposure: { "write-*": "hidden" },
	};
	const f = mcpConfigFixture(t, { docs: base }, { docs: { enabled: false, exposure: "codemode", toolExposure: { read: "deferred" } } });
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers, [{ name: "docs", source: f.source, override: f.override, config: { ...base, enabled: false, exposure: "codemode", toolExposure: { read: "deferred" } } }]);
});

it("enables a global server and treats an empty project override as an inherited no-op", (t) => {
	const base = { command: "synthetic-server", args: ["--docs"], env: { DOCS_ACCOUNT: "synthetic-account" }, cwd: "docs", enabled: false };
	const f = mcpConfigFixture(t, { enabled: base, unchanged: base }, { enabled: { enabled: true }, unchanged: {} });
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers, [
		{ name: "enabled", source: f.source, override: f.override, config: { ...base, enabled: true } },
		{ name: "unchanged", source: f.source, override: f.override, config: base },
	]);
});

it("replaces the toolExposure map rather than merging its entries", (t) => {
	const f = mcpConfigFixture(t, { docs: { command: "synthetic-server", toolExposure: { "*": "hidden" } } }, { docs: { toolExposure: {} } });
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers[0]?.config.toolExposure, {});
});

it("ignores project selection when the project is not trusted", (t) => {
	const base = { command: "synthetic-server", exposure: "direct" };
	const f = mcpConfigFixture(t, { docs: base }, { docs: { enabled: false } });
	const config = loadMcpConfig({ ...f, projectTrusted: false });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers, [{ name: "docs", source: f.source, config: base }]);
});

it("rejects nonselection and invalid project overrides without changing the global entry", (t) => {
	const base = { command: "synthetic-server" };
	const patches: readonly [string, Record<string, unknown>, RegExp][] = [
		["auth", { auth: { provider: "synthetic-provider" } }, /an override can only set enabled, exposure, toolExposure/u],
		["env", { env: { ACCOUNT: "injected" } }, /an override can only set/u],
		["args", { args: ["injected"] }, /an override can only set/u],
		["oauth", { oauth: { clientId: "injected" } }, /an override can only set/u],
		["enabled", { enabled: "false" }, /enabled must be a boolean/u],
		["exposure", { exposure: "invalid" }, /invalid exposure/u],
		["toolExposure", { toolExposure: { read: "invalid" } }, /invalid toolExposure/u],
		["typed", { type: "stdio", enabled: false }, /set "command"/u],
	];
	const f = mcpConfigFixture(t, Object.fromEntries(patches.map(([name]) => [name, base])), Object.fromEntries(patches.map(([name, patch]) => [name, patch])));
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.servers, patches.map(([name]) => ({ name, source: f.source, config: base })));
	assert.equal(config.errors.length, patches.length);
	for (const [index, [name, , expected]] of patches.entries()) {
		assert.match(config.errors[index] ?? "", expected, name);
		assert.ok(config.errors[index]?.includes(`server "${name}"`));
	}
});

it("requires an exact global server name for a project override", (t) => {
	const base = { command: "synthetic-server" };
	const f = mcpConfigFixture(t, { "dev-docs": base }, { dev_docs: { enabled: false }, missing: {} });
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.servers, [{ name: "dev-docs", source: f.source, config: base }]);
	assert.equal(config.errors.length, 2);
	for (const error of config.errors) assert.match(error, /a global server to override/u);
});

it("replaces a global server when the project supplies a transport", (t) => {
	const f = mcpConfigFixture(t, { docs: { url: "https://example.com/mcp", auth: { provider: "synthetic-provider" } } }, { docs: { command: "project-server", args: ["docs"] } });
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers, [{ name: "docs", source: f.override, config: { command: "project-server", args: ["docs"] } }]);
});

it("does not start or expose a global MCP server disabled by a trusted project", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-mcp-startup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const eventsFile = join(root, "server-events.txt");
	const f = await executionFixture(t, {
		code: `return { callable: "mcp__dev_docs__list_topics" in tools, matches: await searchTools("documentation", { namespace: "dev-docs" }) };`,
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_FILE: eventsFile }, exposure: "direct" } },
		projectMcpServers: { "dev-docs": { enabled: false } },
	});
	const result = await f.submit("Use only this project's selected tools.");
	assert.deepEqual(JSON.parse(toolResultBody(result.toolResults.at(-1))), { callable: false, matches: [] });
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), []);
	assert.equal(existsSync(eventsFile), false, "the disabled server never started");
	assert.deepEqual(f.services.services.diagnostics, []);
});

it("keeps the global MCP selection in an untrusted project", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-mcp-startup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const eventsFile = join(root, "server-events.txt");
	const f = await executionFixture(t, {
		code: `return (await tools.mcp__dev_docs__list_topics({})).content[0].text;`,
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_FILE: eventsFile }, exposure: "direct" } },
		projectMcpServers: { "dev-docs": { enabled: false } },
		trusted: false,
	});
	const result = await f.submit("Use the global tools without project trust.");
	assert.equal(toolResultBody(result.toolResults.at(-1)), "called list-topics {}");
	assert.match(readFileSync(eventsFile, "utf8"), /^started \d+\ninitialize\n$/u);
	assert.ok(declaredTools(f.requests[0]).includes("mcp__dev_docs__list_topics"));
});

it("starts a global MCP server enabled by a trusted project", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return (await tools.mcp__dev_docs__list_topics({})).content[0].text;`,
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], exposure: "direct", enabled: false } },
		projectMcpServers: { "dev-docs": { enabled: true } },
	});
	const result = await f.submit("Use the documentation server selected by the project.");
	assert.equal(toolResultBody(result.toolResults.at(-1)), "called list-topics {}");
	assert.ok(declaredTools(f.requests[0]).includes("mcp__dev_docs__list_topics"));
	assert.deepEqual(f.services.services.diagnostics, []);
});

it("discovers and calls MCP tools through a trusted project codemode override", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const info = await describeNamespace("dev-docs"); return { info, called: (await tools.mcp__dev_docs__list_topics({})).content[0].text };`,
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], exposure: "direct" } },
		projectMcpServers: { "dev-docs": { exposure: "codemode" } },
	});
	const result = await f.submit("Use the project documentation tools through a script.");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { info: { name: string; tools: string[] }; called: string };
	assert.equal(output.info.name, "mcp__dev_docs");
	assert.ok(output.info.tools.includes("mcp__dev_docs__list_topics"));
	assert.equal(output.called, "called list-topics {}");
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), []);
});

it("loads MCP tools after search through a trusted project deferred override", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		stream: toolSearchStream("documentation"),
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], exposure: "direct" } },
		projectMcpServers: { "dev-docs": { exposure: "deferred" } },
	});
	const result = await f.submit("Find the project documentation tools.");
	assert.match(toolResultText(result.toolResults.at(-1)), /mcp__dev_docs__lookup_doc/u);
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), []);
	assert.ok(declaredTools(f.requests[1]).some((name) => name.startsWith("mcp__dev_docs__lookup_doc")));
});

it("hides one project tool and discards the global toolExposure map", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return { info: await describeNamespace("dev-docs"), callable: "mcp__dev_docs__list_topics" in tools };`,
		mcpServers: { "dev-docs": { command: process.execPath, args: [fixtureServerPath], exposure: "codemode", toolExposure: { "*": "hidden" } } },
		projectMcpServers: { "dev-docs": { toolExposure: { "list-topics": "hidden" } } },
	});
	const result = await f.submit("Use only the documentation tools selected by the project.");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { info: { tools: string[] }; callable: boolean };
	assert.equal(output.callable, false);
	assert.ok(output.info.tools.some((name) => name.startsWith("mcp__dev_docs__lookup_doc")));
	assert.ok(output.info.tools.every((name) => name !== "mcp__dev_docs__list_topics"));
});

it("uses stored CIMD OAuth state through a project selection override", { timeout: 30000 }, async (t) => {
	const token = `synthetic-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const f = await executionFixture(t, {
		code: `return (await tools.mcp__remote_docs__echo({ value: "selected" })).content[0].text;`,
		mcpServers: { "remote-docs": { url: server.url, exposure: "direct", oauth: { clientRegistration: "cimd" } } },
		projectMcpServers: { "remote-docs": { exposure: "codemode" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, clientInformation: { client_id: "https://pi.dev/oauth/client.json" }, tokens: { access_token: token, token_type: "Bearer" } } },
	});
	const result = await f.submit("Use the project's authenticated documentation tools.");
	assert.equal(toolResultBody(result.toolResults.at(-1)), "echo selected");
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), []);
});

it("rejects auth in a trusted project's mcp.json", () => {
	const root = mkdtempSync(join(tmpdir(), "durable-execution-auth-"));
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp", auth: { provider: "example" } } } }));
		const config = loadMcpConfig({ agentDir: join(root, "agent"), cwd: root, projectTrusted: true });
		assert.equal(config.servers.length, 0);
		assert.match(config.errors.join("\n"), /auth is only allowed in the global mcp.json/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("bounds ready for a direct server that never answers", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return "ok";`,
		readyTimeoutMs: 150,
		awaitReady: true,
		mcpServers: { "silent-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_MODE: "silent" }, exposure: "direct" } },
	});
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 5000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("say hi");
	assert.equal(result.answer, "durable answer");
});

it("waits for a late direct server before the first request", { timeout: 30000 }, async (t) => {
	const token = `token-${randomUUID()}`;
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	const server = await httpMcpServer(token, { beforeResponse: async (method) => {
		if (method === "tools/list") { entered.resolve(); await release.promise; }
	} });
	t.after(() => server.close());
	let ready = false;
	const completion = executionFixture(t, {
		code: `const out = await tools.mcp__remote_docs__echo({ value: "ready" });\nreturn out.content[0].text;`,
		readyTimeoutMs: 5000,
		awaitReady: true,
		mcpServers: { "remote-docs": { url: server.url, description: "Remote docs", exposure: "direct" } },
		mcpAuth: { [`mcp__remote_docs|${server.url}`]: { serverUrl: server.url, tokens: { access_token: token, token_type: "Bearer" } } },
	}).then((fixture) => { ready = true; return fixture; });
	await entered.promise;
	assert.equal(ready, false, "the server still holds registration before the first model request");
	release.resolve();
	const f = await completion;
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 5000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("use the late server");
	assert.ok(declaredTools(f.requests[0]).includes("mcp__remote_docs__echo"));
	assert.match(toolResultBody(result.toolResults.at(-1)), /echo ready/u);
});

it("does not wait for an indirect server that never answers", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `return "ok";`,
		readyTimeoutMs: 10000,
		awaitReady: true,
		mcpServers: { "silent-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_MODE: "silent" }, exposure: "codemode" } },
	});
	assert.ok(f.readyElapsedMs !== undefined && f.readyElapsedMs < 1000, `ready took ${String(f.readyElapsedMs)}ms`);
	const result = await f.submit("say hi");
	assert.equal(result.answer, "durable answer");
});

it("aborts an owned nested call with the conversation and reaches idle", { timeout: 30000 }, async (t) => {	const entered = deferred();
	const f = await executionFixture(t, { code: `try { await tools.hanging({}); return "ok"; } catch (error) { return { error: String(error.message ?? error) }; }` });
	(globalThis as Record<string, unknown>).__execFixture = { onEnter: () => entered.resolve(), aborted: false };
	try {
		const submission = await f.conversation.submit({ type: "input", content: "hang the tool" }, BACKGROUND_CONTEXT);
		await entered.promise;
		await f.conversation.abort(BACKGROUND_CONTEXT);
		await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
		await submission.wait(BACKGROUND_CONTEXT);
		const view = await f.conversation.context(BACKGROUND_CONTEXT);
		const toolResults = view.messages.filter((message) => message.role === "toolResult");
		assert.ok(toolResults.length >= 1, "the codemode call retained a result");
		assert.ok(toolResults.some((result) => messageText(result).length > 0), "the result reports the aborted call");
		const inspection = await f.harness.inspect(BACKGROUND_CONTEXT);
		assert.equal(inspection.tasks.length, 0, "the owned nested task settled with its owner");
		const fixtureState = (globalThis as Record<string, unknown>).__execFixture as { aborted?: boolean };
		assert.equal(fixtureState.aborted, true, "the nested tool observed its cancellation");
	} finally {
		delete (globalThis as Record<string, unknown>).__execFixture;
	}
});

it("does not repeat an interrupted unsafe nested call after a crash", { timeout: 60000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "durable-execution-crash-"));
	const storagePath = join(root, "run.sqlite");
	const effectPath = join(root, "effect.txt");
	const rerunPath = join(root, "rerun.txt");
	const runId = "crash-unsafe-nested";
	const child = spawn(process.execPath, [fixturePath, storagePath, runId, "do the task"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_AGENT_DIR: join(root, "agent"), PI_AGENT_SESSIONS_DIR: join(root, "sessions") },
	});
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	let host: DurableHost | undefined;
	try {
		await readyFrom(child);
		const death = childDeath(child);
		child.kill("SIGKILL");
		await death;
		const extensionPath = writeExecutionExtension(join(root, "parent-extension"));
		(globalThis as Record<string, unknown>).__execFixture = { rerunPath, hang: false };
		const runtime = await answerRuntime();
		services = await createDurableServices({
			cwd: root,
			agentDir: join(root, "agent"),
			storageId: CRASH_STORAGE_ID,
			extensionPaths: [extensionPath],
			trusted: true,
			buildBuiltin: createDurableExecution,
			modelRuntime: runtime,
		});
		host = await DurableHost.open({
			storagePath,
			storageId: CRASH_STORAGE_ID,
			cwd: root,
			models: runtime,
			registry: services.registry,
			settings: services.settings,
			env: services.env,
			agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
			resume: false,
		});
		await services.install(host.harness);
		host.harness.resume();
		await reconcileDeliveries(host.harness, BACKGROUND_CONTEXT);
		const submission = await host.submit({ message: "do the task", requestId: runId });
		const outcome = await host.wait(submission.submissionId);
		assert.equal(outcome.status, "done");
		assert.equal(outcome.answer, "durable answer");
		assert.equal(readFileSync(effectPath, "utf8").trim().split("\n").length, 1, "the unsafe effect ran exactly once");
		assert.equal(existsSync(rerunPath), false, "the interrupted nested call did not rerun");
		const transcript = await host.transcript();
		assert.match(transcript, /interrupted/iu);
	} finally {
		if (host) await host.close().catch(() => undefined);
		if (services) await services.close().catch(() => undefined);
		if (child.exitCode === null && child.signalCode === null) {
			const death = childDeath(child);
			child.kill("SIGKILL");
			await death;
		}
		delete (globalThis as Record<string, unknown>).__execFixture;
		rmSync(root, { recursive: true, force: true });
	}
});
