import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Form } from "./form.ts";
import { Frame, type ViewHost } from "./frame.ts";
import { ArtifactReview } from "./operator-view.ts";
import { viewTheme } from "./view-fixture.mts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

function makeFrame(open: ConstructorParameters<typeof Frame>[0]["open"]) {
	return new Frame({
		theme: viewTheme,
		target: { id: "session", label: "This session" },
		rows: (expanded) => (expanded ? 20 : 14),
		expandKey: "ctrl+o",
		requestRender: () => {},
		close: () => {},
		open,
	});
}

const screen = (frame: Frame, width = 120) => frame.render(width).map(stripVTControlCharacters);

function click(frame: Frame, x: number, y: number, width: number, height: number, fields: Partial<TuiMouseEvent> = {}) {
	return frame.handleMouse({
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...fields,
	});
}

test("the view owns a claimed key; its action moves to More without that key", () => {
	const ran: string[] = [];
	const frame = makeFrame(() => ({
		title: "Policy",
		render: () => [],
		keys: () => [{ keys: ["r"], label: "read" }],
		handleInput: (data) => {
			ran.push(data);
			return true;
		},
		actions: () => [{ id: "change", label: "Change rules", key: "r", primary: true, run: () => ran.push("action") }],
	}));
	const row = screen(frame).at(-1) ?? "";
	assert.match(row, /r read/);
	assert.doesNotMatch(row, /r change rules/);
	const x = row.indexOf("r read");
	assert.equal(click(frame, x, 13, 120, 14, { type: "press" }), undefined);
	assert.equal(click(frame, x, 13, 119, 14), undefined);
	click(frame, x, 13, 120, 14);
	frame.handleInput("r");
	assert.deepEqual(ran, ["r", "r"]);
	frame.handleInput("x");
	const menu = screen(frame).join("\n");
	assert.match(menu, /Change rules/);
	assert.doesNotMatch(menu, /r\s+Change rules/);
	frame.handleInput("\r");
	assert.deepEqual(ran, ["r", "r", "action"]);
	frame.handleInput("\u000f");
	assert.equal(screen(frame).length, 20, "the Pi expand binding expands the frame");
});

test("filtered choices stage a value and Escape closes More before it cancels", () => {
	const submits: string[] = [];
	const frame = makeFrame(
		(host) =>
			new Form({
				title: "Policy",
				heading: "Select an effect",
				fields: [
					{
						kind: "choice",
						id: "effect",
						label: "Effect",
						filter: true,
						choices: [
							{ value: "steer", label: "Steer" },
							{ value: "block", label: "Block" },
							{ value: "exact", label: "Exact" },
						],
					},
				],
				action: { label: "Read artifact" },
				host,
				submit: async (values) => {
					submits.push(values.effect ?? "");
					return undefined;
				},
			}),
	);
	assert.match(screen(frame).at(-1) ?? "", /ctrl\+n more/);
	frame.handleInput("x");
	assert.equal(frame.editing, true, "x goes into the filter");
	assert.match(screen(frame).join("\n"), /Effect\s+Exact/);
	assert.deepEqual(submits, [], "selection does not submit");
	frame.handleInput("\u000e");
	assert.match(screen(frame).at(-1) ?? "", /esc close menu/);
	frame.handleInput("\u001b");
	assert.equal(frame.editing, true);
	assert.deepEqual(submits, []);
	frame.handleInput("\u001b");
	assert.equal(frame.viewTitle, undefined);
	assert.deepEqual(submits, []);
});

test("rows painted beneath More do not count as read", () => {
	let parent: ViewHost | undefined;
	const frame = makeFrame((host) => {
		parent = host;
		return { title: "Policy", render: () => [], handleInput: () => false };
	});
	parent?.push(
		(host) =>
			new ArtifactReview({
				host,
				title: "Review",
				artifact: Array.from({ length: 18 }, (_, row) => `Row ${row + 1}`).join("\n"),
				label: "Approve proposal",
				decide: () => assert.fail("unread review cannot approve"),
			}),
	);
	// The narrow key row puts the final action in More.
	assert.match(screen(frame, 42).at(-1) ?? "", /x more/);
	frame.handleInput("\u001b[6~");
	frame.handleInput("x");
	assert.match(screen(frame, 42).join("\n"), /More/);
	assert.match(frame.viewActions[0]?.disabled ?? "", /Read every line/);
	frame.handleInput("\u001b");
	assert.match(screen(frame, 42).join("\n"), /All 18 lines read/);
});
