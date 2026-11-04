import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SlashCommandInfo, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	CommandsPanel,
	commandIdentity,
	commandLine,
	createSelectorState,
	dispatchExtensionCommand,
	filterCommands,
	prepareDraft,
	restoreDraft,
	type CommandsPanelResult,
	type SelectorState,
} from "./commands.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

function command(name: string, over: Partial<SlashCommandInfo> & { path?: string } = {}): SlashCommandInfo {
	return {
		name,
		description: over.description ?? `${name} description`,
		source: over.source ?? "extension",
		sourceInfo: {
			path: over.path ?? `/ext/${name}/index.ts`,
			source: "../../harness",
			scope: "user",
			origin: "package",
			...over.sourceInfo,
		},
	};
}

const evo = command("evo", { description: "Autonomous harness improvement with an optional direction" });
const review = command("review:1", { description: "Review the current diff" });
const recap = command("recap", { source: "prompt", description: "Summarise the session", path: "/prompts/recap.md" });
const skill = command("skill:dig", { source: "skill", description: "Dig into a question", path: "/skills/dig/SKILL.md" });
const inventory = [evo, review, recap, skill];

function click(x: number, y: number, width: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width, height: 30, shift: false, alt: false, ctrl: false };
}

function wheel(delta: number, width: number, y = 2): TuiMouseEvent {
	return { ...click(0, y, width, "wheel"), button: "none" as TuiMouseEvent["button"], wheelDelta: delta };
}

function makePanel(over: { commands?: SlashCommandInfo[]; state?: SelectorState; draft?: boolean; replaced?: boolean; rows?: number } = {}) {
	const results: CommandsPanelResult[] = [];
	const state = over.state ?? createSelectorState();
	const panel = new CommandsPanel({
		commands: over.commands ?? inventory,
		theme,
		rows: over.rows ?? 30,
		state,
		draftPresent: () => over.draft ?? false,
		replacedDraftPresent: () => over.replaced ?? false,
		done: (result) => results.push(result),
	});
	return { panel, results, state };
}

/** Rendered row index and column of a label, or -1 when absent. */
function locate(lines: string[], label: string): { y: number; x: number } {
	const y = lines.findIndex((line) => strip(line).includes(label));
	return { y, x: y >= 0 ? strip(lines[y]).indexOf(label) : -1 };
}

describe("registration identity and filtering", () => {
	it("distinguishes registrations by provenance, not name alone", () => {
		const twin = command("review:1", { path: "/other/review/index.ts" });
		assert.notEqual(commandIdentity(review), commandIdentity(twin));
		assert.equal(commandIdentity(review), commandIdentity({ ...review, sourceInfo: { ...review.sourceInfo } }));
	});

	it("matches every query word against name or description", () => {
		assert.deepEqual(filterCommands(inventory, "harness improvement").map((c) => c.name), ["evo"]);
		assert.deepEqual(filterCommands(inventory, "REVIEW").map((c) => c.name), ["review:1"]);
		assert.deepEqual(filterCommands(inventory, "  ").map((c) => c.name), inventory.map((c) => c.name));
		assert.deepEqual(filterCommands(inventory, "nothing matches this"), []);
	});

	it("builds the exact invocation line with trimmed arguments", () => {
		assert.equal(commandLine("review:1", ""), "/review:1");
		assert.equal(commandLine("review:1", "  src/index.ts  "), "/review:1 src/index.ts");
	});
});

