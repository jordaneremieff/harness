import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { createBriefTool } from "./brief-tool.ts";
import { toolDisplay } from "./display.ts";
import { markdownContribution } from "./durable.ts";
import { createLiveTool } from "./live-tool.ts";
import { createPublishTool } from "./publish.ts";
import { createReadTool } from "./read.ts";
import { MarkdownStore } from "./store.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const nativeTui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const id = "md-0123456789abcdef0123";
function keys(t: TestContext, defaultKeys: KeyId | KeyId[] = "ctrl+g") {
	initTheme("dark", false);
	const prior = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(prior));
}
function card(name: string, args: Record<string, unknown>) {
	const display = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(display);
	const definition = defineTool({
		...display,
		label: name,
		description: name,
		parameters: obj({}, { open: true }),
		async execute() {
			throw new Error("Display only");
		},
	});
	const component = new ToolExecutionComponent(name, "fixture", args, { outputPad: 1 }, definition, ui, "/");
	component.setArgsComplete();
	return component;
}
function screen(component: ToolExecutionComponent, width = 120) {
	return component
		.render(width)
		.map((line) => {
			assert.ok(visibleWidth(line) <= width);
			return stripVTControlCharacters(line).trimEnd();
		})
		.join("\n");
}
function result(text: string | string[], details?: unknown, isError = false) {
	return {
		content: (Array.isArray(text) ? text : [text]).map((text) => ({ type: "text" as const, text })),
		details,
		isError,
	};
}

test("the ordinary tool registrations and attached descriptor use the same inert display records", () => {
	const store = new MarkdownStore("/unused");
	const tools = [
		createBriefTool({ mode: "off" }),
		createPublishTool({ store }),
		createReadTool({ store }),
		createLiveTool(async () => undefined),
	];
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(
		publication.tools.map((v) => v.name),
		tools.map((v) => v.name),
	);
	for (const [index, entry] of publication.tools.entries()) {
		assert.deepEqual(Object.keys(entry).sort(), ["name", "renderCall", "renderResult"]);
		assert.equal(entry.renderCall, tools[index]?.renderCall);
		assert.equal(entry.renderResult, tools[index]?.renderResult);
	}
	assert.deepEqual(markdownContribution("fixture", {} as never, () => {}).display, {
		version: 1,
		entry: "./display.ts",
		export: "toolDisplay",
	});
});

test("the result takes over the only expansion hint during progress and after settlement", (t) => {
	keys(t);
	const component = card("markdown_publish", {
		title: "A document",
		document: id,
		expectedRevision: 3,
		reuseKey: "full-reuse-key",
	});
	assert.match(
		screen(component),
		new RegExp(`markdown_publish A document\\n +${id} · expected revision 3\\n +\\.\\.\\. \\(ctrl\\+g to expand\\)`),
	);
	component.markExecutionStarted();
	component.updateResult(result(""), true);
	assert.match(screen(component), /Working…\n +\.\.\. \(ctrl\+g to expand\)/u);
	assert.equal(screen(component).match(/to expand/gu)?.length, 1);
	component.updateResult(
		result("Saved text. Model instructions here.", {
			ok: true,
			documentId: id,
			revision: 4,
			bytes: 90,
			paneState: { status: "unknown" },
		}),
	);
	assert.match(screen(component), /Saved md-0123456789abcdef0123 · revision 4; reader state not observed\./u);
	assert.doesNotMatch(screen(component), /Model instructions/u);
	component.updateResult(
		result("Observed saved revision.", {
			ok: true,
			documentId: id,
			revision: 4,
			paneState: { status: "observed", showing: ["reader"] },
		}),
	);
	assert.match(screen(component), /a reader reported this revision/u);
	component.setExpanded(true);
	assert.match(screen(component), /reuseKey: full-reuse-key/u);
	assert.doesNotMatch(screen(component), /to expand/u);
});

test("a narrow width caps a single long read line and discloses the exact next page", (t) => {
	keys(t);
	const component = card("markdown_read", { document: id, revision: 4, offset: 100 });
	const fragment = "abcdefghij".repeat(31);
	component.updateResult(
		result([`Read header for ${id}`, fragment], {
			op: "read",
			documentId: id,
			revision: 4,
			status: "page",
			offset: 100,
			nextOffset: 410,
		}),
	);
	const narrow = screen(component, 45);
	assert.equal(narrow.split("\n").filter((row) => /^ +[a-j]+$/u.test(row)).length, 5, narrow);
	assert.match(narrow, /\.\.\. \(\d+ more lines, ctrl\+g to expand\)/u);
	assert.match(
		screen(component),
		/Read a fragment of md-0123456789abcdef0123 · revision 4 at offset 100; more follows/u,
	);
	component.setExpanded(true);
	assert.match(
		screen(component, 130),
		/Continue with markdown_read \{"document":"md-0123456789abcdef0123","revision":4,"offset":410\}/u,
	);
	assert.doesNotMatch(screen(component), /Truncated:|to expand/u);
});

