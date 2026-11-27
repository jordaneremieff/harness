import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const nativeTui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const url = "https://example.com/docs";
const sourceId = "0123456789abcdef";
const readDisplay = toolDisplay().tools.find((tool) => tool.name === "web_read");
assert.ok(readDisplay);
const definition = defineTool({
	...readDisplay,
	label: "Read public web page",
	description: "Display fixture",
	parameters: obj({}, { open: true }),
	async execute() {
		throw new Error("A display fixture must not execute");
	},
});

function keyFixture(t: TestContext, keys: KeyId | KeyId[] = "ctrl+g"): void {
	initTheme("dark", false);
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}

function card(args: Record<string, unknown> = { url }): ToolExecutionComponent {
	const component = new ToolExecutionComponent("web_read", "fixture", args, { outputPad: 1 }, definition, ui, ".");
	component.setArgsComplete();
	return component;
}

function rows(component: ToolExecutionComponent, width = 100): string[] {
	return component.render(width).map((row) => stripVTControlCharacters(row).trimEnd());
}

function screen(component: ToolExecutionComponent, width = 100): string {
	return rows(component, width).join("\n");
}

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

it("keeps one hint across the call, progress, final result and expanded result", (t) => {
	keyFixture(t);
	const component = card({ url, find: "literal", expected_source_id: sourceId, excerpt_offset: 2 });
	const before = rows(component);
	assert.equal(before[2], ` web_read ${url}`);
	assert.equal(before[3], " ... (ctrl+g to expand)");
	assert.doesNotMatch(before.join("\n"), /find literal|expected source/);
	assert.doesNotMatch(before.join("\n"), /Returned|Reading|unknown|pending/);
	component.markExecutionStarted();
	component.updateResult(result(""), true);
	assert.match(screen(component), /\n +Reading the page…/);
	assert.equal(screen(component).match(/to expand/g)?.length, 1);
	const finalUrl = "https://example.net/final";
	const header = "Fetch provenance \u202e\x1b[31m\nFurther fetch facts\n\n";
	component.updateResult(
		result(
			`${header}First evidence\nSecond evidence\nThird evidence\nFourth evidence\nFifth evidence\nSixth evidence`,
			{
				previewOffset: header.length,
				redirectCount: 1,
				downloadedBytes: 412,
				status: "readable",
				excerptCount: 2,
				excerptOffset: 2,
				nextOffset: 7,
				find: { query: "literal", firstMatchOffset: 3 },
				sourceId,
				requestedUrl: url,
				finalUrl,
				title: "Page",
				outputTruncated: true,
			},
		),
	);
	const settled = rows(component, 88);
	assert.deepEqual(
		settled.filter((line) => line.trim()),
		[` web_read ${url}`, " Returned 2 matching excerpts from example.net; more follow.", " ... (ctrl+g to expand)"],
	);
	component.setExpanded(true);
	const expanded = screen(component, 180);
	assert.ok(expanded.includes(`final URL ${finalUrl} · Page · source ${sourceId} · find literal`));
	assert.match(
		expanded,
		/Returned 2 matching excerpts \(first E4\) from example\.net; more follow from excerpt offset 7\./,
	);
	assert.match(expanded, /Fetch provenance[\s\S]*First evidence[\s\S]*Sixth evidence/);
	assert.match(expanded, /1 redirect · 412 bytes downloaded/);
	assert.ok(
		expanded.includes(
			`web_read {"url":"${url}","excerpt_offset":7,"expected_source_id":"${sourceId}","find":"literal"}`,
		),
	);
	assert.doesNotMatch(expanded, /\u202e|\x1b\[31m/);
	assert.doesNotMatch(expanded, /to expand/);
});

it("discloses retained records and fetch provenance without a preview offset", (t) => {
	keyFixture(t);
	const component = card({ url, excerpt_offset: 0, max_bytes: 3500 });
	assert.match(screen(component, 60), /to expand/);
	const text = `Final URL: ${url}\nRetrieved: 2026-11-21\nTitle: (not supplied)\nUntrusted page content follows.\n\n[${sourceId}:E1] Modules: TypeScript#`;
	component.updateResult(
		result(text, {
			status: "readable",
			sourceId,
			excerptCount: 1,
			excerptOffset: 0,
			finalUrl: url,
			requestedUrl: url,
			title: "",
		}),
	);
	assert.match(screen(component), /Returned 1 excerpt from example\.com\./);
	assert.doesNotMatch(screen(component), /source |Modules: TypeScript#|Retrieved:|Untrusted page/);
	component.setExpanded(true);
	assert.match(screen(component), /example\.com · source/);
	assert.match(screen(component), /Retrieved: 2026-11-21[\s\S]*Modules: TypeScript#/);
});

it("keeps the first diagnostic visible and discloses its supplemental evidence", (t) => {
	keyFixture(t);
	const component = card({ url, find: "pi-node", max_bytes: 12_000 });
	component.updateResult(
		result(
			"Web reader accepts HTML, plain text and Markdown only; the server returned a PDF.\nHTTP 200 · application/pdf",
			undefined,
			true,
		),
	);
	assert.match(screen(component), /returned a PDF\.\n ... \(ctrl\+g to expand\)/);
	assert.doesNotMatch(screen(component), /HTTP 200/);
	assert.match(screen(component, 60), /…[\s\S]*\.\.\. \(ctrl\+g to expand\)/);
	component.setExpanded(true);
	assert.match(screen(component), /HTTP 200 · application\/pdf/);
});

it("uses no hint when disclosure adds nothing, and a click hint without a binding", (t) => {
	keyFixture(t, []);
	const component = card();
	assert.doesNotMatch(screen(component), /expand/);
	component.updateResult(result("", { status: "readable", excerptCount: 1 }));
	assert.match(screen(component), /Returned 1 excerpt\./);
	assert.doesNotMatch(screen(component), /expand/);
	const redirected = card({ url: `${url}/${"long".repeat(100)}` });
	assert.doesNotMatch(screen(redirected), /expand/);
	redirected.updateResult(result("one retained link", { view: "links", linkCount: 1, linkOffset: 0 }));
	assert.deepEqual(
		rows(redirected)
			.filter((line) => line.includes("expand"))
			.map((line) => line.trim()),
		["... (click to expand)"],
	);
});

it("shows actual empty, partial and budget outcomes instead of success claims", (t) => {
	keyFixture(t);
	const component = card();
	component.updateResult(
		result("Retained text evidence", { status: "no-readable-text", excerptCount: 0, extractionTruncated: true }),
	);
	assert.match(screen(component), /No readable text in the retained page\. · extraction truncated/);
	component.updateResult(
		result("Retained find evidence", {
			status: "readable",
			excerptCount: 0,
			excerptOffset: 2,
			find: { query: "literal", firstMatchOffset: null },
		}),
	);
	assert.match(screen(component), /No matching excerpts in this page of retained results\./);
	assert.doesNotMatch(screen(component), /Returned|first E/);
	component.updateResult(
		result("Retained link evidence", {
			view: "links",
			sourceId,
			linkCount: 0,
			linkOffset: 3,
			nextOffset: 5,
			requiredMaxBytes: 1234,
			outputTruncated: true,
		}),
	);
	assert.match(screen(component), /No complete link returned; retry with max_bytes 1234\./);
	assert.doesNotMatch(screen(component), /Partial coverage|Returned 0 links|link offset 5/);
	component.setExpanded(true);
	assert.ok(
		screen(component, 180).includes(
			`web_read {"url":"${url}","view":"links","link_offset":5,"expected_source_id":"${sourceId}","max_bytes":1234}`,
		),
	);
});

it("uses the actual diagnostic and falls back to retained text for malformed details", (t) => {
	keyFixture(t);
	const component = card();
	component.updateResult(
		result(
			"\nWeb reader cancelled.\nFirst diagnostic\nSecond diagnostic",
			{ status: "readable", excerptCount: 5 },
			true,
		),
	);
	assert.match(screen(component), /Web reader cancelled\.\n ... \(ctrl\+g to expand\)/);
	assert.doesNotMatch(screen(component), /Returned 5 excerpts|First diagnostic|Second diagnostic/);
	component.setExpanded(true);
	assert.match(screen(component), /First diagnostic\n Second diagnostic/);
	component.setExpanded(false);
	component.updateResult(result("Source snapshot\nActual evidence", { status: "readable", excerptCount: "1" }));
	assert.match(screen(component), /Source snapshot\n ... \(ctrl\+g to expand\)/);
	assert.doesNotMatch(screen(component), /0 excerpts|unknown|Actual evidence/);
	component.setExpanded(true);
	assert.match(screen(component), /Actual evidence/);
});

it("clips narrow rows inside Pi's background and keeps the body for expansion", (t) => {
	keyFixture(t);
	const component = card({ url: `${url}/${"界é🙂".repeat(40)}` });
	const content = `${"x".repeat(240)}\u202e\u009b\x1b[31m\tTail`;
	component.updateResult(result(content, { status: "readable", excerptCount: 2, excerptOffset: 2 }));
	const width = 36;
	const narrow = rows(component, width);
	assert.match(narrow[2] ?? "", /…$/u);
	assert.equal(narrow.filter((row) => row.trim()).length, 3);
	assert.match(narrow.join("\n"), /\.\.\. \(ctrl\+g to expand\)/);
	assert.doesNotMatch(narrow.join("\n"), /Tail|\u202e|\u009b/);
	for (const row of component.render(width)) {
		assert.ok(visibleWidth(row) <= width);
		assert.doesNotMatch(row, /\x1b\[0m/);
	}
	component.setExpanded(true);
	assert.match(screen(component, width), /Tail/);
	assert.doesNotMatch(screen(component, width), /to expand|\u202e|\u009b/);
	component.setExpanded(false);
	assert.equal(screen(component, width), narrow.join("\n"));
});

it("bounds even a single long line in success and error results", (t) => {
	keyFixture(t);
	const component = card();
	for (const isError of [false, true]) {
		component.updateResult(result(`${"x".repeat(32_001)}TAIL`, { status: "readable", excerptCount: 1 }, isError));
		component.setExpanded(true);
		const text = screen(component, 100);
		assert.match(text, /\[Truncated: showing 32000 of 32005 characters\]/);
		assert.doesNotMatch(text, /TAIL|to expand/);
	}
});
