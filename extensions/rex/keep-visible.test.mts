import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { conversationWindow, createConversationKeeper, dockDirection, MAX_FAILED_MOVES, MIN_COVERED_SHARE, paneState, runAnswered } from "./keep-visible.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const CONVERSATION = "block:conversation";
const CREATED = [0.1, 0.1, 0.8, 0.8];

function leaf(blockId: string, rect: number[]) {
	return { block_id: blockId, rect };
}

function floating(blockId: string, bounds: number[]) {
	return { kind: "floating", bounds, layout: leaf(blockId, bounds) };
}

function view(layers: unknown[], options: { zoomed?: string; focus?: string } = {}) {
	return { revision: 3, session_id: "session:test", windows: [
		{ window_id: "window:other", focused_block_id: "block:elsewhere", layers: [{ kind: "tiled", layout: leaf("block:elsewhere", [0, 0, 1, 1]) }] },
		{ window_id: "window:conversation", focused_block_id: options.focus ?? CONVERSATION, zoomed_block_id: options.zoomed ?? null, layers },
	] };
}

const SPLIT_LAYOUT = { split: { direction: "horizontal", before: leaf(CONVERSATION, [0, 0, 0.5, 1]), after: leaf("block:neighbour", [0.5, 0, 0.5, 1]) } };

function stateOf(layers: unknown[], blockId: string, created: number[] | undefined = undefined, options: { zoomed?: string; focus?: string } = {}) {
	const shown = view(layers, options);
	const window = conversationWindow(shown, CONVERSATION);
	assert.ok(window, "the conversation's window allows a move");
	return paneState(shown, window, blockId, created);
}

test("a floating pane that covers the conversation is reported with its share", () => {
	const state = stateOf([{ kind: "tiled", layout: SPLIT_LAYOUT }, floating("block:reader", CREATED)], "block:reader", CREATED);
	assert.equal(state.kind, "covering");
	assert.ok(state.kind === "covering" && Math.abs(state.share - 0.64) < 1e-9);
});

test("panes that cover too little of the conversation, or only its neighbour, leave it visible", () => {
	const small = Math.sqrt(MIN_COVERED_SHARE * 0.5) * 0.9;
	const layers = [{ kind: "tiled", layout: SPLIT_LAYOUT }, floating("block:corner", [0.5 - small, 0, small, small]), floating("block:neighbour-only", [0.55, 0.1, 0.4, 0.8])];
	assert.equal(stateOf(layers, "block:corner").kind, "clear");
	assert.equal(stateOf(layers, "block:neighbour-only").kind, "clear");
});

test("a zoom anywhere in the window and a conversation outside the tiled layout leave the window to the operator", () => {
	const layers = [{ kind: "tiled", layout: SPLIT_LAYOUT }, floating("block:reader", [0, 0, 1, 1])];
	assert.equal(conversationWindow(view(layers, { zoomed: "block:neighbour" }), CONVERSATION), undefined);
	assert.equal(conversationWindow(view(layers, { zoomed: CONVERSATION }), CONVERSATION), undefined, "moving a block would end the operator's zoom");
	assert.equal(conversationWindow(view([{ kind: "tiled", layout: leaf("block:neighbour", [0, 0, 1, 1]) }, floating(CONVERSATION, [0.2, 0.2, 0.5, 0.5])]), CONVERSATION), undefined);
	assert.equal(conversationWindow(view([{ kind: "tiled", layout: leaf("block:neighbour", [0, 0, 1, 1]) }]), CONVERSATION), undefined);
});

test("a pane that someone moved, resized, tiled or took away stays; the focused pane waits", () => {
	const tiled = { kind: "tiled", layout: SPLIT_LAYOUT };
	assert.equal(stateOf([tiled, floating("block:reader", [0.105, 0.1, 0.8, 0.8])], "block:reader", CREATED).kind, "covering", "rounding within a hundredth of the window is no change");
	assert.equal(stateOf([tiled, floating("block:reader", [0.05, 0.3, 0.6, 0.6])], "block:reader", CREATED).kind, "arranged");
	assert.equal(stateOf([tiled], "block:neighbour", CREATED).kind, "arranged");
	assert.equal(stateOf([tiled], "block:elsewhere", CREATED).kind, "arranged");
	assert.equal(stateOf([tiled], "block:closed", CREATED).kind, "missing");
	assert.equal(stateOf([tiled, floating("block:reader", CREATED)], "block:reader", CREATED, { focus: "block:reader" }).kind, "focused");
	assert.equal(stateOf([tiled, { ...floating("block:reader", CREATED), kind: "stashed" }], "block:reader", CREATED).kind, "arranged", "a layer kind that the extension does not know stays as it is");
});

