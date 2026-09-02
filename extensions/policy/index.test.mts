import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AgentRule,
	AgentRules,
	appendLine,
	MAX_FIRE_SCAN_BYTES,
	RULES_FILE,
	SCHEMA_VERSION,
} from "./agent-rules.ts";
import registerPolicy from "./index.ts";
import type { PromotionWarrant } from "./promotion.ts";
import { PROMOTION_CRITERIA_SOURCE } from "./promotion.ts";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, MAX_QUEUED_RECORDS } from "./store.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

type ToolResult = { content: Array<{ type: string; text?: string }> };
interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
}

interface RegisteredCommand {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (text: string) => Array<{ value: string; label?: string }> | null;
}

interface RegisteredFlag {
	type: "boolean" | "string";
	description?: string;
	default?: boolean | string;
}

interface HarnessOverrides {
	systemPrompt?: string;
	sessionId?: string;
	policyMode?: string;
	policyModeFlag?: boolean | string;
	promotionMode?: string;
	promotionModeFlag?: boolean | string;
	ctxMode?: string;
	model?: { provider: string; id: string } | undefined;
	thinkingLevel?: string | undefined;
	hasUI?: boolean;
	confirm?: (title: string, message: string) => boolean | Promise<boolean>;
	customResults?: unknown[];
	isIdle?: boolean;
}

interface Notification {
	message: string;
	type?: string;
}

function harness(overrides: HarnessOverrides = {}) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const flags = new Map<string, RegisteredFlag>();
	const flagValues = new Map<string, boolean | string>();
	if (overrides.policyModeFlag !== undefined) flagValues.set("policy-mode", overrides.policyModeFlag);
	if (overrides.promotionModeFlag !== undefined) {
		flagValues.set("policy-promotion-mode", overrides.promotionModeFlag);
	}
	const messages: Array<{
		content: string;
		options?: Record<string, unknown>;
		customType?: string;
		display?: boolean;
		details?: Record<string, unknown>;
	}> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerFlag(name: string, options: RegisteredFlag) {
			flags.set(name, options);
			if (options.default !== undefined && !flagValues.has(name)) flagValues.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.has(name) ? flagValues.get(name) : undefined;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		sendUserMessage(content: string, options?: Record<string, unknown>) {
			messages.push({ content, options });
		},
		sendMessage(
			message: {
				customType: string;
				content: string;
				display?: boolean;
				details?: Record<string, unknown>;
			},
			options?: Record<string, unknown>,
		) {
			messages.push({ ...message, options });
		},
	};
	const notifications: Notification[] = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const customResults = [...(overrides.customResults ?? [])];
	const ctx = {
		mode: overrides.ctxMode ?? "tui",
		hasUI: overrides.hasUI ?? true,
		cwd: "/work",
		model: Object.hasOwn(overrides, "model") ? overrides.model : { provider: "xai", id: "grok-4.6" },
		thinkingLevel: Object.hasOwn(overrides, "thinkingLevel") ? overrides.thinkingLevel : "high",
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return (await overrides.confirm?.(title, message)) ?? true;
			},
			custom: async () => customResults.shift(),
		},
		isIdle: () => overrides.isIdle ?? true,
		sessionManager: { getSessionId: () => overrides.sessionId ?? "session-1" },
		getSystemPrompt: () => overrides.systemPrompt ?? "base prompt\n\n<project_context>\n\n",
	};
	if (overrides.policyMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = overrides.policyMode;
	if (overrides.promotionMode === undefined) delete process.env.PI_POLICY_PROMOTION_MODE;
	else process.env.PI_POLICY_PROMOTION_MODE = overrides.promotionMode;
	// The fake supplies only the surface the slice uses.
	registerPolicy(pi as unknown as Parameters<typeof registerPolicy>[0]);
	return { handlers, tools, commands, flags, ctx, notifications, confirmations, messages, entries };
}

const passingWarrant: PromotionWarrant = {
	criteria: 1,
	fires: 5,
	errors: 3,
	errorKinds: { timeout: 0, aborted: 0, other: 3 },
	truncated: 0,
	partial: false,
	pass: true,
};

/** One completed bash call through the tool_call and tool_result pair. */
async function runBash(
	harnessed: { handlers: Map<string, Handler>; ctx: unknown },
	callId: string,
	command: string,
	result: { content?: unknown[]; isError?: boolean } = {},
): Promise<unknown> {
	const { handlers, ctx } = harnessed;
	await handlers.get("tool_call")!({ toolName: "bash", toolCallId: callId, input: { command } }, ctx);
	return handlers.get("tool_result")!(
		{
			toolName: "bash",
			toolCallId: callId,
			input: { command },
			content: result.content ?? [{ type: "text", text: "out" }],
			isError: result.isError ?? false,
		},
		ctx,
	);
}

