import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerStatusline from "./index.ts";
import type { SessionEntryLike } from "./metrics.ts";

// --- Fake timers: capture interval create/clear so tick ownership is testable ---

type Tick = { callback: () => void; ms: number; unref: () => void };
const liveTicks = new Set<Tick>();
let _clearedTicks = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

const fakeSetInterval = ((callback: () => void, ms: number) => {
	const tick: Tick = { callback, ms, unref: () => {} };
	liveTicks.add(tick);
	return tick;
}) as unknown as typeof globalThis.setInterval;
const fakeClearInterval = ((tick: Tick) => {
	if (liveTicks.delete(tick)) _clearedTicks++;
}) as unknown as typeof globalThis.clearInterval;

before(() => {
	globalThis.setInterval = fakeSetInterval;
	globalThis.clearInterval = fakeClearInterval;
});

after(() => {
	globalThis.setInterval = realSetInterval;
	globalThis.clearInterval = realClearInterval;
});

// --- Mocks ---

interface MockModel {
	id?: string;
	name?: string;
	api?: string;
	provider?: string;
	reasoning?: boolean;
}

interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

interface MockSessionManager {
	getEntries(): SessionEntryLike[];
	getBranch?(): never;
}

interface MockUi {
	setFooter(factory: MockFactory | undefined): void;
	notify(message: string): void;
}

interface MockCtx {
	mode: string;
	hasUI: boolean;
	cwd: string;
	model: MockModel;
	thinkingLevel: string;
	sessionManager: MockSessionManager;
	getContextUsage(): ContextUsage | undefined;
	ui: MockUi;
}

interface MockFooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): Map<string, string>;
	onBranchChange(callback: () => void): () => void;
}

interface MockTheme {
	fg(color: string, text: string): string;
}

interface MockTui {
	renders: number;
	requestRender(): void;
}

interface MockFooter {
	dispose(): void;
	invalidate(): void;
	render(width: number): string[];
}

type MockFactory = (tui: MockTui, theme: MockTheme, footerData: MockFooterData) => MockFooter;
type SessionHandler = (event: { type: string; reason?: string }, ctx: MockCtx) => unknown;

interface MockCommand {
	description: string;
	handler: (args: string, ctx: MockCtx) => unknown;
}

interface CtxOverrides {
	mode?: string;
	hasUI?: boolean;
	cwd?: string;
	model?: MockModel;
	thinkingLevel?: string;
	entries?: SessionEntryLike[];
	usage?: ContextUsage;
	gitBranch?: string | null;
	statuses?: Map<string, string>;
	sessionManager?: MockSessionManager;
	getContextUsage?: () => ContextUsage | undefined;
}

/** Typed registry that fails on a missing entry instead of yielding undefined at each call site. */
class Registry<T> {
	readonly #entries = new Map<string, T>();

	set(name: string, value: T): void {
		this.#entries.set(name, value);
	}

	get(name: string): T {
		const value = this.#entries.get(name);
		if (value === undefined) throw new Error(`missing entry: ${name}`);
		return value;
	}

	has(name: string): boolean {
		return this.#entries.has(name);
	}
}

function makePi() {
	const handlers = new Registry<SessionHandler>();
	const commands = new Registry<MockCommand>();
	const pi = {
		on: (event: string, handler: SessionHandler) => handlers.set(event, handler),
		registerCommand: (name: string, command: MockCommand) => commands.set(name, command),
	};
	registerStatusline(pi as unknown as ExtensionAPI);
	return { handlers, commands };
}

