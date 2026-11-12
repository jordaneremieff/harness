import { onStoredCommit } from "./commit-observation.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { str, bool, obj } from "@earendil-works/pi-schema";
import { matchesSchema, schemaErrors } from "./schema-check.ts";
import { Harness, MemoryStorage, LiveDoc, UsageDoc, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, type CodemodeRunOptions, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { CodemodeWorkerQueue, QueuedCodemodeSandbox } from "./codemode-admission.ts";
import { readCreatedAgents } from "./agent-lineage.ts";
import { agentChildrenDoc } from "./children.ts";
import { StatusOutputSchema, StatusToolOutputSchema } from "./observation-schema.ts";
import { convertMcpResult, createDurableExecution, loadMcpConfig, type DurableExecutionHost } from "./durable-execution.ts";
import { createAgentContribution, type AgentContributionHost } from "./durable-agents.ts";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { answerRuntime, answerMessage, codemodeStream, CRASH_STORAGE_ID, declaredTool, declaredTools, executionFixture, fixtureModelId, fixtureProvider, fixtureServerPath, httpMcpServer, messageText, resourceListStream, streamRuntime, toolResultBody, toolResultText, toolSearchStream, writeExecutionExtension, type FixtureStream } from "./durable-execution-fixture.mts";
import { DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS } from "./codemode-source.ts";
import { createDurableServices, type DurableContributionHost } from "./durable-services.ts";
import type { DurableHost } from "./durable-host.ts";
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

it("hands a structured result to the script through structuredOutput", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `const value = await tools.structured({});\nreturn value;` });
	const result = await f.submit("call the structured tool");
	const text = result.toolResults.map(toolResultText).join("\n");
	assert.match(text, /"answer":"42"/u);
});

it("returns text and structured images from native nested read", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const textFile = await tools.read({ path: "sample.txt" });
			const picture = await tools.read({ path: "sample.png" });
			image(picture);
			return { textFile, type: picture.type, mimeType: picture.mimeType, data: picture.data, note: picture.note };`,
	});
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	writeFileSync(join(f.cwd, "sample.txt"), "plain text\n");
	writeFileSync(join(f.cwd, "sample.png"), Buffer.from(png, "base64"));
	const result = await f.submit("read text and show the image");
	const toolResult = result.toolResults.at(-1);
	assert.ok(toolResult);
	assert.notEqual(toolResult.isError, true, toolResultText(toolResult));
	const output = JSON.parse(toolResultBody(toolResult)) as { textFile: string; type: string; mimeType: string; data: string; note: string };
	assert.equal(output.textFile, "plain text\n");
	assert.equal(output.type, "image");
	assert.equal(output.mimeType, "image/png");
	assert.equal(typeof output.note, "string");
	assert.ok(output.data.length > 0);
	assert.deepEqual(toolResult.content.filter((block) => block.type === "image"), [{ type: "image", data: output.data, mimeType: output.mimeType }]);
	const details = toolResult.details as unknown as CodemodeToolDetails;
	assert.ok(details);
	assert.equal(details.calls.every((call) => call.status === "ok"), true);
});

it("preserves read truncation details beside the structured text result", { timeout: 30000 }, async (t) => {
	let captured: ToolExecutionResult | undefined;
	const f = await executionFixture(t, {
		code: `const value = await tools.read({ path: "long.txt" }); return { length: value.length, continuation: value.includes("Use offset=2001 to continue") };`,
		builtinExtensions: (host) => [host.durable.defineExtension({
			name: "fixture.read-result",
			hooks: [host.durable.hook(host.durable.ToolTask, { afterTool(call, result) {
				if (call.name === "read") captured = result;
				return undefined;
			} })],
		})],
	});
	writeFileSync(join(f.cwd, "long.txt"), Array.from({ length: 2101 }, (_, index) => `line ${index}`).join("\n"));
	const result = await f.submit("read a file with truncated text");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { length: number; continuation: boolean };
	const details = captured?.details as { truncated?: boolean; outputLines?: number; totalLines?: number; structuredContent?: unknown } | undefined;
	assert.ok(details);
	assert.equal(details.truncated, true);
	assert.equal(details.outputLines, 2000);
	assert.equal(details.totalLines, 2101);
	assert.ok(typeof captured?.structuredOutput === "string");
	assert.equal(captured.structuredOutput.length, output.length);
	assert.equal(captured.structuredOutput, toolResultText(captured));
	assert.equal("structuredContent" in details, false);
	assert.equal(output.continuation, true);
});

it("rejects a missing nested read without a structured success value", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `try { return { value: await tools.read({ path: "missing.txt" }) }; } catch (error) { return { error: error.message }; }` });
	const result = await f.submit("read a missing file");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { value?: unknown; error?: string };
	assert.equal(output.value, undefined);
	assert.match(output.error ?? "", /ENOENT|not found|does not exist/u);
	const toolResult = result.toolResults.at(-1);
	assert.ok(toolResult);
	const details = toolResult.details as unknown as CodemodeToolDetails;
	assert.ok(details);
	assert.equal(details.calls[0].status, "error");
});

it("describes asynchronous discovery and awaits native tool descriptions", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const pending = describeTool("structured");
			return { listed: ALL_TOOLS.find((tool) => tool.name === "structured"),
			found: (await searchTools("structured"))[0], described: await pending, asynchronous: typeof pending.then === "function",
			missing: (await describeTool("missing")) === undefined, missingNamespace: (await describeNamespace("missing")) === undefined };`,
	});
	const result = await f.submit("discover a native tool");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { listed: { description: string }; found: { name: string; description: string }; described: string; asynchronous: boolean; missing: boolean; missingNamespace: boolean };
	assert.equal(output.asynchronous, true);
	assert.equal(output.missingNamespace, true);
	assert.match(output.described, /structured\(args:.*Promise</u);
	assert.equal(output.listed.description, output.described);
	assert.equal(output.found.name, "structured");
	assert.equal(output.found.description, output.described);
	assert.equal(output.missing, true);
	const description = declaredTool(f.requests[0], "codemode")?.description ?? "";
	for (const helper of ["searchTools", "describeTool", "describeNamespace"]) assert.ok(description.includes(`await ${helper}(`));
});

it("separates script text and the returned value from grouped console lines", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `console.log("first log"); text("alpha"); console.warn("second log"); text({ value: 2 }); return "omega";` });
	const result = await f.submit("produce separate output items");
	assert.equal(toolResultBody(result.toolResults.at(-1)), "==> text 1/3 <==\nalpha\n==> text 2/3 <==\n{\"value\":2}\n==> text 3/3 <==\nomega\n<console_output>\nfirst log\nsecond log\n</console_output>");
});

it("leaves one script text item unnumbered and groups console-only output", { timeout: 30000 }, async (t) => {
	for (const [code, expected] of [
		[`text("one\\n"); console.log("log");`, "one\n<console_output>\nlog\n</console_output>"],
		[`console.log("one"); console.error("two");`, "<console_output>\none\ntwo\n</console_output>"],
	]) {
		const f = await executionFixture(t, { code });
		const result = await f.submit("produce a single output group");
		assert.equal(toolResultBody(result.toolResults.at(-1)), expected);
	}
});

