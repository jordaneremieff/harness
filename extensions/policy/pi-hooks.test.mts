/** Controlled real Pi dispatcher tests. No provider, credential, or external tool executes. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { FactsProgram } from "./program.ts";
import { RuleRegistry, proposalRevision } from "./local-rules.ts";

const piRoot = process.env.PI_POLICY_TEST_PI_ROOT
	? resolve(process.env.PI_POLICY_TEST_PI_ROOT)
	: resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const nestedCore = join(piRoot, "node_modules/@earendil-works/pi-agent-core");
const coreRoot = existsSync(join(nestedCore, "dist/agent-loop.js")) ? nestedCore : resolve(piRoot, "../pi-agent-core");
const host = await import(pathToFileURL(join(piRoot, "dist/index.js")).href);
const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const { runAgentLoop } = await import(pathToFileURL(join(coreRoot, "dist/agent-loop.js")).href);
const version = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")).version;
const model = {
	provider: "controlled",
	id: "controlled",
	api: "openai-completions",
	name: "Controlled",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const observe = { op: "exists" as const, path: ["outcome"] };
const audit = { session: "controlled", model: null, at: new Date().toISOString() };
const inputSchema = Type.Object(
	{
		old: Type.Optional(Type.String()),
		name: Type.Optional(Type.String()),
		order: Type.Optional(Type.Integer()),
		fail: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
type ControlledTool = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (
		id: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; terminate?: boolean }>;
};

async function setup(programs: Array<[string, FactsProgram]>, mode = "enforce", later?: (pi: unknown) => void) {
	const base = await mkdtemp(join(tmpdir(), "policy-hooks-"));
	const dir = join(base, "policy");
	const registry = new RuleRegistry(dir);
	for (const [id, program] of programs) {
		const proposal = await registry.proposeAdd(
			{
				id,
				purpose: "Exercise controlled tool policy behavior.",
				authority: "exact",
				matcher: { kind: "declarative", language: "facts/v1", spec: program },
				note: `Policy ${id}.`,
			},
			"Controlled test",
			{ ...audit, surface: "agent-tool" },
		);
		await registry.decide(
			proposal.id,
			"approved",
			undefined,
			{ ...audit, surface: "command" },
			proposalRevision(proposal),
		);
	}
	const previous = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = dir;
	let loaded: Awaited<ReturnType<typeof loadExtensions>>;
	try {
		loaded = await loadExtensions([resolve(import.meta.dirname, "index.ts")], base);
	} finally {
		if (previous === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previous;
	}
	assert.deepEqual(loaded.errors, []);
	if (later) {
		const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
		loaded.extensions.push(
			await loader.loadExtensionFromFactory(later, base, host.createEventBus(), loaded.runtime, "controlled-later"),
		);
	}
	const session = host.SessionManager.inMemory(base);
	const runner = new host.ExtensionRunner(loaded.extensions, loaded.runtime, base, session, {});
	const errors: unknown[] = [];
	runner.onError((error: unknown) => errors.push(error));
	const controller = new AbortController();
	let tools: ControlledTool[] = [];
	let requestCount = 0;
	const requestContexts: unknown[][] = [];
	const actions = {
		sendMessage: () => assert.fail("Policy must not send a message to force a turn"),
		sendUserMessage: () => assert.fail("Policy must not force a user turn"),
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => tools.map((t) => t.name),
		getAllTools: () =>
			tools.map((t) => ({
				...t,
				sourceInfo: { path: "controlled", source: "sdk", scope: "temporary", origin: "top-level" },
			})),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};
	runner.bindCore(actions, {
		getModel: () => model,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => controller.signal,
		abort: () => controller.abort(),
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "Controlled policy test",
	});
	runner.setFlagValue("policy-mode", mode);
	await runner.emit({ type: "session_start", reason: "startup" });
	const invoke = async (name: string, params: unknown) => {
		const registered = runner
			.getAllRegisteredTools()
			.find((tool: { definition: { name: string } }) => tool.definition.name === name);
		assert.ok(registered);
		return registered.definition.execute("inspection", params, undefined, () => {}, runner.createContext());
	};
	const states = async () => JSON.parse((await invoke("policy_rules", { view: "state" })).content[0].text);
	const endings: string[] = [];
	const run = async (
		calls: Array<{ id: string; name?: string; arguments: Record<string, unknown> }>,
		options: { stop?: boolean; stopReason?: string } = {},
	) => {
		let supplied = false;
		const stream = async (_model: unknown, context: { messages: unknown[] }) => {
			requestCount++;
			requestContexts.push(context.messages);
			const content = supplied
				? [{ type: "text", text: "Finished" }]
				: calls.map((call) => ({
						type: "toolCall",
						id: call.id,
						name: call.name ?? "sample",
						arguments: call.arguments,
					}));
			const message = {
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: supplied ? "stop" : (options.stopReason ?? "toolUse"),
				timestamp: Date.now(),
			};
			supplied = true;
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: message.stopReason, message };
				},
				result: async () => message,
			};
		};
		return runAgentLoop(
			[{ role: "user", content: "Run controlled tools", timestamp: Date.now() }],
			{ systemPrompt: "Controlled test", messages: [], tools },
			{
				model,
				convertToLlm: (messages: unknown[]) => messages,
				transformContext: (messages: unknown[]) => runner.emitContext(messages),
				beforeToolCall: ({ toolCall, args }: { toolCall: { id: string; name: string }; args: unknown }) =>
					runner.emitToolCall({ type: "tool_call", toolCallId: toolCall.id, toolName: toolCall.name, input: args }),
				afterToolCall: ({
					toolCall,
					args,
					result,
					isError,
				}: {
					toolCall: { id: string; name: string };
					args: unknown;
					result: Record<string, unknown>;
					isError: boolean;
				}) =>
					runner.emitToolResult({
						type: "tool_result",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						input: args,
						...result,
						isError,
					}),
				...(options.stop ? { shouldStopAfterTurn: () => true } : {}),
			},
			async (event: { type: string; toolCallId?: string }) => {
				if (event.type === "tool_execution_end") endings.push(event.toolCallId!);
				if (event.type === "message_end") await runner.emitMessageEnd(event);
				else await runner.emit(event);
			},
			controller.signal,
			stream,
		);
	};
	const telemetry = async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		const names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
		return (
			await Promise.all(
				names.map(async (name) =>
					(
						await readFile(join(dir, name), "utf8")
					)
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line)),
				),
			)
		).flat();
	};
	return {
		base,
		runner,
		registry,
		controller,
		run,
		invoke,
		states,
		requestContexts,
		endings,
		errors,
		telemetry,
		setTools: (next: ControlledTool[]) => {
			tools = next;
		},
		requests: () => requestCount,
		cleanup: () => rm(base, { recursive: true, force: true }),
	};
}
const observeProgram: FactsProgram = {
	phase: "completion",
	when: { op: "exists", path: ["outcome"] },
	action: { kind: "observe", label: "completed" },
	onUnavailable: "skip",
	state: { observe },
};
const renameProgram: FactsProgram = {
	phase: "input",
	selector: { tools: ["sample"] },
	when: { op: "exists", path: ["input", "old"] },
	action: { kind: "rename-key", path: [], from: "old", to: "name" },
	onUnavailable: "skip",
};
const errorProgram: FactsProgram = {
	phase: "result",
	when: { op: "eq", path: ["result", "details", "failed"], value: true },
	action: { kind: "assert-error" },
	onUnavailable: "skip",
};
const contextProgram: FactsProgram = {
	phase: "context",
	selector: { tools: ["sample"] },
	when: { op: "gte", path: ["state", "count"], value: 1 },
	action: { kind: "guide", text: "Review the completed calls." },
	onUnavailable: "skip",
	state: { observe: { op: "eq", path: ["outcome", "kind"], value: "success" }, once: "period" },
};

describe(`ordinary Pi ${version} policy hooks`, () => {
	it("executes validated input corrections and observes final chained result patches in completion order", async () => {
		let releaseFirst = () => {};
		const secondFinalized = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const f = await setup(
			[
				["rename", renameProgram],
				["errors", errorProgram],
				["observe", observeProgram],
			],
			"enforce",
			(pi: unknown) => {
				(pi as { on: (name: string, handler: (event: { isError: boolean }) => unknown) => void }).on(
					"tool_result",
					(event) => ({ details: { failed: event.isError, private: "result-body" } }),
				);
				(pi as { on: (name: string, handler: (event: { toolCallId: string }) => unknown) => void }).on(
					"tool_execution_end",
					(event) => {
						if (event.toolCallId === "second") releaseFirst();
					},
				);
			},
		);
		try {
			const received: Array<Record<string, unknown>> = [];
			f.setTools([
				{
					name: "sample",
					description: "controlled",
					parameters: inputSchema,
					execute: async (_id, args) => {
						received.push({ ...args });
						if (args.order === 1) await secondFinalized;
						return { content: [{ type: "text", text: "private-output" }], details: { failed: args.fail === true } };
					},
				},
			]);
			await f.run(
				[
					{ id: "first", arguments: { old: "private-input", order: 1 } },
					{ id: "second", arguments: { old: "other", order: 2, fail: true } },
				],
				{ stop: true },
			);
			assert.deepEqual(received, [
				{ name: "private-input", order: 1 },
				{ name: "other", order: 2, fail: true },
			]);
			assert.deepEqual(f.endings, ["second", "first"]);
			const records = await f.telemetry();
			assert.deepEqual(
				records.map((row) => row.callId),
				["second", "first"],
			);
			assert.equal(records[0].error, true);
			assert.equal(records[0].outcome, "execution-error");
			assert.doesNotMatch(JSON.stringify(records), /private-input|private-output|result-body/);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.cleanup();
		}
	});
	it("records denied, invalid, truncated, and unknown-tool calls at the terminal fallback", async () => {
		const denial: FactsProgram = {
			phase: "input",
			when: { op: "eq", path: ["input", "name"], value: "deny" },
			action: { kind: "deny" },
			onUnavailable: "skip",
		};
		const f = await setup([
			["deny", denial],
			["observe", observeProgram],
		]);
		try {
			let executions = 0;
			f.setTools([
				{
					name: "sample",
					description: "controlled",
					parameters: Type.Object({ name: Type.String() }, { additionalProperties: false }),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				},
			]);
			await f.run(
				[
					{ id: "denied", arguments: { name: "deny" } },
					{ id: "invalid", arguments: { bad: 1 } },
					{ id: "unknown", name: "missing", arguments: {} },
				],
				{ stop: true },
			);
			await f.run([{ id: "truncated", arguments: { name: "ok" } }], { stop: true, stopReason: "length" });
			const rows = await f.telemetry();
			assert.equal(executions, 0);
			assert.deepEqual(
				rows.map((row) => row.callId),
				["denied", "invalid", "unknown", "truncated"],
			);
			assert.equal(rows[0].outcome, "denied");
			assert.equal(rows[0].blocked, true);
			assert.ok(rows.slice(1).every((row) => row.outcome === "unexecuted" && row.observationComplete === false));
			assert.deepEqual(f.errors, []);
		} finally {
			await f.cleanup();
		}
	});
	it("projects tool-scoped context before the next real request without an extra request after a stopped batch", async () => {
		const f = await setup([["context", contextProgram]]);
		try {
			f.setTools([
				{
					name: "sample",
					description: "controlled",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				},
			]);
			await f.run([{ id: "first", arguments: {} }], { stop: true });
			assert.equal(f.requests(), 1);
			assert.equal(
				(await f.states()).observationPeriods.find((row: { id: string }) => row.id === "context").projected,
				0,
			);
			await f.run([]);
			assert.equal(f.requests(), 2);
			assert.match(JSON.stringify(f.requestContexts[1]), /Review the completed calls/);
			await f.run([]);
			assert.equal(f.requests(), 3);
			assert.doesNotMatch(JSON.stringify(f.requestContexts[2]), /Review the completed calls/);
			assert.equal(
				(await f.states()).observationPeriods.find((row: { id: string }) => row.id === "context").projected,
				1,
			);
			await f.telemetry();
			assert.deepEqual(f.errors, []);
		} finally {
			await f.cleanup();
		}
	});
	it("retains the own denial decision when Pi substitutes abort after the hook", async () => {
		let controller: AbortController;
		const f = await setup([
			[
				"deny",
				{ phase: "input", when: { op: "exists", path: ["input"] }, action: { kind: "deny" }, onUnavailable: "skip" },
			],
		]);
		controller = f.controller;
		try {
			f.setTools([
				{
					name: "sample",
					description: "controlled",
					parameters: Type.Object({}),
					execute: async () => assert.fail("Denied tool must not execute"),
				},
			]);
			const original = f.runner.emitToolCall.bind(f.runner);
			f.runner.emitToolCall = async (event: unknown) => {
				const decision = await original(event);
				controller.abort();
				return decision;
			};
			await f.run([{ id: "aborted", arguments: {} }], { stop: true });
			const rows = await f.telemetry();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].outcome, "unexecuted");
			assert.equal(rows[0].abortRequested, true);
			assert.equal(rows[0].errorKind, "aborted");
			assert.equal(rows[0].policy.decision, "deny");
			assert.equal(rows[0].blocked, undefined);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.cleanup();
		}
	});
});
