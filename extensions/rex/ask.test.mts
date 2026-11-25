import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createEventBus,
	defineTool,
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { obj, type Schema } from "@earendil-works/pi-schema";
import type { TUI } from "@earendil-works/pi-tui";
import { ASK_ACTION_DESCRIPTION, askArguments, askSettlement, askTabLabel, askTitle, type AskRequest } from "./ask.ts";
import { resultChannels } from "./config.ts";
import { RexCore, type RexCallContext, type RexResult } from "./core.ts";
import { toolDisplay } from "./display.ts";
import { registerRex } from "./index.ts";
import type { OwnershipStore } from "./ownership.ts";
import { validateRequest } from "./schema.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const question = {
	about: "Delete the three folders that another agent made under the build directory. Nothing else uses them.",
	question: "Delete 3 folders another agent made?",
	choices: [
		{ id: "keep", title: "Keep them", subtitle: "No change. The folders stay where they are." },
		{
			id: "delete",
			title: "Delete them",
			subtitle: "Moves them to the Trash, so you can undo it.",
			recommended: true,
		},
	],
};
const askRequest = (fields: Partial<AskRequest> = {}): AskRequest => ({ op: "ask", ...question, ...fields });

function exited(stdout: unknown, exitCode = 0, stderr = ""): CliResult {
	return {
		outcome: "exited",
		exitCode,
		signal: null,
		stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
		stderr,
		bytes: 0,
		truncated: false,
		started: true,
	};
}

/** A Rex server that lists the current question action and answers each `rex do` with the next scripted reply. */
class AskTransport implements RexTransport {
	calls: Array<{ args: readonly string[]; call: CliCall }> = [];
	revision = 18;
	actions: unknown[] = [{ name: "pi_ask", kind: "lua", description: ASK_ACTION_DESCRIPTION }];
	view: unknown = {};
	replies: Array<CliResult | ((call: CliCall) => Promise<CliResult>)>;
	whoami?: CliResult;
	constructor(...replies: Array<CliResult | ((call: CliCall) => Promise<CliResult>)>) {
		this.replies = replies;
	}
	get asks(): Array<Record<string, unknown>> {
		return this.calls
			.filter(({ args }) => args.includes("do"))
			.map(({ args }) => JSON.parse(args[args.indexOf("--args") + 1] ?? "{}") as Record<string, unknown>);
	}
	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		this.calls.push({ args, call });
		if (args.includes("whoami"))
			return (
				this.whoami ??
				exited({
					endpoint: "unix:///test-rex",
					host_id: "host",
					instance_id: "instance",
					rex_version: "0.1.0-test",
					api_revision: this.revision,
				})
			);
		if (args.includes("actions")) return exited({ actions: this.actions });
		if (args.includes("session.view")) return exited(this.view);
		if (args.includes("do")) {
			const reply = this.replies.shift();
			if (!reply) throw new Error("No scripted reply is left.");
			return typeof reply === "function" ? reply(call) : reply;
		}
		return exited({}, 1, `unexpected ${args.join(" ")}`);
	}
	dispose() {}
}

const store: OwnershipStore = {
	load: async () => {
		throw new Error("A question keeps no ownership record.");
	},
	save: async () => {
		throw new Error("A question keeps no ownership record.");
	},
} as unknown as OwnershipStore;

async function ask(
	transport: AskTransport,
	fields: Partial<AskRequest> = {},
	context: Partial<RexCallContext> = {},
): Promise<RexResult> {
	const core = new RexCore({ store, transport, env: {}, askRetryMs: 1 });
	try {
		return await core.execute(askRequest(fields), {
			ownerId: "owner",
			callId: "call",
			cwd: "/work/harness",
			asker: "harness",
			...context,
		});
	} finally {
		core.dispose();
	}
}