test("a docked pane goes beside a conversation whose pixels are wide and below one that is tall", () => {
	assert.equal(dockDirection({ columns: 137, rows: 63, cell_width_px: 18, cell_height_px: 35 }), "horizontal");
	assert.equal(dockDirection({ columns: 80, rows: 60, cell_width_px: 18, cell_height_px: 35 }), "vertical");
	assert.equal(dockDirection({}), "horizontal");
});

test("only a run that ends with an answer or an error leaves something for the operator", () => {
	const answer = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Result." }] } };
	const blank = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "  " }] } };
	const error = { type: "message", message: { role: "assistant", stopReason: "error", content: [], errorMessage: "quota" } };
	const call = { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c", name: "note", arguments: {} }] } };
	const result = { type: "message", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "Noted." }] } };
	const custom = { type: "custom_message", customType: "completion", content: "done" };
	assert.equal(runAnswered([answer], false), true);
	assert.equal(runAnswered([answer, custom, { type: "label" }], false), true);
	assert.equal(runAnswered([error], false), true);
	assert.equal(runAnswered([answer], true), false, "the operator aborted the run");
	assert.equal(runAnswered([answer, call, result], false), false, "the run ended quietly in a tool call");
	assert.equal(runAnswered([blank], false), false);
	assert.equal(runAnswered([{ type: "message", message: { role: "user", content: "hi" } }], false), false);
	assert.equal(runAnswered([], false), false);
});

type Gate = { promise: Promise<void>; open: () => void };
function gate(): Gate {
	let open = () => {};
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
}

/** A Rex session in memory: the view reflects the state at the moment Rex answers, and moves change it. */
class FakeRex implements RexTransport {
	readonly calls: { method: string; args: Record<string, unknown> }[] = [];
	foreground = 4242;
	tiled: { blockId: string; rect: number[] }[] = [{ blockId: CONVERSATION, rect: [0, 0, 1, 1] }];
	floats = new Map<string, number[]>();
	zoomed: string | undefined;
	focus = CONVERSATION;
	failViews = 0;
	/** Per block: `exit` refuses the move; `timeout` applies it but reports no answer. */
	moveFailures = new Map<string, ("exit" | "timeout")[]>();
	/** Holds a call before Rex answers it; the hook may change the session meanwhile. */
	hold: ((method: string) => Promise<void> | undefined) | undefined;

	constructor(floats: [string, number[]][] = []) {
		for (const [blockId, bounds] of floats) this.floats.set(blockId, bounds);
	}

	layers(): unknown[] {
		return [{ kind: "tiled", layout: this.tiledLayout() }, ...[...this.floats].map(([blockId, bounds]) => floating(blockId, bounds))];
	}

	private tiledLayout(): unknown {
		const [first, ...rest] = this.tiled;
		let node: unknown = leaf(first?.blockId ?? CONVERSATION, first?.rect ?? [0, 0, 1, 1]);
		for (const pane of rest) node = { split: { before: node, after: leaf(pane.blockId, pane.rect) } };
		return node;
	}

	moves(): Record<string, unknown>[] {
		return this.calls.filter((call) => call.method === "session.move_block").map((call) => call.args);
	}

	async run(args: readonly string[], _call: CliCall): Promise<CliResult> {
		const method = args.at(-2) ?? "";
		const input = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
		this.calls.push({ method, args: input });
		await this.hold?.(method);
		if (method === "com.superlogical.terminal.process") return reply({ foreground: { pid: this.foreground } });
		if (method === "com.superlogical.terminal.size") return reply({ columns: 137, rows: 63, cell_width_px: 18, cell_height_px: 35 });
		if (method === "session.view") return this.view();
		if (method === "session.move_block") return this.move(String(input.block_id));
		throw new Error(`Unexpected Rex method: ${method}`);
	}

	private view(): CliResult {
		if (this.failViews > 0) {
			this.failViews -= 1;
			return { ...reply({}), exitCode: 1, stderr: "server busy" };
		}
		return reply(view(this.layers(), { ...(this.zoomed ? { zoomed: this.zoomed } : {}), focus: this.focus }));
	}

	private move(blockId: string): CliResult {
		const failure = this.moveFailures.get(blockId)?.shift();
		if (failure === "exit") return { ...reply({}), exitCode: 1, stderr: "conflict" };
		this.zoomed = undefined;
		this.floats.delete(blockId);
		this.tiled.push({ blockId, rect: [0.5, 0, 0.5, 1] });
		const conversation = this.tiled.find((pane) => pane.blockId === CONVERSATION);
		if (conversation) conversation.rect = [0, 0, 0.5, 1];
		if (failure === "timeout") return { outcome: "timeout", exitCode: null, signal: null, stdout: "", stderr: "", bytes: 0, truncated: false, started: true };
		return reply({ revision: 4 });
	}