it("keeps numbered text on each side of an image and console output last", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `text("before"); console.log("log"); image({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }); text("after");` });
	const result = await f.submit("produce an image between text items");
	const first = result.toolResults.at(-1)?.content[1];
	assert.ok(first?.type === "text");
	const saved = /\[Image saved to (.+) \(image\/png, 8 bytes\)\]/u.exec(first.text)?.[1];
	assert.ok(saved);
	t.after(() => rmSync(saved, { force: true }));
	assert.deepEqual(readFileSync(saved), Buffer.from("iVBORw0KGgo=", "base64"));
	assert.deepEqual(result.toolResults.at(-1)?.content.slice(1), [
		{ type: "text", text: `==> text 1/2 <==\nbefore\n[Image saved to ${saved} (image/png, 8 bytes)]` },
		{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		{ type: "text", text: "==> text 2/2 <==\nafter\n<console_output>\nlog\n</console_output>" },
	]);
});

it("retains separated partial output and grouped console lines before a script error", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `text("before"); console.log("log"); text("second"); throw new Error("stop here");` });
	const result = await f.submit("fail after partial output");
	const output = toolResultBody(result.toolResults.at(-1));
	assert.ok(output.startsWith("==> text 1/2 <==\nbefore\n==> text 2/2 <==\nsecond\n<console_output>\nlog\n</console_output>\nScript error:\n"));
	assert.match(output, /stop here/u);
	assert.equal(result.toolResults.at(-1)?.isError, true);
});

it("spills the full separated output before text truncation", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: `// @options: {"max_output_tokens": 20}\ntext("a".repeat(100)); console.log("log"); return "z".repeat(100);` });
	const result = await f.submit("truncate separated output");
	const toolResult = result.toolResults.at(-1);
	const path = (toolResult?.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
	assert.ok(path);
	t.after(() => rmSync(path, { force: true }));
	assert.equal(readFileSync(path, "utf8"), `==> text 1/2 <==\n${"a".repeat(100)}\n==> text 2/2 <==\n${"z".repeat(100)}\n<console_output>\nlog\n</console_output>`);
	assert.match(toolResultBody(toolResult), /Warning: truncated output/u);
});

it("ignores undeclared structured results and rejects their error text", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `const value = await tools.text_only({ fail: false });
			try { await tools.text_only({ fail: true }); } catch (error) { return { value, error: error.message }; }`,
		builtinExtensions: (host) => [host.durable.defineExtension({
			name: "fixture.text-only",
			tools: [host.durable.defineTool({
				name: "text_only", description: "Return text without an output schema.", parameters: obj({ fail: bool() }, { open: true }), replay: "safe",
				execute: async ({ fail }) => ({ output: [{ type: "text" as const, text: fail ? "text error" : "text value" }], isError: fail, details: { structuredContent: { ignored: true } } }),
			})],
		})],
	});
	const result = await f.submit("check the output schema boundary");
	assert.deepEqual(JSON.parse(toolResultBody(result.toolResults.at(-1))), { value: "text value", error: "text error" });
});

