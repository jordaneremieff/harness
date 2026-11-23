import assert from "node:assert/strict";
import test from "node:test";
import {
	defineTool,
	getMarkdownTheme,
	initTheme,
	keyText,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	type KeyId,
	KeybindingsManager,
	Markdown,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { AccessPage } from "./access.ts";
import { emptyShard, zero } from "./capacity.ts";
import { usageMarkdown } from "./presentation.ts";
import { toolDisplay } from "./display.ts";
import { createReader, errorResponse } from "./readback.ts";

test("operator pages preserve evidence meaning, continuation, and narrow terminal widths", async () => {
	const day = "2026-09-07";
	const shard = emptyShard(day);
	for (let i = 0; i < 25; i++)
		shard.cells.push({
			day,
			observationStage: "tool_request",
			resourceClass: "entry",
			resourceId: `entry-${String(i).padStart(2, "0")}`,
			model: "synthetic/model",
			reasoning: "high",
			referenceBodyDigest: "a".repeat(64),
			observerVersion: "0.1.0",
			piVersion: "0.85.1",
			counters: { ...zero(), readRequests: 1 },
		});
	const reader = createReader(() => ({ shards: { [day]: shard } }), { now: () => Date.parse(`${day}T00:00:00Z`) });
	const page = await reader.read({ view: "revisions" });
	assert.equal(page.kind, "page");
	const text = usageMarkdown(page);
	assert.ok(Buffer.byteLength(text) <= 32768);
	assert.ok(text.includes("/pillars next "));
	assert.ok(text.includes("unpersisted loss: unknown"));
	assert.ok(text.includes("not the selected read-event window"));
	assert.ok(text.includes("readRequests: 25"));
	initTheme("dark", false);
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme());
	for (const width of [20, 40, 100]) {
		markdown.invalidate();
		const lines = markdown.render(width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	const card = component("pillars_usage", { view: "revisions", windowDays: 7 });
	assert.match(render(card), /pillars_usage revisions +\n +7 days/);
	card.updateResult({ content: textBlock(JSON.stringify(page)), details: page, isError: false });
	const collapsed = render(card);
	assert.match(collapsed, /Read page 1 of .* of the revisions.*continuation available\./);
	assert.match(collapsed, /Pillars access evidence/);
	assert.doesNotMatch(collapsed, /Continue:|Truncated/);
	card.setExpanded(true);
	const cursor = page.pagination.nextCursor;
	assert.ok(cursor);
	assert.ok(render(card, 280).includes(`Continue: pillars_usage ${JSON.stringify({ cursor })}`));
	reader.clear();
	const error = usageMarkdown(errorResponse("store_corrupt"));
	assert.ok(error.includes("invalid"));
	assert.ok(error.includes("Only retained persisted aggregates"));
});

const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");
function binding(keys: KeyId[]): void {
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: keys, description: "Expand" } }));
}

function component(name: string, args: Record<string, unknown>) {
	const renderers = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(renderers);
	const tool = defineTool({
		name,
		label: name,
		description: "Display fixture.",
		parameters: obj({ resource: opt(str()) }, { open: true }),
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
		async execute() {
			throw new Error("Renderer fixtures must not execute.");
		},
	});
	return new ToolExecutionComponent(
		name,
		"fixture",
		args,
		undefined,
		tool,
		{ requestRender() {} } as unknown as TUI,
		".",
	);
}

const render = (card: ToolExecutionComponent, width = 120) => plain(card.render(width).join("\n"));
const textBlock = (text: string) => [{ type: "text" as const, text }];
const sourcePage: AccessPage = {
	schema: "pillars-source",
	resource: "governance",
	referenceBodyDigest: "a".repeat(64),
	bodyBytes: 64,
	offset: 16,
	endOffset: 48,
	text: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
	nextOffset: 48,
};

