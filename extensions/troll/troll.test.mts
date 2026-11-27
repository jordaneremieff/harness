import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	EndpointError,
	endpointPath,
	liveEndpoints,
	liveEndpoint,
	openEndpoint,
	parseReply,
	parseRequest,
	parseStatus,
	submit,
	sweepEndpoints,
} from "./endpoint.ts";
import {
	type BranchEntry,
	clip,
	replyContent,
	replyFromBranch,
	roundState,
	storedRole,
	waitingRounds,
} from "./exchange.ts";
import trollExtension, { registerTroll } from "./index.ts";
import {
	findPi,
	type Helper,
	openingMessage,
	openPane,
	paneBounds,
	parseOriginFlag,
	parseTrollArgs,
	trollArgv,
} from "./launch.ts";
import { readSettings } from "./settings.ts";

const settings = { width: 0.34, left: 0.01, top: 0.016 };
const scratch = () => mkdtempSync(join(tmpdir(), "tr-"));
const message = (id: string, role: string, content: unknown, extra: object = {}): BranchEntry => ({
	type: "message",
	id,
	message: { role, content, ...extra },
});
const submitRequest = {
	version: 1,
	op: "submit",
	target: "target-1",
	from: "troll-1",
	round: 1,
	text: "Why?",
} as const;
async function until(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(check(), "the expected event did not arrive");
}
function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
	const server = createServer(onConnection);
	return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

