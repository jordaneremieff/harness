import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { coveringPanes, createConversationKeeper, dockDirection, MIN_COVERED_SHARE } from "./keep-visible.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const CONVERSATION = "block:conversation";

function leaf(blockId: string, rect: number[]) {
	return { block_id: blockId, rect };
}

function view(layers: unknown[], zoomed?: string) {
	return { revision: 3, session_id: "session:test", windows: [
		{ window_id: "window:other", layers: [{ kind: "tiled", layout: leaf("block:elsewhere", [0, 0, 1, 1]) }] },
		{ window_id: "window:conversation", ...(zoomed ? { zoomed_block_id: zoomed } : {}), layers },
	] };
}

const SPLIT_LAYOUT = { split: { direction: "horizontal", before: leaf(CONVERSATION, [0, 0, 0.5, 1]), after: leaf("block:neighbour", [0.5, 0, 0.5, 1]) } };

/** Candidates without recorded creation bounds. */
function candidates(...blockIds: string[]) {
	return new Map(blockIds.map((blockId) => [blockId, undefined]));
}

function panes(...blockIds: string[]) {
	return blockIds.map((blockId) => ({ blockId }));
}

test("a floating pane that this conversation created and that covers it is reported with its share", () => {
	const covering = coveringPanes(view([
		{ kind: "tiled", layout: SPLIT_LAYOUT },
		{ kind: "floating", bounds: [0.1, 0.1, 0.8, 0.8], layout: leaf("block:reader", [0.1, 0.1, 0.8, 0.8]) },
		{ kind: "floating", bounds: [0, 0, 1, 1], layout: leaf("block:foreign", [0, 0, 1, 1]) },
	]), CONVERSATION, candidates("block:reader"));
	assert.equal(covering?.length, 1);
	assert.equal(covering?.[0]?.blockId, "block:reader");
	assert.ok(Math.abs((covering?.[0]?.share ?? 0) - 0.64) < 1e-9);
});

test("panes that cover too little of the conversation, or only its neighbour, stay where they are", () => {
	const small = Math.sqrt(MIN_COVERED_SHARE * 0.5) * 0.9;
	const covering = coveringPanes(view([
		{ kind: "tiled", layout: SPLIT_LAYOUT },
		{ kind: "floating", layout: leaf("block:corner", [0.5 - small, 0, small, small]) },
		{ kind: "floating", layout: leaf("block:neighbour-only", [0.55, 0.1, 0.4, 0.8]) },
	]), CONVERSATION, candidates("block:corner", "block:neighbour-only"));
	assert.deepEqual(covering, []);
});

test("any zoom in the window and a conversation outside the tiled layout leave every pane in place", () => {
	const floating = { kind: "floating", layout: leaf("block:reader", [0, 0, 1, 1]) };
	assert.equal(coveringPanes(view([{ kind: "tiled", layout: SPLIT_LAYOUT }, floating], "block:neighbour"), CONVERSATION, candidates("block:reader")), undefined);
	assert.equal(coveringPanes(view([{ kind: "tiled", layout: SPLIT_LAYOUT }, floating], CONVERSATION), CONVERSATION, candidates("block:reader")), undefined, "moving a block would end the operator's zoom");
	assert.equal(coveringPanes(view([{ kind: "tiled", layout: leaf("block:neighbour", [0, 0, 1, 1]) }, { kind: "floating", layout: leaf(CONVERSATION, [0.2, 0.2, 0.5, 0.5]) }]), CONVERSATION, candidates("block:reader")), undefined);
});

test("a floating pane that someone moved or resized before the decision stays where it is", () => {
	const created = [0.1, 0.1, 0.8, 0.8];
	const layers = (bounds: number[]) => [{ kind: "tiled", layout: SPLIT_LAYOUT }, { kind: "floating", bounds, layout: leaf("block:reader", bounds) }];
	const recorded = new Map([["block:reader", created]]);
	assert.equal(coveringPanes(view(layers([0.1, 0.1, 0.8, 0.8])), CONVERSATION, recorded)?.length, 1);
	assert.equal(coveringPanes(view(layers([0.105, 0.1, 0.8, 0.8])), CONVERSATION, recorded)?.length, 1, "rounding within a hundredth of the window is no change");
	assert.deepEqual(coveringPanes(view(layers([0.05, 0.3, 0.6, 0.6])), CONVERSATION, recorded), []);
});

test("a docked pane goes beside a conversation whose pixels are wide and below one that is tall", () => {
	assert.equal(dockDirection({ columns: 137, rows: 63, cell_width_px: 18, cell_height_px: 35 }), "horizontal");
	assert.equal(dockDirection({ columns: 80, rows: 60, cell_width_px: 18, cell_height_px: 35 }), "vertical");
	assert.equal(dockDirection({}), "horizontal");
});

class FakeRex implements RexTransport {
	readonly calls: { method: string; args: Record<string, unknown> }[] = [];
	foreground: number;
	layers: unknown[];
	failMove = false;