async function registryLines(): Promise<Array<Record<string, unknown>>> {
	const text = await readFile(join(dir, RULES_FILE), "utf8");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function seedEvidence(slug: string, fires: number, errors: number): Promise<void> {
	for (let index = 0; index < fires; index++) {
		const failed = index < errors;
		const record: PolicyRecord = {
			session: "evidence-session",
			mode: "print",
			cwd: "/work",
			model: "xai/grok-4.6",
			thinkingLevel: "high",
			projectContext: true,
			at: `2026-09-03T12:00:${String(index).padStart(2, "0")}.000Z`,
			tool: "bash",
			callId: `evidence-${slug}-${index}`,
			durationMs: 1,
			outputBytes: 0,
			truncated: false,
			error: failed,
			errorKind: failed ? "other" : null,
			tokens: null,
			policyMode: "observe",
			classes: [`agent.${slug}`],
		};
		assert.equal(await appendRecord(dir, record), null);
	}
}

async function records(dir: string): Promise<PolicyRecord[]> {
	const files = await readdir(dir);
	const lines: PolicyRecord[] = [];
	for (const file of files.filter((name) => name !== RULES_FILE).sort()) {
		const text = await readFile(join(dir, file), "utf8");
		for (const line of text.trim().split("\n")) {
			if (line) lines.push(JSON.parse(line) as PolicyRecord);
		}
	}
	return lines;
}

async function seedRule(overrides: Partial<AgentRule> = {}): Promise<AgentRule> {
	const requestedState = overrides.state;
	const rule: AgentRule = {
		version: SCHEMA_VERSION,
		slug: "no-force-push",
		note: "Do not force push this branch.",
		match: { tool: "bash", command: "git", flags: ["force"], operands: { at: { "0": "push" } } },
		model: "xai/grok-4.6",
		session: "seed-session",
		at: "2026-09-01T07:00:00Z",
		...overrides,
		state: "active",
	};
	const rules = new AgentRules(dir);
	assert.equal(await rules.add(rule), null);
	if (requestedState && requestedState !== "active") {
		assert.equal(
			await rules.setState(
				rule.slug,
				requestedState,
				rule.model,
				rule.session,
				rule.at,
				"command",
				requestedState === "promoted" ? passingWarrant : undefined,
			),
			null,
		);
		rule.state = requestedState;
	}
	return rule;
}

async function callTool(
	run: ReturnType<typeof harness>,
	name: string,
	params: Record<string, unknown>,
	ctx: unknown = run.ctx,
): Promise<string> {
	const result = await run.tools.get(name)!.execute(`${name}-call`, params, undefined, undefined, ctx);
	return result.content.map((part) => part.text ?? "").join("");
}

async function callCommand(run: ReturnType<typeof harness>, args: string, ctx: unknown = run.ctx): Promise<void> {
	await run.commands.get("policy")!.handler(args, ctx);
}

let dir: string;
const previousDir = process.env.PI_POLICY_DIR;
const previousMode = process.env.PI_POLICY_MODE;
const previousPromotionMode = process.env.PI_POLICY_PROMOTION_MODE;

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "store");
	process.env.PI_POLICY_DIR = dir;
	delete process.env.PI_POLICY_MODE;
	delete process.env.PI_POLICY_PROMOTION_MODE;
});

afterEach(() => {
	if (previousDir === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previousDir;
	if (previousMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = previousMode;
	if (previousPromotionMode === undefined) delete process.env.PI_POLICY_PROMOTION_MODE;
	else process.env.PI_POLICY_PROMOTION_MODE = previousPromotionMode;
});

describe("policy extension", () => {
	it("registers the policy flag, tools, command, and session handlers", () => {
		const { handlers, tools, commands, flags } = harness();
		assert.deepEqual([...handlers.keys()].sort(), [
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_execution_end",
			"tool_result",
		]);
		assert.deepEqual([...tools.keys()].sort(), ["policy_rule_add", "policy_rule_list", "policy_rule_set_state"]);
		assert.deepEqual([...commands.keys()], ["policy"]);
		assert.deepEqual(
			[...flags],
			[
				[
					"policy-mode",
					{
						type: "string",
						description: "Policy mode (observe, notice, annotate, enforce); overrides PI_POLICY_MODE",
					},
				],
				[
					"policy-promotion-mode",
					{
						type: "string",
						description: "Policy promotion mode (agent, operator); overrides PI_POLICY_PROMOTION_MODE",
					},
				],
			],
		);
	});

	it("writes one record per completed call and returns nothing", async () => {
		const { handlers, ctx } = harness();
		const call = await handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			ctx,
		);
		const result = await handlers.get("tool_result")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				input: { command: "cat notes.md" },
				content: [{ type: "text", text: "hello" }],
				isError: false,
				details: { truncation: { truncated: true } },
				usage: { totalTokens: 7 },
			},
			ctx,
		);
		assert.equal(call, undefined, "tool_call must not return a result object");
		assert.equal(result, undefined, "tool_result must not return a result object");
		await handlers.get("session_shutdown")!({}, ctx);

		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].tool, "bash");
		assert.equal(written[0].session, "session-1");
		assert.equal(written[0].model, "xai/grok-4.6");
		assert.equal(written[0].thinkingLevel, "high");
		assert.equal(written[0].projectContext, true);
		assert.deepEqual(written[0].classes, ["routing.cat-read"]);
		assert.equal(written[0].captured, "cat notes.md");
		assert.equal(written[0].outputBytes, 5);
		assert.equal(written[0].truncated, true);
		assert.equal(written[0].tokens, 7);
		assert.ok(written[0].durationMs >= 0);
	});

	it("records absent model facts and a worker session with no project context", async () => {
		const { handlers, ctx } = harness({
			systemPrompt: "worker prompt without context files",
			model: undefined,
			thinkingLevel: undefined,
		});
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls -R ." } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written[0].projectContext, false);
		assert.equal(written[0].model, null);
		assert.equal(written[0].thinkingLevel, null);
		assert.deepEqual(written[0].classes, ["bounds.ls-recursive-uncapped", "form.ls-recursive"]);
	});

	it("binds session facts to each call when the live context changes", async () => {
		const { handlers, ctx } = harness({ sessionId: "session-1" });
		const next = {
			...ctx,
			cwd: "/other",
			model: { provider: "anthropic", id: "claude-opus" },
			thinkingLevel: "low",
			sessionManager: { getSessionId: () => "session-2" },
			getSystemPrompt: () => "prompt without project context",
		};
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, next);
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, next);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c2", content: [], isError: false }, next);
		await handlers.get("session_shutdown")!({}, next);
		const written = await records(dir);
		assert.deepEqual(
			written.map((entry) => [entry.session, entry.cwd, entry.model, entry.thinkingLevel, entry.projectContext]),
			[
				["session-1", "/work", "xai/grok-4.6", "high", true],
				["session-2", "/other", "anthropic/claude-opus", "low", false],
			],
		);
	});

	it("stores no input for a tool without a declared capture", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_call")!({ toolName: "read", toolCallId: "c9", input: { path: "/secret/file" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "read", toolCallId: "c9", content: [], isError: false }, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].captured, undefined);
		assert.equal(JSON.stringify(written[0]).includes("/secret/file"), false);
	});

	it("records a blocked call from its execution-end outcome", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "blocked", input: { command: "cat notes.md" } },
			ctx,
		);
		await handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "blocked",
				result: { content: [{ type: "text", text: "blocked by policy" }] },
				isError: true,
			},
			ctx,
		);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].callId, "blocked");
		assert.equal(written[0].error, true);
		assert.equal(written[0].outputBytes, 17);
		assert.equal(JSON.stringify(written[0]).includes("blocked by policy"), false);
	});

	it("accepts no calls after session shutdown closes observation", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("session_shutdown")!({}, ctx);
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "late", input: { command: "cat notes.md" } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "late", content: [], isError: false }, ctx);
		await assert.rejects(() => readdir(dir));
	});

	it("ignores a result whose call was never seen", async () => {
		const { handlers, ctx } = harness();
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "unknown", content: [] }, ctx);
		await assert.rejects(() => readdir(dir));
	});

	it("stops recording after a failure and never throws into the call", async () => {
		const { handlers, ctx } = harness();
		const broken = {
			...ctx,
			sessionManager: {
				getSessionId: () => {
					throw new Error("session gone");
				},
			},
		};
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			assert.equal(
				await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, broken),
				undefined,
			);
			await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } }, ctx);
			await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c2", content: [] }, ctx);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /\[policy\] recording stopped/);
		await assert.rejects(() => readdir(dir));
	});

	it("contains a thrown value and a warning channel that both throw", async () => {
		const { handlers, ctx } = harness();
		const hostile = Object.create(null);
		Object.defineProperty(hostile, Symbol.toPrimitive, {
			value: () => {
				throw new Error("conversion failed");
			},
		});
		const broken = {
			...ctx,
			sessionManager: {
				getSessionId: () => {
					throw hostile;
				},
			},
		};
		const original = console.warn;
		console.warn = () => {
			throw new Error("warning failed");
		};
		try {
			assert.equal(
				await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls" } }, broken),
				undefined,
			);
		} finally {
			console.warn = original;
		}
	});
});