test("the host tool shell shows visual previews, hands off one hint and keeps exact continuation arguments", (t) => {
	initTheme("dark", false);
	const prior = getKeybindings();
	t.after(() => setKeybindings(prior));
	binding(["ctrl+p"]);
	assert.equal(keyText("app.tools.expand"), "ctrl+p");
	const args = { resource: "governance", offset: 16, draft: "sensitive draft prose" };
	const card = component("pillars", args);
	assert.match(render(card), /pillars governance +\n +offset 16 · draft assessment/);
	assert.match(render(card), /\.\.\. \(ctrl\+p to expand\)/);
	card.updateResult({ content: textBlock(JSON.stringify(sourcePage)), details: sourcePage, isError: false });
	const collapsed = render(card);
	assert.match(collapsed, /Read 32 of 64 bytes from governance; continuation available\./);
	assert.match(collapsed, /one +\n +two +\n +three +\n +four +\n +five/);
	assert.match(collapsed, /\.\.\. \(2 more lines, ctrl\+p to expand\)/);
	assert.equal(collapsed.match(/to expand/g)?.length, 1);
	assert.doesNotMatch(collapsed, /six|seven|Continue:|sensitive draft prose/);
	card.setExpanded(true);
	const expanded = render(card, 240);
	assert.ok(
		expanded.includes(
			`Continue: pillars ${JSON.stringify({ resource: "governance", offset: 48, referenceBodyDigest: sourcePage.referenceBodyDigest })}`,
		),
	);
	assert.match(expanded, /draft: 21 characters/);
	assert.match(expanded, /seven/);
	assert.doesNotMatch(expanded, /to expand|sensitive draft prose/);
	binding([]);
	card.setExpanded(false);
	assert.match(render(card), /2 more lines, click to expand/);
	assert.doesNotMatch(render(component("pillars", args)), /expand/);
});

