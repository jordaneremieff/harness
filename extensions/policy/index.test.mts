import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import registerPolicy from "./index.ts";
import { RULES_FILE, validateRuleEvent, type RuleEvent } from "./local-rules.ts";
import { PolicyProposeParams } from "./tools.ts";
import { PACKAGE_CATALOG } from "./shell-rules.ts";

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
}

class FakePi {
	readonly handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	readonly commands = new Map<
		string,
		{ handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
	>();
	readonly tools = new Map<string, RegisteredTool>();
	readonly flags = new Map<string, unknown>();
	readonly entries: Array<{ customType: string; data: unknown }> = [];

	registerFlag(): void {}
	getFlag(name: string): unknown {
		return this.flags.get(name);
	}
	registerTool(tool: RegisteredTool): void {
		this.tools.set(tool.name, tool);
	}
	appendEntry(customType: string, data: unknown): void {
		this.entries.push({ customType, data });
	}
	registerCommand(
		name: string,
		command: {
			handler: (args: string, ctx: never) => Promise<void>;
			getArgumentCompletions?: (prefix: string) => unknown;
		},
	): void {
		this.commands.set(name, command);
	}
	on(name: string, handler: (event: never, ctx: never) => unknown): void {
		const entries = this.handlers.get(name) ?? [];
		entries.push(handler);
		this.handlers.set(name, entries);
	}
	async emit(name: string, event: unknown, ctx?: unknown): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(name) ?? []) {
			const next = await handler(event as never, ctx as never);
			if (next !== undefined) result = next;
		}
		return result;
	}
}

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
};

function context(notifications: Array<{ message: string; type?: string }>, overrides: Record<string, unknown> = {}) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/work/project",
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "session-1" },
		getSystemPrompt: () => "<project_context>loaded</project_context>",
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async custom<T>(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
			): Promise<T> {
				return new Promise<T>((resolve) => {
					const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve) as {
						handleInput(data: string): void;
					};
					component.handleInput("\u001b");
				});
			},
			async select(): Promise<undefined> {
				return undefined;
			},
			async confirm(): Promise<boolean> {
				return false;
			},
			async input(): Promise<undefined> {
				return undefined;
			},
		},
		...overrides,
	};
}

async function setup(mode = "observe") {
	const dir = join(await mkdtemp(join(tmpdir(), "policy-index-")), "policy");
	const previous = process.env.PI_POLICY_DIR;
	process.env.PI_POLICY_DIR = dir;
	const pi = new FakePi();
	pi.flags.set("policy-mode", mode);
	registerPolicy(pi as never);
	if (previous === undefined) delete process.env.PI_POLICY_DIR;
	else process.env.PI_POLICY_DIR = previous;
	const notifications: Array<{ message: string; type?: string }> = [];
	return { dir, pi, notifications, ctx: context(notifications) };
}

async function storedEvents(dir: string): Promise<RuleEvent[]> {
	return (await readFile(join(dir, RULES_FILE), "utf8"))
		.trim()
		.split("\n")
		.map((line) => validateRuleEvent(JSON.parse(line)));
}

