import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { classifyCaptured, notesFor } from "./classify.ts";
import registerPolicy from "./index.ts";
import {
	LocalRuleRegistry,
	localRuleGuidance,
	MAX_GUIDANCE_TEXT_BYTES,
	type LocalRuleCandidate,
	type RuleAudit,
} from "./local-rules.ts";
import type { PolicyRecord } from "./record.ts";
import { MAX_QUEUED_RECORDS } from "./store.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

interface Notification {
	message: string;
	type?: string;
}

interface FakeTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ text: string }>;
		details?: Record<string, unknown>;
	}>;
}

function harness(
	overrides: {
		systemPrompt?: string;
		sessionId?: string;
		policyMode?: string;
		policyModeFlag?: string;
		ctxMode?: string;
	} = {},
) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<
		string,
		{
			handler: (args: string, ctx: unknown) => Promise<void>;
			getArgumentCompletions?: (text: string) => AutocompleteItem[] | null;
		}
	>();
	const flags = new Map<string, unknown>();
	const registeredFlags: string[] = [];
	const registeredTools: string[] = [];
	const tools = new Map<string, FakeTool>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerFlag(name: string) {
			registeredFlags.push(name);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand(
			name: string,
			command: {
				handler: (args: string, ctx: unknown) => Promise<void>;
				getArgumentCompletions?: (text: string) => AutocompleteItem[] | null;
			},
		) {
			commands.set(name, command);
		},
		registerTool(tool: FakeTool) {
			registeredTools.push(tool.name);
			tools.set(tool.name, tool);
		},
	};
	if (overrides.policyModeFlag !== undefined) flags.set("policy-mode", overrides.policyModeFlag);
	const notifications: Notification[] = [];
	const ctx = {
		mode: overrides.ctxMode ?? "tui",
		hasUI: true,
		cwd: "/work",
		model: { provider: "test", id: "model" },
		thinkingLevel: "medium",
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async (_title: string, options: string[]) => options[0],
			confirm: async () => true,
		},
		sessionManager: { getSessionId: () => overrides.sessionId ?? "session-1" },
		getSystemPrompt: () => overrides.systemPrompt ?? "base prompt\n\n<project_context>\n\n",
	};
	if (overrides.policyMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = overrides.policyMode;
	registerPolicy(pi as unknown as ExtensionAPI);
	return { handlers, commands, registeredFlags, registeredTools, tools, ctx, notifications };
}

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

async function records(dir: string): Promise<PolicyRecord[]> {
	const files = (await readdir(dir)).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file));
	const lines: PolicyRecord[] = [];
	for (const file of files.sort()) {
		const text = await readFile(join(dir, file), "utf8");
		for (const line of text.trim().split("\n")) {
			if (line) lines.push(JSON.parse(line) as PolicyRecord);
		}
	}
	return lines;
}

let dir: string;
const previousDir = process.env.PI_POLICY_DIR;
const previousMode = process.env.PI_POLICY_MODE;

const localCandidate = (overrides: Partial<LocalRuleCandidate> = {}): LocalRuleCandidate => ({
	slug: "shell.scan",
	note: "Bound scan output.",
	match: { command: "scan" },
	suggest: { command: "scan", flags: ["--limit", "50"] },
	...overrides,
});
const localAudit = (surface: RuleAudit["surface"]): RuleAudit => ({
	at: "2026-09-03T12:00:00.000Z",
	session: "setup-session",
	model: "test/model",
	surface,
});

async function installLocalRule(
	candidate: LocalRuleCandidate = localCandidate(),
	effect: "steer" | "block" = "block",
): Promise<LocalRuleRegistry> {
	const registry = new LocalRuleRegistry(dir);
	const proposal = await registry.proposeUpsert(candidate, "Requested by the operator.", localAudit("agent-tool"));
	await registry.decide(proposal.id, "approved", effect, localAudit("command"));
	return registry;
}

async function executeTool(run: ReturnType<typeof harness>, name: string, params: Record<string, unknown>) {
	return run.tools.get(name)!.execute("tool-1", params, undefined, undefined, run.ctx);
}

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "store");
	process.env.PI_POLICY_DIR = dir;
	delete process.env.PI_POLICY_MODE;
});