it("returns admitted spawn and send references as native codemode objects", { timeout: 30000 }, async (t) => {
	const { createAgentContribution } = await import("./durable-agents.ts");
	const f = await executionFixture(t, {
		code: `const created = await tools.agent_spawn({ name: "idle-agent", model: ${JSON.stringify(`${fixtureProvider}/${fixtureModelId}`)} });
			const spawned = await tools.agent_spawn({ name: "working-agent", model: ${JSON.stringify(`${fixtureProvider}/${fixtureModelId}`)}, prompt: "Reply with a result" });
			const sent = await tools.agent_send({ sessionId: created.sessionId, message: "Reply with another result" });
			return { created, spawned, sent };`,
		builtinExtensions: (host) => [createAgentContribution({ configureSettings: () => {}, source: fileURLToPath(new URL("./index.ts", import.meta.url)) }).create(host)],
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

it("preserves compact native status and retained creation facts through codemode", { timeout: 30000 }, async (t) => {
	const { createAgentContribution } = await import("./durable-agents.ts");
	const { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } = await import("./primary-channel.ts");
	const peer = randomUUID();
	const label = "\u0001😀".repeat(60);
	const captured: ToolExecutionResult[] = [];
	const calls: Readonly<Record<string, unknown>>[] = [];
	const hostStatus = { conversations: [], live: false, storageId: "fixture-execution", coverage: { complete: true, returned: 0, scanned: 0, next: null } };
	const selectedStatus = { live: false, storageId: peer,
		conversation: { conversationId: 1, identity: peer, busy: false, lastText: null, live: null, inbox: null,
			agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [], submissions: [] } };
	const f = await executionFixture(t, {
		code: `const before = await tools.agent_status({});
			for (let i = 0; i < 21; i++) await tools.agent_spawn({ name: ${JSON.stringify(label)} + i, model: ${JSON.stringify(`${fixtureProvider}/${fixtureModelId}`)} });
			return { before, combined: await tools.agent_status({}),
				selected: await tools.agent_status({ sessionId: ${JSON.stringify(peer)} }),
				detail: await tools.agent_status({ sessionId: ${JSON.stringify(peer)}, detail: true }),
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
			return [createAgentContribution({ configureSettings: () => {},
				source: fileURLToPath(new URL("./index.ts", import.meta.url)),
				dispatch: async (method, params) => { assert.equal(method, "status"); calls.push(params); return params.sessionId === peer ? selectedStatus : hostStatus; },
			}).create({ ...host, catalogRoot }), host.durable.defineExtension({
				name: "fixture.status-capture",
				hooks: [host.durable.hook(host.durable.ToolTask, { afterTool(call, result) {
					if (call.name === "agent_status") captured.push(result);
					return undefined;
				} })],
			})];
		},
	});
	const result = await f.submit("Read compact status and selected detail");
	type Overview = typeof hostStatus & { format: string; omitted: string[]; createdAgents?: unknown; awareness?: unknown };
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1))) as { before: Overview; combined: Overview; selected: { format: string; conversation: { identity: string } }; detail: typeof selectedStatus; fleet: Record<string, unknown> };
	assert.equal(captured.length, 5);
	for (const [index, value] of [output.before, output.combined, output.selected, output.detail, output.fleet].entries()) {
		assert.equal(matchesSchema(StatusToolOutputSchema, value), true, JSON.stringify(schemaErrors(StatusToolOutputSchema, value, 10)));
		assert.deepEqual(captured[index]?.structuredOutput, value, "codemode retains the native structured result");
		assert.notEqual(captured[index]?.isError, true);
	}
	for (const overview of [output.before, output.combined]) {
		assert.equal(overview.format, "compact");
		assert.equal(overview.createdAgents, undefined);
		assert.equal(overview.awareness, undefined);
		assert.deepEqual(overview.omitted, ["host inventory", "effort awareness", "created-agent detail"]);
	}
	const combined = output.combined;
	assert.deepEqual({ conversations: combined.conversations, live: combined.live, storageId: combined.storageId, coverage: combined.coverage }, hostStatus);
	assert.deepEqual(JSON.parse(messageText(captured[1])), combined);
	assert.equal(matchesSchema(StatusOutputSchema, combined), false, "the host wire schema is not widened");
	const created = await readCreatedAgents(f.harness, agentChildrenDoc(await import("@earendil-works/pi-durable")), { storageId: hostStatus.storageId, conversationId: f.conversation.id }, BACKGROUND_CONTEXT);
	assert.ok(created);
	assert.equal(created.agents.length, 20);
	assert.equal(created.omitted, 1);
	assert.equal(created.agents[0]?.name, `${label.slice(0, 160)}…`);
	assert.ok(created.agents.every((child) => child.kind === "conversation" && child.identity.startsWith(`${hostStatus.storageId}:`)));
	assert.equal(output.selected.format, "compact");
	assert.equal(output.selected.conversation.identity, peer);
	assert.deepEqual(output.detail, selectedStatus);
	assert.equal(output.fleet.view, "fleet");
	assert.equal("awareness" in output.fleet, false);
	assert.equal("lineage" in output.fleet, false);
	assert.deepEqual(calls, [{}, {}, { sessionId: peer }, { sessionId: peer }]);
});

it("preserves live models and environment getters in the MCP catalog adapter", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { mcpServers: { docs: { command: process.execPath, args: [fixtureServerPath], exposure: "direct" } } });
	const state: { models: ToolExecutionApi["models"]; env: ToolExecutionApi["env"] } = { models: {} as ToolExecutionApi["models"], env: undefined };
	const source = { get models() { return state.models; }, get env() { return state.env; } } as ToolExecutionApi;
	const adapter = (f.execution as unknown as { catalogApi(api: ToolExecutionApi): ToolExecutionApi }).catalogApi(source);
	assert.equal(adapter.models, state.models);
	assert.equal(adapter.env, undefined);
	const models = {} as ToolExecutionApi["models"];
	const env = {} as NonNullable<ToolExecutionApi["env"]>;
	state.models = models;
	state.env = env;
	assert.equal(adapter.models, models);
	assert.equal(adapter.env, env);
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
	const { createAgentContribution } = await import("./durable-agents.ts");
	const f = await executionFixture(t, {
		code: `try {
			return { caught: false, value: await tools.agent_status({ sessionId: "target" }) };
		} catch (error) {
			return { caught: true, error: error.message };
		}`,
		builtinExtensions: (host) => [createAgentContribution({ configureSettings: () => {},
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
					name: "data_error", description: "Return an error with structured data.", parameters: obj({}, { open: true }), replay: "safe",
					execute: async () => ({ output: [{ type: "text" as const, text: "target is busy" }], isError: true, structuredOutput: failure, diagnostics: [{ severity: "error" as const, message: "target is busy" }] }),
				}),
				structuredOutputSchema: obj({ outcome: str(), error: str() }, { open: true }),
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

it("starts only the named indirect server on demand and keeps prompt declarations stable", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "mcp-demand-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const one = join(root, "one.events"), two = join(root, "two.events");
	const f = await executionFixture(t, {
		code: 'return await tools.mcp__one_more__list_topics({});',
		mcpServers: {
			one_more: { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_FILE: one } },
			one: { command: process.execPath, args: [fixtureServerPath], exposure: "deferred", env: { MCP_FIXTURE_EVENTS_FILE: two } },
		},
	});
	assert.equal(existsSync(one), false);
	assert.equal(existsSync(two), false);
	const result = await f.submit("call one server");
	assert.match(toolResultBody(result.toolResults.at(-1)), /called list-topics/u);
	assert.match(readFileSync(one, "utf8"), /^started /u);
	assert.equal(existsSync(two), false);
	assert.deepEqual(declaredTools(f.requests[1]), declaredTools(f.requests[0]));
	assert.deepEqual(f.requests[1].messages.filter(message => message.role === "system"), f.requests[0].messages.filter(message => message.role === "system"), "connection completion emits no system or tool declaration patch");
});

for (const code of ['return await searchTools("topics");', 'return ALL_TOOLS;', 'return await tools.list_mcp_resources({});']) it(`starts all indirect servers for discovery: ${code}`, { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "mcp-discovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const one = join(root, "one.events"), two = join(root, "two.events");
	const f = await executionFixture(t, { code, mcpServers: {
		one: { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_FILE: one } },
		two: { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_EVENTS_FILE: two } },
	} });
	assert.equal(existsSync(one), false);
	assert.equal(existsSync(two), false);
	await f.submit("discover resources");
	assert.match(readFileSync(one, "utf8"), /^started /u);
	assert.match(readFileSync(two, "utf8"), /^started /u);
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
	assert.equal(output.info.name, "dev-docs");
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
	const section = systemSection(f.requests[0], "codemode") ?? "";
	assert.match(section, /### `structured`/u);
	assert.match(section, /### `read`/u);
});

it("keeps the model-only agent coordination declarations in codemode only mode", { timeout: 30000 }, async (t) => {
	const control = (host: DurableExecutionHost, name: string, modelOnly: boolean) => host.durable.defineTool({
		name,
		description: `${name} fixture`,
		parameters: obj({}, { open: true }),
		execute: async () => ({ output: [{ type: "text" as const, text: "ok" }] }),
		...(modelOnly ? { callers: ["model"] as const } : {}),
	});
	const f = await executionFixture(t, {
		stream: () => answerMessage(),
		settings: { defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" } },
		builtinExtensions: (host) => [host.durable.defineExtension({ name: "fixture.agent-controls", tools: [
			control(host, "agent_await", true),
			control(host, "agent_compact", true),
			control(host, "agent_status", false),
		] })],
	});
	await f.submit("say hi");
	assert.deepEqual(declaredTools(f.requests[0]).sort(), ["agent_await", "agent_compact", "codemode", "tool_search"]);
});

/** The harness Agent contribution as a native extension for one execution fixture host. */
function agentContribution(host: Parameters<NonNullable<Parameters<typeof executionFixture>[1]["builtinExtensions"]>>[0], dispatched: string[] = []): ReturnType<ReturnType<typeof createAgentContribution>["create"]> {
	return createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts", dispatch: async (method) => { dispatched.push(method); return { items: [], next: undefined }; } }).create(host as unknown as AgentContributionHost);
}

it("declares direct controls, defers infrequent ones, and discovers a deferred control without MCP", { timeout: 30000 }, async (t) => {
	const dispatched: string[] = [];
	const stream: FixtureStream = (context) => {
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!results.some((result) => result.toolName === "tool_search"))
			return { role: "assistant", api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, content: [{ type: "toolCall", id: "search-agents", name: "tool_search", arguments: { query: "list retained agent sessions" } }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
		if (!results.some((result) => result.toolName === "agent_list"))
			return { role: "assistant", api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, content: [{ type: "toolCall", id: "list-agents", name: "agent_list", arguments: {} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
		return answerMessage();
	};
	const f = await executionFixture(t, { settings: { defaultTools: ["+codemode", "+tool_search"] }, stream, builtinExtensions: (host) => [agentContribution(host, dispatched)] });
	const result = await f.submit("find the retained agent tools and use them");
	const first = declaredTools(f.requests[0]);
	for (const name of ["agent_spawn", "agent_send", "agent_steer", "agent_abort", "agent_status", "agent_intent", "agent_collaborate", "agent_await", "agent_compact", "tool_search"])
		assert.ok(first.includes(name), `${name} is declared directly`);
	for (const name of ["agent_inspect", "agent_list", "agent_attach", "agent_place", "agent_fork", "agent_rewind", "agent_reset", "agent_configure", "agent_profile", "agent_command"])
		assert.ok(!first.includes(name), `${name} starts undeclared`);
	assert.match(systemSection(f.requests[0], "agent-controls") ?? "", /^- agent_spawn:/mu);
	assert.doesNotMatch(systemSection(f.requests[0], "agent-controls") ?? "", /^- agent_list:/mu);
	assert.match(toolResultText(result.toolResults.find((entry) => entry.toolName === "tool_search")), /agent_list/u);
	assert.ok(declaredTools(f.requests[1]).includes("agent_list"), "tool_search declares the loaded control on the next request");
	const listed = result.toolResults.find((entry) => entry.toolName === "agent_list");
	assert.ok(listed, "the loaded control executes");
	assert.ok(dispatched.includes("profile-list"), `the loaded control reached the host dispatch: ${dispatched.join()}`);
});

it("keeps explicit builtin tool-search disablement authoritative without MCP", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { settings: { defaultTools: ["+codemode", "+tool_search"], extensions: ["-builtin:tool_search"] }, stream: () => answerMessage() });
	await f.submit("say hi");
	assert.ok(declaredTools(f.requests[0]).includes("codemode"));
	assert.ok(!declaredTools(f.requests[0]).includes("tool_search"), "the configured removal stays authoritative");
});

it("keeps model-only await and compact out of script callables", { timeout: 60000 }, async (t) => {
	const f = await executionFixture(t, {
		code: "return ALL_TOOLS.map((tool) => tool.name).sort();",
		settings: { defaultTools: ["+codemode", "+tool_search"] },
		builtinExtensions: (host) => [agentContribution(host)],
	});
	const result = await f.submit("list the script-visible tools");
	const names = toolResultBody(result.toolResults.at(-1));
	assert.match(names, /agent_status/u);
	assert.match(names, /agent_list/u, "deferred controls remain callable from scripts");
	assert.doesNotMatch(names, /agent_await/u);
	assert.doesNotMatch(names, /agent_compact/u);
});

it("prepares a finite execution budget on the registered native codemode tool", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { stream: () => answerMessage() });
	const tool = f.execution.extensions.find((extension) => extension.name === "codemode")?.tools?.find((candidate) => candidate.name === "codemode");
	assert.ok(tool?.prepareArguments);
	const prepared = tool.prepareArguments({ code: 'return "ok";' }) as { code: string };
	assert.match(prepared.code, new RegExp(`^// @options: \\{"timeout_ms":${DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS}\\}\\nreturn "ok";$`, "u"));
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

it("records nested calls in native live slots and preserves hook parent identity", { timeout: 30000 }, async (t) => {
	const entered = deferred(); const release = deferred();
	t.after(() => release.resolve());
	let parent: unknown; let nestedTask: unknown;
	const f = await executionFixture(t, {
		code: 'return await tools.step({ value: "first" });',
		builtinExtensions: (host) => [host.durable.defineExtension({ name: "fixture.progress", tools: [host.durable.defineTool({
			name: "step", description: "Hold an owned nested call.", parameters: obj({ value: str() }, { open: true }), replay: "safe",
			execute: async (_args, api) => { nestedTask = api.taskId; entered.resolve(); await release.promise; return { output: [{ type: "text" as const, text: "done" }] }; },
		})], hooks: [host.durable.hook(host.durable.ToolTask, { beforeTool(call) {
			if (call.name === "step") parent = call.parent;
			return undefined;
		} })] })],
	});
	const submitted = f.submit("observe a native nested call");
	await entered.promise;
	const live = await f.harness.snapshot(LiveDoc, f.conversation.id, BACKGROUND_CONTEXT);
	const slot = live?.nestedTools?.find((tool) => tool.name === "step");
	assert.ok(slot);
	assert.equal(slot.taskId, nestedTask);
	assert.equal(slot.parentCallId, "codemode-call");
	assert.equal(slot.callId, "codemode-call/c1");
	assert.deepEqual(slot.arguments, { value: "first" });
	assert.deepEqual(parent, { callId: slot.parentCallId, taskId: slot.parentTaskId });
	release.resolve();
	const result = await submitted;
	assert.equal(toolResultBody(result.toolResults.at(-1)), "done");
	const details = result.toolResults.at(-1)?.details as unknown as CodemodeToolDetails;
	assert.equal(details.calls[0].id, 1);
	assert.equal(details.calls[0].status, "ok");
	assert.ok((details.calls[0].durationMs ?? -1) >= 0);
	assert.equal((await f.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
});

it("counts model usage under the nested model tool without charging codemode twice", { timeout: 30000 }, async (t) => {
	const model = { provider: "fixture", id: "classifier" };
	const context = { state: {}, images: [{ type: "image", data: "AA==", mimeType: "image/png" }], questions: { q: { type: "bool", instructions: "Check", criteria: { true: "yes", false: "no" } } } };
	const f = await executionFixture(t, { code: `return await models.classify(${JSON.stringify(model)}, ${JSON.stringify(context)});` });
	const runtime = f.services.services.modelRuntime;
	runtime.getModelOfType = (() => model) as typeof runtime.getModelOfType;
	let received: unknown;
	runtime.classify = (async (_model, value) => {
		received = value;
		return { api: "fixture-classifier", provider: model.provider, model: model.id, answers: { q: { type: "bool", probability: 1 } }, timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.1 } } };
	}) as typeof runtime.classify;
	const result = await f.submit("classify with an image");
	assert.deepEqual(received, context);
	assert.deepEqual(JSON.parse(toolResultBody(result.toolResults.at(-1))).answers, { q: { type: "bool", probability: 1 } });
	assert.equal(result.toolResults.at(-1)?.usage, undefined);
	const usage = await f.harness.snapshot(UsageDoc, f.conversation.id, BACKGROUND_CONTEXT);
	assert.equal(usage?.tools["pi.codemode.models.classify"].cost.total, 0.1);
	assert.equal(usage?.tools.codemode, undefined);
});

it("rejects malformed structured output before the script receives a success value", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: 'try { return { value: await tools.malformed({}) }; } catch (error) { return { error: error.message }; }',
		builtinExtensions: (host) => [host.durable.defineExtension({ name: "fixture.malformed", tools: [host.durable.defineTool({
			name: "malformed", description: "Return an invalid structured value.", parameters: obj({}, { open: true }), structuredOutputSchema: obj({ answer: str() }, { open: true }),
			execute: async () => ({ output: [{ type: "text" as const, text: "not a success" }], structuredOutput: { answer: 42 } }),
		})] })],
	});
	const result = await f.submit("reject invalid output");
	const output = JSON.parse(toolResultBody(result.toolResults.at(-1)));
	assert.equal(output.value, undefined);
	assert.match(output.error, /structured|schema|answer/iu);
});

it("rejects invalid model arguments with the public contract's error text", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, { code: 'try { await models.classify({}, {}); return "no error"; } catch (error) { return error.message; }' });
	const result = await f.submit("call classify badly");
	assert.match(toolResultBody(result.toolResults.at(-1)), /expects a classifier model/u);
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

it("keeps MCP text at Unicode boundaries and preserves the full script result", async (t) => {
	const text = `${"x".repeat(10237)}😀${"y".repeat(30000)}😀${"z".repeat(10237)}`;
	const raw = { content: [{ type: "text" as const, text }], structuredContent: { text } };
	const result = await convertMcpResult("docs", "large", raw);
	assert.deepEqual(result.structuredOutput, raw);
	assert.ok(result.output);
	const shown = result.output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	assert.equal(Buffer.from(shown, "utf8").toString("utf8"), shown);
	assert.ok(shown.length < text.length);
	assert.match(shown, /truncated/u);
	const path = (result.details as { fullOutputPath?: string }).fullOutputPath;
	assert.ok(path);
	t.after(() => rmSync(path, { force: true }));
	assert.equal(readFileSync(path, "utf8"), text);
});

it("rejects MCP OAuth callbacks outside the declared registration contract", (t) => {
	const url = "https://example.com/mcp";
	const f = mcpConfigFixture(t, {
		query: { url, oauth: { callbackUrl: "http://localhost/callback?state=foreign" } },
		ports: { url, oauth: { callbackUrl: "http://localhost:1234/callback", callbackPort: 5678 } },
		document: { url, oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost/other" } },
		valid: { url, oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost:1234/callback" } },
	}, {});
	const config = loadMcpConfig({ ...f, projectTrusted: false });
	assert.deepEqual(config.servers.map((server) => server.name), ["valid"]);
	assert.equal(config.errors.length, 3);
	assert.match(config.errors.join("\n"), /query|fragment/u);
	assert.match(config.errors.join("\n"), /different ports/u);
	assert.match(config.errors.join("\n"), /path \/callback/u);
});

it("reads a leading BOM in global and trusted project MCP configuration", (t) => {
	const base = { command: "synthetic-server", exposure: "direct" };
	const f = mcpConfigFixture(t, { docs: base }, { docs: { enabled: false } });
	writeFileSync(f.source, `\uFEFF${readFileSync(f.source, "utf8")}`);
	writeFileSync(f.override, `\uFEFF${readFileSync(f.override, "utf8")}`);
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.deepEqual(config.errors, []);
	assert.deepEqual(config.servers, [{ name: "docs", source: f.source, override: f.override, config: { ...base, enabled: false } }]);
	assert.deepEqual(loadMcpConfig({ ...f, projectTrusted: false }).servers, [{ name: "docs", source: f.source, config: base }]);
});

it("reports malformed JSON after a BOM and does not read an untrusted project MCP configuration", (t) => {
	const f = mcpConfigFixture(t, {}, {});
	writeFileSync(f.override, "\uFEFF{invalid");
	assert.deepEqual(loadMcpConfig({ ...f, projectTrusted: false }).errors, []);
	const config = loadMcpConfig({ ...f, projectTrusted: true });
	assert.equal(config.errors.length, 1);
	assert.ok(config.errors[0]?.startsWith(`${f.override}:`));
	writeFileSync(f.source, "\uFEFF{invalid");
	const globalError = loadMcpConfig({ ...f, projectTrusted: false });
	assert.equal(globalError.errors.length, 1);
	assert.ok(globalError.errors[0]?.startsWith(`${f.source}:`));
});

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
		["typed", { type: "stdio", enabled: false }, /needs either "command"/u],
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
	assert.equal(output.info.name, "dev-docs");
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

function cimdGrant(serverUrl: string): McpOAuthState {
	return { serverUrl, tokens: { access_token: "synthetic-expired", refresh_token: "synthetic-refresh", token_type: "Bearer" }, tokensExpireAt: 1,
		discovery: { authorizationServerUrl: "https://auth.example.test", authorizationServerMetadata: {
			issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token",
			response_types_supported: ["code"], client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
		} } };
}

it("refreshes production CIMD state through a project selection override", { timeout: 30000 }, async (t) => {
	const token = `synthetic-${randomUUID()}`;
	const server = await httpMcpServer(token);
	t.after(() => server.close());
	const fetch = globalThis.fetch; let refreshes = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
		if (String(input) !== "https://auth.example.test/token") return fetch(input, init);
		refreshes++;
		assert.equal(new URLSearchParams(String(init?.body)).get("client_id"), "https://pi.dev/oauth/client.json");
		return Response.json({ access_token: token, refresh_token: "synthetic-rotated", token_type: "Bearer", expires_in: 3600 });
	});
	const key = `mcp__remote_docs|${server.url}`;
	const f = await executionFixture(t, {
		code: `return (await tools.mcp__remote_docs__echo({ value: "selected" })).content[0].text;`,
		mcpServers: { "remote-docs": { url: server.url, exposure: "direct", oauth: { clientRegistration: "cimd" } } },
		projectMcpServers: { "remote-docs": { exposure: "codemode" } },
		mcpAuth: { [key]: cimdGrant(server.url) },
	});
	const result = await f.submit("Use the project's authenticated documentation tools.");
	assert.equal(toolResultBody(result.toolResults.at(-1)), "echo selected");
	assert.deepEqual(declaredTools(f.requests[0]).filter((name) => name.startsWith("mcp__")), []);
	assert.equal(refreshes, 1);
	const state = JSON.parse(readFileSync(join(f.agentDir, "mcp-auth.json"), "utf8"))[key];
	assert.equal(state.tokens.access_token, token); assert.equal(state.tokens.refresh_token, "synthetic-rotated");
	assert.equal(state.clientInformation, undefined);
});

it("shares one rotating grant between two native executions", { timeout: 30000 }, async (t) => {
	const token = `synthetic-${randomUUID()}`; const server = await httpMcpServer(token); t.after(() => server.close());
	let host!: DurableExecutionHost;
	const f = await executionFixture(t, { builtinExtensions: (value) => { host = value; return []; } });
	const key = `mcp__remote_docs|${server.url}`;
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "remote-docs": { url: server.url, exposure: "direct" } } }));
	writeFileSync(join(f.agentDir, "mcp-auth.json"), JSON.stringify({ [key]: cimdGrant(server.url) }));
	const entered = deferred(); const release = deferred(); t.after(release.resolve);
	const fetch = globalThis.fetch; let refreshes = 0;
	t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
		if (String(input) !== "https://auth.example.test/token") return fetch(input, init);
		refreshes++; entered.resolve(); await release.promise;
		return refreshes === 1 ? Response.json({ access_token: token, refresh_token: "synthetic-rotated", token_type: "Bearer", expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
	});
	const first = createDurableExecution(host); const second = createDurableExecution(host);
	t.after(async () => { await Promise.all([first.close(), second.close()]); });
	await entered.promise; release.resolve(); await Promise.all([first.ready, second.ready]);
	for (const execution of [first, second]) assert.ok(execution.extensions.some((extension) => extension.tools?.some((tool) => tool.name === "mcp__remote_docs__echo")));
	assert.equal(refreshes, 1);
	assert.equal(JSON.parse(readFileSync(join(f.agentDir, "mcp-auth.json"), "utf8"))[key].tokens.refresh_token, "synthetic-rotated");
});

it("awaits refresh persistence on native execution close", { timeout: 30000 }, async (t) => {
	let host!: DurableExecutionHost;
	const f = await executionFixture(t, { builtinExtensions: (value) => { host = value; return []; } });
	const url = "https://mcp.example.test/mcp"; const key = `mcp__docs|${url}`;
	const path = join(f.agentDir, "mcp-auth.json");
	writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url, exposure: "direct" } } }));
	writeFileSync(path, JSON.stringify({ [key]: cimdGrant(url) }));
	const answered = deferred();
	t.mock.method(globalThis, "fetch", async (input: string | URL) => {
		assert.equal(String(input), "https://auth.example.test/token");
		mkdirSync(`${path}.lock`); answered.resolve();
		return Response.json({ access_token: "synthetic-new", refresh_token: "synthetic-rotated", token_type: "Bearer", expires_in: 3600 });
	});
	const execution = createDurableExecution(host); t.after(() => execution.close());
	await answered.promise;
	let closed = false; const closing = execution.close().then(() => { closed = true; });
	await Promise.resolve(); assert.equal(closed, false);
	rmdirSync(`${path}.lock`); await closing;
	assert.equal(JSON.parse(readFileSync(path, "utf8"))[key].tokens.refresh_token, "synthetic-rotated");
});

