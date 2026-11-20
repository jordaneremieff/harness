import assert from "node:assert/strict";
import test from "node:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Schema } from "@earendil-works/pi-schema";
import {
	ASK_SHOW_FIRST_ID,
	ASK_UNREACHED,
	askCliFailure,
	askCliSettlement,
	askInDialog,
	askPrompt,
	askSettlement,
	askTitle,
	choiceLabels,
	type AskDialogs,
	type AskRequest,
} from "./ask.ts";
import { RexCore, type RexCallContext, type RexRequest, type RexResult } from "./core.ts";
import { registerRex } from "./index.ts";
import { initialOwnershipState, type OwnershipStore } from "./ownership.ts";
import { validateRequest } from "./schema.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const choices = [
	{ id: "hold", title: "Hold", subtitle: "Do not publish" },
	{ id: "publish", title: "Publish" },
];
const ask = (fields: Partial<AskRequest> = {}): AskRequest => ({
	op: "ask",
	question: "Publish the change?",
	...fields,
});

function reply(value: unknown, exitCode = 0, stderr = ""): CliResult {
	return {
		outcome: "exited",
		exitCode,
		signal: null,
		stdout: JSON.stringify(value),
		stderr,
		bytes: 0,
		truncated: false,
		started: true,
	};
}
/** A store that fails the test if a question tries to keep an ownership record. */
const noRecords: OwnershipStore = {
	read: async () => initialOwnershipState(),
	update: async () => {
		throw new Error("a question must not write ownership state");
	},
};

class AskTransport implements RexTransport {
	calls: { args: readonly string[]; call: CliCall }[] = [];
	revision = 18;
	actions: unknown[] = [{ name: "pi_ask", kind: "lua" }];
	view = () => reply({});
	focus = () => reply({ revision: 2 });
	answer: (args: readonly string[], call: CliCall) => CliResult | Promise<CliResult> = () =>
		reply({ answer: "hold", version: 1 });
	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		this.calls.push({ args, call });
		if (args.includes("whoami"))
			return reply({
				endpoint: "unix:///rex",
				host_id: "host",
				instance_id: "instance",
				rex_version: "0.1.0-test",
				api_revision: this.revision,
			});
		if (args.includes("actions")) return reply({ actions: this.actions });
		if (args.includes("session.view")) return this.view();
		if (args.includes("session.focus_block")) return this.focus();
		if (args.includes("do")) return this.answer(args, call);
		throw new Error(`Unexpected Rex call: ${args.join(" ")}`);
	}
	dispose() {}
}
function core(transport = new AskTransport()) {
	return {
		transport,
		core: new RexCore({
			store: noRecords,
			transport,
			env: { REX_SERVER: "unix:///rex" },
			isCallActive: () => false,
			askRetryMs: 5,
		}),
	};
}
const context = { ownerId: "owner", callId: "ask", cwd: "/work", asker: "harness" };
const pane = {
	session: "session:10000000-0000-0000-0000-000000000000",
	block: "block:20000000-0000-0000-0000-000000000000",
	hasUI: true,
};
const windowId = "window:30000000-0000-0000-0000-000012345678";
function paneView(label: string, kind = "floating") {
	return reply({
		windows: [
			{ window_id: "window:elsewhere", label: "harness", layers: [{ blocks: [{ block_id: "block:other" }] }] },
			{
				window_id: windowId,
				label,
				layers: [{ kind, blocks: [{ block_id: "block:peer" }, { block_id: pane.block }] }],
			},
		],
	});
}
const doArgs = (transport: AskTransport, attempt = 0) => {
	const call = transport.calls.filter((entry) => entry.args.includes("do"))[attempt];
	assert.ok(call, "the question ran the pi_ask action");
	return {
		args: call.args,
		json: JSON.parse(call.args[call.args.indexOf("--args") + 1] ?? "{}") as {
			kind: string;
			prompt: Record<string, unknown>;
		},
		call: call.call,
	};
};