describe("notice mode", () => {
	it("shows one flag per flagged call, records it, and returns nothing", async () => {
		const run = harness({ policyMode: "notice" });
		const result = await runBash(run, "c1", "cat notes.md");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(result, undefined, "notice mode must not patch the tool result");
		assert.equal(run.notifications.length, 1);
		assert.match(run.notifications[0].message, /^\[policy\] routing\.cat-read$/);
		assert.equal(run.notifications[0].type, "warning");
		const written = await records(dir);
		assert.equal(written[0].policyMode, "notice");
		assert.equal(written[0].notified, true);
		assert.equal(written[0].annotated, undefined);
	});

	it("shows nothing for a call that matched no rule", async () => {
		const run = harness({ policyMode: "notice" });
		await runBash(run, "c1", "rg -n pattern src/");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.deepEqual(run.notifications, []);
		assert.equal((await records(dir))[0].notified, undefined);
	});

	it("shows nothing outside the terminal, where the notice reaches nobody", async () => {
		const run = harness({ policyMode: "notice", ctxMode: "print" });
		await runBash(run, "c1", "cat notes.md");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.deepEqual(run.notifications, []);
		const written = await records(dir);
		assert.equal(written[0].policyMode, "notice");
		assert.equal(written[0].notified, undefined);
	});
});

describe("annotate mode", () => {
	const MANY = [
		"cat a.txt",
		"cat b.json | jq .",
		"sed -n '1,2p' f.ts",
		"python3 -c \"open('x').read()\"",
		"ls | grep x",
		"grep -n p f.ts",
		"find .",
		"ls -R .",
		"du -sh x",
		"env | grep P",
		"find . | sort | head -2",
	].join("; ");

	it("appends one guidance line after the tool output", async () => {
		const run = harness({ policyMode: "annotate" });
		const patch = (await runBash(run, "c1", "cat notes.md", {
			content: [{ type: "text", text: "file body" }],
		})) as { content: { type: string; text: string }[] };
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(patch.content.length, 2);
		assert.deepEqual(patch.content[0], { type: "text", text: "file body" });
		assert.equal(patch.content[1].text, "[policy] Use the read tool for file contents.");
		const written = await records(dir);
		assert.equal(written[0].policyMode, "annotate");
		assert.equal(written[0].annotated, true);
		assert.equal(written[0].annotationBytes, patch.content[1].text.length);
		assert.equal(written[0].notified, undefined);
		assert.equal(written[0].outputBytes, 9, "the appended line is not tool output");
	});

	it("annotates one rule id once per session", async () => {
		const run = harness({ policyMode: "annotate" });
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		assert.equal(await runBash(run, "c2", "cat other.md"), undefined);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const written = await records(dir);
		assert.deepEqual(
			written.map((entry) => entry.annotated),
			[true, undefined],
		);
	});

	it("annotates the same rule id again in a later session", async () => {
		const run = harness({ policyMode: "annotate" });
		const next = { ...run.ctx, sessionManager: { getSessionId: () => "session-2" } };
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c2", input: { command: "cat notes.md" } },
			next,
		);
		const patch = await run.handlers.get("tool_result")!(
			{ toolName: "bash", toolCallId: "c2", content: [], isError: false },
			next,
		);
		assert.notEqual(patch, undefined);
	});

	it("keeps annotation history when a session returns after another session", async () => {
		const run = harness({ policyMode: "annotate" });
		const first = run.ctx;
		const second = { ...run.ctx, sessionManager: { getSessionId: () => "session-2" } };
		assert.notEqual(await runBash(run, "c1", "cat notes.md"), undefined);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c2", input: { command: "cat notes.md" } },
			second,
		);
		assert.notEqual(
			await run.handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "c2", content: [], isError: false },
				second,
			),
			undefined,
		);
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c3", input: { command: "cat notes.md" } },
			first,
		);
		assert.equal(
			await run.handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "c3", content: [], isError: false },
				first,
			),
			undefined,
			"session-1 history survives the session-2 visit",
		);
	});

	it("withholds the mechanism effect when record admission fails", async () => {
		await writeFile(dir, "");
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const run = harness({ policyMode: "annotate" });
			assert.notEqual(
				await runBash(run, "c1", "cat notes.md"),
				undefined,
				"the first patch is decided before the async store failure",
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(await runBash(run, "c2", "cat notes.md"), undefined, "no effect without its record");
			assert.deepEqual(run.notifications, []);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.filter((warning) => /recording stopped for this session/.test(warning)).length, 1);
		assert.equal(warnings.filter((warning) => /agent rules ignored/.test(warning)).length, 1);
	});

	it("leaves a failed call unchanged", async () => {
		const run = harness({ policyMode: "annotate" });
		const patch = await runBash(run, "c1", "cat missing.md", {
			content: [{ type: "text", text: "No such file" }],
			isError: true,
		});
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal(patch, undefined);
		const written = await records(dir);
		assert.equal(written[0].error, true);
		assert.equal(written[0].annotated, undefined);
	});

	it("leaves a call that matched no rule unchanged", async () => {
		const run = harness({ policyMode: "annotate" });
		assert.equal(await runBash(run, "c1", "rg -n pattern src/"), undefined);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal((await records(dir))[0].annotated, undefined);
	});

	it("keeps one annotation inside the byte cap and defers the rest", async () => {
		const run = harness({ policyMode: "annotate" });
		const first = (await runBash(run, "c1", MANY)) as { content: { text: string }[] };
		const text = first.content.at(-1)!.text;
		assert.ok(Buffer.byteLength(text, "utf8") <= 512, `annotation was ${text.length} bytes`);
		const second = await runBash(run, "c2", MANY);
		assert.notEqual(second, undefined, "ids left outside the cap stay available");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
	});

	it("shows the operator nothing", async () => {
		const run = harness({ policyMode: "annotate" });
		await runBash(run, "c1", "cat notes.md");
		assert.deepEqual(run.notifications, []);
	});
});