test("the troll starts the operator's pi from PATH with the configured model and the operator's words", () => {
	const root = scratch();
	try {
		const plain = join(root, "plain");
		const bin = join(root, "bin");
		mkdirSync(plain);
		mkdirSync(bin);
		writeFileSync(join(plain, "pi"), "not executable");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
		chmodSync(join(bin, "pi"), 0o755);
		assert.equal(findPi({ PATH: ["relative", plain, bin].join(":") }), join(bin, "pi"));
		assert.equal(findPi({ PATH: plain }), undefined);
		assert.equal(findPi({}), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const origin = { id: "01a2-origin", pid: 4242, name: "Editor sidebar" };
	assert.equal(
		openingMessage(origin, "push on the cache claim"),
		'The operator ran /troll in session 01a2-origin ("Editor sidebar").\nInstruction: push on the cache claim',
	);
	assert.equal(
		openingMessage({ id: "01a2-origin", pid: 1 }, ""),
		"The operator ran /troll in session 01a2-origin without an instruction.",
	);
	assert.deepEqual(trollArgv("/bin/pi", origin, "-hello", settings), [
		"/bin/pi",
		"--unregistered",
		"--troll",
		"01a2-origin@4242",
		"--name",
		"Troll",
		"--",
		"-hello",
	]);
	assert.deepEqual(
		trollArgv("/bin/pi", origin, "x", { ...settings, model: "provider/model", thinkingLevel: "high" }).slice(4, 8),
		["--model", "provider/model", "--thinking", "high"],
	);
	assert.deepEqual(parseOriginFlag("01a2-origin@4242"), { id: "01a2-origin", pid: 4242 });
	assert.deepEqual(parseOriginFlag("01a2-origin"), { id: "01a2-origin" });
	assert.deepEqual(parseOriginFlag("01a2-origin@x"), { id: "01a2-origin" });
	assert.equal(parseOriginFlag(""), undefined);
	assert.equal(parseOriginFlag(undefined), undefined);
	assert.deepEqual(paneBounds(settings), { bounds: [0.01, 0.016, 0.34, 0.34], square: true });
	assert.deepEqual(paneBounds({ ...settings, height: 0.5 }), { bounds: [0.01, 0.016, 0.34, 0.5], square: false });
});

test("/troll consumes only a known model and its optional thinking level before the free-form instruction", () => {
	const hasModel = (provider: string, id: string) => provider === "provider" && id === "model";
	for (const [args, expected] of [
		["", { instruction: "" }],
		["provider/model", { model: "provider/model", instruction: "" }],
		["provider/model max", { model: "provider/model", thinkingLevel: "max", instruction: "" }],
		[
			" provider/model\thigh\nCheck the premise.\nThen check the result. ",
			{
				model: "provider/model",
				thinkingLevel: "high",
				instruction: "Check the premise.\nThen check the result.",
			},
		],
		["provider/model verify this", { model: "provider/model", instruction: "verify this" }],
		["src/cache check the times", { instruction: "src/cache check the times" }],
		["high uncertainty warrants another check", { instruction: "high uncertainty warrants another check" }],
	] as const)
		assert.deepEqual(parseTrollArgs(args, hasModel), expected);
});

test("troll model and level settings supply the launch unless the command overrides them", () => {
	const dir = scratch();
	try {
		writeFileSync(
			join(dir, "harness.json"),
			JSON.stringify({
				version: 1,
				troll: { model: "provider/default", thinkingLevel: "medium" },
			}),
		);
		const defaults = readSettings({ agentDir: dir, env: {} }).values;
		const argv = (args: string) => {
			const { instruction, ...overrides } = parseTrollArgs(
				args,
				(provider, id) => provider === "provider" && id === "override",
			);
			const origin = { id: "origin", pid: 1 };
			return trollArgv("/bin/pi", origin, openingMessage(origin, instruction), { ...defaults, ...overrides });
		};
		assert.deepEqual(argv("").slice(4, 8), ["--model", "provider/default", "--thinking", "medium"]);
		assert.deepEqual(argv("provider/override").slice(4, 8), ["--model", "provider/override", "--thinking", "medium"]);
		const override = argv("provider/override off Check the trace.");
		assert.deepEqual(override.slice(4, 8), ["--model", "provider/override", "--thinking", "off"]);
		assert.match(override.at(-1) ?? "", /\nInstruction: Check the trace\.$/u);
		assert.deepEqual(argv("").slice(4, 8), ["--model", "provider/default", "--thinking", "medium"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the pane opens only over a captured Rex origin and reports Rex's outcome", async () => {
	const request = {
		argv: ["/bin/pi"],
		cwd: "/work",
		bounds: [0.01, 0.016, 0.34, 0.34] as [number, number, number, number],
		square: true,
	};
	const calls: Array<{ program: string; verb: string; input?: object }> = [];
	const helper =
		(origin: unknown, result: unknown): Helper =>
		async (program, verb, input) => {
			calls.push({ program, verb, input });
			return verb === "capture" ? origin : result;
		};
	assert.equal((await openPane(request, helper(null, undefined))).outcome, "unavailable");
	assert.equal(calls.length, 1, "no pane request without an exact origin");
	const origin = { version: 1, terminal: "Rex", exact: { blockId: "block:1" } };
	const created = await openPane(request, helper(origin, { version: 1, outcome: "created", detail: "Created." }));
	assert.deepEqual(created, { outcome: "created", detail: "Created." });
	const float = calls.at(-1);
	assert.equal(float?.verb, "float");
	assert.match(float?.program ?? "", /extensions\/rex\/terminal-pane\.ts$/u);
	assert.deepEqual(float?.input, {
		version: 1,
		origin,
		argv: request.argv,
		cwd: request.cwd,
		bounds: request.bounds,
		square: true,
		label: "shell",
	});
	await openPane({ ...request, square: false }, helper(origin, { outcome: "created", detail: "Created." }));
	assert.equal(Object.hasOwn(calls.at(-1)?.input ?? {}, "square"), false);
	assert.equal((await openPane(request, helper(origin, { outcome: "made" }))).outcome, "uncertain");
	assert.equal((await openPane(request, helper(origin, { outcome: "stale", detail: "Gone." }))).outcome, "stale");
});

test("protocol lines are strict", () => {
	assert.deepEqual(parseRequest(JSON.stringify(submitRequest)), submitRequest);
	for (const bad of [
		{ ...submitRequest, target: "../x" },
		{ ...submitRequest, round: 0 },
		{ ...submitRequest, text: " " },
		{ ...submitRequest, extra: true },
		{ ...submitRequest, op: "reply" },
		{ ...submitRequest, text: "x".repeat(65537) },
	])
		assert.throws(() => parseRequest(JSON.stringify(bad)));
	assert.deepEqual(parseStatus('{"version":1,"type":"status","outcome":"busy","detail":"Working."}'), {
		version: 1,
		type: "status",
		outcome: "busy",
		detail: "Working.",
	});
	assert.throws(() => parseStatus('{"version":1,"type":"status","outcome":"done","detail":"x"}'));
	assert.throws(() => parseStatus('{"version":1,"type":"status","outcome":"busy","detail":"a\\nb"}'));
	const reply = { version: 1, type: "reply", outcome: "answered", text: "Yes.", truncated: false, otherInputs: 0 };
	assert.deepEqual(parseReply(JSON.stringify(reply)), reply);
	assert.throws(() => parseReply(JSON.stringify({ ...reply, outcome: "agreed" })));
	assert.throws(() => parseReply(JSON.stringify({ ...reply, otherInputs: -1 })));
	assert.throws(() => endpointPath("/tmp", "bad id", 1));
	assert.throws(() => endpointPath(`/${"d".repeat(90)}`, "target-1", 1), /too long/u);
	assert.equal(endpointPath("/tmp/troll", "target-1", 42), "/tmp/troll/target-1.42.sock");
});

test("an accepted submission keeps its connection until the reply, and a closed connection reports no reply", async () => {
	const dir = join(scratch(), "troll");
	const endpoint = await openEndpoint(dir, "target-1", (exchange) => {
		if (exchange.request.text === "Busy?") return exchange.status("busy", "Working.");
		exchange.status("submitted", "Started.");
		setTimeout(() => exchange.reply({ outcome: "answered", text: "Because.", truncated: false, otherInputs: 0 }), 20);
	});
	try {
		assert.equal(endpoint.path, endpointPath(dir, "target-1", process.pid));
		const busy = await submit(endpoint.path, { ...submitRequest, text: "Busy?" });
		assert.equal(busy.status.outcome, "busy");
		assert.equal(await busy.reply, undefined);
		const accepted = await submit(endpoint.path, submitRequest);
		assert.equal(accepted.status.outcome, "submitted");
		assert.deepEqual(await accepted.reply, {
			version: 1,
			type: "reply",
			outcome: "answered",
			text: "Because.",
			truncated: false,
			otherInputs: 0,
		});
		const invalid = await submit(endpoint.path, { ...submitRequest, round: 0 });
		assert.equal(invalid.status.outcome, "refused");
	} finally {
		endpoint.close();
	}
	assert.equal(existsSync(endpointPath(dir, "target-1", process.pid)), false);
	await assert.rejects(
		submit(endpointPath(dir, "target-1", process.pid), submitRequest),
		(error: unknown) => error instanceof EndpointError && error.reason === "absent",
	);
	const ended = join(dir, "ended.sock");
	const server = await listen(ended, (socket) => {
		socket.once("data", () => {
			socket.write('{"version":1,"type":"status","outcome":"submitted","detail":"Started."}\n');
			setTimeout(() => socket.destroy(), 20);
		});
	});
	try {
		const lost = await submit(ended, submitRequest);
		assert.equal(lost.status.outcome, "submitted");
		assert.equal(await lost.reply, undefined, "a target that ends without a reply leaves no reply");
	} finally {
		server.close();
	}
});

test("the request deadline covers only the request, so a slow status still arrives", async () => {
	const dir = join(scratch(), "troll");
	const endpoint = await openEndpoint(
		dir,
		"slow-1",
		(exchange) => void setTimeout(() => exchange.status("waiting", "Not started yet."), 150),
		{ requestDeadlineMs: 50 },
	);
	try {
		const slow = await submit(endpoint.path, { ...submitRequest, target: "slow-1" });
		assert.equal(slow.status.outcome, "waiting");
		slow.close();
		assert.equal(await slow.reply, undefined);
	} finally {
		endpoint.close();
	}
});

test("live endpoints are the sockets of running processes that answer, and a sweep removes those of ended ones", async () => {
	const dir = join(scratch(), "troll");
	const own = await openEndpoint(dir, "target-1", (exchange) => exchange.status("refused", "No."));
	const other = await listen(endpointPath(dir, "target-1", 77777), () => {});
	try {
		writeFileSync(endpointPath(dir, "target-1", 88888), "");
		writeFileSync(endpointPath(dir, "elsewhere-1", 99999), "");
		writeFileSync(join(dir, "notes.txt"), "");
		for (let index = 0; index < 600; index++) writeFileSync(join(dir, `aaa-${index}.2.sock`), "");
		const alive = (pid: number) => pid !== 88888 && pid !== 99999;
		assert.deepEqual(
			(await liveEndpoints(dir, "target-1", alive)).map((found) => found.pid).sort(),
			[77777, process.pid].sort(),
			"many sockets of other sessions do not hide the target's",
		);
		assert.deepEqual(await liveEndpoints(dir, "nobody-1", alive), []);
		assert.equal(await liveEndpoint(dir, "target-1", process.pid, alive), own.path);
		assert.equal(await liveEndpoint(dir, "target-1", 88888, alive), undefined);
		sweepEndpoints(dir, alive);
		assert.equal(existsSync(endpointPath(dir, "target-1", 88888)), true, "a socket younger than a minute stays");
		sweepEndpoints(dir, alive, Date.now() + 120000);
		assert.equal(existsSync(endpointPath(dir, "target-1", 88888)), false);
		assert.equal(existsSync(endpointPath(dir, "elsewhere-1", 99999)), false);
		assert.equal(existsSync(endpointPath(dir, "target-1", 77777)), true);
		assert.equal(existsSync(own.path), true);
		assert.equal(existsSync(join(dir, "notes.txt")), true, "only socket names are swept");
		const again = await openEndpoint(dir, "target-1", (exchange) => exchange.status("refused", "No."));
		assert.equal(again.path, own.path, "a later instance in the same process replaces its own socket");
		again.close();
	} finally {
		own.close();
		other.close();
	}
});

test("the reply is the last public answer after the first copy of the submitted message", () => {
	const submitted = { text: "Why X?", leaf: "a1" };
	const branch = [
		message("u0", "user", "Why X?"),
		message("a1", "assistant", [{ type: "text", text: "Old answer" }]),
		message("u1", "user", [{ type: "text", text: "Why X?" }]),
		message("a2", "assistant", [
			{ type: "text", text: "Checking." },
			{ type: "toolCall", id: "t" },
		]),
		message("r2", "toolResult", [{ type: "text", text: "tool output" }], { toolName: "read" }),
		message("a3", "assistant", [{ type: "text", text: "Because Y." }]),
	];
	assert.deepEqual(replyFromBranch(branch, submitted, false), {
		outcome: "answered",
		text: "Because Y.",
		truncated: false,
		otherInputs: 0,
	});
	const repeated = [
		...branch,
		message("u2", "user", "Why X?"),
		message("a4", "assistant", [{ type: "text", text: "Same again." }]),
	];
	assert.deepEqual(
		replyFromBranch(repeated, submitted, true),
		{ outcome: "aborted", text: "Same again.", truncated: false, otherInputs: 1 },
		"the operator's identical message counts as other input",
	);
	assert.equal(replyFromBranch(branch.slice(0, 2), submitted, false).outcome, "not-run");
	assert.equal(replyFromBranch(branch.slice(0, 3), submitted, false).outcome, "unanswered");
	assert.equal(replyFromBranch(branch, { text: "Why X?", leaf: "gone" }, false).outcome, "not-run");
	assert.deepEqual(clip("aé".repeat(3), 4), { text: "aéa", truncated: true });
});

test("round state counts submissions and retains halts until the operator writes", () => {
	const sent = (id: string, outcome = "submitted", round = 1) =>
		message(id, "toolResult", [], { toolName: "troll_submit", details: { outcome, session: "target-1", round } });
	const replyEntry = (id: string, details: object): BranchEntry => ({
		type: "custom_message",
		id,
		customType: "troll-reply",
		details: { from: "target-1", round: 1, ...details },
	});
	const opening = message("u0", "user", "The operator ran /troll in session x.");
	assert.deepEqual(roundState([opening]), { rounds: 0 });
	const three = [
		opening,
		sent("s1"),
		replyEntry("r1", { outcome: "answered", otherInputs: 0 }),
		sent("s2", "waiting", 2),
		sent("s3", "uncertain", 3),
	];
	assert.deepEqual(roundState(three), { rounds: 3 });
	assert.deepEqual(roundState([...three, message("u1", "user", "Press again.")]), { rounds: 0 });
	for (const outcome of ["aborted", "unanswered", "not-run", "not-started", "closed", "lost", "restarted"])
		assert.match(
			roundState([opening, sent("s1"), replyEntry("r1", { outcome, otherInputs: 0 })]).halt ?? "",
			/did not end/u,
		);
	assert.match(
		roundState([opening, sent("s1"), replyEntry("r1", { outcome: "answered", otherInputs: 2 })]).halt ?? "",
		/added input/u,
	);
	assert.deepEqual(roundState([opening, sent("s1", "busy")]), { rounds: 0 });
	assert.deepEqual(
		waitingRounds([opening, sent("s1"), replyEntry("r1", { outcome: "answered" }), sent("s2", "waiting", 2)]),
		[{ session: "target-1", round: 2 }],
	);
	assert.deepEqual(waitingRounds([opening, sent("s1", "uncertain")]), []);
	const inFlight: BranchEntry = {
		type: "custom",
		id: "m1",
		customType: "troll-sent",
		data: { session: "target-1", round: 1 },
	};
	assert.deepEqual(
		waitingRounds([opening, inFlight]),
		[{ session: "target-1", round: 1 }],
		"a round cut off mid-call waits",
	);
	assert.deepEqual(waitingRounds([opening, inFlight, sent("s1", "busy")]), []);
	const role = (data: unknown): BranchEntry => ({ type: "custom", id: "r", customType: "troll-role", data });
	assert.deepEqual(storedRole([role({ id: "a-1", pid: 5 }), role({ id: "b-1" })]), { id: "b-1" });
	assert.equal(storedRole([opening]), undefined);
	const content = replyContent("target-1", 2, {
		outcome: "answered",
		text: "Because Y.",
		truncated: true,
		otherInputs: 1,
	});
	assert.match(content, /^Session target-1, troll round 2\.\nIts run ended with this answer\./u);
	assert.match(content, /1 other message in that session/u);
	assert.match(content, /cut at 64 KB/u);
	assert.match(content, /\n\nBecause Y\.$/u);
	assert.doesNotMatch(content, /Submit the next round/u, "operator input in the target ends automatic rounds");
	assert.match(
		replyContent("target-1", 3, { outcome: "answered", text: "Because Y.", truncated: false, otherInputs: 0 }),
		/^Session target-1, troll round 3\.\nIts run ended with this answer\.\nSubmit the next round unless a stop reason from your instructions holds\.[^\n]*\n\nBecause Y\.$/u,
	);
	const lost = replyContent("target-1", 1, { outcome: "lost", text: "", truncated: false, otherInputs: 0 });
	assert.match(lost, /Read the target's history/u);
	assert.doesNotMatch(lost, /Submit the next round/u);
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { details: Record<string, unknown> };
function fakePi(
	flags: Record<string, string> = {},
	onUserMessage?: (text: string) => void,
	branch: BranchEntry[] = [],
) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<ToolResult> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const userMessages: string[] = [];
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, definition),
		registerTool: (definition: { name: string; execute: (...args: unknown[]) => Promise<ToolResult> }) =>
			tools.set(definition.name, definition),
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) =>
			sent.push({ message, options }),
		sendUserMessage: (text: string) => {
			userMessages.push(text);
			onUserMessage?.(text);
		},
		appendEntry: (customType: string, data: unknown) =>
			branch.push({ type: "custom", id: `c${branch.length}`, customType, data }),
	};
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, tools, commands, sent, userMessages, fire };
}
function fakeContext(id: string, branch: BranchEntry[], state: { idle: boolean } = { idle: true }) {
	const notes: Array<{ text: string; level: string }> = [];
	return {
		mode: "tui",
		cwd: "/work",
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => undefined,
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
		},
		notes,
	};
}
async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = scratch();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}
const timing = { startWaitMs: 100, giveUpMs: 200 };
/** Pi starts a run for a submitted message: its before_agent_start event carries the message as the prompt. */
const startsRun =
	(extension: () => { fire: (name: string, event: unknown, ctx: unknown) => Promise<void> }, ctx: unknown) =>
	(text: string) =>
		setImmediate(
			() =>
				void extension().fire(
					"before_agent_start",
					{ messageType: "user", prompt: text, systemPromptOptions: { sections: {} } },
					ctx,
				),
		);
const outcomeOf = (sent: { message: Record<string, unknown> } | undefined) =>
	(sent?.message.details as Record<string, unknown> | undefined)?.outcome;

test("a troll submits as the operator through a fourth round, receives replies, and halts after interruption", async () => {
	await withAgentDir(async (agentDir) => {
		const targetBranch = [message("a1", "assistant", [{ type: "text", text: "Use a cache." }])];
		const targetState = { idle: true };
		const targetContext = fakeContext("target-1", targetBranch, targetState);
		const target = fakePi(
			{},
			startsRun(() => target, targetContext),
		);
		const trollBranch = [message("u0", "user", "The operator ran /troll in session target-1 without an instruction.")];
		const troll = fakePi({ troll: `target-1@${process.pid}` }, undefined, trollBranch);
		registerTroll(target.pi as never, timing);
		registerTroll(troll.pi as never, timing);
		const trollContext = fakeContext("troll-1", trollBranch);
		try {
			await target.fire("session_start", {}, targetContext);
			await troll.fire("session_start", {}, trollContext);
			assert.equal(target.tools.has("troll_submit"), false, "only a troll session submits");
			const submitTool = troll.tools.get("troll_submit");
			assert.ok(submitTool);
			const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await troll.fire("before_agent_start", prompt, trollContext);
			assert.match(prompt.systemPromptOptions.sections.troll ?? "", /^# Troll/u);
			const plainPrompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await target.fire("before_agent_start", plainPrompt, targetContext);
			assert.equal(plainPrompt.systemPromptOptions.sections.troll, undefined);
			const call = (session: string, text: string) =>
				submitTool.execute("call", { session, message: text }, undefined, undefined, trollContext);

			targetState.idle = false;
			assert.equal((await call("target-1", "What does the cache save?")).details.outcome, "busy");
			assert.deepEqual(target.userMessages, []);
			targetState.idle = true;
			assert.equal((await call("nobody-1", "Hello")).details.outcome, "unavailable");
			assert.equal((await call("troll-1", "Hello")).details.outcome, "refused");

			assert.deepEqual(
				trollBranch.find((entry) => entry.customType === "troll-role")?.data,
				{ id: "target-1", pid: process.pid },
				"the session records its troll role",
			);
			const aborted = new AbortController();
			aborted.abort();
			await assert.rejects(
				submitTool.execute("call", { session: "target-1", message: "Stop." }, aborted.signal, undefined, trollContext),
				{ name: "AbortError" },
			);
			assert.deepEqual(target.userMessages, [], "a cancelled call sends nothing");
			const sent = await call("target-1", "What does the cache save?");
			assert.deepEqual(sent.details, { outcome: "submitted", session: "target-1", round: 1 });
			assert.deepEqual(
				trollBranch.at(-1)?.data,
				{ session: "target-1", round: 1 },
				"the round is marked before it goes out",
			);
			assert.deepEqual(target.userMessages, ["What does the cache save?"]);
			assert.match(targetContext.notes.at(-1)?.text ?? "", /Troll round 1/u);
			assert.equal((await call("target-1", "And?")).details.outcome, "busy", "one troll message runs at a time");

			targetBranch.push(
				message("u1", "user", "What does the cache save?"),
				message("a2", "assistant", [{ type: "text", text: "About 40 ms per request." }]),
			);
			await target.fire("agent_settled", { aborted: false }, targetContext);
			await until(() => troll.sent.length === 1);
			const [{ message: reply, options }] = troll.sent;
			assert.equal(reply.customType, "troll-reply");
			assert.match(String(reply.content), /troll round 1\.[\s\S]*About 40 ms per request\.$/u);
			assert.deepEqual(reply.details, {
				from: "target-1",
				round: 1,
				outcome: "answered",
				otherInputs: 0,
				truncated: false,
			});
			assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });

			const retainRound = (result: ToolResult, notice: Record<string, unknown>, round: number) => {
				trollBranch.push(
					message(`submit-${round}`, "toolResult", [], { toolName: "troll_submit", details: result.details }),
					{ type: "custom_message", id: `reply-${round}`, customType: "troll-reply", details: notice.details },
				);
			};
			retainRound(sent, reply, 1);
			for (const round of [2, 3, 4]) {
				const question = `Check the cache measurement for case ${round}.`;
				const next = await call("target-1", question);
				assert.deepEqual(next.details, { outcome: "submitted", session: "target-1", round });
				targetBranch.push(
					message(`question-${round}`, "user", question),
					message(`answer-${round}`, "assistant", "Measured."),
				);
				await target.fire("agent_settled", { aborted: round === 4 }, targetContext);
				await until(() => troll.sent.length === round);
				retainRound(next, troll.sent[round - 1].message, round);
			}
			const halted = await call("target-1", "Try another measurement.");
			assert.equal(halted.details.outcome, "refused", "an interrupted run still halts submission");
			assert.equal(target.userMessages.length, 4);
		} finally {
			await target.fire("session_shutdown", {}, targetContext);
			await troll.fire("session_shutdown", {}, trollContext);
		}
		assert.equal(existsSync(join(agentDir, "troll", `target-1.${process.pid}.sock`)), false);
	});
});

