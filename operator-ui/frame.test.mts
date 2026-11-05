import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Destination, NavigationFrame } from "./frame.ts";
import { HitMap } from "./hits.ts";
import type { Action, KeyHint, OperatorView, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const ESC = "\u001b";
const plain = (line: string) => stripVTControlCharacters(line);
const lines = (view: NavigationFrame, width = 80) => view.render(width).map((line) => plain(line).trimEnd());

interface Probe {
	readonly hosts: ViewHost[];
	readonly signals: AbortSignal[];
	readonly seen: string[];
	escapes: number;
}

function probe(): Probe {
	return { hosts: [], signals: [], seen: [], escapes: 0 };
}

function body(title: string, text: string): OperatorView["render"] {
	return (_width, height) => Array.from({ length: height }, (_, row) => (row === 0 ? `${title} ${text}` : ""));
}

/** A view with no keys and no actions, for the frame's own footer wording. */
function bare(title: string): OperatorView {
	return { title, render: body(title, "rows"), handleInput: () => false };
}

/** A view that counts "+" keys, opens a nested view by its key or by click, and can consume Escape. */
function counter(host: ViewHost, title: string, seen: Probe): OperatorView {
	seen.hosts.push(host);
	seen.signals.push(host.signal);
	let count = 0;
	const open = () => host.push((next) => counter(next, "Nested", seen));
	return {
		title,
		render: (_width, height) => {
			const row = `${title} count ${count}`;
			return Array.from({ length: height }, (_, index) => (index === 0 ? row : ""));
		},
		handleInput: (data) => {
			if (data !== "+") return false;
			count++;
			return true;
		},
		keys: () => [{ keys: ["up", "down"], label: "select", priority: 0 }],
		actions: () => [{ id: "open", label: "Open nested", key: "o", primary: true, run: open }],
		escape: () => {
			if (seen.escapes <= 0) return false;
			seen.escapes--;
			return true;
		},
	};
}

/** A view whose own keys are the only ones it handles; it records the input each click sends. */
function keysView(host: ViewHost, title: string, seen: Probe, hints: readonly KeyHint[], actions: readonly Action[] = []): OperatorView {
	seen.hosts.push(host);
	return {
		title,
		render: body(title, "keys"),
		handleInput: (data) => {
			seen.seen.push(data);
			return true;
		},
		keys: () => hints,
		actions: () => actions,
	};
}

/** A view with a focused text field: every printable key is text, and the field reports editing. */
function fieldView(host: ViewHost, title: string, seen: Probe, runs: string[]): OperatorView {
	seen.hosts.push(host);
	return {
		title,
		render: body(title, "field"),
		editing: () => true,
		handleInput: (data) => {
			seen.seen.push(data);
			return true;
		},
		keys: () => [{ keys: ["tab"], label: "focus" }],
		actions: () => [
			{ id: "zap", label: "Zap", key: "z", primary: true, run: () => runs.push("zap") },
			{ id: "fork", label: "Fork", run: () => runs.push("fork") },
		],
	};
}

function resizeView(host: ViewHost, title: string, seen: Probe): OperatorView {
	seen.hosts.push(host);
	const keys: readonly KeyHint[] = [{ keys: ["up", "down"], label: "select", priority: 0 }];
	return {
		title,
		render: body(title, "rows"),
		handleInput: () => false,
		keys: () => keys,
		actions: () => [
			{ id: "open", label: "Open", key: "enter", primary: true, run: () => seen.seen.push("open") },
			{ id: "attach", label: "Attach", key: "a", primary: true, run: () => seen.seen.push("attach") },
			{ id: "configure", label: "Configure", key: "c", primary: true, run: () => seen.seen.push("configure") },
			{ id: "threads", label: "Threads", key: "t", primary: true, run: () => seen.seen.push("threads") },
			{ id: "tasks", label: "Tasks", key: "k", primary: true, run: () => seen.seen.push("tasks") },
		],
	};
}

interface FramePatch {
	readonly initial?: string;
	readonly closeLabel?: string;
	readonly tabs?: boolean;
	readonly footer?: boolean;
	readonly controls?: () => readonly Action[];
}

function frame(destinations: Destination[], patch: FramePatch = {}) {
	const closes: Array<(() => void) | undefined> = [];
	const view = new NavigationFrame({
		theme,
		target: { id: "session", label: "This session · work" },
		destinations: () => destinations,
		initial: patch.initial,
		rows: () => 12,
		requestRender: () => {},
		close: (then) => closes.push(then),
		...(patch.closeLabel ? { closeLabel: patch.closeLabel } : {}),
		...(patch.tabs === false ? { tabs: false } : {}),
		...(patch.footer === false ? { footer: false } : {}),
		...(patch.controls ? { controls: patch.controls } : {}),
	});
	return {
		view,
		closes,
		lines: (width = 80) => lines(view, width),
		screen: (width = 80) => lines(view, width).join("\n"),
	};
}

function click(view: NavigationFrame, x: number, y: number, width = 80) {
	return view.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 12, shift: false, alt: false, ctrl: false, clickCount: 1 });
}

