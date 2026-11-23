import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionToolContext,
	initTheme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import explorer from "./index.ts";
import { type Outcome, outcomeContent } from "./tools.ts";

initTheme("dark");
function bind(key: "ctrl+o" | []) {
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: key } }));
}
bind("ctrl+o");
const ui = { requestRender() {} } as TUI;
const noteId = "n-01234567890123456789";
const tourId = "t-09876543210987654321";
const location = { root: "/work", path: "source.ts", line: 12, end: 40 };

function card(name: string, args: unknown, tool?: ToolDefinition) {
	const definition = tool ?? {
		...toolDisplay().tools.find((record) => record.name === name),
		name,
		label: "Explorer",
		description: "Read only card fixture",
		parameters: {} as ToolDefinition["parameters"],
		execute: async () => {
			throw new Error("Display cannot execute.");
		},
	};
	return new ToolExecutionComponent(name, "test-call", args, { outputPad: 1 }, definition, ui, "/work");
}
function screen(component: ToolExecutionComponent, width = 120) {
	const rows = component.render(width).map((row) => stripTerminalSequences(row).trim());
	assert.ok(rows.every((row) => visibleWidth(row) <= width));
	return rows.filter(Boolean);
}
function hints(rows: string[]) {
	return rows.filter((row) => row.startsWith("... ("));
}
function settle(component: ToolExecutionComponent, outcome: Outcome, details?: Record<string, unknown>) {
	component.updateResult({ content: outcomeContent(outcome), details, isError: !outcome.ok });
}

test("show call names the requested lines and review; clipping alone uses a configured key", (t) => {
	const name = "explorer_show";
	assert.deepEqual(screen(card(name, { review: { range: "base..head" } })), ["explorer_show Review base..head"]);
	const path = join(homedir(), "source.ts");
	assert.equal(screen(card(name, { path, line: 12, endLine: 40 }))[0], "explorer_show ~/source.ts:12-40");
	const subject = `${"tree/".repeat(45)}source.ts`;
	const tool = card(name, { path: subject, line: 2 });
	const rows = screen(tool, 64);
	assert.match(rows[0], /^explorer_show tree\/.+…$/u);
	assert.deepEqual(hints(rows), ["... (ctrl+o to expand)"]);
	assert.ok(screen(tool, 280)[0].includes(subject));
	assert.deepEqual(hints(screen(tool, 280)), []);
	bind([]);
	t.after(() => bind("ctrl+o"));
	const narrow = card(name, { path: subject, line: 2 });
	assert.deepEqual(hints(screen(narrow, 64)), []);
	settle(narrow, { ok: true, op: "show", summary: "Prepared command.", show: ["launch", subject], target: location });
	assert.deepEqual(hints(screen(narrow, 64)), ["... (click to expand)"]);
});