describe("agent rule mechanisms", () => {
	it("records a matching agent class", async () => {
		await seedRule();
		const run = harness();
		await runBash(run, "c1", "git push --force origin main");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.deepEqual((await records(dir))[0].classes, ["agent.no-force-push"]);
	});

	it("annotates an active agent rule instead of blocking it in enforce mode", async () => {
		await seedRule();
		const run = harness({ policyMode: "enforce" });
		const call = await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "git push --force origin main" } },
			run.ctx,
		);
		assert.equal(call, undefined);
		const patch = (await run.handlers.get("tool_result")!(
			{ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false },
			run.ctx,
		)) as { content: Array<{ text: string }> };
		assert.equal(patch.content.at(-1)?.text, "[policy] Do not force push this branch.");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const [written] = await records(dir);
		assert.equal(written.policyMode, "enforce");
		assert.equal(written.blocked, undefined);
		assert.equal(written.annotated, true);
	});

	it("does not annotate a scoped-out active rule but still records its class", async () => {
		await seedRule({ scope: { providers: ["anthropic"] } });
		const run = harness({ policyMode: "annotate" });
		assert.equal(await runBash(run, "c1", "git push --force origin main"), undefined);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const [written] = await records(dir);
		assert.deepEqual(written.classes, ["agent.no-force-push"]);
		assert.equal(written.annotated, undefined);
		assert.equal(written.blocked, undefined);
	});

	it("blocks a promoted agent rule with its note", async () => {
		await seedRule({ state: "promoted" });
		const run = harness({ policyMode: "enforce" });
		const result = (await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "git push --force origin main" } },
			run.ctx,
		)) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.equal(result.reason, "[policy] Do not force push this branch.");
		await run.handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				result: { content: [{ type: "text", text: result.reason }] },
				isError: true,
			},
			run.ctx,
		);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal((await records(dir))[0].blocked, true);
	});

	it("does not block a scoped-out promoted rule but still records its class", async () => {
		await seedRule({ state: "promoted", scope: { providers: ["anthropic"] } });
		const run = harness({ policyMode: "enforce" });
		const preflight = await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "git push --force origin main" } },
			run.ctx,
		);
		assert.equal(preflight, undefined);
		assert.equal(
			await run.handlers.get("tool_result")!(
				{ toolName: "bash", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false },
				run.ctx,
			),
			undefined,
		);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const [written] = await records(dir);
		assert.deepEqual(written.classes, ["agent.no-force-push"]);
		assert.equal(written.blocked, undefined);
		assert.equal(written.annotated, undefined);
	});

	it("still blocks a built-in class alongside an active agent class", async () => {
		await seedRule({
			slug: "cat-shape",
			note: "Custom cat guidance.",
			match: { tool: "bash", command: "cat" },
		});
		const run = harness({ policyMode: "enforce" });
		const result = (await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			run.ctx,
		)) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.match(result.reason, /read tool/);
		assert.doesNotMatch(result.reason, /Custom cat guidance/);
	});
});