	constructor(foreground: number, layers: unknown[]) {
		this.foreground = foreground;
		this.layers = layers;
	}

	async run(args: readonly string[], _call: CliCall): Promise<CliResult> {
		const method = args.at(-2) ?? "";
		const input = JSON.parse(args.at(-1) ?? "{}") as Record<string, unknown>;
		this.calls.push({ method, args: input });
		if (method === "com.superlogical.terminal.process") return reply({ foreground: { pid: this.foreground } });
		if (method === "session.view") return reply(view(this.layers));
		if (method === "com.superlogical.terminal.size") return reply({ columns: 137, rows: 63, cell_width_px: 18, cell_height_px: 35 });
		if (method === "session.move_block") {
			if (this.failMove) return { ...reply({}), exitCode: 1, stderr: "conflict" };
			return reply({ revision: 4 });
		}
		throw new Error(`Unexpected Rex method: ${method}`);
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
const COVERED = [
	{ kind: "tiled", layout: leaf(CONVERSATION, [0, 0, 1, 1]) },
	{ kind: "floating", layout: leaf("block:reader", [0.1, 0.1, 0.8, 0.8]) },
	{ kind: "floating", layout: leaf("block:probe", [0.6, 0.6, 0.3, 0.3]) },
];

test("when the run settles, covering floating panes move beside the conversation once", async () => {
	const rex = new FakeRex(4242, COVERED);
	const keeper = createConversationKeeper({ settings: { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 }, env: ENV, pid: 4242, createTransport: () => rex });
	const { ctx, notices } = context();
	keeper.start(ctx);
	keeper.floated(panes("block:reader", "block:probe"));
	keeper.attention(ctx);
	await keeper.idle();
	const moves = rex.calls.filter((call) => call.method === "session.move_block").map((call) => call.args);
	assert.deepEqual(moves, [
		{ session_id: "session:test", block_id: "block:reader", anchor_block_id: CONVERSATION, direction: "horizontal", side: "after", ratio: 0.5 },
		{ session_id: "session:test", block_id: "block:probe", anchor_block_id: "block:reader", direction: "vertical", side: "after", ratio: 0.5 },
	]);
	rex.calls.length = 0;
	keeper.attention(ctx);
	await keeper.idle();
	assert.deepEqual(rex.calls, [], "a pane gets one decision; later arrangement belongs to the operator");
	assert.deepEqual(notices, []);
	await keeper.shutdown();
});

test("a pane that does not cover the conversation at its first decision is never moved later", async () => {
	const rex = new FakeRex(4242, [{ kind: "tiled", layout: leaf(CONVERSATION, [0, 0, 0.5, 1]) }, { kind: "floating", layout: leaf("block:reader", [0.55, 0.1, 0.4, 0.8]) }]);
	const keeper = createConversationKeeper({ settings: { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 }, env: ENV, pid: 4242, createTransport: () => rex });
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated(panes("block:reader"));
	keeper.attention(ctx);
	await keeper.idle();
	rex.layers = COVERED;
	rex.calls.length = 0;
	keeper.attention(ctx);
	await keeper.idle();
	assert.deepEqual(rex.calls, []);
	await keeper.shutdown();
});

test("another foreground program, another mode or no inherited block moves nothing", async () => {
	for (const [pid, mode, env] of [[1, "tui", ENV], [4242, "rpc", ENV], [4242, "tui", {}]] as const) {
		const rex = new FakeRex(4242, COVERED);
		const keeper = createConversationKeeper({ settings: { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 }, env, pid, createTransport: () => rex });
		const { ctx } = context(mode);
		keeper.start(ctx);
		keeper.floated(panes("block:reader"));
		keeper.attention(ctx);
		await keeper.idle();
		assert.equal(rex.calls.some((call) => call.method === "session.move_block"), false);
		await keeper.shutdown();
	}
});

test("a failed move warns once and leaves later decisions to new panes", async () => {
	const rex = new FakeRex(4242, COVERED);
	rex.failMove = true;
	const keeper = createConversationKeeper({ settings: { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 }, env: ENV, pid: 4242, createTransport: () => rex });
	const { ctx, notices } = context();
	keeper.start(ctx);
	keeper.floated(panes("block:reader"));
	keeper.attention(ctx);
	await keeper.idle();
	keeper.floated(panes("block:probe"));
	keeper.attention(ctx);
	await keeper.idle();
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /session\.move_block: exit 1: conflict/);
	await keeper.shutdown();
});

test("panes floated before a session switch belong to the old session", async () => {
	const rex = new FakeRex(4242, COVERED);
	const keeper = createConversationKeeper({ settings: { executable: "rex", maxOutputBytes: 65536, maxWaitMs: 1000 }, env: ENV, pid: 4242, createTransport: () => rex });
	const { ctx } = context();
	keeper.start(ctx);
	keeper.floated(panes("block:reader"));
	keeper.start(ctx);
	keeper.attention(ctx);
	await keeper.idle();
	assert.deepEqual(rex.calls, []);
	await keeper.shutdown();
});