test("a question names its session and maps every field to Rex's prompt table", () => {
	assert.equal(askTitle("Publish?", "harness"), "harness: Publish?");
	assert.equal(askTitle("harness: Publish?", "harness"), "harness: Publish?", "an asker already named is not repeated");
	assert.equal(
		askTitle("Line\none\u202e", "a\u0007b"),
		"a b: Line one",
		"controls and format characters never reach the palette",
	);
	assert.deepEqual(
		askPrompt(ask({ value: "feature/", placeholder: "branch", confirm: "Create", timeoutMs: 60000 }), "harness"),
		{
			kind: "input",
			title: "harness: Publish the change?",
			prompt: {
				title: "harness: Publish the change?",
				timeout: 60,
				placeholder: "branch",
				value: "feature/",
				confirm: "Create",
			},
		},
	);
	const pick = askPrompt(
		ask({
			choices: [
				{ id: "a", selected: true },
				{ id: "b", title: "B", detail: "risky" },
			],
			multiple: true,
		}),
		undefined,
	);
	assert.deepEqual(pick, {
		kind: "pick",
		title: "Publish the change?",
		prompt: {
			title: "Publish the change?",
			timeout: 300,
			items: [
				{ id: "a", selected: true },
				{ id: "b", title: "B", detail: "risky" },
			],
			multiple: true,
		},
	});
	assert.equal(askPrompt(ask({ choices, allowOther: true }), undefined).prompt.allow_other, true);
	const problems: Array<[Partial<AskRequest>, RegExp]> = [
		[{ multiple: true }, /multiple requires choices/],
		[{ allowOther: true }, /allowOther requires choices/],
		[{ choices, multiple: true, allowOther: true }, /cannot be combined/],
		[{ choices: [{ id: "a" }, { id: "a" }] }, /unique/],
		[{ choices: [{ id: "a", selected: true }] }, /selected applies only with multiple/],
	];
	for (const [fields, problem] of problems) {
		assert.throws(() => askPrompt(ask(fields), undefined), problem);
		const validated = validateRequest("rex_ask", ask(fields));
		assert.equal(validated.ok, false);
		assert.match(validated.ok ? "" : validated.error, problem);
	}
});

test("the tool schema accepts a question within its bounds and refuses the rest before any Rex access", () => {
	assert.equal(validateRequest("rex_ask", ask({ choices, timeoutMs: 3600000 })).ok, true);
	for (const fields of [
		{ timeoutMs: 9999 },
		{ timeoutMs: 3600001 },
		{ question: "" },
		{ question: " \u0007\u202e " },
		{ choices: [] },
		{ choices: [{ id: "" }] },
		{ target: { server: "x" } },
		{ op: "wait" },
	]) {
		const validated = validateRequest("rex_ask", { ...ask(), ...fields });
		assert.equal(validated.ok, false, JSON.stringify(fields));
	}
});

test("Rex's answers and reasons settle as the question's outcome", () => {
	assert.deepEqual(askSettlement(ask(), { answer: "free text" }), {
		outcome: "answered",
		answer: { text: "free text" },
	});
	assert.deepEqual(
		askSettlement(ask(), { answer: "" }),
		{ outcome: "answered", answer: { text: "" } },
		"an empty submitted field is an answer",
	);
	assert.deepEqual(askSettlement(ask({ choices }), { answer: "publish" }), {
		outcome: "answered",
		answer: { choice: "publish" },
	});
	assert.deepEqual(askSettlement(ask({ choices, multiple: true }), { answer: ["hold", "publish"] }), {
		outcome: "answered",
		answer: { choices: ["hold", "publish"] },
	});
	assert.deepEqual(
		askSettlement(ask({ choices, multiple: true }), { answer: {} }),
		{ outcome: "answered", answer: { choices: [] } },
		"Lua's empty list arrives as an empty object",
	);
	assert.deepEqual(askSettlement(ask({ choices, allowOther: true }), { answer: { text: "later" } }), {
		outcome: "answered",
		answer: { text: "later" },
	});
	for (const value of [{ answer: "other" }, { answer: ["hold", "x"] }, { answer: { text: "typed" } }, {}, null])
		assert.equal(askSettlement(ask({ choices }), value).outcome, "failed", JSON.stringify(value));
	for (const [why, outcome] of [
		["cancelled", "declined"],
		["timeout", "timeout"],
		["no_client", "no_client"],
		["unsupported", "unsupported"],
		["busy", "busy"],
		["failed", "failed"],
		["new_reason", "failed"],
	])
		assert.equal(askSettlement(ask(), { why }).outcome, outcome, why);
	assert.deepEqual(askSettlement(ask(), { why: "failed", detail: "The app crashed." }), {
		outcome: "failed",
		reason: "failed",
		detail: "The app crashed.",
	});
	assert.equal(
		askCliFailure('Error: action "pi_ask" did not finish within --timeout 5s. It may be waiting').outcome,
		"timeout",
	);
	assert.equal(
		askCliFailure('Error: no action named "pi_ask". Run "rex actions" to list them.').outcome,
		"not_configured",
	);
	assert.deepEqual(askCliFailure("Error: init.lua:3: rex.ui.pick: title is required"), {
		outcome: "failed",
		detail: "Error: init.lua:3: rex.ui.pick: title is required",
	});
});