describe("agent rule tools", () => {
	it("adds an attributed active rule and refuses a duplicate", async () => {
		const run = harness();
		const params = {
			slug: "review-force",
			note: "Use a reviewed push.",
			match: { tool: "bash", command: "git", flags: ["force"] },
			suggest: { command: "git", flags: ["force-with-lease"] },
		};
		assert.match(await callTool(run, "policy_rule_add", params), /agent\.review-force/);
		assert.match(await callTool(run, "policy_rule_add", params), /already exists/);
		const [added] = AgentRules.load(dir).list();
		assert.equal(added.version, SCHEMA_VERSION);
		assert.equal(added.state, "active");
		assert.deepEqual(added.suggest, params.suggest);
		assert.equal(added.model, "xai/grok-4.6");
		assert.equal(added.session, "session-1");
	});

	it("refuses a suggested form matched by an active rule and allows an unflagged form", async () => {
		const run = harness();
		assert.match(
			await callTool(run, "policy_rule_add", {
				slug: "flag-unsafe",
				note: "Use another form.",
				match: { tool: "bash", command: "unsafe" },
			}),
			/agent\.flag-unsafe/,
		);
		assert.match(
			await callTool(run, "policy_rule_add", {
				slug: "bad-suggestion",
				note: "Use unsafe instead.",
				match: { tool: "bash", command: "danger" },
				suggest: { command: "unsafe" },
			}),
			/agent\.flag-unsafe/,
		);
		assert.match(
			await callTool(run, "policy_rule_add", {
				slug: "good-suggestion",
				note: "Use safe instead.",
				match: { tool: "bash", command: "danger" },
				suggest: { command: "safe" },
			}),
			/agent\.good-suggestion/,
		);
		assert.equal(AgentRules.load(dir).get("bad-suggestion"), undefined);
		assert.deepEqual(AgentRules.load(dir).get("good-suggestion")?.suggest, { command: "safe" });
	});

	it("refuses bad rule shapes and a missing model", async () => {
		const run = harness();
		assert.match(
			await callTool(run, "policy_rule_add", {
				slug: "bad-match",
				note: "Bad match should fail.",
				match: { tool: "bash", command: "git", regex: "push" },
			}),
			/unknown key/,
		);
		assert.match(
			await callTool(run, "policy_rule_add", {
				slug: "bad-suggest",
				note: "Bad suggestion should fail.",
				match: { tool: "bash", command: "git" },
				suggest: { command: "safe", operands: ["path"] },
			}),
			/suggest has unknown key/,
		);
		const noModel = { ...run.ctx, model: undefined };
		assert.equal(
			await callTool(
				run,
				"policy_rule_add",
				{ slug: "no-model", note: "Needs attribution.", match: { tool: "bash", command: "git" } },
				noModel,
			),
			"cannot attribute a rule without a model",
		);
	});

	it("lists every seeded field in bounded text", async () => {
		const seeded = await seedRule({ suggest: { command: "printf" }, scope: { providers: ["xai"] } });
		const run = harness();
		const text = await callTool(run, "policy_rule_list", {});
		for (const value of [
			seeded.slug,
			seeded.state,
			seeded.note,
			JSON.stringify(seeded.match),
			JSON.stringify(seeded.suggest),
			JSON.stringify(seeded.scope),
			seeded.model,
			seeded.session,
			seeded.at,
		]) {
			assert.ok(text.includes(value));
		}
		assert.match(text, /fires: 0/);
		assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024);
	});

	it("lists a firing after its matching record lands in the store", async () => {
		await seedRule();
		const run = harness();
		await runBash(run, "c1", "git push --force origin main");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const text = await callTool(run, "policy_rule_list", {});
		assert.match(text, /slug: no-force-push[\s\S]*fires: 1/);
	});

	it("marks firing counts partial when the store scan reaches its byte bound", async () => {
		await seedRule();
		const daily = join(dir, "2026-01-01.jsonl");
		await writeFile(daily, "{}\n", "utf8");
		await truncate(daily, MAX_FIRE_SCAN_BYTES + 1);
		const run = harness();
		const text = await callTool(run, "policy_rule_list", {});
		assert.ok(text.endsWith("firing counts partial: store scan exceeded the byte bound"));
	});

	it("rechecks the suggested form before promotion and preserves active posture on refusal", async () => {
		await seedRule({
			slug: "candidate",
			match: { tool: "bash", command: "danger" },
			suggest: { command: "later-safe" },
		});
		await seedRule({ slug: "later-rule", match: { tool: "bash", command: "later-safe" } });
		await seedEvidence("candidate", 5, 3);
		const run = harness();
		const text = await callTool(run, "policy_rule_set_state", { slug: "candidate", state: "promoted" });
		assert.match(text, /agent\.later-rule/);
		assert.equal(AgentRules.load(dir).get("candidate")?.state, "active");
	});

	it("promotes with a passing measured warrant and records tool origin", async () => {
		await seedRule({ slug: "warrant-pass", match: { tool: "bash", command: "danger" } });
		await seedEvidence("warrant-pass", 5, 3);
		const run = harness();
		assert.match(
			await callTool(run, "policy_rule_set_state", { slug: "warrant-pass", state: "promoted" }),
			/to promoted/,
		);
		const state = (await registryLines()).find((line) => line.kind === "state" && line.slug === "warrant-pass");
		assert.equal(state?.origin, "tool");
		assert.deepEqual(state?.warrant, passingWarrant);
		assert.equal(AgentRules.load(dir).get("warrant-pass")?.state, "promoted");
	});

	it("refuses promotion without evidence and reports the measured zeroes", async () => {
		await seedRule({ slug: "no-evidence" });
		const run = harness();
		const text = await callTool(run, "policy_rule_set_state", { slug: "no-evidence", state: "promoted" });
		assert.match(text, /warrant fails criteria v1/);
		assert.match(text, /fewer than 5 matching calls \(0\)/);
		assert.match(text, /Measured: 0 matching calls, 0 failures, 0 truncated, scan complete/);
		assert.match(text, /\/policy criteria/);
		assert.equal(AgentRules.load(dir).get("no-evidence")?.state, "active");
	});

	it("refuses a mostly successful 90/10 evidence history", async () => {
		await seedRule({ slug: "mostly-successful" });
		await seedEvidence("mostly-successful", 10, 1);
		const run = harness();
		const text = await callTool(run, "policy_rule_set_state", {
			slug: "mostly-successful",
			state: "promoted",
		});
		assert.match(text, /failures do not outnumber successes \(1 of 10\)/);
		assert.match(text, /Measured: 10 matching calls, 1 failures/);
		assert.equal(AgentRules.load(dir).get("mostly-successful")?.state, "active");
	});

	it("restricts tool promotion in operator mode from either configuration source", async () => {
		const exact =
			'promotion of policy rule "operator-only" is restricted to operator action in promotion mode "operator"; promote with /policy state operator-only promoted';
		for (const overrides of [{ promotionMode: "operator" }, { promotionModeFlag: "operator" }]) {
			await seedRule({ slug: "operator-only" });
			const run = harness(overrides);
			assert.equal(await callTool(run, "policy_rule_set_state", { slug: "operator-only", state: "promoted" }), exact);
			assert.equal(AgentRules.load(dir).get("operator-only")?.state, "active");
			await writeFile(join(dir, RULES_FILE), "", "utf8");
		}
	});

	it("records tool origin for a non-promotion state change", async () => {
		await seedRule({ slug: "tool-disable" });
		const run = harness();
		assert.match(
			await callTool(run, "policy_rule_set_state", { slug: "tool-disable", state: "disabled" }),
			/to disabled/,
		);
		const state = (await registryLines()).find((line) => line.kind === "state" && line.slug === "tool-disable");
		assert.equal(state?.origin, "tool");
		assert.equal(state?.warrant, undefined);
	});

	it("lowers a promoted rule only after operator confirmation", async () => {
		const seeded = await seedRule({ state: "promoted" });
		const run = harness({ confirm: () => true });
		assert.match(await callTool(run, "policy_rule_set_state", { slug: seeded.slug, state: "active" }), /to active/);
		assert.equal(run.confirmations.length, 1);
		assert.match(run.confirmations[0].title, new RegExp(seeded.slug));
		for (const value of [seeded.slug, "promoted", "active", seeded.note]) {
			assert.ok(run.confirmations[0].message.includes(value));
		}
		assert.equal(AgentRules.load(dir).get(seeded.slug)?.state, "active");
	});

	it("refuses to lower a promoted rule without dialog-capable UI", async () => {
		const seeded = await seedRule({ state: "promoted" });
		const run = harness({ hasUI: false, ctxMode: "print" });
		const text = await callTool(run, "policy_rule_set_state", { slug: seeded.slug, state: "disabled" });
		assert.match(text, /print mode/);
		assert.match(text, /requires operator confirmation/);
		assert.deepEqual(run.confirmations, []);
		assert.equal(AgentRules.load(dir).get(seeded.slug)?.state, "promoted");
	});

	it("reports an operator-declined lowering without changing state", async () => {
		const seeded = await seedRule({ state: "promoted" });
		const run = harness({ confirm: () => false });
		assert.match(
			await callTool(run, "policy_rule_set_state", { slug: seeded.slug, state: "discarded" }),
			/declined by the operator/,
		);
		assert.equal(AgentRules.load(dir).get(seeded.slug)?.state, "promoted");
	});
});