test("a question takes two to four choices with lines that fit the palette, and names no operation", () => {
	const valid = validateRequest("rex_ask", question);
	assert.ok(valid.ok);
	assert.equal(valid.request.op, "ask", "the core selects the question by its operation");
	const choice = (fields: Record<string, unknown>) => ({ id: "x", title: "Do it", subtitle: "Does it.", ...fields });
	const refused: Array<[Record<string, unknown>, RegExp]> = [
		[{ ...question, question: "q".repeat(46) }, /\/question/],
		[{ ...question, about: "a".repeat(1201) }, /\/about/],
		[{ ...question, about: " \n " }, /about needs visible text/],
		[{ ...question, choices: [choice({})] }, /\/choices/],
		[{ ...question, choices: ["a", "b", "c", "d", "e"].map((id) => choice({ id })) }, /\/choices/],
		[{ ...question, choices: [choice({ title: "t".repeat(41) }), choice({ id: "y" })] }, /title/],
		[{ ...question, choices: [choice({ subtitle: "s".repeat(49) }), choice({ id: "y" })] }, /subtitle/],
		[{ ...question, choices: [choice({}), choice({ subtitle: undefined, id: "y" })] }, /subtitle/],
		[{ ...question, choices: [choice({}), choice({})] }, /choice ids must be unique/],
		[
			{ ...question, choices: [choice({ recommended: true }), choice({ id: "y", recommended: true })] },
			/recommend at most one choice/,
		],
		[{ ...question, choices: [choice({ detail: "soon" }), choice({ id: "y" })] }, /detail/],
		[{ ...question, allowOther: true }, /allowOther/],
		[{ ...question, op: "ask" }, /op/],
		[{ ...question, timeoutMs: 9999 }, /\/timeoutMs/],
		[{ ...question, timeoutMs: 3_600_001 }, /\/timeoutMs/],
	];
	for (const [args, pattern] of refused) {
		const result = validateRequest("rex_ask", args);
		assert.equal(result.ok, false, JSON.stringify(args));
		assert.match(result.ok ? "" : result.error, pattern);
	}
	assert.ok(validateRequest("rex_ask", { ...question, timeoutMs: 3_600_000 }).ok);
});

test("the title names the asker only when the whole title fits one palette line", () => {
	assert.equal(
		askTitle("Delete 3 folders another agent made?", "harness"),
		"Delete 3 folders another agent made? · harness",
	);
	assert.equal(
		askTitle("Delete 3 folders another agent made?", "a long session name"),
		"Delete 3 folders another agent made?",
	);
	assert.equal(askTitle("Push the release?", undefined), "Push the release?");
	assert.equal(askTitle("Push\nthe release?", " tab\u0007 "), "Push the release? · tab");
	const args = askArguments(askRequest(), "harness", 125_500);
	assert.deepEqual(args, {
		title: "Delete 3 folders another agent made? · harness",
		items: [
			{ id: "keep", title: "Keep them", subtitle: "No change. The folders stay where they are." },
			{
				id: "delete",
				title: "Delete them",
				subtitle: "Moves them to the Trash, so you can undo it.",
				detail: "recommended",
			},
		],
		wait: 126,
	});
});

test("the tab label names the asker unless it is missing or Rex's default", () => {
	const view = (label: unknown) => ({
		windows: [
			{ window_id: "window-0000000000000001", label: "Other", layers: [{ blocks: [{ block_id: "b0" }] }] },
			{ window_id: "window-00000000abcdef12", label, layers: [{ blocks: [{ block_id: "b1" }] }] },
		],
	});
	assert.equal(askTabLabel(view("Release work"), "b1"), "Release work");
	assert.equal(askTabLabel(view("Window abcdef12"), "b1"), undefined);
	assert.equal(askTabLabel(view(""), "b1"), undefined);
	assert.equal(askTabLabel(view("Release work"), "b9"), undefined);
});