test("a message whose run never starts is reported as waiting and then as not run, and the target takes the next one", async () => {
	await withAgentDir(async () => {
		const targetContext = fakeContext("target-1", []);
		const target = fakePi();
		const troll = fakePi({ troll: "target-1" });
		registerTroll(target.pi as never, timing);
		registerTroll(troll.pi as never, timing);
		const trollContext = fakeContext("troll-1", [message("u0", "user", "Go.")]);
		try {
			await target.fire("session_start", {}, targetContext);
			await troll.fire("session_start", {}, trollContext);
			const submitTool = troll.tools.get("troll_submit");
			assert.ok(submitTool);
			const first = await submitTool.execute(
				"c1",
				{ session: "target-1", message: "Why?" },
				undefined,
				undefined,
				trollContext,
			);
			assert.equal(first.details.outcome, "waiting");
			await until(() => troll.sent.length === 1);
			assert.equal(outcomeOf(troll.sent[0]), "not-started");
			const second = await submitTool.execute(
				"c2",
				{ session: "target-1", message: "Still?" },
				undefined,
				undefined,
				fakeContext("troll-1", [message("u1", "user", "Try again.")]),
			);
			assert.equal(second.details.outcome, "waiting", "the target is free again");
			await target.fire("session_shutdown", {}, targetContext);
			await until(() => troll.sent.length === 2);
			assert.equal(outcomeOf(troll.sent[1]), "closed");
		} finally {
			await target.fire("session_shutdown", {}, targetContext);
			await troll.fire("session_shutdown", {}, trollContext);
		}
	});
});