describe("/policy command", () => {
	it("completes verbs, agent slugs, built-in ids, and states", async () => {
		await seedRule();
		const run = harness();
		const complete = run.commands.get("policy")!.getArgumentCompletions!;
		assert.deepEqual(
			complete("")?.map((item) => item.value),
			["list", "show", "history", "state", "capture", "criteria", "mode", "help"],
		);
		assert.deepEqual(
			complete("show no-")?.map((item) => item.value),
			["show no-force-push"],
		);
		assert.deepEqual(
			complete("show routing.cat-")?.map((item) => item.value),
			["show routing.cat-read", "show routing.cat-pipe"],
		);
		assert.deepEqual(
			complete("history no-")?.map((item) => item.value),
			["history no-force-push"],
		);
		assert.equal(complete("history routing.cat-"), null);
		assert.equal(complete("capture "), null);
		assert.equal(complete("criteria "), null);
		assert.deepEqual(
			complete("state no-force-push ")?.map((item) => item.value),
			[
				"state no-force-push active",
				"state no-force-push promoted",
				"state no-force-push disabled",
				"state no-force-push discarded",
			],
		);
	});

	it("lists and shows rules with built-in groups and per-model fire evidence", async () => {
		await seedRule();
		await writeFile(
			join(dir, "2026-09-03.jsonl"),
			`${JSON.stringify({ model: "openai/gpt-5", classes: ["agent.no-force-push", "routing.cat-read"] })}\n${JSON.stringify({ model: "anthropic/claude-opus", classes: ["agent.no-force-push"] })}\n`,
		);
		const run = harness();
		await callCommand(run, "list");
		assert.match(run.notifications.at(-1)?.message ?? "", /BUILT-IN GROUPS/);
		for (const group of ["routing", "form", "bounds"]) {
			assert.match(run.notifications.at(-1)?.message ?? "", new RegExp(`^${group} \\|`, "m"));
		}
		await callCommand(run, "show no-force-push");
		const agentText = run.notifications.at(-1)?.message ?? "";
		assert.match(agentText, /fires by model:/);
		assert.match(agentText, /openai\/gpt-5: 1/);
		assert.match(agentText, /anthropic\/claude-opus: 1/);
		await callCommand(run, "show routing.cat-read");
		assert.match(run.notifications.at(-1)?.message ?? "", /Use the read tool for file contents/);
		assert.match(run.notifications.at(-1)?.message ?? "", /openai\/gpt-5: 1/);
	});

	it("routes direct state changes through the registry and confirms demote and discard", async () => {
		await seedRule();
		const run = harness({ confirm: () => true });
		await callCommand(run, "state no-force-push promoted");
		assert.equal(AgentRules.load(dir).get("no-force-push")?.state, "promoted");
		assert.equal(run.confirmations.length, 0);
		await callCommand(run, "state no-force-push active");
		assert.match(run.confirmations.at(-1)?.title ?? "", /Demote promoted policy rule/);
		assert.equal(AgentRules.load(dir).get("no-force-push")?.state, "active");
		await callCommand(run, "state no-force-push discarded");
		assert.match(run.confirmations.at(-1)?.title ?? "", /Discard policy rule/);
		assert.equal(AgentRules.load(dir).get("no-force-push")?.state, "discarded");
	});

	it("lets the operator promote with a failing warrant and records command origin", async () => {
		await seedRule({ slug: "operator-promote" });
		const run = harness({ promotionMode: "operator" });
		await callCommand(run, "state operator-promote promoted");
		assert.match(run.notifications.at(-1)?.message ?? "", /to promoted/);
		const state = (await registryLines()).find((line) => line.kind === "state" && line.slug === "operator-promote");
		assert.equal(state?.origin, "command");
		assert.deepEqual(state?.warrant, {
			criteria: 1,
			fires: 0,
			errors: 0,
			errorKinds: { timeout: 0, aborted: 0, other: 0 },
			truncated: 0,
			partial: false,
			pass: false,
		});
		assert.equal(AgentRules.load(dir).get("operator-promote")?.state, "promoted");
	});

	it("captures a durable hint and sends its orchestration entry in UI mode", async () => {
		const run = harness({ sessionId: "capture-session" });
		await callCommand(run, "capture prefer bounded repository searches");
		const capture = (await registryLines()).find((line) => line.kind === "capture");
		assert.equal(capture?.hint, "prefer bounded repository searches");
		assert.equal(capture?.session, "capture-session");
		assert.equal(typeof capture?.at, "string");
		assert.match(run.notifications[0]?.message ?? "", /^captured: prefer bounded repository searches/m);
		assert.equal(run.messages.length, 1);
		assert.equal(run.messages[0].customType, "policy-capture");
		assert.equal(run.messages[0].display, true);
		assert.deepEqual(run.messages[0].options, { triggerTurn: true, deliverAs: "steer" });
		assert.deepEqual(run.messages[0].details, {
			hint: capture?.hint,
			session: capture?.session,
			at: capture?.at,
		});
		assert.match(run.messages[0].content, /policy_rule_add/);
		assert.match(run.messages[0].content, /separate clean-context worker/);
	});

	it("rejects empty, overlong, and multiline capture hints", async () => {
		const run = harness();
		await callCommand(run, "capture");
		await callCommand(run, `capture ${"x".repeat(201)}`);
		await callCommand(run, "capture first\nsecond");
		assert.deepEqual(
			run.notifications.map((notification) => notification.type),
			["error", "error", "error"],
		);
		assert.match(run.notifications[0].message, /Usage: \/policy capture/);
		assert.match(run.notifications[1].message, /exceeds 200 UTF-8 bytes/);
		assert.match(run.notifications[2].message, /must not contain a newline/);
		await assert.rejects(() => readFile(join(dir, RULES_FILE), "utf8"));
	});

	it("prints the criteria source and state history audit details", async () => {
		const legacy = {
			kind: "state",
			slug: "history-rule",
			state: "active",
			model: "xai/grok-4.6",
			session: "legacy-session",
			at: "2026-09-01T07:00:00.000Z",
		};
		const failedWarrant = {
			criteria: 1,
			fires: 0,
			errors: 0,
			errorKinds: { timeout: 0, aborted: 0, other: 0 },
			truncated: 0,
			partial: false,
			pass: false,
		};
		assert.equal(await appendLine(dir, JSON.stringify(legacy)), null);
		assert.equal(
			await appendLine(
				dir,
				JSON.stringify({
					kind: "state",
					slug: "history-rule",
					state: "promoted",
					model: "xai/grok-4.6",
					session: "current-session",
					at: "2026-09-02T07:00:00.000Z",
					origin: "command",
					warrant: failedWarrant,
				}),
			),
			null,
		);
		const run = harness();
		await callCommand(run, "criteria");
		assert.ok((run.notifications.at(-1)?.message ?? "").includes(PROMOTION_CRITERIA_SOURCE));
		await callCommand(run, "history agent.history-rule");
		const history = run.notifications.at(-1)?.message ?? "";
		assert.match(history, /origin: unknown/);
		assert.match(history, /origin: command/);
		assert.match(history, /warrant: criteria v1 fail · 0 fires · 0 errors · 0 truncated · scan complete/);
	});

	it("supports every text verb with no UI and refuses confirmation-gated changes", async () => {
		await seedRule();
		const run = harness({ hasUI: false, ctxMode: "json", policyMode: "notice" });
		await callCommand(run, "list");
		await callCommand(run, "show no-force-push");
		await callCommand(run, "mode");
		await callCommand(run, "help");
		await callCommand(run, "state no-force-push promoted");
		await callCommand(run, "history no-force-push");
		await callCommand(run, "criteria");
		await callCommand(run, "capture remember this command shape");
		assert.equal(run.entries.length, 8);
		assert.match(JSON.stringify(run.entries[0].data), /BUILT-IN GROUPS/);
		assert.match(JSON.stringify(run.entries[1].data), /fires by model/);
		assert.match(JSON.stringify(run.entries[2].data), /PI_POLICY_MODE=notice/);
		assert.match(JSON.stringify(run.entries[2].data), /original mode/);
		assert.match(JSON.stringify(run.entries[3].data), /\/policy list/);
		assert.match(JSON.stringify(run.entries[4].data), /to promoted/);
		assert.match(JSON.stringify(run.entries[5].data), /origin: command/);
		assert.ok(JSON.stringify(run.entries[6].data).includes(PROMOTION_CRITERIA_SOURCE));
		assert.match(JSON.stringify(run.entries[7].data), /captured: remember this command shape/);
		await assert.rejects(() => callCommand(run, "state no-force-push discarded"), /operator confirmation/);
		assert.equal(AgentRules.load(dir).get("no-force-push")?.state, "promoted");
	});

	it("fails bare invocation without a dialog-capable TUI and names all text verbs", async () => {
		for (const ctxMode of ["print", "tui"]) {
			const run = harness({ hasUI: false, ctxMode });
			await assert.rejects(
				() => callCommand(run, ""),
				(error: Error) => {
					for (const verb of ["list", "show", "history", "state", "capture", "criteria", "mode", "help"]) {
						assert.match(error.message, new RegExp(`/policy ${verb}`));
					}
					return true;
				},
			);
		}
	});

	it("keeps command failures outside the per-call fail-open boundary", async () => {
		const run = harness();
		await callCommand(run, "show missing-rule");
		assert.equal(run.notifications.at(-1)?.type, "error");
		await runBash(run, "after-command-error", "cat notes.md");
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		assert.equal((await records(dir)).length, 1);
	});

	it("drafts from Activity through sendUserMessage with only the redacted command", async () => {
		const selected = {
			at: "2026-09-03T12:00:00.000Z",
			model: "openai/gpt-5",
			thinkingLevel: "high",
			tool: "bash",
			classes: ["bounds.false-cap"],
			blocked: true,
			error: true,
			captured: "find [REDACTED] | sort | head",
			policyMode: "enforce",
			session: "observed-session",
		};
		const result = {
			view: "activity",
			filter: "",
			expandedGroups: [],
			action: { kind: "draft", record: selected },
		};
		const idle = harness({ customResults: [result] });
		await callCommand(idle, "");
		assert.equal(idle.messages.length, 1);
		assert.equal(idle.messages[0].options, undefined);
		assert.match(idle.messages[0].content, /policy_rule_add/);
		assert.match(idle.messages[0].content, /find \[REDACTED\] \| sort \| head/);

		const busy = harness({ customResults: [result], isIdle: false });
		await callCommand(busy, "");
		assert.deepEqual(busy.messages[0].options, { deliverAs: "followUp" });
		assert.match(busy.notifications.at(-1)?.message ?? "", /Queued/);
	});
});