describe("dispatchExtensionCommand", () => {
	function host(current: SlashCommandInfo[]) {
		const sent: Array<{ content: string; options: unknown }> = [];
		return {
			sent,
			getCommands: () => current,
			sendUserMessage: (content: string, options: unknown) => {
				sent.push({ content, options });
			},
		};
	}

	it("sends the collision-suffixed name with command expansion", () => {
		const h = host(inventory);
		assert.deepEqual(dispatchExtensionCommand(h, review, " src "), { kind: "sent", line: "/review:1 src" });
		assert.deepEqual(h.sent, [{ content: "/review:1 src", options: { expandPromptTemplates: true } }]);
	});

	it("refuses a registration that disappeared or changed provenance", () => {
		const gone = host([evo]);
		assert.deepEqual(dispatchExtensionCommand(gone, review, ""), { kind: "changed" });
		const moved = host([command("review:1", { path: "/moved/review/index.ts" })]);
		assert.deepEqual(dispatchExtensionCommand(moved, review, ""), { kind: "changed" });
		assert.equal(gone.sent.length + moved.sent.length, 0, "nothing reaches the session");
	});

	it("never sends prompt templates or skills", () => {
		const h = host(inventory);
		assert.deepEqual(dispatchExtensionCommand(h, recap, ""), { kind: "not-extension" });
		assert.deepEqual(dispatchExtensionCommand(h, skill, ""), { kind: "not-extension" });
		assert.equal(h.sent.length, 0);
	});
});

describe("draft preparation", () => {
	function editor(initial: string) {
		const calls: string[] = [];
		let text = initial;
		return {
			calls,
			getEditorText: () => text,
			setEditorText: (value: string) => {
				calls.push(`set:${value}`);
				text = value;
			},
			pasteToEditor: (value: string) => {
				calls.push(`paste:${value}`);
				text += value;
			},
		};
	}

	it("fills an empty editor directly", () => {
		const e = editor("");
		assert.deepEqual(prepareDraft(e, "/recap", "replace"), {});
		assert.deepEqual(e.calls, ["set:/recap"]);
	});

	it("inserts through paste handling and keeps the draft", () => {
		const e = editor("half-written");
		assert.deepEqual(prepareDraft(e, "/skill:dig why", "insert"), {});
		assert.deepEqual(e.calls, ["paste:/skill:dig why"]);
	});

	it("replaces only on request and returns the replaced draft for recovery", () => {
		const e = editor("half-written");
		assert.deepEqual(prepareDraft(e, "/recap", "replace"), { replaced: "half-written" });
		assert.deepEqual(e.calls, ["set:/recap"]);
		restoreDraft(editor(""), "half-written");
		const busy = editor("new text");
		restoreDraft(busy, "half-written");
		assert.deepEqual(busy.calls, ["paste:half-written"]);
	});
});

