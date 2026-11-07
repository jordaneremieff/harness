import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type NavigationFrame, type OrdinaryView, publishOperatorViews, viewKey } from "../../operator-ui/index.ts";
import registerStatusline from "./index.ts";
import type { SessionEntryLike } from "./metrics.ts";

/** The statusline entrypoint; the frame binds each statusline view to this registration of its command. */
const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

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
	getLeafId?(): string | null;
	getEntry?(id: string): (SessionEntryLike & { parentId: string | null }) | undefined;
	getBranch?(): never;
	getSessionId?(): string;
}

type CustomFactory = (tui: MockTui, theme: MockTheme, keybindings: unknown, done: (result: unknown) => void) => unknown;
type CustomDriver = (factory: CustomFactory, resolve: (result: unknown) => void, reject: (error: unknown) => void) => void;

interface MockUi {
	setFooter(factory: MockFactory | undefined): void;
	notify(message: string, type?: string): void;
	custom(factory: CustomFactory, options?: unknown): Promise<unknown>;
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
}

interface MockCtx {
	mode: string;
	hasUI: boolean;
	cwd: string;
	model: MockModel;
	thinkingLevel: string;
	sessionManager: MockSessionManager;
	modelRegistry: { getAvailable(): MockModel[] };
	getContextUsage(): ContextUsage | undefined;
	isIdle(): boolean;
	abort(): void;
	ui: MockUi;
}

interface MockFooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): Map<string, string>;
	onBranchChange(callback: () => void): () => void;
}

interface MockTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

interface MockTui {
	renders: number;
	mode?: "regular" | "fullscreen";
	terminal: { rows: number; columns: number };
	requestRender(): void;
}

interface MockFooter {
	dispose(): void;
	invalidate(): void;
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): { handled?: boolean } | undefined;
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
	tuiMode?: "regular" | "fullscreen";
	editorText?: string;
	cwd?: string;
	model?: MockModel;
	models?: MockModel[];
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

interface RegistrationOverrides {
	description?: string;
	source?: SlashCommandInfo["source"];
	sourceInfo?: Partial<SlashCommandInfo["sourceInfo"]>;
}

function registration(name: string, over: RegistrationOverrides = {}): SlashCommandInfo {
	return {
		name,
		description: over.description ?? `${name} description`,
		source: over.source ?? "extension",
		sourceInfo: { path: `/ext/${name}/index.ts`, source: "../../harness", scope: "user", origin: "package", ...over.sourceInfo },
	};
}

/** A small synchronous event bus, as Pi's extension bus delivers publications and frame requests. */
function eventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			const set = handlers.get(name) ?? new Set();
			set.add(handler);
			handlers.set(name, set);
			return () => set.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
		},
	};
}

interface PiOptions {
	/** Pi's answer to setModel: false when the provider has no authentication. */
	setModel?: (model: MockModel) => boolean;
}

function makePi(inventory: () => SlashCommandInfo[] = () => [registration("evo"), registration("review:1")], options: PiOptions = {}) {
	const handlers = new Map<string, SessionHandler[]>();
	const commands = new Registry<MockCommand>();
	const owned: string[] = [];
	const sent: Array<{ content: string; options: unknown }> = [];
	const models: string[] = [];
	const levels: string[] = [];
	let level = "high";
	const events = eventBus();
	const pi = {
		on: (event: string, handler: SessionHandler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, command: MockCommand) => {
			commands.set(name, command);
			owned.push(name);
		},
		getCommands: () => [...owned.map((name) => registration(name, { sourceInfo: { path: ENTRY } })), ...inventory()],
		sendUserMessage: (content: string, options: unknown) => {
			sent.push({ content, options });
		},
		events,
		setModel: async (model: MockModel) => {
			models.push(`${model.provider}/${model.id}`);
			return options.setModel?.(model) ?? true;
		},
		getThinkingLevel: () => level,
		setThinkingLevel: (next: string) => {
			level = next;
			levels.push(next);
		},
	};
	registerStatusline(pi as unknown as ExtensionAPI);
	const session = {
		has: (event: string) => handlers.has(event),
		get: (event: string) => async (payload: { type: string; reason?: string }, ctx: MockCtx) => {
			const registered = handlers.get(event);
			if (!registered) throw new Error(`missing handler: ${event}`);
			for (const handler of registered) await handler(payload, ctx);
		},
	};
	/** Announce another owner's destinations, as that owner's extension would. */
	const publish = (owner: string, views: OrdinaryView[]) => publishOperatorViews({ events } as unknown as Pick<ExtensionAPI, "events">, { version: 2, owner, views });
	return { handlers: session, commands, sent, models, levels, publish };
}