for (const clientRegistration of ["auto", "cimd", "dcr", "unsupported", ["cimd"], null]) {
	it(`validates the native OAuth registration setting ${JSON.stringify(clientRegistration)}`, (t) => {
		const f = mcpConfigFixture(t, { docs: { url: "https://example.com/mcp", oauth: { clientRegistration } } }, {});
		const loaded = loadMcpConfig({ agentDir: f.agentDir, cwd: f.cwd, projectTrusted: true });
		const valid = typeof clientRegistration === "string" && ["auto", "cimd", "dcr"].includes(clientRegistration);
		assert.equal(loaded.servers.length, valid ? 1 : 0);
		if (valid) assert.deepEqual(loaded.errors, []);
		else assert.match(loaded.errors.join("\n"), /oauth.clientRegistration/u);
	});
}

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

it("ends the MCP preflight at the script's explicit budget and records a stable diagnostic", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: `// @options: {"timeout_ms": 200}\nreturn await tools.mcp__silent_docs__anything({});`,
		mcpServers: { "silent-docs": { command: process.execPath, args: [fixtureServerPath], env: { MCP_FIXTURE_MODE: "silent" }, exposure: "codemode" } },
	});
	const started = Date.now();
	const result = await f.submit("call the silent server");
	assert.ok(Date.now() - started < 10000, "the wait is bounded by the script budget");
	const output = result.toolResults.at(-1);
	assert.equal(output?.isError, true);
	assert.match(toolResultText(output), /CODEMODE_ADMISSION_TIMEOUT|timed out while waiting for MCP servers/u);
});