afterEach(() => {
	if (previousDir === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previousDir;
	if (previousMode === undefined) delete process.env.PI_POLICY_MODE;
	else process.env.PI_POLICY_MODE = previousMode;
});

describe("policy extension", () => {
	it("registers the mode flag, browser, local-rule tools, and session handlers", () => {
		const { commands, handlers, registeredFlags, registeredTools } = harness();
		assert.deepEqual(registeredFlags, ["policy-mode"]);
		assert.deepEqual(registeredTools, ["policy_propose", "policy_rules"]);
		assert.deepEqual([...commands.keys()], ["policy"]);
		assert.deepEqual([...handlers.keys()].sort(), [
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_execution_end",
			"tool_result",
		]);
	});

	it("does no registry work at session start", async () => {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "rules.jsonl"), "broken\n", { mode: 0o600 });
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const run = harness();
			await run.handlers.get("session_start")!({}, run.ctx);
		} finally {
			console.warn = original;
		}
		assert.deepEqual(warnings, []);
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
		assert.equal(written[0].projectContext, true);
		assert.deepEqual(written[0].classes, ["routing.cat-read"]);
		assert.equal(written[0].captured, "cat notes.md");
		assert.equal(written[0].outputBytes, 5);
		assert.equal(written[0].truncated, true);
		assert.equal(written[0].tokens, 7);
		assert.ok(written[0].durationMs >= 0);
	});

	it("records a worker session as carrying no project context", async () => {
		const { handlers, ctx } = harness({ systemPrompt: "worker prompt without context files" });
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "ls -R ." } }, ctx);
		await handlers.get("tool_result")!({ toolName: "bash", toolCallId: "c1", content: [], isError: false }, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		const written = await records(dir);
		assert.equal(written[0].projectContext, false);
		assert.deepEqual(written[0].classes, ["bounds.ls-recursive-uncapped", "form.ls-recursive"]);
	});

	it("binds session facts to each call when the live context changes", async () => {
		const { handlers, ctx } = harness({ sessionId: "session-1" });
		const next = {
			...ctx,
			cwd: "/other",
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
			written.map((entry) => [entry.session, entry.cwd, entry.projectContext]),
			[
				["session-1", "/work", true],
				["session-2", "/other", false],
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
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "blocked", input: { command: "cat notes.md" } }, ctx);
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
		const broken = { ...ctx, sessionManager: { getSessionId: () => { throw new Error("session gone"); } } };
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
		Object.defineProperty(hostile, Symbol.toPrimitive, { value: () => { throw new Error("conversion failed"); } });
		const broken = { ...ctx, sessionManager: { getSessionId: () => { throw hostile; } } };
		const original = console.warn;
		console.warn = () => { throw new Error("warning failed"); };
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
		'python3 -c "open(\'x\').read()"',
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
		assert.equal(
			patch.content[1].text,
			"[policy] Use the read tool for file contents, one call per file: read path=README.md.",
		);
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
		assert.equal(warnings.length, 2);
		assert.ok(warnings.some((warning) => /local rule matching disabled/.test(warning)));
		assert.ok(warnings.some((warning) => /recording stopped for this session/.test(warning)));
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

	it("includes only complete built-in notes at the aggregate byte bound", async () => {
		const run = harness({ policyMode: "annotate" });
		const patch = (await runBash(run, "complete-notes", MANY)) as { content: { text: string }[] };
		const annotation = patch.content.at(-1)!.text;
		let remainder = annotation.slice("[policy] ".length);
		let included = 0;
		for (const note of notesFor("bash", classifyCaptured("bash", MANY))) {
			if (!remainder.startsWith(note)) break;
			remainder = remainder.slice(note.length).trimStart();
			included++;
		}
		assert.ok(included > 0);
		assert.equal(remainder, "", "the aggregate line must not contain a partial built-in note");
	});

	it("shows the operator nothing", async () => {
		const run = harness({ policyMode: "annotate" });
		await runBash(run, "c1", "cat notes.md");
		assert.deepEqual(run.notifications, []);
	});
});