	dispose(): void {}
}

function reply(value: unknown): CliResult {
	return { outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true };
}

function context(mode = "tui") {
	const notices: string[] = [];
	const ctx = { mode, cwd: "/tmp", hasUI: true, ui: { notify: (text: string) => { notices.push(text); } } } as unknown as ExtensionContext;
	return { ctx, notices };
}

const ENV = { REX_SESSION: "session:test", REX_BLOCK: CONVERSATION };
const SETTINGS = { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 };
const READER = [0.1, 0.1, 0.8, 0.8];
const PROBE = [0.1, 0.55, 0.3, 0.3];

function keeperFor(rex: FakeRex, env: Record<string, string> = ENV, pid = 4242) {
	return createConversationKeeper({ settings: SETTINGS, env, pid, createTransport: () => rex });
}

async function decide(keeper: ReturnType<typeof keeperFor>, ctx: ExtensionContext): Promise<void> {
	keeper.attention(ctx);
	await keeper.idle();
}

test("covering panes move beside the conversation, one decision after another", async () => {
	const rex = new FakeRex([["block:reader", READER], ["block:probe", PROBE]]);
	const keeper = keeperFor(rex);
	const { ctx, notices } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }, { blockId: "block:probe", bounds: PROBE }]);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves(), [
		{ session_id: "session:test", block_id: "block:reader", anchor_block_id: CONVERSATION, direction: "horizontal", side: "after", ratio: 0.5 },
		{ session_id: "session:test", block_id: "block:probe", anchor_block_id: "block:reader", direction: "vertical", side: "after", ratio: 0.5 },
	]);
	const order = rex.calls.map((call) => call.method);
	assert.deepEqual(order, ["com.superlogical.terminal.process", "com.superlogical.terminal.size", "session.view", "session.move_block", "session.view", "session.move_block", "session.view"], "each move follows its own view");
	rex.calls.length = 0;
	rex.floats.set("block:reader", READER);
	await decide(keeper, ctx);
	assert.deepEqual(rex.calls, [], "a moved pane is decided; floating it again is the operator's arrangement");
	assert.deepEqual(notices, []);
	await keeper.shutdown();
});

test("a resize or zoom while the keeper inspects the window wins over the move", async () => {
	for (const change of ["resize", "zoom"] as const) {
		for (const held of ["com.superlogical.terminal.size", "session.view"]) {
			const rex = new FakeRex([["block:reader", READER]]);
			const keeper = keeperFor(rex);
			const { ctx } = context();
			keeper.start(ctx);
			keeper.floated([{ blockId: "block:reader", bounds: READER }]);
			const pause = gate();
			const reached = gate();
			rex.hold = (method) => {
				if (method !== held) return undefined;
				reached.open();
				return pause.promise;
			};
			keeper.attention(ctx);
			await reached.promise;
			if (change === "resize") rex.floats.set("block:reader", [0.3, 0.2, 0.5, 0.5]);
			else rex.zoomed = CONVERSATION;
			rex.hold = undefined;
			pause.open();
			await keeper.idle();
			assert.deepEqual(rex.moves(), [], `${change} during ${held}`);
			await keeper.shutdown();
		}
	}
});

test("a change between two moves stops the decision before the second move", async () => {
	for (const change of ["zoom", "resize", "focus", "other pane"] as const) {
		const rex = new FakeRex([["block:reader", READER], ["block:probe", PROBE], ["block:foreign", [0.7, 0.7, 0.2, 0.2]]]);
		const keeper = keeperFor(rex);
		const { ctx } = context();
		keeper.start(ctx);
		keeper.floated([{ blockId: "block:reader", bounds: READER }, { blockId: "block:probe", bounds: PROBE }]);
		let views = 0;
		const pause = gate();
		const reached = gate();
		rex.hold = (method) => {
			if (method !== "session.view" || ++views !== 2) return undefined;
			reached.open();
			return pause.promise;
		};
		keeper.attention(ctx);
		await reached.promise;
		if (change === "zoom") rex.zoomed = "block:reader";
		else if (change === "resize") rex.floats.set("block:probe", [0.5, 0.5, 0.4, 0.4]);
		else if (change === "focus") rex.focus = "block:reader";
		else rex.floats.set("block:foreign", [0.6, 0.6, 0.3, 0.3]);
		rex.hold = undefined;
		pause.open();
		await keeper.idle();
		assert.deepEqual(rex.moves().map((move) => move.block_id), ["block:reader"], `${change} between the moves`);
		if (change === "zoom" || change === "other pane") {
			rex.zoomed = undefined;
			rex.calls.length = 0;
			await decide(keeper, ctx);
			assert.deepEqual(rex.moves(), [{ session_id: "session:test", block_id: "block:probe", anchor_block_id: "block:reader", direction: "vertical", side: "after", ratio: 0.5 }], "the pane waited through the zoom and stacks beside the docked pane");
		}
		await keeper.shutdown();
	}
});