test("the action's reply settles as an offered choice with its note, or as Rex's reason for none", () => {
	const request = askRequest();
	assert.deepEqual(askSettlement(request, { choice: "delete", note: "empty the bin too" }), {
		outcome: "answered",
		answer: { choice: "delete", note: "empty the bin too" },
	});
	assert.deepEqual(askSettlement(request, { choice: "keep", note: "" }).answer, { choice: "keep", note: "" });
	assert.equal(askSettlement(request, { choice: "other", note: "" }).outcome, "failed");
	assert.equal(askSettlement(request, { choice: "keep" }).outcome, "failed");
	assert.equal(askSettlement(request, { why: "cancelled" }).outcome, "declined");
	const afterChoice = askSettlement(request, { why: "cancelled", choice: "delete" });
	assert.equal(afterChoice.outcome, "declined");
	assert.match(afterChoice.detail ?? "", /picked a choice and then closed the note, so nothing is approved/);
	assert.equal(askSettlement(request, { why: "busy" }).outcome, "busy");
	assert.equal(askSettlement(request, { why: "strange" }).outcome, "failed");
});

test("an answer returns the choice and the note, and tells the agent what it approves", async () => {
	const transport = new AskTransport(exited({ choice: "delete", note: "empty the bin too" }));
	const result = await ask(transport, {}, { askPane: { session: "s1", block: "b1" } });
	assert.equal(result.ok, true);
	assert.equal(result.outcome, "answered");
	const data = result.data as Record<string, unknown>;
	assert.deepEqual(data.answer, { choice: "delete", note: "empty the bin too" });
	assert.match(String(data.meaning), /approves only the act that this question asked about/);
	assert.match(String(data.meaning), /Carry out the chosen act and follow the note in this run/);
	assert.equal(result.effects.state, "none");
	const run = transport.calls.find(({ args }) => args.includes("do"));
	assert.ok(run);
	assert.deepEqual(run.args.slice(run.args.indexOf("do")), [
		"do",
		"pi_ask",
		"--args",
		run.args[run.args.indexOf("--args") + 1],
		"--json",
	]);
	assert.ok(run.call.timeoutMs > 3_600_000, "the process outlives the question's own hour");
	assert.equal(transport.asks[0]?.wait, 3600, "a question waits one hour by default");
	assert.equal(transport.asks[0]?.title, "Delete 3 folders another agent made? · harness");
});

test("the asking tab's label names the asker in place of the session name", async () => {
	const transport = new AskTransport(exited({ choice: "keep", note: "" }));
	transport.view = {
		windows: [{ window_id: "window-1", label: "Release", layers: [{ blocks: [{ block_id: "b1" }] }] }],
	};
	await ask(transport, {}, { askPane: { session: "s1", block: "b1" } });
	assert.equal(transport.asks[0]?.title, "Delete 3 folders another agent made? · Release");
});

test("while every app shows another question, the question asks again for the rest of its wait", async () => {
	const transport = new AskTransport(
		exited({ why: "busy" }),
		exited({ why: "busy" }),
		exited({ choice: "keep", note: "" }),
	);
	const result = await ask(transport, { timeoutMs: 60_000 });
	assert.equal(result.outcome, "answered");
	assert.equal(transport.asks.length, 3);
	assert.ok(Number(transport.asks[2]?.wait) <= 60, "each attempt asks only for the time left");
});

test("every outcome without an answer approves nothing and ends questions for the run", async () => {
	const cases: Array<[AskTransport, string, RegExp]> = [
		[new AskTransport(exited({ why: "cancelled" })), "declined", /closed the question without answering/],
		[new AskTransport(exited({ why: "cancelled", choice: "delete" })), "declined", /then closed the note/],
		[new AskTransport(exited({ why: "timeout" })), "timeout", /Nobody answered/],
		[new AskTransport(exited({ why: "no_client" })), "no_client", /No Rex app is connected/],
		[new AskTransport(exited({ why: "unsupported" })), "unsupported", /can show questions/],
		[new AskTransport(exited("", 1, "Error: the action failed")), "failed", /the action failed/],
		[
			new AskTransport(exited("", 1, 'Error: no action named "pi_ask"')),
			"not_configured",
			/has not loaded the pi_ask action.*\/rex setup/,
		],
		[new AskTransport(exited("", 1, "Error: action pi_ask did not finish within --timeout")), "timeout", /wait ended/],
	];
	for (const [transport, outcome, error] of cases) {
		const result = await ask(transport);
		assert.equal(result.ok, false, outcome);
		assert.equal(result.outcome, outcome);
		assert.match(result.error ?? "", error);
		assert.equal(
			(result.data as { meaning: string }).meaning,
			"No answer arrived, so nothing is approved. Do not act on what you asked. Put the question in your final report, and ask nothing more through rex_ask in this run.",
		);
	}
});

