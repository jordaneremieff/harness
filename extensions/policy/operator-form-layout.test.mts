import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { NavigationFrame } from "../../operator-ui/index.ts";
import { type PolicyOperations, policyView } from "./operator-view.ts";
import { data as panelData, snapshot as policySnapshot, scopeContext, viewTheme } from "./view-fixture.mts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const plain = (line: string) => stripVTControlCharacters(line).trimEnd();
const RIGHT = "\u001b[C";
const ENTER = "\r";
const SHIFT_TAB = "\u001b[Z";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The policy owner, answering from fixtures; every change route refuses so an unintended call fails loudly. */
function operations(): PolicyOperations {
	const snapshot = policySnapshot();
	const refused = async (): Promise<never> => {
		throw new Error("unexpected policy change");
	};
	return {
		load: async () => ({ snapshot, fireSummary: panelData().fireSummary, activity: panelData().activity, scope: scopeContext }),
		refresh: async () => snapshot,
		inspect: async () => ({ text: "Observation state", snapshot }),
		approve: refused,
		reject: refused,
		lifecycle: refused,
		effect: refused,
		resetRevision: async () => "abcdefabcdef",
		reset: refused,
		data: refused,
	};
}

async function until(shown: () => string, pattern: RegExp, label: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const text = shown();
		if (pattern.test(text)) return text;
		await turn();
	}
	throw new Error(`the view never showed ${label}; last screen:\n${shown()}`);
}

/** A frame that gives its body the rows an ordinary 24-row terminal leaves below the header. */
function frame() {
	return new NavigationFrame({
		theme: viewTheme,
		target: { id: "session", label: "This session" },
		destinations: () => [{ key: "policy", label: "Policy", open: (host) => policyView(host, operations()) }],
		rows: () => 14,
		requestRender: () => {},
		close: () => {},
	});
}

for (const width of [80, 120]) {
	it(`the Set data validation error is visible at ${width} columns in a 14-row frame`, async () => {
		const view = frame();
		const shown = () => view.render(width).map(plain).join("\n");
		await until(shown, /named data|rules/, "the loaded policy registry");
		view.render(width);
		view.handleInput(SHIFT_TAB);
		for (let step = 0; step < 3; step++) {
			view.handleInput(RIGHT);
			view.render(width);
		}
		assert.match(shown(), /No named policy data/);
		const set = view.viewActions.find((action) => action.label === "Set data…");
		assert.ok(set, "the data scope offers Set data");
		assert.equal(set.disabled, undefined);
		set.run();
		assert.equal(view.viewTitle, "Set data");
		view.render(width);
		view.handleInput("{");
		view.handleInput(ENTER);
		const screen = shown();
		assert.match(screen, /The JSON does not parse/, `the error is visible at ${width} columns`);
		assert.match(screen.split("\n").at(-1) ?? "", /esc cancel/, "the footer stays on the last row");
	});
}
