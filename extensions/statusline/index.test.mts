import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerStatusline from "./index.ts";

// --- Fake timers: capture interval create/clear so tick ownership is testable ---

type Tick = { callback: () => void; ms: number; unref: () => void };
const liveTicks = new Set<Tick>();
let _clearedTicks = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

before(() => {
	globalThis.setInterval = ((callback: () => void, ms: number) => {
		const tick: Tick = { callback, ms, unref: () => {} };
		liveTicks.add(tick);
		return tick;
	}) as any;
	globalThis.clearInterval = ((tick: Tick) => {
		if (liveTicks.delete(tick)) _clearedTicks++;
	}) as any;
});

after(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
});

// --- Mocks ---

function makePi() {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	};
	registerStatusline(pi as any);
	return { handlers, commands };
}

function makeCtx(over: Record<string, any> = {}) {
	const footerCalls: any[] = [];
	const notifications: string[] = [];
	const branchChangeCbs: (() => void)[] = [];
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/statusline-test",
		model: { id: "test-model", name: "Test Model", api: "anthropic-messages", provider: "test", reasoning: true },
		thinkingLevel: "high",
		sessionManager: { getBranch: () => over.branch ?? [] },
		getContextUsage: () => over.usage ?? { tokens: 50_000, contextWindow: 200_000, percent: 25 },
		ui: {
			setFooter: (factory: any) => footerCalls.push(factory),
			notify: (msg: string) => notifications.push(msg),
		},
		...over,
	};
	delete ctx.branch;
	delete ctx.usage;
	const footerData: any = {
		getGitBranch: () => (over.gitBranch === undefined ? "main" : over.gitBranch),
		getExtensionStatuses: () => over.statuses ?? new Map(),
		onBranchChange: (cb: () => void) => {
			branchChangeCbs.push(cb);
			return () => branchChangeCbs.splice(branchChangeCbs.indexOf(cb), 1);
		},
	};
	const theme: any = { fg: (_c: string, t: string) => t };
	const tui: any = {
		renders: 0,
		requestRender() {
			this.renders++;
		},
	};
	return { ctx, footerCalls, notifications, footerData, theme, tui, branchChangeCbs };
}

const sessionStart = { type: "session_start", reason: "startup" };

function installFooter(mocks: ReturnType<typeof makeCtx>) {
	const factory = mocks.footerCalls.at(-1);
	assert.ok(factory, "footer factory installed");
	return factory(mocks.tui, mocks.theme, mocks.footerData);
}

describe("registration and mode gating", () => {
	it("registers the toggle command and session handlers", () => {
		const { handlers, commands } = makePi();
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("session_shutdown"));
		assert.ok(commands.has("statusline"));
	});

	it("installs the footer only in tui mode", async () => {
		for (const mode of ["rpc", "json", "print"]) {
			const { handlers } = makePi();
			const mocks = makeCtx({ mode });
			liveTicks.clear();
			await handlers.get("session_start")(sessionStart, mocks.ctx);
			assert.equal(mocks.footerCalls.length, 0, `no footer in ${mode}`);
			assert.equal(liveTicks.size, 0, `no tick in ${mode}`);
		}
		const { handlers } = makePi();
		const mocks = makeCtx({ mode: "tui" });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		assert.equal(mocks.footerCalls.length, 1);
		installFooter(mocks); // Pi invokes the factory on install
		assert.equal(liveTicks.size, 1);
	});
});