it("destinations show as tabs with the target, and the way out is the footer's last row", () => {
	const seen = probe();
	const f = frame([
		{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) },
		{ key: "b", label: "Beta", open: (host) => counter(host, "Beta", seen) },
	]);
	const rows = f.lines();
	assert.match(rows[0] ?? "", /Alpha/);
	assert.match(rows[0] ?? "", /Beta/);
	assert.match(rows[0] ?? "", /This session · work/);
	assert.doesNotMatch(rows[0] ?? "", /close/i, "the header holds no commands");
	assert.equal(rows.at(-1), "↑↓ select · o open nested · esc close");
	f.view.handleInput("+");
	f.view.handleInput("+");
	f.view.navigate("b");
	assert.ok(f.screen().includes("Beta count 0"));
	f.view.navigate("a");
	assert.ok(f.screen().includes("Alpha count 2"), "returning to a destination keeps its view state");
	assert.equal(seen.hosts.length, 2, "a destination opens once while the frame stays open");
});

it("a narrow tab row keeps every destination, and the target gives way before a tab", () => {
	const seen = probe();
	const labels = ["One", "Two", "Three", "Four", "Five", "Six", "Seven"];
	const f = frame(labels.map((label) => ({ key: label, label, open: (host: ViewHost) => counter(host, label, seen) })));
	for (const width of [120, 80, 60]) {
		const rows = f.lines(width);
		const row = rows[0] ?? "";
		for (const label of labels) assert.ok(row.includes(label.slice(0, 2)), `${label} stays reachable at ${width}: ${row}`);
		if (width === 120) assert.ok(row.includes("This session · work"), "a wide row also names the target");
		assert.doesNotMatch(row, /close/i);
		assert.equal(rows.at(-1), "↑↓ select · o open nested · esc close", `the footer keeps the way out at ${width}`);
	}
	const narrow = f.lines(60);
	const x = (narrow[0] ?? "").indexOf("Th");
	click(f.view, x + 1, 0, 60);
	assert.equal(f.view.activeKey, "Three", "a shortened tab still opens its destination");
	const footer = f.lines(60).at(-1) ?? "";
	click(f.view, footer.indexOf("esc") + 1, 11, 60);
	assert.equal(f.closes.length, 1, "the way out answers where it is drawn");
});

it("push adds a muted trail row with no Back control, and the footer goes back", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	seen.hosts[0]?.push((host) => counter(host, "Nested", seen));
	assert.equal(f.view.viewTitle, "Nested");
	const nested = f.screen();
	assert.ok(nested.includes("Alpha › Nested"));
	assert.ok(!nested.includes("‹ Back"), "the trail is passive text, not a control");
	assert.equal(f.lines().at(-1), "↑↓ select · o open nested · esc back");
	click(f.view, (f.lines().at(-1) ?? "").indexOf("esc") + 1, 11);
	assert.equal(f.view.viewTitle, "Alpha");
	assert.ok(seen.signals[1]?.aborted, "leaving a nested view aborts its requests");
	assert.equal(seen.signals[0]?.aborted, false);
});

it("Escape closes the menu, then lets the view consume it, then leaves the nested view, then closes the frame", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	seen.hosts[0]?.push((host) => counter(host, "Nested", seen));
	seen.escapes = 1;
	f.view.handleInput(ESC);
	assert.equal(f.view.viewTitle, "Nested", "the view consumed the first Escape");
	f.view.handleInput(ESC);
	assert.equal(f.view.viewTitle, "Alpha", "the next Escape leaves the nested view");
	assert.equal(f.closes.length, 0);
	f.view.handleInput(ESC);
	assert.equal(f.closes.length, 1, "Escape at the root closes the frame");
	assert.ok(seen.signals.every((signal) => signal.aborted), "closing aborts every view's requests");
});

it("a view that fails to open or to draw costs only its destination", () => {
	const seen = probe();
	const f = frame([
		{
			key: "bad",
			label: "Broken",
			open: () => {
				throw new Error("the owner module failed");
			},
		},
		{ key: "draw", label: "Faulty", open: () => ({ title: "Faulty", render: () => { throw new Error("paint failed"); }, handleInput: () => false }) },
		{ key: "good", label: "Working", open: (host) => counter(host, "Working", seen) },
	]);
	assert.ok(f.screen().includes("Broken is unavailable here"));
	assert.ok(f.screen().includes("the owner module failed"));
	assert.equal(f.lines().at(-1), "esc close");
	f.view.navigate("draw");
	assert.ok(f.screen().includes("paint failed"));
	f.view.navigate("good");
	f.view.handleInput("+");
	assert.ok(f.screen().includes("Working count 1"));
});