test("a troll prefers the origin pane, refuses an ambiguous target and reports rounds that its restart cut off", async () => {
	await withAgentDir(async (agentDir) => {
		const dir = join(agentDir, "troll");
		const targetContext = fakeContext("target-1", []);
		const target = fakePi(
			{},
			startsRun(() => target, targetContext),
		);
		registerTroll(target.pi as never, timing);
		await target.fire("session_start", {}, targetContext);
		// A second running process for the same session: the parent of this test process.
		const second = await listen(endpointPath(dir, "target-1", process.ppid), (socket) => socket.destroy());
		const pending = [
			message("u0", "user", "Go."),
			message("s1", "toolResult", [], {
				toolName: "troll_submit",
				details: { outcome: "submitted", session: "target-1", round: 1 },
			}),
		];
		const viaOrigin = fakePi({ troll: `target-1@${process.pid}` });
		const unsure = fakePi({ troll: "target-1" });
		registerTroll(viaOrigin.pi as never, timing);
		registerTroll(unsure.pi as never, timing);
		const originContext = fakeContext("troll-1", pending);
		const unsureContext = fakeContext("troll-2", [message("u0", "user", "Go.")]);
		try {
			await viaOrigin.fire("session_start", {}, originContext);
			await unsure.fire("session_start", {}, unsureContext);
			assert.equal(viaOrigin.sent.length, 1);
			assert.deepEqual(viaOrigin.sent[0]?.options, {}, "the restart notice starts no turn");
			assert.equal(outcomeOf(viaOrigin.sent[0]), "restarted");
			const ambiguous = await unsure.tools
				.get("troll_submit")
				?.execute("c", { session: "target-1", message: "Why?" }, undefined, undefined, unsureContext);
			assert.equal(ambiguous?.details.outcome, "refused");
			const fromOrigin = await viaOrigin.tools
				.get("troll_submit")
				?.execute(
					"c",
					{ session: "target-1", message: "Why?" },
					undefined,
					undefined,
					fakeContext("troll-1", [message("u1", "user", "Go on.")]),
				);
			assert.equal(fromOrigin?.details.outcome, "submitted");
		} finally {
			second.close();
			await target.fire("session_shutdown", {}, targetContext);
			await viaOrigin.fire("session_shutdown", {}, originContext);
			await unsure.fire("session_shutdown", {}, unsureContext);
		}
	});
});