describe("footer render", () => {
	it("renders two width-bounded lines with the full segment set", async () => {
		const { handlers } = makePi();
		const branch = [
			{
				type: "message",
				timestamp: new Date(Date.now() - 60_000).toISOString(),
				message: {
					role: "assistant",
					usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.42 } },
				},
			},
		];
		const mocks = makeCtx({ branch, statuses: new Map([["lint", "lint ok"]]) });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [line1, line2] = footer.render(120);
		assert.ok(visibleWidth(line1) <= 120);
		assert.ok(visibleWidth(line2) <= 120);
		assert.match(line1, /Test Model \[high\]/);
		assert.match(line1, /25%/);
		assert.match(line1, /50k\/200k/);
		assert.match(line1, /~\$0\.42/);
		assert.match(line1, /●/);
		assert.match(line1, /90% hit/);
		assert.equal(line2, "/tmp/statusline-test (main) │ \x1b[0mlint ok\x1b[0m");
	});

	it("bounds both lines on narrow terminals by shedding then truncating", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({
			statuses: new Map([
				["a", "status-alpha"],
				["b", "status-beta"],
			]),
		});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		for (const width of [80, 55, 40, 24, 10]) {
			const [line1, line2] = footer.render(width);
			assert.ok(visibleWidth(line1) <= width, `line1 at ${width}: ${JSON.stringify(line1)}`);
			assert.ok(visibleWidth(line2) <= width, `line2 at ${width}: ${JSON.stringify(line2)}`);
		}
	});

	it("omits the thinking bracket for non-reasoning models and hides unknown context", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({
			model: { id: "acp-model", name: "acp-model-high", api: "pi-messages", provider: "acp", reasoning: false },
			usage: { tokens: null, contextWindow: 200_000, percent: null },
			gitBranch: null,
		});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [line1, line2] = footer.render(120);
		assert.match(line1, /acp-model-high/);
		assert.ok(!line1.includes("[high]"), "no bracket without reasoning");
		assert.ok(!line1.includes("%"), "no context bar when percent is unknown");
		assert.ok(!line1.includes("cache "), "no estimated cache TTL segment");
		assert.equal(line2, "/tmp/statusline-test\x1b[0m");
	});

	it("keeps a pre-colored extension status colored, bounded by resets", async () => {
		const { handlers } = makePi();
		const colored = "\x1b[38;2;137;180;250m\u{1F50C} MCP: 10 servers enabled\x1b[39m";
		const mocks = makeCtx({ statuses: new Map([["mcp", colored]]) });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [, line2] = footer.render(200);
		assert.ok(line2.includes(colored), "color sequence survives intact");
		assert.doesNotMatch(line2, /(^|[^\x1b])\[38;2;137/, "no literal escape residue");
		assert.ok(line2.endsWith("\x1b[0m"), "line ends reset");
	});

	it("never emits a half-cut escape at any terminal width", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({
			statuses: new Map([
				["mcp", "\x1b[38;2;137;180;250m\u{1F50C} MCP: 10 servers enabled\x1b[39m"],
				["lint", "\x1b[1mlint ok\x1b[22m"],
			]),
		});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		for (let width = 0; width <= 80; width++) {
			for (const line of footer.render(width)) {
				// Remove every complete SGR; a truncator that cut one in half would
				// leave an ESC or its parameter bytes behind.
				const stripped = line.replace(/\x1b\[[0-9;:]*m/g, "");
				assert.ok(!stripped.includes("\x1b"), `partial escape at width ${width}: ${JSON.stringify(line)}`);
				assert.ok(visibleWidth(line) <= width, `overflow at width ${width}`);
			}
		}
	});

	it("sanitizes hostile extension status text", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({
			statuses: new Map([["evil", "\x1b[2J\x1b]0;title\x07 forged\nsecond line \x1b[38;2;1;2;3"]]),
		});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [, line2] = footer.render(200);
		assert.ok(!line2.includes("\n"));
		assert.ok(!line2.includes("[2J"), "no clear-screen residue");
		assert.ok(!line2.includes("title"), "OSC payload dropped whole");
		assert.ok(!line2.includes("[38;2;1;2;3"), "truncated sequence leaves no residue");
		assert.match(line2, /forged second line/);
	});

	it("shows measured cache telemetry without a TTL estimate", async () => {
		const { handlers } = makePi();
		const branch = [
			{
				type: "message",
				timestamp: new Date(Date.now() - 60_000).toISOString(),
				message: {
					role: "assistant",
					usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.42 } },
				},
			},
		];
		const mocks = makeCtx({ branch });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [line1] = footer.render(200);
		assert.ok(!line1.includes("cache "), "no cache TTL estimate");
		assert.match(line1, /●/);
		assert.match(line1, /90% hit/);
	});
});

describe("tick ownership", () => {
	it("clears the tick on dispose, shutdown, and reinstall without accumulation", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({});
		liveTicks.clear();
		_clearedTicks = 0;

		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks); // factory creates the tick
		assert.equal(liveTicks.size, 1);

		// Branch change subscription requests renders; dispose unsubscribes.
		assert.equal(mocks.branchChangeCbs.length, 1);
		mocks.branchChangeCbs[0]();
		assert.equal(mocks.tui.renders, 1);

		footer.dispose();
		assert.equal(liveTicks.size, 0);
		footer.dispose(); // repeated cleanup is safe
		assert.equal(mocks.branchChangeCbs.length, 0);

		// A second session start installs a fresh tick, not a second one.
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		installFooter(mocks);
		assert.equal(liveTicks.size, 1);

		// The interval callback drives re-renders.
		const [tick] = liveTicks;
		tick.callback();
		assert.ok(mocks.tui.renders >= 2);

		await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, mocks.ctx);
		assert.equal(liveTicks.size, 0);
	});
});

describe("/statusline toggle", () => {
	it("restores the default footer when disabled and reinstalls when enabled", async () => {
		const { handlers, commands } = makePi();
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		assert.equal(mocks.footerCalls.length, 1);

		await commands.get("statusline").handler("", mocks.ctx);
		assert.equal(mocks.footerCalls.at(-1), undefined, "footer cleared on disable");
		const disabledNote = mocks.notifications.at(-1);
		assert.ok(disabledNote !== undefined, "disable notification recorded");
		assert.match(disabledNote, /disabled/);

		await commands.get("statusline").handler("", mocks.ctx);
		assert.notEqual(mocks.footerCalls.at(-1), undefined, "footer reinstalled on enable");
		const enabledNote = mocks.notifications.at(-1);
		assert.ok(enabledNote !== undefined, "enable notification recorded");
		assert.match(enabledNote, /enabled/);
	});

	it("toggles without touching the footer outside tui mode", async () => {
		const { handlers, commands } = makePi();
		const mocks = makeCtx({ mode: "rpc", hasUI: true });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		assert.equal(mocks.footerCalls.length, 0);
		await commands.get("statusline").handler("", mocks.ctx);
		assert.equal(mocks.footerCalls.length, 0, "setFooter untouched in rpc");
		const disabledNote = mocks.notifications.at(-1);
		assert.ok(disabledNote !== undefined, "disable notification recorded");
		assert.match(disabledNote, /disabled/);
	});
});