it("an unavailable destination stays listed and explains itself", () => {
	const f = frame([{ key: "off", label: "Offline", unavailable: "/offline is not registered by its owner", open: () => { throw new Error("never opened"); } }]);
	const screen = f.screen();
	assert.ok(screen.includes("Offline"));
	assert.ok(screen.includes("/offline is not registered by its owner"));
	assert.equal(f.lines().at(-1), "esc close", "the way out stays reachable");
});

it("close passes its continuation to the host, which runs it after the frame leaves", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	const ran: string[] = [];
	seen.hosts[0]?.close(() => ran.push("after"));
	assert.equal(f.closes.length, 1);
	assert.deepEqual(ran, [], "the frame does not run the continuation itself");
	f.closes[0]?.();
	assert.deepEqual(ran, ["after"]);
	seen.hosts[0]?.close();
	assert.equal(f.closes.length, 1, "a closed frame ignores a second close");
});

it("an action runs by its key and by a click on its footer control", () => {
	const seen = probe();
	const byKey = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	byKey.view.handleInput("o");
	assert.equal(byKey.view.viewTitle, "Nested");
	const byClick = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	const row = byClick.lines().at(-1) ?? "";
	click(byClick.view, row.indexOf("o open nested"), 11);
	assert.equal(byClick.view.viewTitle, "Nested");
	const gap = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	const gapRow = gap.lines().at(-1) ?? "";
	click(gap.view, gapRow.indexOf(" · "), 11);
	assert.equal(gap.view.viewTitle, "Alpha", "the separator between controls is inert");
});

it("each token of a two-key control has its own target and sends its key", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => keysView(host, "Alpha", seen, [{ keys: ["up", "down"], label: "select", priority: 0 }]) }]);
	assert.equal(f.lines().at(-1), "↑↓ select · esc close");
	click(f.view, 0, 11);
	click(f.view, 1, 11);
	click(f.view, 2, 11);
	assert.deepEqual(seen.seen, ["\u001b[A", "\u001b[B"], "a click beyond the key tokens does nothing");
	const pages = probe();
	const page = frame([{ key: "a", label: "Alpha", open: (host) => keysView(host, "Alpha", pages, [{ keys: ["pageUp", "pageDown"], label: "read", priority: 0 }]) }]);
	assert.equal(page.lines().at(-1), "pgup/pgdn read · esc close");
	click(page.view, 0, 11);
	click(page.view, 5, 11);
	click(page.view, 4, 11);
	assert.deepEqual(pages.seen, ["\u001b[5~", "\u001b[6~"], "the slash between keys is inert");
});

it("while a field has focus the footer shows no action keys or More, and letters reach the field", () => {
	const seen = probe();
	const runs: string[] = [];
	const f = frame([{ key: "a", label: "Alpha", open: (host) => fieldView(host, "Alpha", seen, runs) }]);
	assert.equal(f.lines().at(-1), "tab focus · esc close");
	assert.doesNotMatch(f.screen(), /z zap|x more/);
	f.view.handleInput("z");
	assert.deepEqual(seen.seen, ["z"]);
	assert.deepEqual(runs, [], "the action key is text while the field has focus");
});

it("the Escape control names what Escape does now", () => {
	const label = (open: (host: ViewHost) => OperatorView, patch: FramePatch = {}) => frame([{ key: "a", label: "Alpha", open }], patch).lines().at(-1);
	assert.equal(
		label((host) => keysView(host, "Alpha", probe(), [{ keys: ["escape"], label: "list" }])),
		"esc list",
		"a view's own Escape hint wins",
	);
	assert.equal(
		label((host) => keysView(host, "Alpha", probe(), [], [{ id: "cancel", label: "Cancel", key: "escape", primary: true, run: () => {} }])),
		"esc cancel",
		"a Cancel action names the key",
	);
	assert.equal(label(() => bare("Alpha")), "esc close");
	assert.equal(label(() => bare("Alpha"), { closeLabel: "quit" }), "esc quit");
	const seen = probe();
	const nested = frame([{ key: "a", label: "Alpha", open: (host) => keysView(host, "Alpha", seen, []) }]);
	nested.view.render(80);
	seen.hosts[0]?.push((host) => keysView(host, "Nested", probe(), []));
	assert.equal(nested.lines().at(-1), "esc back", "a nested view goes back");
});