function makeCtx(over: CtxOverrides = {}) {
	const footerCalls: (MockFactory | undefined)[] = [];
	const notifications: string[] = [];
	const branchChangeCbs: (() => void)[] = [];
	const customCalls: Array<{ factory: CustomFactory; options: unknown }> = [];
	const editorCalls: string[] = [];
	const state = { idle: true, aborts: 0 };
	let editorText = over.editorText ?? "";
	let customDriver: CustomDriver | undefined;
	const model = over.model ?? { id: "test-model", name: "Test Model", api: "anthropic-messages", provider: "test", reasoning: true };
	const ctx: MockCtx = {
		mode: over.mode ?? "tui",
		hasUI: over.hasUI ?? true,
		cwd: over.cwd ?? "/tmp/statusline-test",
		model,
		thinkingLevel: over.thinkingLevel ?? "high",
		sessionManager: {
			getEntries: () => over.entries ?? [],
			getLeafId: () => null,
			getEntry: () => undefined,
			getSessionId: () => "session-1",
			...over.sessionManager,
		},
		modelRegistry: { getAvailable: () => over.models ?? [model] },
		getContextUsage:
			over.getContextUsage ?? (() => over.usage ?? { tokens: 50_000, contextWindow: 200_000, percent: 25 }),
		isIdle: () => state.idle,
		abort: () => {
			state.aborts += 1;
		},
		ui: {
			setFooter: (factory) => footerCalls.push(factory),
			notify: (msg) => notifications.push(msg),
			custom: (factory, options) =>
				new Promise((resolve, reject) => {
					customCalls.push({ factory, options });
					const driver = customDriver;
					customDriver = undefined;
					driver?.(factory, resolve, reject);
				}),
			getEditorText: () => editorText,
			setEditorText: (text) => {
				editorCalls.push(`set:${text}`);
				editorText = text;
			},
			pasteToEditor: (text) => {
				editorCalls.push(`paste:${text}`);
				editorText += text;
			},
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
	const theme: MockTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
	const tui: MockTui = {
		renders: 0,
		mode: over.tuiMode,
		terminal: { rows: 30, columns: 100 },
		requestRender() {
			this.renders++;
		},
	};
	/**
	 * Drive the next frame this context opens: run the script against it, then close it. The promise
	 * settles when the script ends, so a footer click that opens the frame without waiting is awaitable.
	 */
	const onNextFrame = (script: (frame: NavigationFrame) => unknown): Promise<void> =>
		new Promise<void>((finished, failed) => {
			customDriver = (factory, resolve, reject) => {
				const frame = factory(tui, theme, { getKeys: () => [] }, resolve) as NavigationFrame;
				Promise.resolve()
					.then(async () => {
						await loaded(frame);
						return script(frame);
					})
					.then(
						() => {
							frame.close();
							finished();
						},
						(error: unknown) => {
							// Reject first: closing resolves the custom view, and a settled promise ignores a later rejection.
							reject(error);
							frame.close();
							failed(error);
						},
					);
			};
		});
	return { ctx, state, footerCalls, notifications, footerData, theme, tui, branchChangeCbs, customCalls, editorCalls, onNextFrame, editorText: () => editorText };
}

function click(x: number, y: number, width: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 2, shift: false, alt: false, ctrl: false };
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

const sessionStart = { type: "session_start", reason: "startup" };

function installFooter(mocks: ReturnType<typeof makeCtx>) {
	const factory = mocks.footerCalls.at(-1);
	assert.ok(factory, "footer factory installed");
	return factory(mocks.tui, mocks.theme, mocks.footerData);
}

const frameText = (frame: NavigationFrame, width = 100) => frame.render(width).map(strip).join("\n");

/** A destination shows a reading placeholder until its view module loads. */
async function loaded(frame: NavigationFrame): Promise<void> {
	for (let attempt = 0; attempt < 400 && /Reading…/.test(frameText(frame)); attempt++) await turn();
}

/** Run one labelled action of the view the operator reads, as its control would. */
function act(frame: NavigationFrame, label: string): void {
	const action = frame.viewActions.find((candidate) => candidate.label === label);
	assert.ok(action, `no action ${label}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
	assert.equal(action.disabled, undefined, `${label} is unavailable: ${action.disabled}`);
	action.run();
}

function typeText(frame: NavigationFrame, text: string): void {
	for (const character of text) frame.handleInput(character);
}

/** Focus the search field with `/`, type to filter the command list, then return to the list. */
function filterTo(frame: NavigationFrame, text: string): void {
	frame.handleInput("/");
	typeText(frame, text);
	frame.handleInput("\r");
}

/** Click the footer control drawn as `label`, at the position the last render gave it. */
function clickFooter(frame: NavigationFrame, label: string, width = 160): void {
	const lines = frame.render(width);
	const row = strip(lines.at(-1) ?? "");
	const at = row.indexOf(label);
	assert.ok(at >= 0, `no footer control ${label} in: ${row}`);
	const event: TuiMouseEvent = { type: "click", button: "left", x: at, y: lines.length - 1, screenX: at, screenY: lines.length - 1, width, height: lines.length, shift: false, alt: false, ctrl: false };
	assert.ok(frame.handleMouse(event)?.handled, `${label} is clickable`);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("registration and mode gating", () => {
	it("registers the toggle, the view commands and session handlers", () => {
		const { handlers, commands } = makePi();
		assert.ok(handlers.has("session_start"));
		assert.ok(handlers.has("session_shutdown"));
		for (const name of ["statusline", "commands", "statuses", "dashboard"]) assert.ok(commands.has(name), name);
		assert.equal(commands.has("model-reasoning"), false, "the Model view opens from the footer and /dashboard, not from a command of its own");
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
	for (const width of [140, 80, 70, 40]) {
		it(`keeps generic extension statuses visible with a long project label at ${width} columns`, async () => {
			const { handlers } = makePi();
			const mocks = makeCtx({
				cwd: "/work/Workspace/harness.worktrees/sample",
				gitBranch: "extension/sample",
				statuses: new Map([["first", "workers 3 · $1.23"], ["second", "checks ready"], ["third", "links online"]]),
			});
			await handlers.get("session_start")(sessionStart, mocks.ctx);
			const footer = installFooter(mocks);
			try {
				const [line1, line2] = footer.render(width);
				const text = line2.replace(/\x1b\[[0-9;:]*m/g, "");
				assert.ok(visibleWidth(line2) <= width);
				assert.match(text, /workers 3 · \$1\.23/);
				if (width === 140) {
					assert.equal(text, "/work/Workspace/harness.worktrees/sample (extension/sample) │ workers 3 · $1.23 │ checks ready │ links online");
				} else if (width >= 70) {
					assert.match(text, /checks ready │ links online$/);
					assert.match(text, /^….*sample /, "the last path component stays visible before the branch shrinks");
				} else {
					assert.match(text, / │ \+2$/);
					assert.doesNotMatch(text, /checks ready|links online/);
				}
				assert.equal(line1, footer.render(width)[0], "line 1 remains independent of project width allocation");
			} finally {
				footer.dispose();
			}
		});
	}
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
		assert.ok(line1.includes("test/test-model\x1b[0m [high]"), line1);
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
		assert.match(line1, /acp\/acp-model/, "the route identity is provider/model");
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
		const mocks = makeCtx({ cwd: "/work/\x1b[2Jproject\nnext", model: { provider: "p", id: "\x1b]0;title\x07Model\nnext" } });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const lines = installFooter(mocks).render(120);
		assert.match(lines[0], /Model next/);
		assert.match(lines[1], /project next/);
		for (const line of lines) assert.doesNotMatch(line, /\n|\[2J|title/);
	});
	for (const { label, overrides, lineIndex, following } of [
		{ label: "model", overrides: { model: { provider: "p", id: "\x1b[8;5;41mLabel", reasoning: true } }, lineIndex: 0, following: "[high]" },
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

describe("metrics invalidation", () => {
	it("does no history work on unchanged frames and catches new standalone usage outside paint", async () => {
		const { handlers } = makePi();
		const entries = [{ id: "a", parentId: null as string | null, type: "usage", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } }];
		let scans = 0, points = 0, contextReads = 0;
		const mocks = makeCtx({ getContextUsage: () => { contextReads += 1; return undefined; }, sessionManager: {
			getEntries: () => { scans += 1; return entries; },
			getLeafId: () => entries.at(-1)?.id ?? null,
			getEntry: (id) => { points += 1; return entries.find((entry) => entry.id === id); },
		} });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		try {
			for (let frame = 0; frame < 100; frame += 1) footer.render(120);
			assert.equal(scans, 1); assert.equal(points, 0); assert.equal(contextReads, 1);
			for (const tick of liveTicks) tick.callback();
			assert.equal(scans, 1); assert.equal(points, 0);
			entries.push({ ...entries[0], id: "b", parentId: "a" });
			for (const tick of liveTicks) tick.callback();
			assert.match(footer.render(120)[0], /~\$0\.50/);
			assert.equal(scans, 1); assert.equal(points, 1);
			await handlers.get("session_tree")({ type: "session_tree" }, mocks.ctx);
			assert.equal(scans, 2);
			assert.match(footer.render(120)[0], /~\$0\.50/);
		} finally { footer.dispose(); }
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

const STASH_OWNER = "/ext/stash/index.ts";

/** A minimal published view: a list-free reader the frame can mount. */
function stubView(title: string) {
	return () => ({ title, render: () => [`${title} content`], handleInput: () => false });
}

describe("footer controls", () => {
	it("keeps line 2 to status: no navigation labels, whatever owners publish", async () => {
		const { handlers, publish } = makePi(() => [registration("stash")]);
		publish(STASH_OWNER, [{ id: "stash", label: "Stashes", command: { name: "stash" }, order: 10, view: stubView("Stashes") }]);
		for (const tuiMode of ["fullscreen", "regular"] as const) {
			const mocks = makeCtx({ tuiMode, cwd: "/work/project" });
			await handlers.get("session_start")(sessionStart, mocks.ctx);
			mocks.state.idle = false;
			const footer = installFooter(mocks);
			try {
				const line = strip(footer.render(120)[1]);
				assert.ok(line.startsWith("/work/project"), line);
				assert.doesNotMatch(line, /Stashes|Agents|More|Stop|\/commands/u, "the footer adds no navigation words");
				assert.equal(footer.handleMouse?.(click(1, 1, 120)), undefined, "the folder is not a control");
			} finally {
				footer.dispose();
			}
		}
	});

	it("opens Model from the model identity and Statuses from the +N cell, only at the rendered width", async () => {
		const statuses = new Map([["first", "alpha status"], ["second", "beta status"], ["third", "\x1b[2Jgamma\nstatus"]]);
		const { handlers } = makePi();
		const mocks = makeCtx({ tuiMode: "fullscreen", statuses, cwd: "/work/project" });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const footer = installFooter(mocks);
		try {
			footer.render(100);
			assert.equal(footer.handleMouse?.(click(60, 0, 100)), undefined, "line 1 outside the model and level segments is not a target");
			assert.equal(footer.handleMouse?.(click(2, 0, 90)), undefined, "a click at a stale width is ignored");
			let opened = mocks.onNextFrame((frame) => assert.equal(frame.activeKey, viewKey(ENTRY, "model")));
			assert.equal(footer.handleMouse?.(click(2, 0, 100))?.handled, true);
			await opened;
			assert.equal(mocks.customCalls[0]?.options, undefined, "the frame takes the editor slot, not an overlay");
			const text = strip(footer.render(40)[1]);
			assert.match(text, /\+\d$/, text);
			opened = mocks.onNextFrame((frame) => {
				assert.equal(frame.activeKey, viewKey(ENTRY, "statuses"));
				const shown = frameText(frame);
				for (const [key, value] of [["first", "alpha status"], ["second", "beta status"], ["third", "gamma status"]]) assert.match(shown, new RegExp(`${key}  ${value}`));
				assert.doesNotMatch(shown, /\[2J/, "values are opaque and sanitized");
			});
			assert.equal(footer.handleMouse?.(click(text.length - 1, 1, 40))?.handled, true);
			await opened;
		} finally {
			footer.dispose();
		}
	});
});

describe("Commands view", () => {
	it("sends an extension command only after an explicit Run with the exact current registration", async () => {
		const review = registration("review:1", { description: "Review the current diff" });
		const { handlers, commands, sent } = makePi(() => [registration("evo"), review]);
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const done = mocks.onNextFrame(async (frame) => {
			filterTo(frame, "review");
			assert.match(frameText(frame), /Review the current diff/);
			assert.equal(sent.length, 0, "selection sends nothing");
			act(frame, "Run with arguments…");
			typeText(frame, "src/index.ts");
			assert.equal(sent.length, 0, "typing sends nothing");
			act(frame, "Run");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.deepEqual(sent, [{ content: "/review:1 src/index.ts", options: { expandPromptTemplates: true } }]);
	});

	it("shows enter run in the footer, and Enter and a footer click both run the selected command", async () => {
		const { handlers, commands, sent } = makePi(() => [registration("review:1", { description: "Review the current diff" })]);
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const byKey = mocks.onNextFrame((frame) => {
			filterTo(frame, "review");
			const row = strip(frame.render(160).at(-1) ?? "");
			for (const control of ["enter run", "a arguments", "esc close"]) assert.ok(row.includes(control), `${control} in: ${row}`);
			frame.handleInput("\r");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await byKey;
		const byClick = mocks.onNextFrame((frame) => {
			// The query and selection survive reopening, so the list is already filtered.
			clickFooter(frame, "enter run");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await byClick;
		assert.deepEqual(sent, [
			{ content: "/review:1", options: { expandPromptTemplates: true } },
			{ content: "/review:1", options: { expandPromptTemplates: true } },
		]);
	});

	it("keeps unsent arguments and the selection when the frame closes and reopens", async () => {
		const { handlers, commands, sent } = makePi(() => [registration("evo"), registration("review:1")]);
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		let done = mocks.onNextFrame((frame) => {
			filterTo(frame, "review");
			act(frame, "Run with arguments…");
			typeText(frame, "half typed");
			frame.handleInput("\u001b");
			frame.handleInput("\u001b");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		done = mocks.onNextFrame((frame) => {
			assert.match(frameText(frame), /Unsent arguments: half typed/);
			act(frame, "Run with arguments…");
			assert.match(frameText(frame), /half typed/);
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.equal(sent.length, 0);
	});

	it("refuses a command whose registration disappeared and sends nothing", async () => {
		let inventory = [registration("evo"), registration("review:1")];
		const { handlers, commands, sent } = makePi(() => inventory);
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const done = mocks.onNextFrame((frame) => {
			filterTo(frame, "review");
			inventory = [registration("evo")];
			act(frame, "Run");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.equal(sent.length, 0, "a disappeared command is never sent as a prompt");
		assert.match(mocks.notifications.at(-1) ?? "", /no longer registered as selected; nothing was sent/);
	});

	it("prepares a prompt template into an empty editor and never sends it", async () => {
		const { handlers, commands, sent } = makePi(() => [registration("recap", { source: "prompt" })]);
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const done = mocks.onNextFrame((frame) => {
			filterTo(frame, "recap");
			assert.deepEqual(frame.viewActions.map((action) => action.label), ["Put in editor…"], "a prompt offers no Run");
			act(frame, "Put in editor…");
			assert.doesNotMatch(frameText(frame), /Placement/, "an empty editor needs no placement choice");
			typeText(frame, "today");
			act(frame, "Put in editor");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.equal(sent.length, 0);
		assert.deepEqual(mocks.editorCalls, ["set:/recap today"]);
	});

	it("keeps an existing draft unless the operator chooses Replace, then offers recovery", async () => {
		const { handlers, commands, sent } = makePi(() => [registration("skill:dig", { source: "skill" })]);
		const mocks = makeCtx({ editorText: "half-written draft" });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		let done = mocks.onNextFrame((frame) => {
			filterTo(frame, "dig");
			act(frame, "Put in editor…");
			assert.match(frameText(frame), /Insert at the cursor/);
			frame.handleInput("\r");
			frame.handleInput("\u001b[B");
			assert.match(frameText(frame), /Replace the draft/);
			act(frame, "Put in editor");
		});
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.equal(sent.length, 0);
		assert.deepEqual(mocks.editorCalls, ["set:/skill:dig"]);
		assert.match(mocks.notifications.at(-1) ?? "", /Restore replaced draft/);
		done = mocks.onNextFrame((frame) => act(frame, "Restore replaced draft"));
		await commands.get("commands").handler("", mocks.ctx);
		await done;
		assert.equal(mocks.editorCalls.at(-1), "paste:half-written draft", "recovery inserts into the current editor text");
	});

	it("closes an open frame on session shutdown without sending", async () => {
		const { handlers, commands, sent } = makePi();
		const mocks = makeCtx({});
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		let frame: NavigationFrame | undefined;
		mocks.ctx.ui.custom = (factory) => new Promise((resolve) => {
			frame = factory(mocks.tui, mocks.theme, { getKeys: () => [] }, resolve) as NavigationFrame;
		});
		const pending = commands.get("commands").handler("", mocks.ctx);
		await turn();
		assert.ok(frame, "the frame opened");
		await loaded(frame);
		filterTo(frame, "review");
		await handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, mocks.ctx);
		await pending;
		assert.equal(sent.length, 0);
	});

	it("explains the terminal requirement outside tui mode", async () => {
		const { handlers, commands } = makePi();
		const rpc = makeCtx({ mode: "rpc", hasUI: true });
		await handlers.get("session_start")(sessionStart, rpc.ctx);
		await commands.get("commands").handler("", rpc.ctx);
		assert.match(rpc.notifications.at(-1) ?? "", /interactive terminal/);
		assert.equal(rpc.customCalls.length, 0);
	});
});

describe("Statuses view", () => {
	it("needs the installed footer, then reads the live status map on every paint", async () => {
		const statuses = new Map([["lint", "lint ok"]]);
		const { handlers, commands } = makePi();
		const mocks = makeCtx({ statuses });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		let done = mocks.onNextFrame((frame) => assert.match(frameText(frame), /Enable the statusline \(\/statusline\)/));
		await commands.get("statuses").handler("", mocks.ctx);
		await done;
		installFooter(mocks);
		done = mocks.onNextFrame((frame) => {
			assert.match(frameText(frame), /lint {2}lint ok/);
			statuses.set("tests", "tests running");
			assert.match(frameText(frame), /tests {2}tests running/);
			assert.match(frameText(frame), /2 extension status entries/);
		});
		await commands.get("statuses").handler("", mocks.ctx);
		await done;
	});
});

describe("Model view", () => {
	const models: MockModel[] = [
		{ provider: "test", id: "test-model", name: "Test Model", reasoning: true },
		{ provider: "other", id: "plain", name: "Plain", reasoning: false },
		{ provider: "locked", id: "needs-auth", name: "Needs Auth", reasoning: true },
	];

	it("stages model and reasoning and applies them only on Apply", async () => {
		const { handlers, commands, models: applied, levels } = makePi();
		const mocks = makeCtx({ models });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const done = mocks.onNextFrame(async (frame) => {
			frame.navigate(viewKey(ENTRY, "model"));
			await loaded(frame);
			assert.match(frameText(frame), /Model and reasoning for this session/);
			frame.handleInput("\r");
			frame.handleInput("\u001b[B");
			assert.deepEqual(applied, [], "staging a level applies nothing");
			act(frame, "Apply");
			for (let attempt = 0; attempt < 20 && !/reasoning/.test(frameText(frame).split("\n").at(-1) ?? ""); attempt++) await turn();
			assert.match(frameText(frame, 160), /Model test\/test-model · reasoning high for this session/);
		});
		await commands.get("dashboard").handler("", mocks.ctx);
		await done;
		assert.deepEqual(applied, [], "the unchanged model is not set again");
		assert.equal(levels.length, 1);
	});

	it("reports Pi's refusal and changes nothing", async () => {
		const { handlers, commands, levels } = makePi(undefined, { setModel: (model) => model.provider !== "locked" });
		const mocks = makeCtx({ models });
		await handlers.get("session_start")(sessionStart, mocks.ctx);
		const done = mocks.onNextFrame(async (frame) => {
			frame.navigate(viewKey(ENTRY, "model"));
			await loaded(frame);
			typeText(frame, "needs");
			frame.handleInput("\u001b[B");
			act(frame, "Apply");
			for (let attempt = 0; attempt < 20 && !/refused/.test(frameText(frame)); attempt++) await turn();
			assert.match(frameText(frame, 160), /Pi refused locked\/needs-auth: authentication is not configured for locked/);
		});
		await commands.get("dashboard").handler("", mocks.ctx);
		await done;
		assert.deepEqual(levels, []);
	});
});