function makeCtx(over: CtxOverrides = {}) {
	const footerCalls: (MockFactory | undefined)[] = [];
	const notifications: string[] = [];
	const branchChangeCbs: (() => void)[] = [];
	const ctx: MockCtx = {
		mode: over.mode ?? "tui",
		hasUI: over.hasUI ?? true,
		cwd: over.cwd ?? "/tmp/statusline-test",
		model: over.model ?? {
			id: "test-model",
			name: "Test Model",
			api: "anthropic-messages",
			provider: "test",
			reasoning: true,
		},
		thinkingLevel: over.thinkingLevel ?? "high",
		sessionManager: over.sessionManager ?? { getEntries: () => over.entries ?? [] },
		getContextUsage:
			over.getContextUsage ?? (() => over.usage ?? { tokens: 50_000, contextWindow: 200_000, percent: 25 }),
		ui: {
			setFooter: (factory) => footerCalls.push(factory),
			notify: (msg) => notifications.push(msg),
		},
	};
	const footerData: MockFooterData = {
		getGitBranch: () => (over.gitBranch === undefined ? "main" : over.gitBranch),
		getExtensionStatuses: () => over.statuses ?? new Map(),
		onBranchChange: (callback: () => void) => {
			branchChangeCbs.push(callback);
			return () => branchChangeCbs.splice(branchChangeCbs.indexOf(callback), 1);
		},
	};
	const theme: MockTheme = { fg: (_c: string, t: string) => t };
	const tui: MockTui = {
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
		const entries = [
			{
				type: "message",
				timestamp: new Date(Date.now() - 60_000).toISOString(),
				message: {
					role: "assistant",
					usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.42 } },
				},
			},
		];
		const mocks = makeCtx({ entries, statuses: new Map([["lint", "lint ok"]]) });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		const [line1, line2] = footer.render(120);
		assert.ok(visibleWidth(line1) <= 120);
		assert.ok(visibleWidth(line2) <= 120);
		assert.ok(line1.includes("Test Model\x1b[0m [high]"));
		assert.match(line1, /25%/);
		assert.match(line1, /50k\/200k/);
		assert.match(line1, /~\$0\.42/);
		assert.match(line1, /●/);
		assert.match(line1, /90% hit/);
		assert.equal(line2, "/tmp/statusline-test\x1b[0m (main)\x1b[0m │ \x1b[0mlint ok\x1b[0m");
	});

	it("includes recorded costs from all session entries, not only the current branch", async () => {
		const { handlers } = makePi();
		const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.25 } };
		const entries = [{ type: "message", message: { role: "assistant", usage } },
			{ type: "usage", kind: "cache_warm", usage }];
		const mocks = makeCtx({ sessionManager: { getEntries: () => entries,
			getBranch: () => { throw new Error("branch history omits paid work"); } } });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		assert.match(installFooter(mocks).render(120)[0], /~\$0\.50/);
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

	it("omits the thinking bracket for non-reasoning models and shows unknown context", async () => {
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
		assert.ok(!line1.includes("%"), "no percentage when usage is unknown");
		assert.match(line1, /context \?/);
		assert.match(line1, /\?\/200k/);
		assert.ok(!line1.includes("cache "), "no estimated cache TTL segment");
		assert.equal(line2, "/tmp/statusline-test\x1b[0m");
	});

	it("distinguishes zero usage from an unavailable host estimate", async () => {
		for (const [usage, expected] of [
			[{ tokens: 0, contextWindow: 200000, percent: 0 }, /0%.*0\/200k/],
			[undefined, /context unavailable/],
		] as const) {
			const { handlers } = makePi();
			const mocks = makeCtx({ getContextUsage: () => usage });
			await handlers.get("session_start")(sessionStart, mocks.ctx);
			assert.match(installFooter(mocks).render(120)[0], expected);
		}
	});
	it("sanitizes model and project labels before terminal rendering", async () => {
		const { handlers } = makePi();
		const mocks = makeCtx({ cwd: "/work/\x1b[2Jproject\nnext", model: { name: "\x1b]0;title\x07Model\nnext" } });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const lines = installFooter(mocks).render(120);
		assert.match(lines[0], /Model next/);
		assert.match(lines[1], /project next/);
		for (const line of lines) assert.doesNotMatch(line, /\n|\[2J|title/);
	});
	for (const { label, overrides, lineIndex, following } of [
		{ label: "model", overrides: { model: { name: "\x1b[8;5;41mLabel", reasoning: true } }, lineIndex: 0, following: "[high]" },
		{ label: "project", overrides: { cwd: "/work/\x1b[8;5;41mLabel" }, lineIndex: 1, following: "(main)" },
		{ label: "branch", overrides: { gitBranch: "\x1b[8;5;41mLabel" }, lineIndex: 1, following: " │ " },
	] as const) {
		it(`contains ${label} label styles before adjacent footer content`, async () => {
			const { handlers } = makePi();
			const mocks = makeCtx({ ...overrides, statuses: new Map([["notice", "visible"]]) });
			// Pi's foreground helper resets foreground color, not conceal, blink, or background.
			mocks.theme.fg = (_color, text) => `\x1b[37m${text}\x1b[39m`;
			await handlers.get("session_start")(sessionStart, mocks.ctx);
			const footer = installFooter(mocks);
			try {
				for (const width of [80, 200]) {
					const line = footer.render(width)[lineIndex];
					const styleStart = line.indexOf("\x1b[8;5;41m");
					const followingStart = line.indexOf(following, styleStart);
					assert.ok(styleStart >= 0, "label styling remains inside its own cell");
					assert.ok(followingStart > styleStart, "adjacent content remains present");
					assert.ok(line.slice(styleStart, followingStart).includes("\x1b[0m"),
						`${label} styles require a full reset before adjacent content`);
					assert.ok(visibleWidth(line) <= width);
				}
			} finally {
				footer.dispose();
			}
		});
	}

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
		const entries = [
			{
				type: "message",
				timestamp: new Date(Date.now() - 60_000).toISOString(),
				message: {
					role: "assistant",
					usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.42 } },
				},
			},
		];
		const mocks = makeCtx({ entries });
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