test("a server without the current question action, or too old for prompts, asks nobody", async () => {
	const missing = new AskTransport();
	missing.actions = [{ name: "pi_command", kind: "lua", description: "" }];
	const unloaded = await ask(missing);
	assert.equal(unloaded.outcome, "not_configured");
	assert.match(unloaded.error ?? "", /\/rex setup/);
	const earlier = new AskTransport();
	earlier.actions = [{ name: "pi_ask", kind: "lua", description: "Shows a question from a Pi agent." }];
	const stale = await ask(earlier);
	assert.equal(stale.outcome, "not_configured");
	assert.match(stale.error ?? "", /earlier pi_ask action.*\/rex setup/);
	const old = new AskTransport();
	old.revision = 13;
	const unsupported = await ask(old);
	assert.equal(unsupported.outcome, "unsupported");
	assert.match(unsupported.error ?? "", /API revision 13.*17 or later/);
	const away = new AskTransport();
	away.whoami = exited("", 1, "Error: no Rex server is running");
	const unavailable = await ask(away);
	assert.equal(unavailable.outcome, "unavailable");
	assert.match(unavailable.error ?? "", /no Rex server is running/);
	for (const transport of [missing, earlier, old, away])
		assert.equal(transport.asks.length, 0, "nothing reached the operator");
});

test("ending the call stops the action, while an answer that arrived first stands", async () => {
	const abort = new AbortController();
	let stopped = false;
	const transport = new AskTransport(
		(call) =>
			new Promise((resolve) => {
				call.signal?.addEventListener("abort", () => {
					stopped = true;
					resolve({ ...exited("", null as unknown as number), outcome: "cancelled", exitCode: null });
				});
				abort.abort();
			}),
	);
	const cancelled = await ask(transport, {}, { signal: abort.signal });
	assert.equal(stopped, true, "the rex do process received the stop, so Rex closes the question");
	assert.equal(cancelled.outcome, "cancelled");
	assert.match(cancelled.error ?? "", /Rex closed the question/);
	const late = new AbortController();
	const answered = new AskTransport(async () => {
		late.abort();
		return exited({ choice: "keep", note: "" });
	});
	const kept = await ask(answered, {}, { signal: late.signal });
	assert.equal(kept.outcome, "answered");
});

function ordinaryPi(transport: AskTransport) {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: () => {},
		getSessionName: () => "Release",
	} as unknown as ExtensionAPI;
	registerRex(pi, {
		createCore: (options) => new RexCore({ ...options, transport, env: {} }),
		createTabLabelProjector: () =>
			({
				start() {},
				refresh() {},
				input() {},
				shutdown: async () => {},
			}) as never,
		createConversationKeeper: () => ({ start() {}, attention() {}, floated() {}, shutdown: async () => {} }) as never,
		createSessionPaneRegistrar: () => ({ start() {}, shutdown() {} }) as never,
	});
	const ctx = {
		cwd: "/work/harness",
		hasUI: true,
		isIdle: () => false,
		sessionManager: { getSessionId: () => "ordinary", getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	return { tools, handlers, ctx };
}

test("in ordinary Pi, a message from the operator ends a waiting question, and the guidance names rex_ask", async (t) => {
	let started!: () => void;
	const asking = new Promise<void>((resolve) => {
		started = resolve;
	});
	const transport = new AskTransport(
		(call) =>
			new Promise((resolve) => {
				call.signal?.addEventListener("abort", () => resolve({ ...exited(""), outcome: "cancelled", exitCode: null }));
				started();
			}),
	);
	const { tools, handlers, ctx } = ordinaryPi(transport);
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});
	const tool = tools.get("rex_ask");
	assert.ok(tool);
	assert.ok(tool.promptGuidelines?.every((line) => line.includes("rex_ask")));
	assert.ok(tool.promptGuidelines?.some((line) => /never use it for optional or follow-on work/i.test(line)));
	const pending = tool.execute("ask-call", question, undefined, undefined, ctx);
	await asking;
	await handlers.get("input")?.({ type: "input", text: "/rex status", source: "extension" }, ctx);
	await handlers.get("input")?.({ type: "input", text: "Hold on", source: "interactive" }, ctx);
	const result = await pending;
	const receipt = result.structuredContent as unknown as RexResult;
	assert.equal(receipt.outcome, "superseded");
	assert.equal(receipt.ok, false);
	assert.match(receipt.error ?? "", /sent a message to this session instead of answering/);
	assert.match((receipt.data as { meaning: string }).meaning, /Read that message when it reaches you/);
	assert.equal(transport.asks[0]?.title, "Delete 3 folders another agent made? · Release");
});