test("live source and edit bodies stay out of collapsed cards, with a click hint only after a result", (t) => {
	keys(t, []);
	const component = card("markdown_live", {
		op: "apply",
		handle: "full-handle",
		edits: [{ find: "private anchor", replace: "private replacement" }],
	});
	assert.doesNotMatch(screen(component), /to expand|private/u);
	component.updateResult(result(JSON.stringify({ status: "applied", generation: 9, retained: true })));
	assert.match(screen(component), /Applied to the live buffer at generation 9; private recovery retained\./u);
	assert.match(screen(component), /\.\.\. \(click to expand\)/u);
	assert.doesNotMatch(screen(component), /private (anchor|replacement)/u);
	component.setExpanded(true);
	assert.match(screen(component), /private replacement/u);

	const read = card("markdown_live", { op: "read", handle: "full-handle" });
	read.updateResult(
		result("", {
			status: "page",
			fragment: "private source",
			generation: 3,
			digest: "sha256:fixture",
			offset: 0,
			nextOffset: 25,
			pane: { view: { dirty: true } },
		}),
	);
	assert.match(screen(read), /Read live fragment at generation 3 · offset 0; unsaved; more follows/u);
	assert.doesNotMatch(screen(read), /private source/u);
	read.setExpanded(true);
	assert.match(
		screen(read, 160),
		/Continue with markdown_live \{"op":"read","handle":"full-handle","offset":25,"baseGeneration":3,"baseDigest":"sha256:fixture"\}/u,
	);
	assert.match(screen(read), /private source/u);
});

test("shows a launch offer, confirmed view, refusal and thrown diagnostic as distinct outcomes", (t) => {
	keys(t);
	const component = card("markdown_live", { op: "show", document: id, handle: "full-handle", revision: 5 });
	assert.match(screen(component), /markdown_live show md-0123456789abcdef0123\n +full-handle · revision 5/u);
	component.updateResult(result("", { status: "launch", documentId: id, revision: 5, argv: ["private-launch"] }));
	assert.match(screen(component), /Launch offered for .*; display unconfirmed\./u);
	assert.doesNotMatch(screen(component), /private-launch|Reader confirmed/u);
	component.updateResult(result("", { status: "navigated", view: { documentId: id, revision: 5 } }));
	assert.match(screen(component), /Reader confirmed md-0123456789abcdef0123 · revision 5\./u);
	component.updateResult(result("", { status: "busy", message: "The passage is in use." }));
	assert.match(screen(component), /The passage is in use\./u);
	assert.doesNotMatch(screen(component), /to expand/u);
	component.updateResult(result("Cancelled by the requester.\nAdditional diagnosis.", undefined, true));
	assert.match(screen(component), /Cancelled by the requester\./u);
	assert.doesNotMatch(screen(component), /Additional diagnosis\./u);
	component.setExpanded(true);
	assert.match(screen(component), /Additional diagnosis\./u);
});