it("persists a finite deadline for a script that names no timeout", { timeout: 30000 }, async (t) => {
	const { harness, conversation } = await nativeClockFixture(t, () => 5000, "return 7;");
	const starts: { startedAt: number; deadline?: number }[] = [];
	onStoredCommit(harness, (publication) => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.kind === "change" && change.record.kind === "pi.codemode.run" && change.value.start !== undefined) starts.push(change.value.start as unknown as { startedAt: number; deadline?: number });
		}
	});
	const outcome = await (await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(outcome.status, "done");
	assert.ok(starts.length > 0);
	assert.equal(starts[0].deadline, starts[0].startedAt + DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS);
});

async function nativeClockFixture(t: TestContext, now: () => number, code = '// @options: {"timeout_ms": 2000}\nreturn 42;', extensions?: (host: DurableContributionHost, execution: ReturnType<typeof createDurableExecution>) => readonly Extension[]) {
	const root = mkdtempSync(join(tmpdir(), "durable-codemode-clock-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"], cacheWarming: "off", retry: { enabled: false } }));
	let services: Awaited<ReturnType<typeof createDurableServices>> | undefined;
	let harness: Harness | undefined;
	const storage = new MemoryStorage();
	const closeStorage = storage.close.bind(storage);
	// The fixture owns the in-memory storage across Harness close/reopen.
	t.mock.method(storage, "close", async () => {});
	t.after(async () => {
		await services?.close();
		await harness?.close(BACKGROUND_CONTEXT);
		await closeStorage(BACKGROUND_CONTEXT);
		rmSync(root, { recursive: true, force: true });
	});
	const { runtime } = await streamRuntime(codemodeStream(code));
	const open = async () => {
		services = await createDurableServices({ cwd: root, agentDir, storageId: "fixture-clock", extensionPaths: [], trusted: true, buildBuiltin: (host) => {
			const execution = createDurableExecution(host);
			return { ...execution, extensions: [...execution.extensions, ...(extensions?.(host, execution) ?? [])] };
		}, modelRuntime: runtime });
		harness = await Harness.open(storage, { models: runtime, registry: services.registry, settings: services.settings, env: services.env, now }, BACKGROUND_CONTEXT);
		await services.install(harness);
		harness.resume();
		const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
		return { services, harness, conversation };
	};
	return { ...await open(), reopen: async () => {
		await services?.close();
		await harness?.close(BACKGROUND_CONTEXT);
		return open();
	} };
}