test("show distinguishes acknowledged navigation, launch preparation, a refusal, and an unconfirmed navigation", () => {
	for (const [extra, outcome, forbidden] of [
		[{ moved: true }, "The connected Explorer pane confirmed navigation.", /prepared a pane command/u],
		[
			{ show: ["explorer", "file with a space"], paneInput: ":open source.ts\r" },
			"Explorer prepared a pane command. No pane opened.",
			/confirmed navigation/u,
		],
		[
			{ showUnavailable: "No exact route.", noteId },
			"Explorer did not prepare a pane command. No pane opened.",
			/confirmed navigation/u,
		],
		[
			{ navigation: "uncertain", summary: "The Explorer pane did not confirm the location.", ok: false },
			"The Explorer pane did not confirm the location.",
			/prepared a pane command|confirmed navigation/u,
		],
	] as const) {
		const component = card("explorer_show", { path: "source.ts", line: 12, endLine: 40, tour: tourId });
		settle(component, { ok: true, op: "show", summary: "Producer summary.", target: location, ...extra });
		const rows = screen(component);
		assert.ok(rows.includes(tourId));
		assert.ok(rows.includes(outcome));
		assert.doesNotMatch(rows.join("\n"), forbidden);
		assert.deepEqual(hints(rows), ["... (ctrl+o to expand)"]);
		assert.equal(rows.at(-1), hints(rows)[0]);
		if ("noteId" in extra) assert.ok(rows.includes(`Saved note ${noteId}.`));
		component.setExpanded(true);
		const expanded = screen(component).join("\n");
		assert.doesNotMatch(expanded, /to expand/u);
		assert.match(expanded, /location: source\.ts:12-40/u);
		if ("paneInput" in extra) {
			assert.match(expanded, /Launch argv: \[/u);
			assert.match(expanded, /"file with a space"/u);
			assert.match(expanded, /Pane input: ":open source.ts\\r"/u);
		}
	}
});

test("partial result takes the last and only hint; a complete short result needs none", () => {
	const component = card("explorer_notes", { op: "list", root: `/${"r".repeat(140)}` });
	assert.deepEqual(hints(screen(component, 64)), ["... (ctrl+o to expand)"]);
	component.updateResult({ content: [], isError: false }, true);
	const rows = screen(component, 64);
	assert.ok(rows.includes("Processing Explorer notes…"));
	assert.deepEqual(hints(rows), ["... (ctrl+o to expand)"]);
	assert.equal(rows.at(-1), hints(rows)[0]);
	const short = card("explorer_notes", { op: "list" });
	short.updateResult({ content: [{ type: "text", text: "No notes returned." }], isError: false });
	assert.deepEqual(screen(short), ["explorer_notes list", "No notes returned."]);
});

test("bare host errors do not reveal withheld note text before expansion", () => {
	const privateText = "Private text from an unsubmitted note.";
	const receipts = [
		{
			args: { op: "tour", title: "Review", stops: [{ path: "file.ts", text: privateText }] },
			diagnostic: `Validation failed for tool "explorer_notes":\n- stops.0.start: required\n\nReceived arguments:\n{"stops":[{"text":"${privateText}"}]}`,
		},
		{
			args: {},
			diagnostic: `Invalid arguments for tool "explorer_notes": Unexpected string "${privateText}"\n\nReceived arguments:\n{"text":"${privateText}`,
		},
	];
	for (const { args, diagnostic } of receipts) {
		const component = card("explorer_notes", args);
		component.updateResult({ content: [{ type: "text", text: diagnostic }], isError: true });
		const rows = screen(component);
		assert.ok(rows.includes("The Explorer tool returned an error."));
		assert.ok(!rows.join("\n").includes(privateText));
		assert.equal(rows.at(-1), "... (ctrl+o to expand)");
		component.setExpanded(true);
		assert.ok(screen(component).join("\n").includes(privateText));
	}
});

test("note prose previews stop at five actual rows and display bounds are distinct from retained excerpts", () => {
	const text = `\x1b[31m${"x".repeat(700)}\x1b[0m`;
	const component = card("explorer_notes", { op: "read", id: noteId });
	settle(component, {
		ok: true,
		op: "read",
		summary: `Read ${noteId}.`,
		note: { id: noteId, text, textTruncated: true, path: "source.ts", anchor: { quote: "q".repeat(33000) } },
	});
	const narrow = screen(component, 56);
	assert.equal(narrow.filter((row) => /^x+$/u.test(row)).length, 5);
	assert.ok(narrow.includes("[Excerpt: note text limited to 4096 characters]"));
	assert.equal(narrow.at(-1), "... (8 more lines, ctrl+o to expand)");
	assert.doesNotMatch(narrow.join("\n"), /\[31m/u);
	component.setExpanded(true);
	const expanded = screen(component).join("\n");
	assert.match(expanded, /\[Excerpt: note text limited to 4096 characters\]/u);
	assert.match(expanded, /\[Truncated: showing 32000 of \d+ characters\]/u);
	assert.doesNotMatch(expanded, /to expand/u);
});

test("bounded note listings distinguish returned scope from display limits", () => {
	const component = card("explorer_notes", { op: "list", state: "open" });
	settle(component, {
		ok: true,
		op: "list",
		summary: "7 notes match in fixture.",
		notes: [{ id: noteId, path: "file.ts", start: 1, end: 5, preview: "A retained preview", state: "open" }],
		tours: [{ id: tourId, title: "Review", stopCount: 2 }],
		limited: true,
		unreadable: 1,
	});
	const collapsed = screen(component);
	assert.ok(
		collapsed.includes(
			"Partial list: 1 note and 1 walkthrough returned · 1 unreadable record; no continuation cursor.",
		),
	);
	assert.ok(collapsed.includes(`${noteId} · file.ts:1-5 · open`));
	assert.equal(collapsed.at(-1), "... (ctrl+o to expand)");
	assert.doesNotMatch(collapsed.join("\n"), /A retained preview|\[Truncated:/u);
	component.setExpanded(true);
	const expanded = screen(component).join("\n");
	assert.match(expanded, /preview: A retained preview/u);
	assert.match(expanded, /stopCount: 2/u);
});

test("main call body and expanded arguments have independent display bounds", () => {
	const component = card("explorer_show", { path: "source.ts", note: { text: "x".repeat(700) } });
	const pending = screen(component, 56);
	assert.equal(pending.filter((row) => /^x+$/u.test(row)).length, 5);
	assert.equal(pending.at(-1), "... (8 more lines, ctrl+o to expand)");
	const tour = card("explorer_notes", {
		op: "tour",
		title: "Review",
		stops: Array.from({ length: 4 }, () => ({ path: "file", text: "x".repeat(10_000) })),
	});
	assert.ok(screen(tour).includes("4 stops"));
	tour.setExpanded(true);
	assert.match(screen(tour).join("\n"), /\[Truncated: showing 32000 of \d+ characters\]/u);
});

test("ordinary registration and publication use the same display and keep the actual launch refusal envelope", {
	timeout: 5000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "explorer-display-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = {
		PI_EXPLORER_DIR: join(root, "store"),
		PI_EXPLORER_APP: join(root, "missing.app"),
		PI_HARNESS_FILE: join(root, "harness.json"),
	};
	for (const [key, value] of Object.entries(env)) {
		const old = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (old === undefined) delete process.env[key];
			else process.env[key] = old;
		});
	}
	await writeFile(join(root, "file.ts"), "a\nb\n");
	const events = createEventBus();
	const publications: ReturnType<typeof toolDisplay>[] = [];
	const tools = new Map<string, ToolDefinition>();
	events.on("harness:tool-display:publish", (value) => publications.push(value as ReturnType<typeof toolDisplay>));
	explorer({
		events,
		on() {},
		registerCommand() {},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI);
	events.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
	for (const { name, renderCall, renderResult } of publications[1].tools) {
		assert.equal(tools.get(name)?.renderCall, renderCall);
		assert.equal(tools.get(name)?.renderResult, renderResult);
	}
	const show = tools.get("explorer_show");
	assert.ok(show);
	const args = { path: "file.ts", line: 2 };
	const ctx = { cwd: root, mode: "print" } as ExtensionToolContext;
	const result = await show.execute("id", args, undefined, undefined, ctx);
	assert.equal(result.isError, false);
	const value = JSON.parse((result.content[0] as { text: string }).text);
	assert.equal(value.target.line, 2);
	assert.ok(value.showUnavailable);
	assert.equal(value.show, undefined);
	const component = card(show.name, args, show);
	component.updateResult({ ...result, isError: false });
	assert.ok(screen(component).includes("Explorer did not prepare a pane command. No pane opened."));
	const failure = await show.execute("error", { path: "file.ts", line: 4, endLine: 2 }, undefined, undefined, ctx);
	assert.equal(failure.isError, true);
	component.updateResult({ ...failure, isError: true });
	assert.ok(screen(component).includes("endLine requires line and cannot precede it."));
	const notes = tools.get("explorer_notes");
	assert.ok(notes);
	const listing = await notes.execute("notes", { op: "list" }, undefined, undefined, ctx);
	const listCard = card(notes.name, { op: "list" }, notes);
	listCard.updateResult({ ...listing, isError: false });
	assert.ok(screen(listCard).includes("0 notes and 0 walkthroughs returned."));
});