test("the core asks through pi_ask without an ownership record, and an action call runs until its own allowance", async () => {
	const { core: rex, transport } = core();
	const result = await rex.execute(ask({ choices, timeoutMs: 600000 }), context);
	assert.equal(result.ok, true);
	assert.equal(result.outcome, "answered");
	assert.deepEqual(result.data, {
		question: "harness: Publish the change?",
		channel: "rex",
		answer: { choice: "hold" },
		meaning: "A person using a connected Rex app answered. The answer covers this question only.",
	});
	assert.deepEqual(result.effects.state, "none");
	const sent = doArgs(transport);
	const { timeout: promptSeconds, ...prompt } = sent.json.prompt;
	assert.deepEqual(
		{ kind: sent.json.kind, prompt },
		{ kind: "pick", prompt: { title: "harness: Publish the change?", items: choices } },
	);
	assert.ok(
		promptSeconds === 600 || promptSeconds === 599,
		`the prompt asks for the rest of the wait: ${promptSeconds}`,
	);
	const timeout = Number(/^--timeout=(\d+)s$/.exec(sent.args.find((arg) => arg.startsWith("--timeout=")) ?? "")?.[1]);
	assert.ok(timeout > 600 && timeout <= 630, `the CLI waits beyond the question's own timeout: ${timeout}`);
	assert.ok(sent.call.timeoutMs > 600000, "the transport outlives the question's own timeout");
	assert.deepEqual(
		transport.calls.map((entry) => entry.args.find((arg) => ["whoami", "actions", "do"].includes(arg))),
		["whoami", "actions", "do"],
	);
});

test("a question uses its containing tab label and offers one last row across busy retries", async () => {
	const { core: rex, transport } = core();
	transport.view = () => paneView(" md\u200b  improve\n ");
	const answers = [reply({ why: "busy" }), reply({ answer: { text: ASK_SHOW_FIRST_ID } })];
	transport.answer = () => {
		const answer = answers.shift();
		assert.ok(answer);
		return answer;
	};
	const result = await rex.execute(ask({ choices, allowOther: true }), { ...context, askPane: pane });
	assert.equal(result.outcome, "answered");
	assert.deepEqual((result.data as { answer: unknown }).answer, { text: ASK_SHOW_FIRST_ID });
	for (const attempt of [0, 1]) {
		const { prompt } = doArgs(transport, attempt).json;
		assert.equal(prompt.title, "md improve: Publish the change?");
		assert.equal(prompt.allow_other, true);
		assert.deepEqual(prompt.items, [
			...choices,
			{ id: ASK_SHOW_FIRST_ID, title: "Show me first", subtitle: "Opens md improve and asks there", icon: "terminal" },
		]);
	}
	assert.equal(transport.calls.filter(({ args }) => args.includes("session.view")).length, 1);
	assert.ok(!transport.calls.some(({ args }) => args.includes("session.focus_block")));
});

test("the tab label falls back independently of the Show me first row", async () => {
	for (const [label, view, showsRow] of [
		["default label", () => paneView("Window 12345678", "tiled"), true],
		["blank label", () => paneView("\u200b \n"), true],
		["missing block", () => reply({ windows: [] }), false],
		["lookup failed", () => reply({}, 1), false],
	] as const) {
		const { core: rex, transport } = core();
		transport.view = view;
		const result = await rex.execute(ask({ choices }), { ...context, askPane: pane });
		assert.equal(result.outcome, "answered", label);
		const { prompt } = doArgs(transport).json;
		assert.equal(prompt.title, "harness: Publish the change?", label);
		assert.equal((prompt.items as unknown[]).length, choices.length + Number(showsRow), label);
		assert.ok((transport.calls.find(({ args }) => args.includes("session.view"))?.call.timeoutMs ?? Infinity) <= 1000);
	}
});

