import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { theme } from "./dashboard-test-fixture.mts";
import { Inspector } from "./inspector.ts";
import { keyInput, keyMatches } from "./view-keys.ts";
import type { Action, KeyHint, View, ViewHost } from "./view-model.ts";

const ESCAPE = "\u001b";

/** What each probe view received, by title, for the current mount. */
const probes = new Map<string, { inputs: string[]; disposed: boolean; host?: ViewHost }>();

function probe(
	title: string,
	options: {
		actions?: () => readonly Action[];
		keys?: () => readonly KeyHint[];
		escape?: () => boolean;
		render?: () => string;
	} = {},
): (host: ViewHost) => View {
	return (host) => {
		const state = { inputs: [] as string[], disposed: false, host };
		probes.set(title, state);
		return {
			title,
			render: (width, height) =>
				Array.from({ length: height }, (_, row) =>
					(row === 0 ? (options.render?.() ?? `${title} body`) : "").padEnd(width),
				),
			handleInput: (data) => {
				state.inputs.push(data);
				return true;
			},
			...(options.actions ? { actions: options.actions } : {}),
			...(options.keys ? { keys: options.keys } : {}),
			...(options.escape ? { escape: options.escape } : {}),
			dispose: () => {
				state.disposed = true;
			},
		};
	};
}

function mount(open: (host: ViewHost) => View, rows = 12) {
	probes.clear();
	let closes = 0;
	const inspector = new Inspector({
		theme,
		target: { id: "a", label: "Parser review · harness" },
		title: "Configure",
		open,
		rows: () => rows,
		requestRender: () => {},
		close: () => {
			closes++;
		},
	});
	const lines = () => inspector.render(80).map((line) => stripVTControlCharacters(line));
	return { inspector, lines, closes: () => closes };
}

function click(inspector: Inspector, x: number, y: number, rows = 12): void {
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: rows,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	inspector.handleMouse(event);
}

it("the title row names the inspector and its bound target, and the key row ends with the way out", () => {
	const { lines } = mount(probe("Configure"));
	const shown = lines();
	assert.match(shown[0] ?? "", /^─ Configure ─+ +Parser review · harness ─$/u);
	assert.match(shown[1] ?? "", /^Configure body/u);
	assert.match((shown.at(-1) ?? "").trimEnd(), /^esc close$/u);
});

it("Escape runs the view's own escape, then its Cancel, then leaves a nested view, then the inspector", () => {
	let escapes = 0;
	let cancels = 0;
	const { inspector, lines, closes } = mount(
		probe("Root", {
			escape: () => escapes++ === 0,
			actions: () => [{ id: "cancel", label: "Cancel", key: "escape", run: () => cancels++ }],
		}),
	);
	inspector.handleInput(ESCAPE);
	assert.equal(escapes, 1, "the view leaves its edit first");
	assert.equal(cancels, 0);
	inspector.handleInput(ESCAPE);
	assert.equal(cancels, 1, "then Escape runs the view's Cancel");
	assert.equal(closes(), 0);
	probes.get("Root")?.host?.push(probe("Detail"));
	assert.match(lines().join("\n"), /Root › Detail/u, "a nested view shows the trail");
	assert.match((lines().at(-1) ?? "").trimEnd(), /esc back$/u);
	inspector.handleInput(ESCAPE);
	assert.equal(probes.get("Detail")?.disposed, true, "leaving the nested view disposes it");
	assert.doesNotMatch(lines().join("\n"), /Detail body/u);
	assert.equal(closes(), 0);
});

it("a key the view's hints claim stays with the view and its action lists in More without the key", () => {
	let runs = 0;
	const { inspector, lines } = mount(
		probe("Root", {
			keys: () => [{ keys: ["r"], label: "reload" }],
			actions: () => [{ id: "restart", label: "Restart", key: "r", primary: true, run: () => runs++ }],
		}),
	);
	assert.match(lines().at(-1) ?? "", /^r reload · x more · esc close/u);
	inspector.handleInput("r");
	assert.equal(runs, 0, "the claimed key reaches the view only");
	assert.deepEqual(probes.get("Root")?.inputs, ["r"]);
	inspector.handleInput("x");
	const menu = lines();
	const entry = menu.findIndex((line) => /Restart/u.test(line));
	assert.ok(entry > 0, "More lists the action");
	assert.doesNotMatch(menu[entry] ?? "", /\br\b +Restart/u, "its key column is empty");
	inspector.handleInput("\r");
	assert.equal(runs, 1, "the More entry runs the action");
});

it("a click on a key-row control runs exactly what its key runs", () => {
	let runs = 0;
	const { inspector, lines } = mount(
		probe("Root", { actions: () => [{ id: "apply", label: "Apply", key: "a", primary: true, run: () => runs++ }] }),
	);
	const row = lines().at(-1) ?? "";
	assert.match(row, /^a apply · esc close/u);
	click(inspector, row.indexOf("apply"), 11);
	assert.equal(runs, 1);
	inspector.handleInput("a");
	assert.equal(runs, 2);
});

it("a disabled action explains itself and does not run", () => {
	let runs = 0;
	const { inspector, lines } = mount(
		probe("Root", {
			actions: () => [
				{
					id: "apply",
					label: "Apply",
					key: "a",
					primary: true,
					disabled: "The request is still running",
					run: () => runs++,
				},
			],
		}),
	);
	lines();
	inspector.handleInput("a");
	assert.equal(runs, 0);
	assert.match(lines().join("\n"), /The request is still running/u);
});

it("a view that fails while drawing is replaced by its reason, and a view that cannot open says why", () => {
	const broken = mount(
		probe("Root", {
			render: () => {
				throw new Error("no layout");
			},
		}),
	);
	assert.match(broken.lines().join("\n"), /Root is unavailable here\.\s+no layout/u);
	const refused = mount(() => {
		throw new Error("module not loaded");
	});
	assert.match(refused.lines().join("\n"), /Configure is unavailable here\.\s+module not loaded/u);
	assert.equal(refused.inspector.viewTitle, "Configure");
});

it("a late answer after the view was left is not shown", () => {
	const { inspector, lines } = mount(probe("Root"));
	const host = probes.get("Root")?.host;
	assert.ok(host);
	inspector.handleInput(ESCAPE);
	assert.equal(host.signal.aborted, true, "leaving aborts the view's signal");
	host.notify("late answer");
	assert.doesNotMatch(lines().join("\n"), /late answer/u);
});

it("every key a key row can show has an input form that its key matching accepts", () => {
	for (const key of [
		"up",
		"down",
		"pageUp",
		"pageDown",
		"home",
		"end",
		"enter",
		"tab",
		"shift+tab",
		"escape",
		"x",
		"/",
		"?",
		"ctrl+n",
		"ctrl+o",
		"ctrl+t",
		"alt+s",
		"shift+enter",
		"ctrl+shift+up",
		"f5",
	]) {
		const data = keyInput(key);
		assert.ok(data !== undefined, `${key} has an input form`);
		assert.ok(keyMatches(data, key), `${key} matches its own input`);
	}
	assert.equal(keyInput("alt+escape"), undefined, "a key without an accepted form is refused, not guessed");
});