function observeQueuedWorkers(t: TestContext, queue: CodemodeWorkerQueue) {
	const queued = deferred();
	const observed = { queued: queued.promise, onQueued: () => {}, workers: 0, timeouts: [] as (number | undefined)[], attempts: [] as { startedAt: number; timeoutMs: number | undefined }[] };
	const reserve = queue.reserve.bind(queue);
	t.mock.method(queue, "reserve", (signal: AbortSignal, deadline: number) => {
		const pending = reserve(signal, deadline);
		queued.resolve();
		observed.onQueued();
		return pending;
	});
	const start = QueuedCodemodeSandbox.prototype.start;
	t.mock.method(QueuedCodemodeSandbox.prototype, "start", function(this: QueuedCodemodeSandbox, code: string, options: CodemodeRunOptions) {
		observed.attempts.push({ startedAt: options.startedAt, timeoutMs: options.timeoutMs });
		const fields = this as unknown as { queue: CodemodeWorkerQueue; options: CodemodeSandboxOptions };
		fields.queue = queue;
		fields.options = { ...fields.options, onWorkerStarted: () => { observed.workers++; } };
		return start.call(this, code, options);
	});
	const nativeStart = CodemodeSandbox.prototype.start;
	t.mock.method(CodemodeSandbox.prototype, "start", function(this: CodemodeSandbox, code: string, options: CodemodeRunOptions) {
		observed.timeouts.push(options.timeoutMs);
		return nativeStart.call(this, code, options);
	});
	return observed;
}