test("the extra row requires a single choice, an interactive UI and a located pane", async () => {
	const cases = [
		{ fields: {}, askPane: pane, answer: ASK_SHOW_FIRST_ID, outcome: "answered", value: { text: ASK_SHOW_FIRST_ID } },
		{
			fields: { choices, multiple: true },
			askPane: pane,
			answer: ["hold"],
			outcome: "answered",
			value: { choices: ["hold"] },
		},
		{ fields: { choices }, askPane: { ...pane, hasUI: false }, answer: ASK_SHOW_FIRST_ID, outcome: "failed" },
		{ fields: { choices }, askPane: undefined, answer: ASK_SHOW_FIRST_ID, outcome: "failed" },
		{
			fields: { choices: [{ id: ASK_SHOW_FIRST_ID, title: "Agent's own choice" }] },
			askPane: pane,
			answer: ASK_SHOW_FIRST_ID,
			outcome: "answered",
			value: { choice: ASK_SHOW_FIRST_ID },
		},
	];
	for (const { fields, askPane, answer, outcome, value } of cases) {
		const { core: rex, transport } = core();
		transport.view = () => paneView("composer");
		transport.answer = () => reply({ answer });
		const result = await rex.execute(ask(fields), { ...context, askPane });
		assert.deepEqual(doArgs(transport).json.prompt.items, fields.choices);
		assert.equal(result.outcome, outcome);
		assert.deepEqual((result.data as { answer?: unknown }).answer, value);
		assert.ok(!transport.calls.some(({ args }) => args.includes("session.focus_block")));
		assert.equal(
			transport.calls.some(({ args }) => args.includes("session.view")),
			!!askPane,
		);
	}
});

test("cancellation during the tab lookup does not start a question", async () => {
	const { core: rex, transport } = core();
	const stop = new AbortController();
	transport.view = () => {
		stop.abort();
		return paneView("composer");
	};
	const result = await rex.execute(ask({ choices }), { ...context, askPane: pane, signal: stop.signal });
	assert.equal(result.outcome, "cancelled");
	assert.ok(!transport.calls.some(({ args }) => args.includes("do")));
});

test("the core refuses before any action when the server is too old or has no pi_ask action", async () => {
	const old = core();
	old.transport.revision = 13;
	const refused = await old.core.execute(ask(), context);
	assert.equal(refused.outcome, "unsupported");
	assert.match(refused.error ?? "", /0\.1\.0-test, API revision 13.*API revision 17/);
	assert.equal(
		old.transport.calls.some((entry) => entry.args.includes("do") || entry.args.includes("actions")),
		false,
	);
	const missing = core();
	missing.transport.actions = [
		{ name: "pi_ask", kind: "block" },
		{ name: "other", kind: "lua" },
	];
	const unconfigured = await missing.core.execute(ask(), context);
	assert.equal(unconfigured.outcome, "not_configured");
	assert.match(unconfigured.error ?? "", /\/rex setup/);
	assert.equal(
		missing.transport.calls.some((entry) => entry.args.includes("do")),
		false,
	);
});

test("a question that could not reach Rex says so, so a session can still ask in its own dialog", async () => {
	const { core: rex, transport } = core();
	const run = transport.run.bind(transport);
	transport.run = async (args, call) =>
		args.includes("whoami")
			? { ...reply({}), exitCode: 1, stderr: "Error: no Rex server is listening" }
			: run(args, call);
	const result = await rex.execute(ask(), context);
	assert.equal(result.outcome, "unavailable");
	assert.equal(result.target, undefined);
	assert.match(result.error ?? "", /could not be reached before the question was asked.*no Rex server is listening/);
	assert.equal(
		transport.calls.some((entry) => entry.args.includes("do")),
		false,
	);
	assert.ok(ASK_UNREACHED.has(result.outcome));
});