describe("CommandsPanel", () => {
	it("opens detail on selection and runs only on the explicit action", () => {
		const { panel, results, state } = makePanel();
		panel.render(80);
		panel.handleInput("\r");
		assert.equal(results.length, 0, "selecting evo starts nothing");
		const detail = panel.render(80).map(strip);
		assert.match(detail[0], /^\/evo extension command/);
		assert.ok(detail.some((line) => line.includes("Autonomous harness improvement")));
		assert.ok(detail.some((line) => line.includes("[Run]")), "explicit Run action is visible");
		for (const char of "focus on x") panel.handleInput(char);
		panel.handleInput("\r");
		assert.deepEqual(results, [{ kind: "run", command: evo, args: "focus on x" }]);
		assert.equal(state.args.get(commandIdentity(evo)), "focus on x", "direction retained for reopening");
	});

	it("keeps the query, selection, and typed arguments through Back and reopen", () => {
		const state = createSelectorState();
		const first = makePanel({ state });
		first.panel.render(80);
		for (const char of "review") first.panel.handleInput(char);
		first.panel.handleInput("\r");
		for (const char of "src") first.panel.handleInput(char);
		first.panel.handleInput("\x1b");
		const list = first.panel.render(80).map(strip);
		assert.ok(list.some((line) => line.includes("review")), "query survives Back");
		assert.equal(first.results.length, 0);
		first.panel.handleInput("\x1b");
		assert.deepEqual(first.results, [undefined], "Escape on the list closes without an action");
		const second = makePanel({ state });
		second.panel.render(80);
		second.panel.handleInput("\r");
		const detail = second.panel.render(80).map(strip);
		assert.ok(detail.some((line) => line.includes("src")), "argument draft recovered after reopening");
	});

	it("selects rows and buttons by pointer and ignores stale geometry", () => {
		const { panel, results } = makePanel();
		const lines = panel.render(80);
		const row = locate(lines, "/review:1");
		assert.ok(row.y > 0);
		assert.equal(panel.handleMouse(click(2, row.y, 100))?.handled, undefined, "a click at another width is ignored");
		assert.equal(results.length, 0);
		assert.equal(panel.handleMouse(click(2, row.y, 80))?.handled, true);
		const detail = panel.render(80);
		assert.match(strip(detail[0]), /^\/review:1/);
		assert.equal(results.length, 0, "a row click inspects; it does not run");
		const run = locate(detail, "[Run]");
		assert.equal(panel.handleMouse(click(run.x, run.y, 80))?.handled, true);
		assert.deepEqual(results, [{ kind: "run", command: review, args: "" }]);
	});

	it("rebuilds hit regions after a resize so an old row cannot act", () => {
		const { panel, results } = makePanel({ rows: 12 });
		const wide = panel.render(80);
		const row = locate(wide, "/skill:dig");
		panel.render(40);
		const narrow = panel.render(40);
		const moved = locate(narrow, "/skill:dig");
		assert.equal(panel.handleMouse(click(2, row.y, 80)), undefined, "pre-resize width is stale");
		assert.equal(panel.handleMouse(click(2, moved.y, 40))?.handled, true);
		assert.match(strip(panel.render(40)[0]), /^\/skill:dig skill/);
		assert.equal(results.length, 0);
	});

	it("asks for placement only when a draft exists and labels the prompt action honestly", () => {
		const direct = makePanel({ commands: [recap] });
		direct.panel.render(80);
		direct.panel.handleInput("\r");
		assert.ok(direct.panel.render(80).some((line) => strip(line).includes("[Insert into draft]")));
		direct.panel.handleInput("\r");
		assert.deepEqual(direct.results, [{ kind: "prepare", command: recap, args: "", placement: "insert" }]);

		const guarded = makePanel({ commands: [recap], draft: true });
		guarded.panel.render(80);
		guarded.panel.handleInput("\r");
		guarded.panel.handleInput("\r");
		const placement = guarded.panel.render(80).map(strip);
		assert.ok(placement.some((line) => line.includes("already holds a draft")));
		assert.equal(guarded.results.length, 0, "no editor change before an explicit choice");
		guarded.panel.handleInput("\x1b[B");
		guarded.panel.handleInput("\r");
		assert.deepEqual(guarded.results, [{ kind: "prepare", command: recap, args: "", placement: "replace" }]);
	});

	it("offers recovery of a replaced draft at the top of the list", () => {
		const { panel, results } = makePanel({ replaced: true });
		const lines = panel.render(80).map(strip);
		assert.ok(lines.some((line) => line.includes("Restore replaced draft")));
		panel.handleInput("\r");
		assert.deepEqual(results, [{ kind: "restore-draft" }]);
	});

	it("scrolls long detail text with the wheel and shows a resize notice when too small", () => {
		const long = command("long", { description: Array.from({ length: 40 }, (_, i) => `line ${i} of the description`).join(" ") });
		const { panel } = makePanel({ commands: [long], rows: 14 });
		panel.render(30);
		panel.handleInput("\r");
		const before = panel.render(30).map(strip);
		assert.ok(before.some((line) => /of \d+ lines/.test(line)), "scroll position shown");
		assert.equal(panel.handleMouse(wheel(3, 30))?.handled, true);
		const after = panel.render(30).map(strip);
		assert.notEqual(before[1], after[1], "wheel moved the detail window");
		const tiny = makePanel({ rows: 4 });
		assert.match(strip(tiny.panel.render(60)[0]), /too small/);
		assert.equal(tiny.panel.handleMouse(click(0, 0, 60)), undefined, "nothing to hit while too small");
		tiny.panel.handleInput("\x1b");
		assert.deepEqual(tiny.results, [undefined], "Escape still closes");
	});
});