test("a failed view keeps every pane for the next moment", async () => {
	const rex = new FakeRex([["block:reader", READER]]);
	rex.failViews = 1;
	const keeper = keeperFor(rex);
	const { ctx, notices } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }]);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves(), []);
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /session\.view: exit 1: server busy/);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves().map((move) => move.block_id), ["block:reader"]);
	assert.equal(notices.length, 1, "one warning per extension runtime");
	await keeper.shutdown();
});

test("a refused move keeps its pane and lets the next pane move", async () => {
	const rex = new FakeRex([["block:reader", READER], ["block:probe", PROBE]]);
	rex.moveFailures.set("block:reader", ["exit"]);
	const keeper = keeperFor(rex);
	const { ctx, notices } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }, { blockId: "block:probe", bounds: PROBE }]);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves().map((move) => [move.block_id, move.anchor_block_id]), [["block:reader", CONVERSATION], ["block:probe", CONVERSATION]]);
	assert.match(notices[0] ?? "", /session\.move_block: exit 1: conflict/);
	rex.calls.length = 0;
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves(), [{ session_id: "session:test", block_id: "block:reader", anchor_block_id: "block:probe", direction: "vertical", side: "after", ratio: 0.5 }]);
	await keeper.shutdown();
});

test("a move without an answer counts once a view shows the pane tiled", async () => {
	const rex = new FakeRex([["block:reader", READER], ["block:probe", PROBE]]);
	rex.moveFailures.set("block:reader", ["timeout"]);
	const keeper = keeperFor(rex);
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }, { blockId: "block:probe", bounds: PROBE }]);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves().map((move) => [move.block_id, move.anchor_block_id]), [["block:reader", CONVERSATION], ["block:probe", "block:reader"]]);
	rex.calls.length = 0;
	await decide(keeper, ctx);
	assert.deepEqual(rex.calls, []);
	await keeper.shutdown();
});

test("a pane that Rex refuses to move stays after a bounded number of moments", async () => {
	const rex = new FakeRex([["block:reader", READER]]);
	rex.moveFailures.set("block:reader", Array.from({ length: MAX_FAILED_MOVES + 1 }, () => "exit" as const));
	const keeper = keeperFor(rex);
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }]);
	for (let moment = 0; moment < MAX_FAILED_MOVES + 1; moment++) await decide(keeper, ctx);
	assert.equal(rex.moves().length, MAX_FAILED_MOVES);
	await keeper.shutdown();
});

test("the pane that has the window's focus waits until the operator leaves it", async () => {
	const rex = new FakeRex([["block:reader", READER]]);
	rex.focus = "block:reader";
	const keeper = keeperFor(rex);
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader", bounds: READER }]);
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves(), []);
	rex.focus = CONVERSATION;
	await decide(keeper, ctx);
	assert.deepEqual(rex.moves().map((move) => move.block_id), ["block:reader"]);
	await keeper.shutdown();
});

test("a pane that leaves the conversation visible at its decision is never moved later", async () => {
	const rex = new FakeRex([["block:reader", [0.55, 0.1, 0.4, 0.8]]]);
	rex.tiled = [{ blockId: CONVERSATION, rect: [0, 0, 0.5, 1] }, { blockId: "block:neighbour", rect: [0.5, 0, 0.5, 1] }];
	const keeper = keeperFor(rex);
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader" }]);
	await decide(keeper, ctx);
	rex.floats.set("block:reader", READER);
	rex.calls.length = 0;
	await decide(keeper, ctx);
	assert.deepEqual(rex.calls, []);
	await keeper.shutdown();
});

test("another foreground program, another mode or no inherited block moves nothing", async () => {
	for (const [pid, mode, env] of [[1, "tui", ENV], [4242, "rpc", ENV], [4242, "tui", {}]] as const) {
		const rex = new FakeRex([["block:reader", READER]]);
		const keeper = keeperFor(rex, env, pid);
		const { ctx } = context(mode);
		keeper.start(ctx);
		keeper.floated([{ blockId: "block:reader" }]);
		await decide(keeper, ctx);
		assert.deepEqual(rex.moves(), []);
		await keeper.shutdown();
	}
});

test("panes floated before a session switch belong to the old session", async () => {
	const rex = new FakeRex([["block:reader", READER]]);
	const keeper = keeperFor(rex);
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated([{ blockId: "block:reader" }]);
	keeper.start(ctx);
	await decide(keeper, ctx);
	assert.deepEqual(rex.calls, []);
	await keeper.shutdown();
});