async function telemetry(dir: string): Promise<Array<Record<string, unknown>>> {
	const files = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
	const records: Array<Record<string, unknown>> = [];
	for (const file of files) {
		for (const line of (await readFile(join(dir, file), "utf8")).trim().split("\n")) {
			if (line) records.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return records;
}

async function callTool(tool: RegisteredTool, params: unknown, ctx: unknown): Promise<Record<string, unknown>> {
	return (await tool.execute("tool-id", params, undefined, () => {}, ctx)) as Record<string, unknown>;
}

describe("registration and lazy catalog use", () => {
	it("registers only the unified tools and performs no rule-store I/O at session startup", async () => {
		const { dir, pi, ctx } = await setup();
		assert.deepEqual([...pi.tools.keys()].sort(), ["policy_propose", "policy_rules"]);
		assert.deepEqual([...pi.commands.keys()], ["policy"]);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		await assert.rejects(stat(dir), /ENOENT/);
	});

	it("uses a top-level object proposal schema with closed least-authority variants", () => {
		const schema = JSON.parse(JSON.stringify(PolicyProposeParams)) as {
			type?: unknown;
			anyOf?: Array<{
				required?: string[];
				properties?: Record<string, { const?: unknown }>;
				additionalProperties?: unknown;
			}>;
		};
		assert.equal(schema.type, "object");
		assert.equal(schema.anyOf?.length, 3);
		const arms = schema.anyOf ?? [];
		const byOperation = new Map(arms.map((arm) => [arm.properties?.operation?.const, arm]));
		for (const [operation, required] of [
			["add", ["operation", "id", "reason", "note", "match"]],
			["retire", ["operation", "id", "reason"]],
			["disable", ["operation", "id", "reason"]],
		] as const) {
			const arm = byOperation.get(operation);
			assert.ok(arm, `${operation} proposal arm must exist`);
			assert.equal(arm.additionalProperties, false, `${operation} proposal arm must reject unknown properties`);
			assert.deepEqual(arm.required, required);
		}
		const propertyNames = new Set(arms.flatMap((arm) => Object.keys(arm.properties ?? {})));
		for (const forbidden of ["approve", "reject", "decision", "state", "effect", "enable"]) {
			assert.equal(propertyNames.has(forbidden), false, `${forbidden} must not be exposed`);
		}
		assert.match(JSON.stringify(schema), /"maxLength":80/);
	});

	it("synchronizes the complete package catalog on the first policy use", async () => {
		const { dir, pi, ctx } = await setup();
		await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		const events = await storedEvents(dir);
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "catalog");
		if (events[0].kind === "catalog") {
			assert.deepEqual(
				events[0].rows,
				[...PACKAGE_CATALOG].sort((a, b) => a.id.localeCompare(b.id)),
			);
		}
	});
});

describe("unified tools and command gates", () => {
	it("policy_rules reports record definitions, overrides, proposals, context, and health", async () => {
		const { pi, ctx } = await setup();
		await pi.commands.get("policy")!.handler("effect routing.cat-read steer operator calibration", ctx as never);
		const proposed = await callTool(
			pi.tools.get("policy_propose")!,
			{
				operation: "add",
				id: "local.pending",
				reason: "Inspect this proposal",
				note: "Use a bounded local command.",
				match: { command: "scan" },
			},
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;
		const result = await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		const text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /SESSION CONTEXT/);
		assert.match(text, /model provider: openai-codex/);
		assert.match(text, /routing\.cat-read \| source=package \| domain=tool-call \| matcher=code:routing\.cat-read/);
		assert.match(text, /state=active \| effect=steer \| override reason=operator calibration/);
		assert.match(text, /definition: revision=[0-9a-f]{12} state=active effect=block/);
		assert.match(text, /override audit: command .*session=session-1 model=openai-codex\/gpt-5\.6-sol/);
		assert.match(text, /override against revision: [0-9a-f]{12}/);
		assert.match(text, new RegExp(`${proposalId} \\| add \\| local\\.pending \\| Inspect this proposal`));
		assert.match(text, /PENDING PROPOSALS/);
		assert.match(text, /registry health: degraded=false \| ok/);
	});

	it("agent add remains inert until exact operator approval, then declarative matching joins package dispatch", async () => {
		const { pi, ctx, notifications } = await setup("enforce");
		const propose = pi.tools.get("policy_propose")!;
		const result = await callTool(
			propose,
			{
				operation: "add",
				id: "local.scan",
				reason: "Bound scans",
				note: "Use a bounded scan command.",
				match: { command: "scan", flags: ["--all"], operands: { min: 1 } },
				suggestion: { command: "scan", flags: ["--limit", "50"] },
				scope: { modelProviders: ["openai-codex"], models: ["openai-codex/gpt-5.6-sol"], cwdPrefixes: ["/work"] },
			},
			ctx,
		);
		const proposalId = (result.details as { proposalId: string }).proposalId;
		assert.match((result.content as Array<{ text: string }>)[0].text, /inert until operator approval/);
		assert.equal(
			await pi.emit(
				"tool_call",
				{ toolName: "bash", toolCallId: "before", input: { command: "scan --all target" } },
				ctx,
			),
			undefined,
		);

		await pi.commands.get("policy")!.handler(`approve ${proposalId}`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /requires.*steer\|block/);
		await pi.commands.get("policy")!.handler(`approve ${proposalId} block`, ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Approved add proposal/);
		const blocked = (await pi.emit(
			"tool_call",
			{ toolName: "bash", toolCallId: "after", input: { command: "scan --all target" } },
			ctx,
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason ?? "", /bounded scan/);
	});

	it("the agent can only leave a disable proposal pending", async () => {
		const { pi, ctx } = await setup();
		const result = await callTool(
			pi.tools.get("policy_propose")!,
			{ operation: "disable", id: "routing.cat-read", reason: "Context-specific false positive" },
			ctx,
		);
		const proposalId = (result.details as { proposalId: string }).proposalId;
		const rules = await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		assert.match((rules.content as Array<{ text: string }>)[0].text, new RegExp(proposalId));
	});

	it("requires reasons for every direct change and composes package overrides", async () => {
		const { dir, pi, ctx, notifications } = await setup();
		const command = pi.commands.get("policy")!;
		for (const verb of ["disable routing.cat-read", "enable routing.cat-read", "retire local.missing"] as const) {
			await command.handler(verb, ctx as never);
			assert.match(notifications.at(-1)?.message ?? "", new RegExp(`Usage: /policy ${verb.split(" ")[0]}`));
		}
		await command.handler("effect routing.cat-read steer", ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Usage: \/policy effect/);
		assert.equal((await storedEvents(dir)).length, 1, "reasonless changes must append no authority event");

		await command.handler("effect routing.cat-read steer calibrated failure cost", ctx as never);
		await command.handler("disable routing.cat-read temporary context", ctx as never);
		let result = await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		let text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /routing\.cat-read.*state=disabled.*effect=steer.*override reason=temporary context/);
		await command.handler("enable routing.cat-read context restored", ctx as never);
		result = await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		text = (result.content as Array<{ text: string }>)[0].text;
		assert.match(text, /routing\.cat-read.*state=active.*effect=steer.*override reason=context restored/);
	});

	it("completes references and effects at each command token position", async () => {
		const { pi, ctx } = await setup();
		const command = pi.commands.get("policy")!;
		const complete = command.getArgumentCompletions!;
		const completions = (prefix: string): string[] =>
			(complete(prefix) as Array<{ value: string }>).map((item) => item.value);
		await callTool(pi.tools.get("policy_rules")!, {}, ctx);
		const proposed = await callTool(
			pi.tools.get("policy_propose")!,
			{
				operation: "add",
				id: "local.scan",
				reason: "Complete this proposal",
				note: "Use a bounded scan.",
				match: { command: "scan" },
			},
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;

		assert.ok(completions("sh").includes("show"));
		assert.ok(completions("show rou").includes("show routing.cat-read"));
		assert.ok(completions("show ").includes(`show ${proposalId}`));
		assert.deepEqual(completions("approve "), [`approve ${proposalId}`]);
		assert.deepEqual(completions("reject "), [`reject ${proposalId}`]);
		assert.deepEqual(completions(`approve ${proposalId} `), [
			`approve ${proposalId} steer`,
			`approve ${proposalId} block`,
		]);
		assert.deepEqual(completions("effect routing.cat-read "), [
			"effect routing.cat-read steer",
			"effect routing.cat-read block",
		]);
		assert.ok(completions("disable routing.").includes("disable routing.cat-read"));
		assert.deepEqual(completions("enable routing.cat-read"), []);
		assert.deepEqual(completions("retire "), []);

		await command.handler(`approve ${proposalId} steer`, ctx as never);
		assert.deepEqual(completions("retire "), ["retire local.scan"]);
		assert.ok(completions("effect local.").includes("effect local.scan"));
		await command.handler("disable routing.cat-read completion setup", ctx as never);
		assert.ok(completions("enable routing.").includes("enable routing.cat-read"));
	});

	it("approves disable through the panel with panel audit and preserves an effect override", async () => {
		const { dir, pi, ctx } = await setup();
		await pi.commands.get("policy")!.handler("effect routing.cat-read steer panel composition setup", ctx as never);
		const proposed = await callTool(
			pi.tools.get("policy_propose")!,
			{ operation: "disable", id: "routing.cat-read", reason: "Panel-approved pause" },
			ctx,
		);
		const proposalId = (proposed.details as { proposalId: string }).proposalId;
		const baseUi = (ctx as { ui: Record<string, unknown> }).ui;
		const panelCtx = {
			...ctx,
			ui: {
				...baseUi,
				async confirm() {
					return true;
				},
				async custom<T>(
					factory: (tui: unknown, themeValue: unknown, keybindings: unknown, done: (result: T) => void) => unknown,
				): Promise<T> {
					return new Promise<T>((resolve, reject) => {
						const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve) as {
							handleInput(data: string): void;
							render(width: number): string[];
						};
						component.handleInput("v");
						component.handleInput("a");
						let attempts = 0;
						const check = () => {
							attempts++;
							if (/Approved proposal/.test(component.render(120).join("\n"))) {
								component.handleInput("\u001b");
								return;
							}
							if (attempts > 100) {
								reject(new Error("panel approval did not settle"));
								return;
							}
							setTimeout(check, 1);
						};
						setTimeout(check, 1);
					});
				},
			},
		};
		await pi.commands.get("policy")!.handler("", panelCtx as never);
		const events = await storedEvents(dir);
		const panelDecision = events.find((event) => event.kind === "decision" && event.proposalId === proposalId);
		assert.equal(panelDecision?.kind, "decision");
		if (panelDecision?.kind === "decision") assert.equal(panelDecision.audit.surface, "panel");
		const rules = await callTool(pi.tools.get("policy_rules")!, {}, panelCtx);
		assert.match(
			(rules.content as Array<{ text: string }>)[0].text,
			/routing\.cat-read.*state=disabled.*effect=steer.*override reason=Panel-approved pause/,
		);
	});

	it("does not construct the custom panel outside TUI mode", async () => {
		const { pi, ctx, notifications } = await setup();
		await pi.commands.get("policy")!.handler("", {
			...ctx,
			mode: "rpc",
			ui: {
				...(ctx as { ui: Record<string, unknown> }).ui,
				custom: () => assert.fail("custom panel must not be constructed outside TUI mode"),
			},
		} as never);
		assert.match(notifications.at(-1)?.message ?? "", /requires TUI mode.*\/policy list/);
	});

	it("emits successful and failed command text as JSON custom entries without a UI", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.commands.get("policy")!;
		const jsonCtx = { ...ctx, mode: "json", hasUI: false };
		await command.handler("mode", jsonCtx as never);
		await command.handler("mode extra", jsonCtx as never);
		assert.deepEqual(notifications, []);
		assert.deepEqual(pi.entries, [
			{
				customType: "policy_command",
				data: {
					text: "observe (--policy-mode)\nRecords every tool call and applies no mechanism.\nRule store healthy.",
				},
			},
			{ customType: "policy_command", data: { text: "Usage: /policy mode" } },
		]);
	});

	it("writes successful and failed command text to print-mode streams without a UI", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.commands.get("policy")!;
		const printCtx = { ...ctx, mode: "print", hasUI: false };
		const stdout: string[] = [];
		const stderr: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await command.handler("mode", printCtx as never);
			await command.handler("mode extra", printCtx as never);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
		}
		assert.deepEqual(notifications, []);
		assert.deepEqual(pi.entries, []);
		assert.equal(
			stdout.join(""),
			"observe (--policy-mode)\nRecords every tool call and applies no mechanism.\nRule store healthy.\n",
		);
		assert.equal(stderr.join(""), "Usage: /policy mode\n");
	});

	it("lists exact help and rejects removed legacy verbs", async () => {
		const { pi, ctx, notifications } = await setup();
		const command = pi.commands.get("policy")!;
		await command.handler("help", ctx as never);
		const usage = notifications.at(-1)?.message ?? "";
		assert.match(usage, /\/policy disable <id> <reason\.\.\.>/);
		assert.match(usage, /\/policy enable <id> <reason\.\.\.>/);
		assert.match(usage, /\/policy retire <local-id> <reason\.\.\.>/);
		assert.doesNotMatch(usage, /\/policy state/);
		await command.handler("state routing.cat-read active", ctx as never);
		assert.match(notifications.at(-1)?.message ?? "", /Unknown \/policy action "state"/);
	});
});