describe("mode configuration", () => {
	it("uses the session flag instead of the environment", async () => {
		const run = harness({ policyMode: "invalid", policyModeFlag: "enforce" });
		const result = await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } },
			run.ctx,
		);
		assert.equal((result as { block: boolean }).block, true);
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
		assert.match(warnings[0], /PI_POLICY_MODE must be one of observe, notice, annotate, enforce/);
		await assert.rejects(() => readdir(dir));
	});
});

describe("/policy command", () => {
	it("lists and shows built-ins and reports the active mode", async () => {
		const run = harness({ policyModeFlag: "notice" });
		const command = run.commands.get("policy")!;
		await command.handler("list", run.ctx);
		await command.handler("show routing.cat-read", run.ctx);
		await command.handler("mode", run.ctx);
		await command.handler("help", run.ctx);
		assert.match(run.notifications[0].message, /BUILT-IN GROUPS/);
		assert.match(run.notifications[1].message, /id: routing\.cat-read/);
		assert.match(run.notifications[2].message, /active mode: notice/);
		assert.match(run.notifications[2].message, /--policy-mode=notice/);
		assert.match(run.notifications[3].message, /\/policy show <ref>/);
	});

	it("shows whether a retained rule scope matches the current session", async () => {
		await installLocalRule(localCandidate({ scope: { modelProviders: ["other-provider"] } }));
		const run = harness();
		await run.commands.get("policy")!.handler("show shell.scan", run.ctx);
		assert.match(
			run.notifications.at(-1)?.message ?? "",
			/scope matches this session: no \(modelProviders\)/,
		);
	});

	it("rejects unknown command verbs", async () => {
		for (const verb of ["introduce request", "remove old", "change old active"]) {
			const run = harness();
			await run.commands.get("policy")!.handler(verb, run.ctx);
			assert.equal(run.notifications.at(-1)?.type, "error");
			assert.match(run.notifications.at(-1)?.message ?? "", /Unknown \/policy action/);
		}
	});
});

describe("local rule agent tools", () => {
	it("registers closed schemas with no operator-gate parameters", () => {
		const run = harness();
		const proposalSchema = run.tools.get("policy_propose")!.parameters as {
			anyOf: Array<{ required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }>;
		};
		assert.equal(proposalSchema.anyOf.length, 2);
		for (const arm of proposalSchema.anyOf) assert.equal(arm.additionalProperties, false);
		const upsert = proposalSchema.anyOf.find((arm) => arm.required.includes("note"))!;
		const discard = proposalSchema.anyOf.find((arm) => !arm.required.includes("note"))!;
		assert.ok(upsert.required.includes("match"));
		assert.deepEqual(discard.required.sort(), ["operation", "reason", "slug"]);
		assert.equal((run.tools.get("policy_rules")!.parameters as { additionalProperties: boolean }).additionalProperties, false);
		const scope = upsert.properties.scope as {
			properties: Record<string, unknown>;
			additionalProperties: boolean;
		};
		assert.deepEqual(Object.keys(scope.properties).sort(), ["cwdPrefixes", "modelProviders", "models"]);
		assert.equal(scope.additionalProperties, false);
		assert.equal("providers" in scope.properties, false);
		const propertyNames = new Set(proposalSchema.anyOf.flatMap((arm) => Object.keys(arm.properties)));
		for (const forbidden of ["approve", "reject", "decision", "state", "effect"]) assert.equal(propertyNames.has(forbidden), false);
		const description = run.tools.get("policy_propose")!.description;
		assert.match(description, /modelProviders.*openai-codex/);
		assert.match(description, /models.*openai-codex\/gpt-5\.6-sol/);
		assert.match(description, /cwdPrefixes holds absolute directory paths/);
		assert.match(description, /Scope does not select which command or tool.*match\.command/);
	});

	it("writes an inert proposal with agent-tool audit and lists it with registry health", async () => {
		const run = harness();
		const result = await executeTool(run, "policy_propose", {
			operation: "upsert",
			slug: "shell.scan",
			reason: "Bound large scans.",
			note: "Bound scan output.",
			match: { command: "scan" },
		});
		assert.match(result.content[0].text, /Pending proposal [0-9a-f-]+/);
		const snapshot = await new LocalRuleRegistry(dir).snapshot();
		assert.equal(snapshot.rules.length, 0);
		assert.equal(snapshot.pending[0].audit.surface, "agent-tool");
		const listed = await executeTool(run, "policy_rules", {});
		assert.match(listed.content[0].text, /shell\.scan/);
		assert.match(listed.content[0].text, /registry health: ok/);
	});

	it("rejects oversized rendered guidance before appending a proposal", async () => {
		const run = harness();
		const oversized = localCandidate({
			note: "x".repeat(390),
			suggest: { command: "scan", flags: ["--some-long-option"] },
		});
		const actualBytes = Buffer.byteLength(localRuleGuidance(oversized), "utf8");
		assert.ok(actualBytes > MAX_GUIDANCE_TEXT_BYTES);
		await assert.rejects(
			executeTool(run, "policy_propose", {
				operation: "upsert",
				slug: oversized.slug,
				reason: "Test rendered guidance validation.",
				note: oversized.note,
				match: oversized.match,
				suggest: oversized.suggest,
			}),
			new RegExp(`rendered guidance is ${actualBytes} UTF-8 bytes.*${MAX_GUIDANCE_TEXT_BYTES} bytes`),
		);
		await assert.rejects(() => readdir(dir), /ENOENT/);
	});

	it("returns actionable validation and registry failures", async () => {
		const run = harness();
		await assert.rejects(
			executeTool(run, "policy_propose", {
				operation: "discard",
				slug: "missing.rule",
				reason: "Not needed.",
			}),
			/no retained rule/,
		);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "rules.jsonl"), "broken\n", { mode: 0o600 });
		const broken = harness();
		const listed = await executeTool(broken, "policy_rules", {});
		assert.match(listed.content[0].text, /registry health: unreadable/);
		await assert.rejects(
			executeTool(broken, "policy_propose", {
				operation: "upsert",
				slug: "shell.other",
				reason: "Use a bound.",
				note: "Use a bound.",
				match: { command: "other" },
			}),
			/invalid local rule registry line/,
		);
	});
});