test("the brief uses a human preview and a long retained fallback names its separate display cap", (t) => {
	keys(t);
	const component = card("markdown_brief", { title: "Guide\x1b[31m\u202e\nnotes" });
	assert.match(screen(component), /markdown_brief Guide notes/u);
	assert.doesNotMatch(screen(component), /to expand|\u202e|\[31m/u);
	component.updateResult(result("Writing brief\nSome guidance", { reader: "Person", checks: [] }));
	assert.match(screen(component), /Prepared the writing brief\./u);
	assert.doesNotMatch(screen(component), /Some guidance/u);
	assert.match(screen(component), /ctrl\+g to expand/u);
	component.setExpanded(true);
	assert.match(screen(component), /Some guidance/u);
	component.updateResult(result(`Reason\n${"x".repeat(50_000)}`, undefined, true));
	component.setExpanded(true);
	assert.match(screen(component), /\[Truncated: showing 32000 of 50007 characters\]/u);
});

test("bare validation errors do not preview echoed arguments", (t) => {
	keys(t);
	for (const [name, args, error] of [
		[
			"markdown_publish",
			{ title: "Draft", text: "private body" },
			'Validation failed for tool "markdown_publish":\n  - title: invalid\n\nReceived arguments:\n{"text":"private body"}',
		],
		[
			"markdown_live",
			{ op: "apply", edits: [{ find: "private body", replace: "amended" }] },
			'Invalid arguments for tool "markdown_live": malformed private body',
		],
	] as const) {
		const component = card(name, args);
		component.updateResult(result(error, undefined, true));
		const collapsed = screen(component);
		assert.match(collapsed, /The tool arguments did not pass validation\./u);
		assert.doesNotMatch(collapsed, /private body|Received arguments/u);
		assert.equal(collapsed.match(/to expand/gu)?.length, 1);
		component.setExpanded(true);
		assert.match(screen(component), /private body/u);
	}
});

test("a publication draft previews only five visual rows and expands on the configured key", (t) => {
	keys(t);
	const component = card("markdown_publish", { title: "Draft", text: "abcdefghij".repeat(32) });
	const collapsed = screen(component, 45);
	assert.equal(collapsed.split("\n").filter((row) => /^ +[a-j]+$/u.test(row)).length, 5, collapsed);
	assert.match(collapsed, /\.\.\. \(3 more lines, ctrl\+g to expand\)/u);
	component.setExpanded(true);
	const expanded = screen(component, 45);
	assert.equal(expanded.split("\n").filter((row) => /^ +[a-j]+$/u.test(row)).length, 8, expanded);
	assert.doesNotMatch(expanded, /to expand/u);
});

test("a retained live snapshot receipt expands as source without exposing the buffer in collapse", (t) => {
	keys(t);
	const component = card("markdown_live", { op: "read", handle: "exact-reader-handle" });
	const source = "# Reader fixture\n\nThe draft remains in the same pane.\n";
	const snapshot = {
		status: "ok",
		source,
		generation: 0,
		digest: `sha256:${"0".repeat(64)}`,
		assets: [],
		offset: 0,
		nextOffset: null,
		totalChars: source.length,
		totalBytes: Buffer.byteLength(source),
	};
	for (const details of [snapshot, undefined]) {
		component.setExpanded(false);
		component.updateResult(result(JSON.stringify(snapshot), details));
		assert.match(screen(component), /Read complete live source at generation 0\./u);
		assert.doesNotMatch(screen(component), /Reader fixture|"status"|"source"/u);
		component.setExpanded(true);
		const expanded = screen(component);
		assert.match(expanded, /\n # Reader fixture\n\n The draft remains in the same pane\./u);
		assert.match(expanded, /"status": "ok"/u);
		assert.doesNotMatch(expanded, /"source"|to expand/u);
	}
});

test("a stored document listing inflects the retained result count", (t) => {
	keys(t);
	const component = card("markdown_read", { kind: "published" });
	const documents = Array.from({ length: 20 }, (_, i) => ({
		id: `md-${String(i).padStart(20, "0")}`,
		title: `Document ${i}`,
		revision: 1,
	}));
	for (const count of [20, 1]) {
		component.updateResult(
			result("", {
				ok: true,
				op: "find",
				kind: "published",
				rows: documents.slice(0, count),
				matched: count,
				scanned: 172,
			}),
		);
		const noun = count === 1 ? "match" : "matches";
		assert.ok(screen(component).includes(`Returned ${count} ${noun}; scanned 172 documents.`));
	}
});

test("publication moves its counted hint to the bottom after settlement and reflows it on resize", (t) => {
	keys(t);
	const component = card("markdown_publish", {
		title: "Draft",
		text: "abcdefghij".repeat(32),
		expectedRevision: 3,
		reuseKey: "named-request",
	});
	const assertHint = (rendered: string, count: number) => {
		const hints = rendered.split("\n").filter((row) => row.includes("to expand"));
		assert.deepEqual(hints, [` ... (${count} more ${count === 1 ? "line" : "lines"}, ctrl+g to expand)`], rendered);
		assert.equal(rendered.trimEnd().split("\n").at(-1), hints[0]);
	};
	assertHint(screen(component, 65), 1);
	assertHint(screen(component, 45), 3);
	component.updateResult(
		result("Saved the exact source and document metadata.", {
			ok: true,
			documentId: id,
			revision: 4,
			paneState: { status: "observed", showing: [] },
		}),
	);
	const wide = screen(component, 65);
	assert.match(wide, /Saved .*revision 4/u);
	assertHint(wide, 1);
	assertHint(screen(component, 45), 3);
	component.setExpanded(true);
	assert.doesNotMatch(screen(component, 45), /to expand/u);
});

test("an empty find page preserves the same filters and full cursor", (t) => {
	keys(t);
	const component = card("markdown_read", { kind: "file", query: "notes", contains: "line\nneedle" });
	const cursor = "next-012345678901234567890123456789";
	component.updateResult(
		result("", {
			ok: true,
			op: "find",
			kind: "file",
			query: "notes",
			search: { contains: "line\nneedle" },
			rows: [],
			scanned: 25,
			nextCursor: cursor,
		}),
	);
	assert.match(screen(component), /No matches in this page; scanned 25 documents; more results follow\./u);
	component.setExpanded(true);
	assert.ok(
		screen(component, 160).includes(
			`Continue with markdown_read ${JSON.stringify({ kind: "file", query: "notes", contains: "line\nneedle", cursor })}`,
		),
	);
});