test("the core reports Rex's reasons and CLI failures without claiming an answer", async () => {
	for (const [answer, outcome, error] of [
		[reply({ why: "cancelled" }), "declined", /closed the question/],
		[reply({}, 1, 'Error: action "pi_ask" did not finish within --timeout 40s.'), "timeout", /wait ended/],
		[reply({}, 1, "Error: init.lua:9: rex.ui.input: title is required"), "failed", /title is required/],
		[{ ...reply({}), stdout: "{partial" }, "failed", /complete JSON/],
	] as const) {
		const { core: rex, transport } = core();
		transport.answer = () => answer;
		const result = await rex.execute(ask(), context);
		assert.equal(result.ok, false);
		assert.equal(result.outcome, outcome);
		assert.match(result.error ?? "", error);
		assert.match(String((result.data as { meaning?: string }).meaning), /No answer arrived/);
	}
});

test("a question waits its turn while every Rex app shows another question", async () => {
	const { core: rex, transport } = core();
	const replies = [
		reply({ why: "busy", version: 1 }),
		reply({ why: "busy", version: 1 }),
		reply({ answer: "publish", version: 1 }),
	];
	transport.answer = () => replies.shift() ?? reply({ why: "failed" });
	const result = await rex.execute(ask({ choices, timeoutMs: 60000 }), context);
	assert.equal(result.outcome, "answered");
	assert.deepEqual((result.data as { answer?: unknown }).answer, { choice: "publish" });
	const asked = transport.calls
		.filter((entry) => entry.args.includes("do"))
		.map(
			(entry) => JSON.parse(entry.args[entry.args.indexOf("--args") + 1] ?? "{}") as { prompt: { timeout: number } },
		);
	assert.equal(asked.length, 3, "each turn asks again");
	assert.ok(
		asked.every((attempt) => attempt.prompt.timeout <= 60 && attempt.prompt.timeout >= 59),
		"each attempt asks for the rest of the wait",
	);
	const always = core();
	always.transport.answer = () => reply({ why: "busy" });
	const stop = new AbortController();
	const pending = always.core.execute(ask(), { ...context, signal: stop.signal });
	setTimeout(() => stop.abort(), 30);
	assert.equal((await pending).outcome, "cancelled", "a cancelled call stops waiting for its turn");
});

test("an answer that the CLI printed as the call was stopped stands", async () => {
	const complete = { outcome: "cancelled", exitCode: null, stdout: '{"answer":"publish","version":1}', stderr: "" };
	assert.deepEqual(askCliSettlement(ask({ choices }), complete, "cancelled"), {
		outcome: "answered",
		answer: { choice: "publish" },
	});
	assert.deepEqual(
		askCliSettlement(ask({ choices }), { ...complete, stdout: '{"answer":"pub' }, "cancelled"),
		{ outcome: "cancelled" },
		"partial output is no answer",
	);
	assert.deepEqual(
		askCliSettlement(ask({ choices }), { ...complete, stdout: '{"why":"cancelled"}' }, "cancelled"),
		{ outcome: "cancelled" },
		"only an answer outranks the stop",
	);
	assert.deepEqual(
		askCliSettlement(ask({ choices }), { ...complete, outcome: "exited", exitCode: 0 }, "timeout"),
		{ outcome: "answered", answer: { choice: "publish" } },
		"a finished call that the deadline overtook keeps its answer",
	);
	const { core: rex, transport } = core();
	const stop = new AbortController();
	transport.answer = () => {
		stop.abort();
		return { ...reply({ answer: "publish", version: 1 }), outcome: "cancelled", exitCode: null };
	};
	const result = await rex.execute(ask({ choices }), { ...context, signal: stop.signal });
	assert.equal(result.outcome, "answered");
	assert.deepEqual((result.data as { answer?: unknown }).answer, { choice: "publish" });
});

test("cancelling a question stops the action call, which closes the question in every app", async () => {
	const { core: rex, transport } = core();
	let started!: () => void;
	const asked = new Promise<void>((resolve) => {
		started = resolve;
	});
	transport.answer = (_args, call) =>
		new Promise((resolve) => {
			started();
			call.signal?.addEventListener("abort", () => resolve({ ...reply({}), outcome: "cancelled", exitCode: 130 }), {
				once: true,
			});
		});
	const stop = new AbortController();
	const pending = rex.execute(ask(), { ...context, signal: stop.signal });
	await asked;
	stop.abort();
	const result = await pending;
	assert.equal(result.outcome, "cancelled");
	assert.equal((result.data as { question?: string }).question, "harness: Publish the change?");
});