it("the More menu lists hidden and keyless actions with their keys, and runs only the chosen one", () => {
	const runs: string[] = [];
	const f = frame([
		{
			key: "a",
			label: "Alpha",
			open: () => ({
				title: "Alpha",
				render: body("Alpha", "rows"),
				handleInput: () => false,
				actions: () => [
					{ id: "open", label: "Open", key: "o", primary: true, run: () => runs.push("open") },
					{ id: "fork", label: "Fork", description: "An idle branch from a committed message", run: () => runs.push("fork") },
				],
			}),
		},
	]);
	assert.equal(f.lines().at(-1), "o open · x more · esc close");
	f.view.handleInput("x");
	const open = f.lines();
	assert.equal(open.at(-1), "↑↓ choose · enter run · esc close menu");
	assert.ok(open.join("\n").includes("Fork"), "the keyless action is reachable in More");
	f.view.handleInput("\r");
	assert.deepEqual(runs, ["fork"]);
	assert.equal(f.lines().at(-1), "o open · x more · esc close");
	f.view.handleInput("x");
	f.view.handleInput(ESC);
	assert.deepEqual(runs, ["fork"], "Escape closes the menu and runs nothing");
	assert.equal(f.closes.length, 0, "Escape in the menu does not leave the frame");
	assert.equal(f.lines().at(-1), "o open · x more · esc close");
});

it("a disabled action stays listed and explains itself without running", () => {
	const runs: string[] = [];
	const f = frame([
		{
			key: "a",
			label: "Alpha",
			open: () => ({
				title: "Alpha",
				render: body("Alpha", "rows"),
				handleInput: () => false,
				actions: () => [{ id: "await", label: "Release await", key: "w", primary: true, disabled: "No await is pending", run: () => runs.push("await") }],
			}),
		},
	]);
	f.view.render(80);
	f.view.handleInput("w");
	assert.deepEqual(runs, []);
	assert.ok(f.screen().includes("No await is pending"), "the reason reaches the operator");
	assert.equal(f.lines().at(-1), "w release await · esc close", "the control stays listed");
});

it("footer targets come from the latest render, so a resize moves them", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => resizeView(host, "Alpha", seen) }]);
	const wide = f.lines(120);
	assert.equal(wide.at(-1), "↑↓ select · enter open · a attach · c configure · t threads · k tasks · esc close");
	const threadsX = (wide.at(-1) ?? "").indexOf("t threads");
	const narrow = f.lines(70);
	assert.equal(narrow.at(-1), "↑↓ select · enter open · a attach · c configure · x more · esc close");
	assert.ok(!narrow.at(-1)?.includes("threads"));
	click(f.view, threadsX, 11, 70);
	assert.equal(f.lines(70).at(-1), "↑↓ choose · enter run · esc close menu", "the old position now opens More");
	assert.ok(f.screen(70).includes("threads"), "the hidden action is listed with its key");
	assert.deepEqual(seen.seen, [], "no action ran from the stale position");
});

it("Tab moves through the view's regions and then the destination row, where commands need no focus", () => {
	const seen = probe();
	const view = (host: ViewHost): OperatorView => {
		let region = 0;
		return {
			title: "Alpha",
			render: body("Alpha", "rows"),
			handleInput: () => false,
			focusNext: (backward) => {
				if (backward || region > 0) return false;
				region = 1;
				return true;
			},
			focusEdge: () => {
				region = 0;
			},
			actions: () => [{ id: "open", label: "Open", key: "o", primary: true, run: () => host.push((next) => counter(next, "Nested", seen)) }],
		};
	};
	const f = frame([
		{ key: "a", label: "Alpha", open: view },
		{ key: "b", label: "Beta", open: (host) => counter(host, "Beta", seen) },
	]);
	f.view.handleInput("\t");
	assert.equal(f.lines().at(-1), "o open · esc close", "Tab stays inside the view while it has another region");
	f.view.handleInput("\t");
	assert.equal(f.lines().at(-1), "←→ choose · enter open · esc back", "the destination row has its own footer");
	f.view.handleInput("\u001b[C");
	f.view.handleInput("\r");
	assert.equal(f.view.activeKey, "b", "the destination row takes arrows and Enter");
	const back = frame([{ key: "a", label: "Alpha", open: view }]);
	back.view.handleInput("\t");
	back.view.handleInput("\t");
	back.view.handleInput(ESC);
	assert.equal(back.closes.length, 0, "Escape returns from the destination row to the view");
	assert.equal(back.lines().at(-1), "o open · esc close");
});

it("a host that draws its own footer can request the frame's row", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }], { footer: false });
	assert.ok(!f.screen().includes("esc close"), "the frame draws no footer row");
	const hits = new HitMap();
	hits.begin(80, 12);
	const row = plain(f.view.renderFooter(80, hits, 11)).trimEnd();
	assert.equal(row, "↑↓ select · o open nested · esc close");
});