describe("operator command gates", () => {
	it("approves, updates state/effect, rejects, and writes command audit", async () => {
		const run = harness();
		await executeTool(run, "policy_propose", {
			operation: "upsert",
			slug: "shell.scan",
			reason: "Bound scans.",
			note: "Bound scan output.",
			match: { command: "scan" },
		});
		let snapshot = await new LocalRuleRegistry(dir).snapshot();
		const proposalId = snapshot.pending[0].id;
		await run.commands.get("policy")!.handler(`show ${proposalId}`, run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /candidate\.match/);
		await run.commands.get("policy")!.handler(`approve ${proposalId}`, run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /requires/);
		await run.commands.get("policy")!.handler(`approve ${proposalId} steer`, run.ctx);
		await run.commands.get("policy")!.handler("state shell.scan disabled", run.ctx);
		await run.commands.get("policy")!.handler("effect shell.scan block", run.ctx);
		snapshot = await new LocalRuleRegistry(dir).snapshot();
		assert.equal(snapshot.rules[0].state, "disabled");
		assert.equal(snapshot.rules[0].effect, "block");
		assert.equal(snapshot.rules[0].approvedAudit.surface, "command");
		assert.equal(snapshot.rules[0].updatedAudit?.surface, "command");
		await run.commands.get("policy")!.handler("show shell.scan", run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /proposed audit:/);
		assert.match(run.notifications.at(-1)?.message ?? "", /effect: block/);
		const completions = run.commands.get("policy")!.getArgumentCompletions?.("state shell.") ?? [];
		assert.ok(completions.some((item) => item.value === "state shell.scan"));

		await executeTool(run, "policy_propose", {
			operation: "upsert",
			slug: "shell.second",
			reason: "Try another rule.",
			note: "Use another form.",
			match: { command: "second" },
		});
		const second = (await new LocalRuleRegistry(dir).snapshot()).pending[0];
		await run.commands.get("policy")!.handler(`reject ${second.id}`, run.ctx);
		assert.equal((await new LocalRuleRegistry(dir).snapshot()).pending.length, 0);
	});

	it("writes panel audit at action time and refreshes through the panel host", async () => {
		const run = harness();
		await executeTool(run, "policy_propose", {
			operation: "upsert",
			slug: "shell.scan",
			reason: "Bound scans.",
			note: "Bound scan output.",
			match: { command: "scan" },
		});
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as never;
		type Factory = (
			tui: { terminal: { rows: number }; requestRender(): void },
			themeValue: never,
			keybindings: unknown,
			done: (value: unknown) => void,
		) => { handleInput(data: string): void };
		Object.assign(run.ctx.ui, {
			custom: async (factory: Factory) => {
				let result: unknown;
				const component = factory(
					{ terminal: { rows: 30 }, requestRender() {} },
					theme,
					{},
					(value) => {
						result = value;
					},
				);
				component.handleInput("v");
				component.handleInput("a");
				await new Promise((resolve) => setTimeout(resolve, 5));
				component.handleInput("\x1b");
				return result;
			},
		});
		await run.commands.get("policy")!.handler("", run.ctx);
		const snapshot = await new LocalRuleRegistry(dir).snapshot();
		assert.equal(snapshot.rules[0].effect, "steer");
		assert.equal(snapshot.rules[0].approvedAudit.surface, "panel");
	});

	it("enforces discard approval syntax and actionable unknown/usage errors", async () => {
		await installLocalRule();
		const run = harness();
		await executeTool(run, "policy_propose", {
			operation: "discard",
			slug: "shell.scan",
			reason: "No longer useful.",
		});
		const proposal = (await new LocalRuleRegistry(dir).snapshot()).pending[0];
		await run.commands.get("policy")!.handler(`approve ${proposal.id} block`, run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /forbids an effect/);
		await run.commands.get("policy")!.handler(`approve ${proposal.id}`, run.ctx);
		assert.equal((await new LocalRuleRegistry(dir).snapshot()).discarded[0].state, "discarded");
		await run.commands.get("policy")!.handler("reject 00000000-0000-4000-8000-000000000001", run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /no pending proposal/);
		await run.commands.get("policy")!.handler("effect only-one-arg", run.ctx);
		assert.match(run.notifications.at(-1)?.message ?? "", /Usage:/);
	});
});