function dialogs(
	script: Array<string | undefined>,
	seen: Array<{ title: string; options?: string[] }> = [],
): AskDialogs {
	return {
		select: async (title, options) => {
			seen.push({ title, options });
			return script.shift();
		},
		input: async (title) => {
			seen.push({ title });
			return script.shift();
		},
	};
}

test("a session's own dialog asks the same question forms", async () => {
	const signal = new AbortController().signal;
	const seen: Array<{ title: string; options?: string[] }> = [];
	assert.deepEqual(await askInDialog(ask({ choices }), "Publish?", dialogs(["Publish"], seen), signal, 60000), {
		outcome: "answered",
		answer: { choice: "publish" },
	});
	assert.deepEqual(seen[0]?.options, ["Hold · Do not publish", "Publish"]);
	assert.deepEqual(
		await askInDialog(
			ask({ choices, allowOther: true }),
			"When?",
			dialogs(["Other: type an answer", "tomorrow"]),
			signal,
			60000,
		),
		{ outcome: "answered", answer: { text: "tomorrow" } },
	);
	assert.deepEqual(
		await askInDialog(
			ask({ choices, multiple: true }),
			"Which?",
			dialogs(["[ ] Publish", "[ ] Hold · Do not publish", "[x] Hold · Do not publish", "Done"]),
			signal,
			60000,
		),
		{ outcome: "answered", answer: { choices: ["publish"] } },
	);
	assert.deepEqual(
		await askInDialog(ask({ value: "feature/x" }), "Branch?", dialogs(['Use "feature/x"']), signal, 60000),
		{ outcome: "answered", answer: { text: "feature/x" } },
	);
	assert.deepEqual(
		await askInDialog(
			ask({ value: "feature/x" }),
			"Branch?",
			dialogs(["Type another answer", "feature/y"]),
			signal,
			60000,
		),
		{ outcome: "answered", answer: { text: "feature/y" } },
	);
	assert.deepEqual(await askInDialog(ask(), "Name?", dialogs([undefined]), signal, 60000), { outcome: "declined" });
	const duplicate = await askInDialog(
		ask({
			choices: [
				{ id: "a", title: "Same" },
				{ id: "b", title: "Same" },
			],
		}),
		"Which?",
		dialogs(["Same [b]"]),
		signal,
		60000,
	);
	assert.deepEqual(duplicate, { outcome: "answered", answer: { choice: "b" } }, "repeated titles stay distinguishable");
	const crafted = [
		{ id: "a", title: "Same" },
		{ id: "b", title: "Same" },
		{ id: "c", title: "Same [b]" },
		{ id: "d", title: "Done" },
	];
	const labels = choiceLabels(crafted);
	assert.equal(new Set(labels).size, labels.length, `every label names one choice: ${labels.join(" | ")}`);
	assert.ok(!labels.includes("Done"), "a choice never takes the label of the dialog's own row");
	assert.deepEqual(await askInDialog(ask({ choices: crafted }), "Which?", dialogs([labels[2]]), signal, 60000), {
		outcome: "answered",
		answer: { choice: "c" },
	});
	assert.deepEqual(
		await askInDialog(
			ask({ choices: crafted, multiple: true }),
			"Which?",
			dialogs([`[ ] ${labels[2]}`, "Done"]),
			signal,
			60000,
		),
		{ outcome: "answered", answer: { choices: ["c"] } },
	);
});

function ordinary(execute: (request: RexRequest, context: RexCallContext) => Promise<RexResult>) {
	const tools = new Map<string, ToolDefinition<Schema>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		events: createEventBus(),
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerTool: (tool: ToolDefinition<Schema>) => tools.set(tool.name, tool),
		registerCommand: () => {},
		appendEntry: () => {},
		getSessionName: () => "release review",
	} as unknown as ExtensionAPI;
	registerRex(pi, { createCore: () => ({ dispose: () => {}, execute }) });
	const tool = tools.get("rex_ask");
	assert.ok(tool);
	return { tool, handlers };
}
const unreached = (outcome: string): RexResult => ({
	ok: false,
	outcome,
	data: { question: "release review: Publish the change?", channel: "rex" },
	error: "Rex could not ask.",
	effects: { state: "none" },
	coverage: { bounded: true },
});
const structured = (result: { structuredContent?: unknown }) =>
	result.structuredContent as unknown as RexResult & { data: Record<string, unknown> };