describe("mode configuration", () => {
	it("uses the session flag instead of the environment in both directions", async () => {
		const enforcing = harness({ policyMode: "observe", policyModeFlag: "enforce" });
		const blocked = (await enforcing.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "enforce", input: { command: "cat notes.md" } },
			enforcing.ctx,
		)) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.equal(blocked.reason, "[policy] Use the read tool for file contents.");
		await enforcing.handlers.get("session_shutdown")!({}, enforcing.ctx);

		const observing = harness({ policyMode: "enforce", policyModeFlag: "observe" });
		assert.equal(
			await observing.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "observe", input: { command: "cat notes.md" } },
				observing.ctx,
			),
			undefined,
		);
		await observing.handlers.get("session_shutdown")!({}, observing.ctx);
	});

	it("falls back to the environment and then to observe when the flag is absent", async () => {
		const environment = harness({ policyMode: "enforce" });
		await callCommand(environment, "mode");
		assert.match(environment.notifications.at(-1)?.message ?? "", /active mode: enforce/);
		assert.match(environment.notifications.at(-1)?.message ?? "", /source: PI_POLICY_MODE=enforce/);

		const defaulted = harness();
		await callCommand(defaulted, "mode");
		assert.match(defaulted.notifications.at(-1)?.message ?? "", /active mode: observe/);
		assert.match(defaulted.notifications.at(-1)?.message ?? "", /PI_POLICY_MODE is unset/);
	});

	it("reports promotion mode and its environment or flag source", async () => {
		const environment = harness({ promotionMode: "operator" });
		await callCommand(environment, "mode");
		assert.match(environment.notifications.at(-1)?.message ?? "", /promotion mode: operator/);
		assert.match(
			environment.notifications.at(-1)?.message ?? "",
			/promotion source: PI_POLICY_PROMOTION_MODE=operator/,
		);

		const flag = harness({ promotionMode: "agent", promotionModeFlag: "operator" });
		await callCommand(flag, "mode");
		assert.match(flag.notifications.at(-1)?.message ?? "", /promotion mode: operator/);
		assert.match(flag.notifications.at(-1)?.message ?? "", /promotion source: --policy-promotion-mode=operator/);
	});

	it("lets a valid flag override an invalid environment value", async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const run = harness({ policyMode: "block", policyModeFlag: "notice" });
			await callCommand(run, "mode");
			assert.match(run.notifications.at(-1)?.message ?? "", /active mode: notice/);
			assert.match(run.notifications.at(-1)?.message ?? "", /source: --policy-mode=notice/);
		} finally {
			console.warn = original;
		}
		assert.deepEqual(warnings, []);
	});

	it("stops recording once on an unrecognized flag value and never throws", async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let run: ReturnType<typeof harness>;
		try {
			run = harness({ policyMode: "enforce", policyModeFlag: "block" });
			assert.equal(await runBash(run, "c1", "cat notes.md"), undefined);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /--policy-mode must be one of observe, notice, annotate, enforce; received "block"/);
		await assert.rejects(() => readdir(dir));
	});

	it("stops recording once on an unrecognized mode and never throws", async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let run: ReturnType<typeof harness>;
		try {
			run = harness({ policyMode: "block" });
			assert.equal(await runBash(run, "c1", "cat notes.md"), undefined);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /PI_POLICY_MODE must be one of observe, notice, annotate/);
		await assert.rejects(() => readdir(dir));
	});
});