test("only the troll's own prompt confirms its run, and a resumed troll keeps its role without the flag", async () => {
	await withAgentDir(async () => {
		const targetContext = fakeContext("target-1", []);
		const target = fakePi({}, () =>
			setImmediate(
				() =>
					void target.fire(
						"before_agent_start",
						{ messageType: "user", prompt: "The operator's own message.", systemPromptOptions: { sections: {} } },
						targetContext,
					),
			),
		);
		registerTroll(target.pi as never, timing);
		await target.fire("session_start", {}, targetContext);
		const resumedBranch: BranchEntry[] = [
			{ type: "custom", id: "r0", customType: "troll-role", data: { id: "target-1" } },
			message("u0", "user", "Go."),
		];
		const resumed = fakePi({}, undefined, resumedBranch);
		registerTroll(resumed.pi as never, timing);
		const resumedContext = fakeContext("troll-1", resumedBranch);
		try {
			await resumed.fire("session_start", {}, resumedContext);
			const submitTool = resumed.tools.get("troll_submit");
			assert.ok(submitTool, "the stored role registers the submit tool");
			const prompt = { systemPromptOptions: { sections: {} as Record<string, string> } };
			await resumed.fire("before_agent_start", prompt, resumedContext);
			assert.match(prompt.systemPromptOptions.sections.troll ?? "", /^# Troll/u);
			const result = await submitTool.execute(
				"c",
				{ session: "target-1", message: "Why?" },
				undefined,
				undefined,
				resumedContext,
			);
			assert.equal(result.details.outcome, "waiting", "another prompt's run does not confirm the troll's message");
		} finally {
			await target.fire("session_shutdown", {}, targetContext);
			await resumed.fire("session_shutdown", {}, resumedContext);
		}
	});
});

test("/troll refuses outside the terminal, without its endpoint, without pi or with an oversized instruction, and needs a Rex origin", async () => {
	await withAgentDir(async (agentDir) => {
		const saved = {
			PATH: process.env.PATH,
			REX_SERVER: process.env.REX_SERVER,
			REX_BLOCK: process.env.REX_BLOCK,
			REX_SESSION: process.env.REX_SESSION,
		};
		delete process.env.REX_SERVER;
		delete process.env.REX_BLOCK;
		delete process.env.REX_SESSION;
		const extension = fakePi();
		trollExtension(extension.pi as never);
		const command = extension.commands.get("troll");
		assert.ok(command);
		const context = fakeContext("origin-1", []);
		try {
			await command.handler("", { ...context, mode: "rpc" });
			assert.match(context.notes.at(-1)?.text ?? "", /interactive terminal/u);
			await command.handler("", context);
			assert.match(context.notes.at(-1)?.text ?? "", /could not reach this session/u);
			await extension.fire("session_start", {}, context);
			process.env.PATH = join(agentDir, "empty");
			await command.handler("", context);
			assert.match(context.notes.at(-1)?.text ?? "", /no pi program/u);
			const bin = join(agentDir, "bin");
			mkdirSync(bin);
			writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
			chmodSync(join(bin, "pi"), 0o755);
			process.env.PATH = bin;
			await command.handler("x".repeat(9000), context);
			assert.match(context.notes.at(-1)?.text ?? "", /longer than 8 KB/u);
			await command.handler("push on the cache", context);
			assert.match(context.notes.at(-1)?.text ?? "", /from a Pi pane in Rex/u);
			assert.equal(context.notes.at(-1)?.level, "error");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await extension.fire("session_shutdown", {}, context);
		}
	});
});