test("an ordinary session asks in its own dialog when Rex cannot show the question", async () => {
	let asker: string | undefined;
	const { tool, handlers } = ordinary(async (_request, context) => {
		asker = context.asker;
		return unreached("not_configured");
	});
	const seen: Array<{ title: string; options?: string[] }> = [];
	const ctx = {
		cwd: "/work/harness",
		hasUI: true,
		ui: dialogs(["Hold · Do not publish"], seen),
		isIdle: () => false,
		sessionManager: { getSessionId: () => "ask-session", getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	try {
		const result = structured(await tool.execute("ask-call", ask({ choices }), undefined, undefined, ctx));
		assert.equal(asker, "release review", "the session name tells the operator who asks");
		assert.equal(result.ok, true);
		assert.equal(result.outcome, "answered");
		assert.deepEqual(result.data.answer, { choice: "hold" });
		assert.equal(result.data.channel, "dialog");
		assert.deepEqual(result.data.rex, { outcome: "not_configured", reason: "Rex could not ask." });
		assert.match(result.coverage.note ?? "", /not configured/);
		assert.equal(seen[0]?.title, "Publish the change?");
		const headless = { ...ctx, hasUI: false } as unknown as ExtensionToolContext;
		const reported = structured(await tool.execute("ask-headless", ask({ choices }), undefined, undefined, headless));
		assert.equal(reported.outcome, "not_configured", "a session without dialogs reports Rex's outcome");
		for (const outcome of ["declined", "timeout", "failed"]) {
			const { tool: settled } = ordinary(async () => unreached(outcome));
			assert.equal(
				structured(await settled.execute("ask-settled", ask(), undefined, undefined, ctx)).outcome,
				outcome,
				`${outcome} opens no dialog`,
			);
		}
	} finally {
		await handlers.get("session_shutdown")?.();
	}
});

test("Show me first focuses the launch block once and continues the same question in Pi", async (t) => {
	t.mock.property(process, "env", { ...process.env, REX_SESSION: pane.session, REX_BLOCK: pane.block });
	for (const [path, selection, outcome, focusFails] of [
		["answer", "Hold · Do not publish", "answered", false],
		["Escape", undefined, "declined", false],
		["operator message", undefined, "superseded", false],
		["too late", undefined, "timeout", false],
		["focus failed", "Hold · Do not publish", "answered", true],
	] as const) {
		const { core: rex, transport } = core();
		let focused = false;
		transport.view = () => paneView("composer");
		transport.answer = () => reply({ answer: ASK_SHOW_FIRST_ID });
		transport.focus = () => {
			focused = true;
			return focusFails ? reply({ error: "not_found" }, 1) : reply({ revision: 2 });
		};
		const { tool, handlers } = ordinary((request, context) => {
			if (path === "too late" && context.budget) t.mock.method(context.budget, "elapsed", () => (focused ? 9500 : 0));
			return rex.execute(request, context);
		});
		const ui = {
			...dialogs([]),
			select: async (title: string, options: string[], time?: { timeout?: number }) => {
				assert.ok(focused, "Rex attempts focus before Pi asks");
				assert.equal(title, "Publish the change?");
				assert.deepEqual(options, ["Hold · Do not publish", "Publish"]);
				assert.ok(time?.timeout && time.timeout <= 10000);
				if (path === "operator message")
					await handlers.get("input")?.({ source: "interactive", text: "Leave it as is." }, ctx);
				return selection;
			},
		};
		const select = t.mock.method(ui, "select");
		const ctx = {
			cwd: "/work",
			hasUI: true,
			ui,
			sessionManager: { getSessionId: () => "ask-session", getEntries: () => [], getSessionFile: () => undefined },
		} as unknown as ExtensionToolContext;
		try {
			const result = structured(
				await tool.execute("ask-call", ask({ choices, timeoutMs: 10000 }), undefined, undefined, ctx),
			);
			const apis = transport.calls.flatMap(({ args }) =>
				args.includes("api") ? [args.slice(args.indexOf("call") + 1)] : [],
			);
			assert.deepEqual(apis, [
				["session.view", JSON.stringify({ session_id: pane.session })],
				["session.focus_block", JSON.stringify({ session_id: pane.session, block_id: pane.block })],
			]);
			assert.equal(select.mock.callCount(), path === "too late" ? 0 : 1, path);
			assert.equal(result.outcome, outcome, path);
			assert.equal(result.ok, outcome === "answered", path);
			assert.equal(result.data.channel, "dialog", path);
			assert.deepEqual(result.data.rex, { outcome: "show" }, path);
			assert.match(String(result.data.meaning), /chose to see this session first/, path);
			assert.deepEqual(result.data.answer, outcome === "answered" ? { choice: "hold" } : undefined, path);
			if (focusFails) assert.match(result.coverage.note ?? "", /could not confirm focus/);
		} finally {
			await handlers.get("session_shutdown")?.();
		}
	}
});

test("a message from the operator ends a waiting question", async () => {
	let started!: () => void;
	const waiting = new Promise<void>((resolve) => {
		started = resolve;
	});
	const { tool, handlers } = ordinary(
		(_request, context) =>
			new Promise((resolve) => {
				started();
				context.signal?.addEventListener(
					"abort",
					() =>
						resolve({
							ok: false,
							outcome: "cancelled",
							data: { question: "release review: Publish the change?", channel: "rex" },
							error: "stopped",
							effects: { state: "none" },
							coverage: { bounded: true },
						}),
					{ once: true },
				);
			}),
	);
	const ctx = {
		cwd: "/work",
		hasUI: true,
		ui: dialogs([]),
		isIdle: () => false,
		sessionManager: { getSessionId: () => "ask-session", getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	try {
		const pending = tool.execute("ask-call", ask(), undefined, undefined, ctx);
		await waiting;
		await handlers.get("input")?.({ source: "extension", text: "injected" }, ctx);
		await handlers.get("input")?.({ source: "interactive", text: "Hold it, I will publish myself." }, ctx);
		const result = structured(await pending);
		assert.equal(result.outcome, "superseded");
		assert.equal(result.ok, false);
		assert.equal(result.data.question, "release review: Publish the change?");
		assert.match(String(result.data.meaning), /typed into this session while the question waited/);
	} finally {
		await handlers.get("session_shutdown")?.();
	}
});

test("an answer that arrives before the operator's message stands", async () => {
	const { tool, handlers } = ordinary(
		(_request, context) =>
			new Promise((resolve) => {
				context.signal?.addEventListener(
					"abort",
					() =>
						resolve({
							ok: true,
							outcome: "answered",
							data: { question: "release review: Publish the change?", channel: "rex", answer: { choice: "hold" } },
							effects: { state: "none" },
							coverage: { bounded: true },
						}),
					{ once: true },
				);
				void Promise.resolve(handlers.get("input")?.({ source: "interactive", text: "and one more thing" }, {}));
			}),
	);
	const ctx = {
		cwd: "/work",
		hasUI: true,
		ui: dialogs([]),
		isIdle: () => false,
		sessionManager: { getSessionId: () => "ask-session", getEntries: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext;
	try {
		const result = structured(await tool.execute("ask-call", ask({ choices }), undefined, undefined, ctx));
		assert.equal(result.outcome, "answered");
		assert.deepEqual(result.data.answer, { choice: "hold" });
	} finally {
		await handlers.get("session_shutdown")?.();
	}
});

test("a question whose wait ran out before Rex could show it says so", async () => {
	const { core: rex, transport } = core();
	const signal = new AbortController().signal;
	const budget = {
		effectiveMs: 40000,
		startedAt: 0,
		workEndsAt: 39000,
		endsAt: 40000,
		signal,
		finaliseSignal: signal,
		phase: "resolve",
		elapsed: () => 9500,
		remaining: () => 30000,
		check: () => {},
		stopReason: () => undefined,
		dispose: () => {},
	};
	const result = await rex.execute(ask({ timeoutMs: 10000 }), { ...context, budget: budget as never });
	assert.equal(result.outcome, "timeout");
	assert.match(result.error ?? "", /took the whole wait before the question could be shown/);
	assert.equal(
		transport.calls.some((entry) => entry.args.includes("do")),
		false,
		"nothing was asked",
	);
});
