import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { type ExtensionContext, initTheme, type SlashCommandInfo, type Theme } from "@earendil-works/pi-coding-agent";
import type { NavigationFrame } from "./frame.ts";
import { LoadingView, openOperatorFrame, publishOperatorViews, type ViewHost } from "./registration.ts";
import type { OperatorView } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

type Handler = (data: unknown) => void;

function bus() {
	const handlers = new Map<string, Set<Handler>>();
	return {
		on(name: string, handler: Handler) {
			const set = handlers.get(name) ?? new Set<Handler>();
			set.add(handler);
			handlers.set(name, set);
			return () => set.delete(handler);
		},
		emit(name: string, data: unknown) {
			for (const handler of [...(handlers.get(name) ?? [])]) handler(data);
		},
	};
}

function command(name: string, path: string): SlashCommandInfo {
	return { name, source: "extension", sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } } as unknown as SlashCommandInfo;
}

function pi(commands: SlashCommandInfo[] = []) {
	const events = bus();
	const api = {
		events,
		getCommands: () => commands,
		on: () => () => {},
	};
	return { api } as unknown as { api: Parameters<typeof openOperatorFrame>[0] };
}

function tuiContext(mounted: { frame?: NavigationFrame }) {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/work",
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify: () => {},
			custom: (factory: (tui: unknown, theme: Theme, keys: unknown, done: (value: undefined) => void) => NavigationFrame) =>
				new Promise<undefined>((resolve) => {
					mounted.frame = factory(
						{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
						theme,
						new KeybindingsManager(TUI_KEYBINDINGS),
						() => resolve(undefined),
					);
				}),
		},
	} as unknown as ExtensionContext;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const text = (frame: NavigationFrame | undefined): string =>
	(frame?.render(100) ?? []).map((row) => stripVTControlCharacters(row)).join("\n");

function deferred() {
	let resolve!: (view: OperatorView) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<OperatorView>((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const content = (title: string): OperatorView => ({
	title,
	render: (_width, height) => Array.from({ length: height }, () => title),
	handleInput: () => false,
});

it("a published loading view reads once, keeps owner state across reopens, drops a late load after close, and explains a failed load", async () => {
	const host = pi([command("loaded", "/loaded.ts")]);
	const loads: ReturnType<typeof deferred>[] = [];
	let state: { opens: number } | undefined;
	const load = () => {
		const next = deferred();
		loads.push(next);
		return next.promise;
	};
	publishOperatorViews(host.api, {
		version: 2,
		owner: "/loaded.ts",
		views: [
			{
				id: "loaded",
				label: "Loaded",
				command: { name: "loaded" },
				view: (_ctx, viewHost: ViewHost) =>
					new LoadingView("Loaded", viewHost, async () => {
						const view = await load();
						state ??= { opens: 0 };
						state.opens += 1;
						return view;
					}),
			},
		],
	});

	const first: { frame?: NavigationFrame } = {};
	const opened = openOperatorFrame(host.api, tuiContext(first), { owner: "/loaded.ts", id: "loaded" });
	await settle();
	assert.match(text(first.frame), /Reading/);
	assert.equal(loads.length, 1, "the module load starts on the first open");
	loads[0]?.resolve(content("First ready"));
	await settle();
	assert.match(text(first.frame), /First ready/);
	assert.equal(state?.opens, 1);

	first.frame?.close();
	await opened;
	const second: { frame?: NavigationFrame } = {};
	const reopened = openOperatorFrame(host.api, tuiContext(second), { owner: "/loaded.ts", id: "loaded" });
	await settle();
	assert.match(text(second.frame), /Reading/, "each open starts its own read");
	loads[1]?.resolve(content("Second ready"));
	await settle();
	assert.match(text(second.frame), /Second ready/);
	assert.equal(state?.opens, 2, "owner state survives the reopen");
	second.frame?.close();
	await reopened;

	const third: { frame?: NavigationFrame } = {};
	const closing = openOperatorFrame(host.api, tuiContext(third), { owner: "/loaded.ts", id: "loaded" });
	await settle();
	third.frame?.close();
	await closing;
	let disposed = 0;
	loads[2]?.resolve({ ...content("Too late"), dispose: () => (disposed += 1) });
	await settle();
	assert.equal(disposed, 1, "a load that finishes after the view closed is disposed");

	const fourth: { frame?: NavigationFrame } = {};
	const failing = openOperatorFrame(host.api, tuiContext(fourth), { owner: "/loaded.ts", id: "loaded" });
	await settle();
	loads[3]?.reject(new Error("source unavailable"));
	await settle();
	const failed = text(fourth.frame);
	assert.match(failed, /Could not read what this view needs: source unavailable/);
	assert.match(failed, /open it again to retry/);
	fourth.frame?.close();
	await failing;
});

const root = fileURLToPath(new URL("..", import.meta.url));

/** Evaluate one module in a fresh process and return every URL its graph loaded. */
function evaluate(entry: string): string[] {
	const dir = mkdtempSync(join(tmpdir(), "operator-ui-graph-"));
	const hook = join(dir, "hook.mjs");
	const runner = join(dir, "run.mjs");
	const out = join(dir, "out.json");
	writeFileSync(
		hook,
		[
			'import { registerHooks } from "node:module";',
			'import { writeFileSync } from "node:fs";',
			"const loaded = [];",
			"registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });",
			'process.on("exit", () => writeFileSync(process.env.PROBE_OUT, JSON.stringify(loaded)));',
		].join("\n"),
	);
	writeFileSync(
		runner,
		[
			'import { join } from "node:path";',
			'import { pathToFileURL } from "node:url";',
			"await import(pathToFileURL(join(process.cwd(), process.argv[2])).href);",
		].join("\n"),
	);
	try {
		const run = spawnSync(process.execPath, ["--import", hook, runner, entry], {
			cwd: root,
			env: { ...process.env, PROBE_OUT: out, PI_CODING_AGENT_DIR: dir },
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(readFileSync(out, "utf8")) as string[];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const LOADING_ENTRY = ["/operator-ui/registration.ts", "/operator-ui/loading.ts", "/operator-ui/text.ts", "/operator-ui/ordinary.ts"];

function implementation(urls: readonly string[]): string[] {
	return urls.filter((url) => /\/operator-ui\/(frame|form|browser|list|controls|field|hits|keys|reader|panel)\.ts$/u.test(url));
}

it("the registration entry evaluates only the publication and loading modules", () => {
	const urls = evaluate("operator-ui/registration.ts");
	for (const module of LOADING_ENTRY) assert.ok(urls.some((url) => url.endsWith(module)), `registration loads ${module}`);
	assert.deepEqual(implementation(urls), [], "no frame, form, browser, list, controls, field, keys, reader or panel module");
});

it("the registration entrypoints evaluate no frame or view implementation", () => {
	const entries: ReadonlyArray<readonly [string, string]> = [
		["extensions/clipboard/index.ts", "/extensions/clipboard/operator-view.ts"],
		["extensions/stash/index.ts", "/extensions/stash/operator-view.ts"],
		["extensions/pillars/index.ts", "/extensions/pillars/operator-view.ts"],
		["extensions/policy/index.ts", "/extensions/policy/operator-view.ts"],
		["extensions/statusline/index.ts", "/extensions/statusline/views.ts"],
	];
	for (const [entry, view] of entries) {
		const urls = evaluate(entry);
		assert.deepEqual(implementation(urls), [], `${entry} evaluates no operator-ui implementation`);
		assert.ok(!urls.some((url) => url.endsWith(view)), `${entry} evaluates no view module`);
	}
});