it("refuses a queued native launch after the committed Harness script deadline passes", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 10000);
	t.after(release);
	const observed = observeQueuedWorkers(t, queue);
	let clock = 1000;
	const { harness, conversation } = await nativeClockFixture(t, () => clock);
	let persisted: { startedAt: number; deadline: number } | undefined;
	onStoredCommit(harness, (publication) => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.kind === "change" && change.record.kind === "pi.codemode.run" && change.value.start !== undefined) {
				const start = change.value.start as unknown as { startedAt: number; deadline: number };
				persisted = { startedAt: start.startedAt, deadline: start.deadline };
			}
		}
	});
	const submission = await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
	await observed.queued;
	assert.deepEqual(persisted, { startedAt: 1000, deadline: 3000 });
	clock = 3001;
	release();
	assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 0, "an expired native deadline must prevent actual worker launch");
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, true);
	assert.match(toolResultBody(output), /timed out/u);
});

it("debits a partial Harness clock advance from the queued native worker budget", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 10000);
	t.after(release);
	const observed = observeQueuedWorkers(t, queue);
	let clock = 1000;
	const { conversation } = await nativeClockFixture(t, () => clock);
	const submission = await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
	await observed.queued;
	clock = 1500;
	release();
	assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 1);
	assert.equal(observed.timeouts.length, 1);
	assert.ok(observed.timeouts[0] !== undefined && observed.timeouts[0] > 0 && observed.timeouts[0] <= 1500);
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, false);
	assert.match(toolResultBody(output), /42/u);
});

it("keeps the original native deadline and replay remainder across a queued Harness reopen", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 10000);
	t.after(release);
	const observed = observeQueuedWorkers(t, queue);
	let clock = 1000;
	const f = await nativeClockFixture(t, () => clock);
	const submission = await f.conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
	await observed.queued;
	const queuedAgain = deferred();
	observed.onQueued = () => queuedAgain.resolve();
	clock = 1600;
	const reopened = await f.reopen();
	await queuedAgain.promise;
	assert.deepEqual(observed.attempts, [{ startedAt: 1000, timeoutMs: 2000 }, { startedAt: 1000, timeoutMs: 1400 }]);
	clock = 2500;
	release();
	const restored = await reopened.harness.submission(submission.id, BACKGROUND_CONTEXT);
	assert.ok(restored);
	assert.equal((await restored.wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 1);
	assert.equal(observed.timeouts.length, 1);
	assert.ok(observed.timeouts[0] !== undefined && observed.timeouts[0] > 0 && observed.timeouts[0] <= 500);
	const view = await reopened.conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, false);
	assert.match(toolResultBody(output), /42/u);
});

it("admits native codemode with an injected Harness clock", { timeout: 30000 }, async (t) => {
	const { conversation } = await nativeClockFixture(t, () => 1000);
	const outcome = await (await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(outcome.status, "done");
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, false);
	assert.match(toolResultBody(output), /42/u);
});

it("preserves an expired persisted worker wait at the native tool boundary", { timeout: 30000 }, async (t) => {
	const f = await executionFixture(t, {
		code: 'await tools.structured({}); return "unexpected";',
		builtinExtensions: (host) => {
			const Admission = host.durable.defineDoc<{ deadline?: number; admitted: boolean }>({
				kind: "agent.codemode-admission", version: 1, scope: "task", initial: () => ({ admitted: false }), checkpointWhen: () => false,
			});
			return [host.durable.defineExtension({ name: "fixture.expired-admission", hooks: [host.durable.hook(host.durable.ToolTask, {
				beforeTool: async (call, api, context) => {
					if (call.name !== "codemode") return undefined;
					await host.harness.commit(async (tx) => {
						const state = await tx.doc(Admission, api.taskId);
						state.deadline = Date.now() - 1;
					}, context);
					return undefined;
				},
			})] })];
		},
	});
	const result = await f.submit("Resume the queued script.");
	const output = result.toolResults.at(-1);
	assert.ok(output);
	assert.equal(output.isError, true);
	assert.match(toolResultBody(output), /worker wait timed out/u);
	assert.deepEqual((output.details as CodemodeToolDetails).calls, []);
});

it("reports a transport that exceeds the close deadline", { timeout: 12000 }, async (t) => {
	const isolated = mkdtempSync(join(tmpdir(), "mcp-deadline-"));
	t.after(() => rmSync(isolated, { recursive: true, force: true }));
	const f = await executionFixture(t, { mcpServers: { docs: { command: process.execPath, args: [fixtureServerPath], env: { PI_AGENT_DIR: isolated, PI_AGENT_SESSIONS_DIR: isolated }, exposure: "direct" } }, awaitReady: true });
	const original = StdioTransport.prototype.close;
	let called = false;
	StdioTransport.prototype.close = async () => { called = true; await new Promise<void>(() => {}); };
	t.after(() => { StdioTransport.prototype.close = original; });
	try {
		const first = f.execution.close();
		assert.equal(first, f.execution.close());
		await first;
		assert.equal(called, true);
		assert.ok(f.services.services.diagnostics.some((entry) => entry.message.includes("MCP shutdown timed out: docs")));
	} finally { StdioTransport.prototype.close = original; }
});

it("joins the same execution close promise", async (t) => {
	const f = await executionFixture(t, {});
	const first = f.execution.close();
	const second = f.execution.close();
	assert.equal(first, second);
	await first;
});