test("the host tool shell uses typed refusals or known JSON envelopes without parsing arbitrary text", () => {
	const card = component("pillars", {});
	const refusal = {
		schema: "pillars-source-error",
		code: "source_changed",
		message: "The source revision changed. Omit both continuation fields for a fresh read.",
	};
	for (const details of [refusal, undefined]) {
		card.updateResult({ content: textBlock(JSON.stringify(refusal)), details, isError: true });
		assert.match(render(card), /The source revision changed\. Omit both continuation fields/);
		assert.doesNotMatch(render(card), /pillars-source-error|source_changed/);
		card.setExpanded(true);
		assert.match(render(card), /Code: source_changed/);
		assert.match(render(card), /Omit both continuation fields/);
		card.setExpanded(false);
	}
	card.updateResult({
		content: textBlock(`External diagnostic: ${JSON.stringify(refusal)}\nDo not show this second line`),
		details: undefined,
		isError: true,
	});
	assert.match(render(card, 240), /External diagnostic: \{"schema":"pillars-source-error"/);
	assert.doesNotMatch(render(card), /Do not show this second line/);
	const usage = component("pillars_usage", {});
	const error = errorResponse("invalid_input");
	usage.updateResult({ content: textBlock(JSON.stringify(error)), isError: true, details: undefined });
	assert.match(render(usage), /received an invalid request\. Send \{\}/);
	assert.doesNotMatch(render(usage), /schemaVersion/);
	usage.setExpanded(true);
	assert.match(render(usage), /Code: invalid_input/);
	assert.match(render(usage), /received an invalid request\. Send \{\}/);
});

test("the source preview counts wrapped visual rows rather than logical lines", () => {
	const card = component("pillars", {});
	const page = { ...sourcePage, text: `${"segment ".repeat(40)}END` };
	card.updateResult({ content: textBlock(JSON.stringify(page)), details: page, isError: false });
	const width = 48;
	const collapsed = render(card, width);
	assert.equal(collapsed.split("\n").filter((row) => /segment/.test(row)).length, 5);
	assert.doesNotMatch(collapsed, /END/u);
	assert.match(collapsed, /\d+ more lines/u);
	card.setExpanded(true);
	const expanded = render(card, width);
	assert.match(expanded, /END/u);
	assert.ok(card.render(width).every((row) => visibleWidth(row) <= width));
});

test("call disclosure adds only evidence that the collapsed header withheld", (t) => {
	const prior = getKeybindings();
	t.after(() => setKeybindings(prior));
	binding(["ctrl+p"]);
	for (const [name, args] of [
		["pillars", { resource: "governance", offset: 16 }],
		["pillars_usage", { view: "revisions", windowDays: 7 }],
	] as const) {
		const card = component(name, args);
		const collapsed = render(card);
		assert.doesNotMatch(collapsed, /to expand|(?:resource|offset|view|windowDays):/);
		card.setExpanded(true);
		assert.equal(render(card), collapsed, "Visible arguments do not appear again as name-value rows.");
	}

	const resource = `principle-${"a".repeat(49)}last`;
	const factCard = component("pillars", { resource, offset: 16 });
	const width = 34;
	assert.match(render(factCard, width), /…/u);
	assert.match(render(factCard, width), /ctrl\+p to expand/);
	factCard.setExpanded(true);
	const full = render(factCard, width);
	assert.ok(full.replace(/\s+/gu, "").includes(resource));
	assert.doesNotMatch(full, /…|resource:|offset:|to expand/u);
	factCard.setExpanded(false);
	factCard.updateResult({ content: textBlock("No page available."), details: undefined, isError: false });
	assert.equal(render(factCard, width).match(/to expand/g)?.length, 1, "The result takes ownership of the hint.");
	assert.doesNotMatch(render(factCard), /to expand/, "After a resize, expansion no longer adds anything.");
	binding([]);
	assert.doesNotMatch(render(component("pillars", { resource }), width), /to expand/);

	const mixed = component("pillars", { draft: "synthetic", offset: -9007199254740991 });
	assert.doesNotMatch(render(mixed, width), /draft assessment/);
	mixed.setExpanded(true);
	assert.match(render(mixed, width), /draft\s+assessment/);
});

test("fallback errors show one safe outcome row and keep the full diagnostic for expansion", (t) => {
	const prior = getKeybindings();
	t.after(() => setKeybindings(prior));
	binding(["ctrl+p"]);
	for (const [name, args, withheld] of [
		["pillars", { draft: "synthetic-draft" }, "synthetic-draft"],
		["pillars_usage", { cursor: "synthetic-cursor" }, "synthetic-cursor"],
	] as const) {
		const card = component(name, args);
		const diagnostic = `Invalid arguments for tool "${name}": ${withheld}\nReceived arguments:\n${JSON.stringify(args, null, 2)}\n\u001b]0;hidden-terminal-control\u0007TAIL`;
		card.updateResult({ content: textBlock(diagnostic), details: undefined, isError: true });
		assert.doesNotMatch(render(card), /synthetic-|Received arguments:|TAIL/);
		assert.equal(render(card).match(/to expand/g)?.length, 1);
		card.setExpanded(true);
		const full = render(card);
		assert.ok(full.includes(withheld));
		assert.doesNotMatch(full, /The Pillars .* read did not complete/);
		assert.match(full, /Invalid arguments.*\n.*Received arguments:.*\n.*\{/);
		assert.match(full, /TAIL/);
		assert.doesNotMatch(full, /hidden-terminal-control|\u0007|to expand/u);
	}

	const card = component("pillars", {});
	const long = `First diagnostic ${"reason ".repeat(75)}FIRST-END`;
	const width = 45;
	card.updateResult({ content: textBlock(long), details: undefined, isError: true });
	const collapsed = render(card, width);
	assert.deepEqual(
		collapsed
			.split("\n")
			.map((row) => row.trim())
			.filter(Boolean)
			.slice(1),
		[
			collapsed
				.split("\n")
				.find((row) => row.includes("First diagnostic"))
				?.trim(),
			"... (ctrl+p to expand)",
		],
	);
	assert.match(collapsed, /…/u);
	assert.doesNotMatch(collapsed, /FIRST-END/);
	card.setExpanded(true);
	assert.match(render(card, width), /FIRST-END/);
});