describe("dispatch and telemetry", () => {
	it("preserves built-in blocking and records unified classes plus healthy rule-store status", async () => {
		const { dir, pi, ctx } = await setup("enforce");
		let reads = 0;
		const input = {
			get command() {
				reads++;
				return reads === 1 ? "cat notes.md" : "npm test";
			},
		};
		const blocked = (await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input }, ctx)) as {
			block: boolean;
			reason: string;
		};
		assert.equal(reads, 1);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /read tool/);
		await pi.emit(
			"tool_execution_end",
			{ toolCallId: "c1", isError: true, result: { content: [{ type: "text", text: blocked.reason }] } },
			ctx,
		);
		await pi.emit("session_shutdown", {}, ctx);
		const records = await telemetry(dir);
		assert.equal(records.length, 1);
		assert.deepEqual(records[0].classes, ["routing.cat-read"]);
		assert.equal(records[0].blocked, true);
		assert.equal(records[0].ruleStoreDegraded, false);
		assert.equal(records[0].captured, "cat notes.md");
	});

	it("prevents a disabled package rule from affecting enforcement", async () => {
		const { pi, ctx } = await setup("enforce");
		await pi.commands.get("policy")!.handler("disable routing.cat-read intentional exception", ctx as never);
		assert.equal(
			await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } }, ctx),
			undefined,
		);
	});

	it("caps degraded enforcement at notice and records ruleStoreDegraded on every telemetry row", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-index-degraded-")), "policy");
		await mkdir(dir, { mode: 0o700 });
		await writeFile(
			join(dir, RULES_FILE),
			`${JSON.stringify({ kind: "catalog", rows: PACKAGE_CATALOG, audit: { surface: "package" } })}\n{"bad":true}\n`,
			{ mode: 0o600 },
		);
		const previous = process.env.PI_POLICY_DIR;
		process.env.PI_POLICY_DIR = dir;
		const pi = new FakePi();
		pi.flags.set("policy-mode", "enforce");
		registerPolicy(pi as never);
		if (previous === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previous;
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = context(notifications);
		for (let index = 1; index <= 3; index++) {
			const callId = `c${index}`;
			assert.equal(
				await pi.emit(
					"tool_call",
					{ toolName: "bash", toolCallId: callId, input: { command: `cat notes-${index}.md` } },
					ctx,
				),
				undefined,
			);
			await pi.emit(
				"tool_result",
				{ toolCallId: callId, content: [{ type: "text", text: "content" }], isError: false, usage: {} },
				ctx,
			);
		}
		await pi.emit("session_shutdown", {}, ctx);
		assert.equal(notifications.filter((entry) => /rule store unreadable/i.test(entry.message)).length, 1);
		assert.equal(notifications.filter((entry) => /\[policy\] routing\.cat-read/.test(entry.message)).length, 3);
		const records = await telemetry(dir);
		assert.equal(records.length, 3);
		assert.ok(records.every((record) => record.ruleStoreDegraded === true));
		assert.ok(records.every((record) => record.blocked === undefined));
		assert.ok(records.every((record) => record.notified === true));
	});

	it("annotates steer rules once per session and never annotates an errored result", async () => {
		const { pi, ctx } = await setup("enforce");
		await pi.commands.get("policy")!.handler("effect routing.cat-read steer lower cost", ctx as never);
		await pi.emit("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "cat notes.md" } }, ctx);
		const first = (await pi.emit(
			"tool_result",
			{ toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false, usage: {} },
			ctx,
		)) as { content: Array<{ text: string }> };
		assert.match(first.content.at(-1)?.text ?? "", /^\[policy\]/);
		await pi.emit("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "cat other.md" } }, ctx);
		assert.equal(
			await pi.emit(
				"tool_result",
				{ toolCallId: "c2", content: [{ type: "text", text: "ok" }], isError: false, usage: {} },
				ctx,
			),
			undefined,
		);
		await pi.emit(
			"tool_call",
			{ toolName: "bash", toolCallId: "c3", input: { command: "cat third.md" } },
			{ ...ctx, sessionManager: { getSessionId: () => "session-2" } },
		);
		assert.equal(
			await pi.emit(
				"tool_result",
				{ toolCallId: "c3", content: [{ type: "text", text: "failed" }], isError: true, usage: {} },
				ctx,
			),
			undefined,
		);
	});
});