describe("local rule mode integration", () => {
	it("records local slugs in observe and flags them in notice", async () => {
		await installLocalRule();
		const observed = harness({ policyMode: "observe" });
		await runBash(observed, "observe-local", "scan src");
		await observed.handlers.get("session_shutdown")!({}, observed.ctx);
		assert.deepEqual((await records(dir)).at(-1)?.classes, ["shell.scan"]);

		const noticed = harness({ policyMode: "notice" });
		await runBash(noticed, "notice-local", "scan src");
		assert.match(noticed.notifications[0].message, /shell\.scan/);
	});

	it("annotates local guidance once per session", async () => {
		await installLocalRule(localCandidate(), "steer");
		const run = harness({ policyMode: "annotate" });
		const first = (await runBash(run, "local-1", "scan src")) as { content: Array<{ text: string }> };
		assert.match(first.content.at(-1)!.text, /Bound scan output\. Suggested form: scan --limit 50\./);
		assert.equal(await runBash(run, "local-2", "scan tests"), undefined);
	});

	it("delivers complete local guidance just inside the proposal bound", async () => {
		const suffix = localRuleGuidance({ note: "", suggest: { command: "scan" } });
		const note = "x".repeat(MAX_GUIDANCE_TEXT_BYTES - Buffer.byteLength(suffix, "utf8"));
		const edge = localCandidate({
			slug: "shell.edge",
			note,
			match: { command: "edge" },
			suggest: { command: "scan" },
		});
		const guidance = localRuleGuidance(edge);
		assert.equal(Buffer.byteLength(guidance, "utf8"), MAX_GUIDANCE_TEXT_BYTES);
		await installLocalRule(edge, "block");

		const enforcing = harness({ policyMode: "enforce" });
		const blocked = (await enforcing.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "edge-block", input: { command: "edge" } },
			enforcing.ctx,
		)) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.equal(blocked.reason, `[policy] ${guidance}`);
		await enforcing.handlers.get("session_shutdown")!({}, enforcing.ctx);

		const annotating = harness({ policyMode: "annotate" });
		const patch = (await runBash(annotating, "edge-annotate", "edge")) as { content: Array<{ text: string }> };
		assert.equal(patch.content.at(-1)?.text, `[policy] ${guidance}`);
	});

	it("blocks local block rules but annotates and never blocks steer rules in enforce", async () => {
		await installLocalRule();
		const blocked = harness({ policyMode: "enforce" });
		const result = (await blocked.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "local-block", input: { command: "scan src" } },
			blocked.ctx,
		)) as { block: boolean; reason: string };
		assert.equal(result.block, true);
		assert.match(result.reason, /Bound scan output/);
		await blocked.handlers.get("tool_execution_end")!(
			{ toolCallId: "local-block", result: { content: [{ type: "text", text: result.reason }] }, isError: true },
			blocked.ctx,
		);
		await blocked.handlers.get("session_shutdown")!({}, blocked.ctx);
		assert.equal((await records(dir)).at(-1)?.blocked, true);

		const registry = new LocalRuleRegistry(dir);
		await registry.setEffect("shell.scan", "steer", localAudit("command"));
		const steering = harness({ policyMode: "enforce" });
		assert.equal(
			await steering.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "local-steer", input: { command: "scan src" } },
				steering.ctx,
			),
			undefined,
		);
		const patch = (await steering.handlers.get("tool_result")!(
			{ toolName: "bash", toolCallId: "local-steer", content: [], isError: false },
			steering.ctx,
		)) as { content: Array<{ text: string }> };
		assert.match(patch.content[0].text, /Bound scan output/);
	});

	it("keeps pending, disabled, and discarded entries inert", async () => {
		const registry = new LocalRuleRegistry(dir);
		await registry.proposeUpsert(localCandidate(), "Pending only.", localAudit("agent-tool"));
		let run = harness({ policyMode: "enforce" });
		assert.equal(await runBash(run, "pending", "scan src"), undefined);
		const proposal = (await registry.snapshot()).pending[0];
		await registry.decide(proposal.id, "approved", "block", localAudit("command"));
		await registry.setState("shell.scan", "disabled", localAudit("command"));
		run = harness({ policyMode: "annotate" });
		assert.equal(await runBash(run, "disabled", "scan src"), undefined);
		await registry.setState("shell.scan", "discarded", localAudit("command"));
		run = harness({ policyMode: "enforce" });
		assert.equal(await runBash(run, "discarded", "scan src"), undefined);
	});

	it("continues built-in enforcement after one local registry warning", async () => {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "rules.jsonl"), "broken\n", { mode: 0o600 });
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const run = harness({ policyMode: "enforce" });
			const first = (await run.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "builtin-1", input: { command: "cat notes.md" } },
				run.ctx,
			)) as { block: boolean };
			assert.equal(first.block, true);
			await run.handlers.get("tool_call")!(
				{ toolName: "bash", toolCallId: "builtin-2", input: { command: "cat other.md" } },
				run.ctx,
			);
		} finally {
			console.warn = original;
		}
		assert.equal(warnings.filter((warning) => /local rule matching disabled/.test(warning)).length, 1);
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
		assert.match((result as { reason: string }).reason, /rg --files, fd, or git ls-files/);
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
		const blocked = (await run.handlers.get("tool_call")!(
			{ toolName: "bash", toolCallId: "c1", input: { command: "grep -rn tarnvel-417 ." } },
			run.ctx,
		)) as { reason: string };
		const reason = blocked.reason;
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
			const calls = Array.from({ length: MAX_QUEUED_RECORDS }, (_, index) => `f${index}`);
			await Promise.all(
				calls.map((id) =>
					run.handlers.get("tool_call")!(
						{ toolName: "bash", toolCallId: id, input: { command: "rg -n x src/" } },
						run.ctx,
					),
				),
			);
			await Promise.all(
				calls.map((id) =>
					run.handlers.get("tool_result")!(
						{ toolName: "bash", toolCallId: id, content: [], isError: false },
						run.ctx,
					),
				),
			);
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
			await run.handlers.get("tool_call")!({ toolName: "bash", toolCallId: "c1", input: { command: "rg -n x src/" } }, run.ctx),
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