test("in ordinary Pi, a question waits up to an hour, beyond the cap for terminal work", async (t) => {
	const transport = new AskTransport(exited({ choice: "keep", note: "" }));
	const { tools, handlers, ctx } = ordinaryPi(transport);
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
	});
	const result = await tools
		.get("rex_ask")
		?.execute("ask-call", { ...question, timeoutMs: 3_600_000 }, undefined, undefined, ctx);
	const receipt = result?.structuredContent as unknown as RexResult;
	assert.equal(receipt.outcome, "answered");
	assert.equal(receipt.coverage.deadline?.effectiveMs, 3_630_000);
});

const ui = { requestRender() {} } as unknown as TUI;
function card(args: unknown): ToolExecutionComponent {
	initTheme("dark", false);
	const display = toolDisplay().tools.find((entry) => entry.name === "rex_ask");
	assert.ok(display);
	const definition = defineTool({
		...display,
		label: "Display fixture",
		description: "Display fixture",
		parameters: obj({}, { open: true }),
		async execute() {
			throw new Error("A display fixture must not execute");
		},
	});
	const component = new ToolExecutionComponent("rex_ask", "fixture", args, { outputPad: 1 }, definition, ui, ".");
	component.setArgsComplete();
	return component;
}
const screen = (component: ToolExecutionComponent, width = 60) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");

test("the card shows the complete act and the choices, then the choice and the note", () => {
	const about = Array.from({ length: 9 }, (_, index) => `Line ${index + 1} of the prepared act.`).join("\n");
	const component = card({ ...question, about });
	component.markExecutionStarted();
	const waiting = screen(component);
	assert.match(waiting, /rex_ask Delete 3 folders another agent made\?/);
	assert.match(waiting, /Line 9 of the prepared act\./, "the act is never cut to a preview");
	assert.match(waiting, /- Keep them: No change\. The folders stay where they are\./);
	assert.match(waiting, /- Delete them \(recommended\): Moves them to the Trash/);
	assert.match(waiting, /Waiting for the operator's answer in Rex\./);
	component.updateResult(
		resultChannels({
			ok: true,
			outcome: "answered",
			data: { answer: { choice: "delete", note: "empty the bin too" } },
			effects: { state: "none" },
			coverage: { bounded: true },
		}),
	);
	const answered = screen(component);
	assert.match(answered, /Answered: Delete them/);
	assert.match(answered, /Note: empty the bin too/);
	assert.doesNotMatch(answered, /Waiting for the operator's answer/);
	const declined = card(question);
	declined.updateResult(
		resultChannels({
			ok: false,
			outcome: "declined",
			error: "The operator closed the question without answering.",
			effects: { state: "none" },
			coverage: { bounded: true },
		}),
	);
	const refused = screen(declined);
	assert.match(refused, /The operator closed the question without answering\./);
	assert.match(refused, /Nothing is approved\./);
});