it("aborts an owned nested call with the conversation and reaches idle", { timeout: 30000 }, async (t) => {
	const entered = deferred();
	const f = await executionFixture(t, { code: 'await tools.hanging({}); return "unexpected";' });
	(globalThis as Record<string, unknown>).__execFixture = { onEnter: () => entered.resolve(), aborted: false };
	try {
		const submission = await f.conversation.submit({ type: "input", content: "hang the tool" }, BACKGROUND_CONTEXT);
		await entered.promise;
		const live = await f.harness.snapshot(LiveDoc, f.conversation.id, BACKGROUND_CONTEXT);
		assert.equal(live?.nestedTools?.some((slot) => slot.name === "hanging" && slot.parentCallId === "codemode-call"), true);
		await f.conversation.abort(BACKGROUND_CONTEXT);
		await f.conversation.waitForIdle(BACKGROUND_CONTEXT);
		await submission.wait(BACKGROUND_CONTEXT);
		const view = await f.conversation.context(BACKGROUND_CONTEXT);
		const retained = view.messages.find((message) => message.role === "toolResult" && message.toolCallId === "codemode-call");
		assert.ok(retained?.role === "toolResult");
		assert.equal(retained.isError, true);
		assert.match(messageText(retained), /Tool codemode was aborted/u);
		assert.equal((await f.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
		assert.equal(((globalThis as Record<string, unknown>).__execFixture as { aborted: boolean }).aborted, true);
	} finally { delete (globalThis as Record<string, unknown>).__execFixture; }
});

it("does not repeat an interrupted unsafe nested call after a crash", { timeout: 60000 }, async () => {
	const { DurableHost } = await import("./durable-host.ts");
	const { reconcileDeliveries } = await import("./durable-controls.ts");
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

/** Holds codemode tool settlement after the native tool returns, so a restart finds its outcome committed but the task unsettled. */
function interruptCodemodeSettlement(host: DurableContributionHost, gate: { interrupt: boolean; entered: ReturnType<typeof deferred> }): readonly Extension[] {
	return [host.durable.defineExtension({ name: "fixture.interrupted-settlement", hooks: [host.durable.hook(host.durable.ToolTask, {
		afterTool: async (call, _result, _api, context) => {
			if (call.name !== "codemode" || !gate.interrupt) return undefined;
			gate.entered.resolve();
			await new Promise<never>((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(context.abortSignal?.reason), { once: true }));
			return undefined;
		},
	})] })];
}

const RETAINED_CODEMODE_RESULTS = [
	{ name: "success", code: '// @options: {"timeout_ms": 2000}\nstore("runs", 1);\nreturn 42;', isError: false, text: /42/u, storeWrites: 1 },
	{ name: "error", code: '// @options: {"timeout_ms": 2000}\nthrow new Error("retained failure");', isError: true, text: /retained failure/u, storeWrites: 0 },
];

for (const scenario of RETAINED_CODEMODE_RESULTS)
	it(`returns the retained codemode ${scenario.name} after the deadline passes during interrupted settlement`, { timeout: 30000 }, async (t) => {
		const observed = observeQueuedWorkers(t, new CodemodeWorkerQueue(1));
		let clock = 1000;
		const gate = { interrupt: true, entered: deferred() };
		const f = await nativeClockFixture(t, () => clock, scenario.code, (host) => interruptCodemodeSettlement(host, gate));
		let storeWrites = 0;
		const countStoreWrites = (harness: Harness) => onStoredCommit(harness, (publication) => {
			for (const change of publication.changes) if (change.type === "document" && change.kind === "change" && change.record.kind === "pi.codemode.store" && "runs" in (change.value as { values: object }).values) storeWrites++;
		});
		countStoreWrites(f.harness);
		const submission = await f.conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
		await gate.entered.promise;
		assert.equal(observed.workers, 1);
		clock = 5000;
		gate.interrupt = false;
		const reopened = await f.reopen();
		countStoreWrites(reopened.harness);
		const restored = await reopened.harness.submission(submission.id, BACKGROUND_CONTEXT);
		assert.ok(restored);
		assert.equal((await restored.wait(BACKGROUND_CONTEXT)).status, "done");
		const view = await reopened.conversation.context(BACKGROUND_CONTEXT);
		const output = view.messages.find((message) => message.role === "toolResult");
		assert.ok(output?.role === "toolResult");
		assert.equal(output.isError, scenario.isError);
		assert.match(toolResultBody(output), scenario.text);
		assert.doesNotMatch(toolResultBody(output), /timed out/u);
		assert.equal(observed.attempts.length, 1, "the retained outcome starts no second sandbox");
		assert.equal(observed.workers, 1, "no second worker launches");
		assert.equal(storeWrites, scenario.storeWrites, "the script's store mutation is committed once");
	});

/** Advances the injected clock once while the native tool prepares its agent, after the harness computed the script's remaining budget. */
function delayNativePreparation(t: TestContext, execution: ReturnType<typeof createDurableExecution>, delay: { ms: number; advance: (ms: number) => void }): readonly Extension[] {
	const catalogApi = (execution as unknown as { catalogApi(api: ToolExecutionApi): ToolExecutionApi }).catalogApi.bind(execution);
	t.mock.method(execution, "catalogApi" as never, ((api: ToolExecutionApi) => Object.create(catalogApi(api), { agent: { value: async (context: Parameters<ToolExecutionApi["agent"]>[0]) => {
		const ms = delay.ms;
		delay.ms = 0;
		delay.advance(ms);
		return api.agent(context);
	} } })) as never);
	return [];
}

it("caps the running native script by the original deadline when preparation takes time", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 10000);
	t.after(release);
	const observed = observeQueuedWorkers(t, queue);
	let clock = 1000;
	const delay = { ms: 1000, advance: (ms: number) => { clock += ms; } };
	const { conversation } = await nativeClockFixture(t, () => clock, undefined, (_host, execution) => delayNativePreparation(t, execution, delay));
	const submission = await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
	await observed.queued;
	assert.deepEqual(observed.attempts, [{ startedAt: 2000, timeoutMs: 2000 }], "preparation moved the native start and deadline");
	release();
	assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 1);
	assert.ok(observed.timeouts[0] !== undefined && observed.timeouts[0] > 0 && observed.timeouts[0] <= 1000, `worker timeout ${String(observed.timeouts[0])}`);
});

it("refuses a native script whose preparation outlasts the original deadline", { timeout: 30000 }, async (t) => {
	const observed = observeQueuedWorkers(t, new CodemodeWorkerQueue(1));
	let clock = 1000;
	const delay = { ms: 2500, advance: (ms: number) => { clock += ms; } };
	const { conversation } = await nativeClockFixture(t, () => clock, undefined, (_host, execution) => delayNativePreparation(t, execution, delay));
	assert.equal((await (await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 0);
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, true);
	assert.match(toolResultBody(output), /timed out/u);
});

it("keeps the original deadline cap on the replayed script after a reopen", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1);
	const release = await queue.reserve(new AbortController().signal, Date.now() + 10000);
	t.after(release);
	const observed = observeQueuedWorkers(t, queue);
	let clock = 1000;
	const delay = { ms: 1000, advance: (ms: number) => { clock += ms; } };
	const f = await nativeClockFixture(t, () => clock, undefined, (_host, execution) => delayNativePreparation(t, execution, delay));
	const submission = await f.conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT);
	await observed.queued;
	const queuedAgain = deferred();
	observed.onQueued = () => queuedAgain.resolve();
	clock = 2600;
	const reopened = await f.reopen();
	await queuedAgain.promise;
	assert.deepEqual(observed.attempts, [{ startedAt: 2000, timeoutMs: 2000 }, { startedAt: 2000, timeoutMs: 1400 }]);
	clock = 2800;
	release();
	const restored = await reopened.harness.submission(submission.id, BACKGROUND_CONTEXT);
	assert.ok(restored);
	assert.equal((await restored.wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 1);
	assert.ok(observed.timeouts[0] !== undefined && observed.timeouts[0] > 0 && observed.timeouts[0] <= 200, `worker timeout ${String(observed.timeouts[0])}`);
});

it("includes worker-capacity counts in the emitted admission diagnostic", { timeout: 30000 }, async (t) => {
	const queue = new CodemodeWorkerQueue(1, 0);
	const observed = observeQueuedWorkers(t, queue);
	const { conversation } = await nativeClockFixture(t, () => 1000);
	assert.equal((await (await conversation.submit({ type: "input", content: "Run the script." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
	assert.equal(observed.workers, 0);
	const view = await conversation.context(BACKGROUND_CONTEXT);
	const output = view.messages.find((message) => message.role === "toolResult");
	assert.ok(output?.role === "toolResult");
	assert.equal(output.isError, true);
	assert.match(toolResultBody(output), /\[error\] The codemode worker queue is full \(0 waiting calls\)\. \(active 0, waiting 0, limit 1\)/u);
});