describe("enforce mode", () => {
	it("blocks a flagged call with a reason that names the preferred form", async () => {
		const run = harness({ policyMode: "enforce" });
		const result = await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "find . -name '*.ts'" } },
			run.ctx,
		);
		assert.deepEqual(Object.keys(result as Record<string, unknown>).sort(), ["block", "reason"]);
		assert.equal((result as { block: boolean }).block, true);
		assert.match((result as { reason: string }).reason, /^\[policy\] /);
		assert.match((result as { reason: string }).reason, /rg --files or fd/);
	});

	it("blocks with deduplicated guidance for a multi-class command", async () => {
		const run = harness({ policyMode: "enforce" });
		const result = (await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "find . -name '*.ts'" } },
			run.ctx,
		)) as { reason: string };
		const reason = result.reason;
		assert.equal(reason.split("Bound the output").length - 1, 1, "the shared bound note appears once");
		assert.ok(Buffer.byteLength(reason, "utf8") <= 512, "the reason respects the byte cap");
	});

	it("records the block from the execution-end outcome", async () => {
		const run = harness({ policyMode: "enforce" });
		const reason =
			"[policy] Bound the output with a cap that stops the producer. Use rg for text search, or git grep for tracked text.";
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "grep -rn tarnvel-417 ." } },
			run.ctx,
		);
		await run.handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				result: { content: [{ type: "text", text: reason }] },
				isError: true,
			},
			run.ctx,
		);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].blocked, true);
		assert.equal(written[0].error, true);
		assert.equal(written[0].policyMode, "enforce");
		assert.deepEqual(written[0].classes, ["bounds.grep-recursive-uncapped", "form.grep-file"]);
	});

	it("records an abort that pre-empted the block without the blocked flag", async () => {
		const run = harness({ policyMode: "enforce" });
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "grep -rn tarnvel-417 ." } },
			run.ctx,
		);
		await run.handlers.get("tool_execution_end")!(
			{
				toolName: "bash",
				toolCallId: "c1",
				result: { content: [{ type: "text", text: "Operation aborted" }] },
				isError: true,
			},
			run.ctx,
		);
		await run.handlers.get("session_shutdown")!({}, run.ctx);
		const written = await records(dir);
		assert.equal(written.length, 1);
		assert.equal(written[0].blocked, undefined);
		assert.equal(written[0].error, true);
		assert.equal(written[0].errorKind, "aborted");
	});

	it("fails open when the writer cannot admit a block record", async () => {
		const run = harness({ policyMode: "enforce" });
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			for (let index = 0; index < MAX_QUEUED_RECORDS; index++) {
				const id = `f${index}`;
				void run.handlers.get("tool_call")!(
					{ toolName: "bash", toolCallId: id, input: { command: "rg -n x src/" } },
					run.ctx,
				);
				void run.handlers.get("tool_result")!(
					{ toolName: "bash", toolCallId: id, content: [], isError: false },
					run.ctx,
				);
			}
			const result = await run.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "blocked", input: { command: "cat notes.md" } },
				run.ctx,
			);
			assert.equal(result, undefined, "a full writer fails open instead of blocking without a record");
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /cannot admit a block record/);
	});

	it("does not block an unflagged call", async () => {
		const run = harness({ policyMode: "enforce" });
		assert.equal(
			await run.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "c1", input: { command: "rg -n x src/" } },
				run.ctx,
			),
			undefined,
		);
		assert.equal(
			await run.handlers.get("tool_call")!({ toolName: "read", toolCallId: "c2", input: { path: "/tmp/x" } }, run.ctx),
			undefined,
		);
	});

	it("blocks no call outside enforce mode", async () => {
		for (const policyMode of ["observe", "notice", "annotate"]) {
			const run = harness({ policyMode });
			assert.equal(
				await run.handlers.get("tool_call")!(
					{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
					run.ctx,
				),
				undefined,
				`${policyMode} must not block`,
			);
		}
	});

	it("shows the operator nothing", async () => {
		const run = harness({ policyMode: "enforce" });
		await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			run.ctx,
		);
		assert.deepEqual(run.notifications, []);
	});
});
