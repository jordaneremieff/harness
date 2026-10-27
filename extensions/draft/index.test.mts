import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	type CheckRecord,
	checkReply,
	needsRepair,
	REPAIR_BLOCK,
	RULES_SECTION,
	repairText,
	replyRulesText,
	unavailableText,
} from "./check.ts";
import draft from "./index.ts";
import { measure, runMeter } from "./meter.ts";
import { filler } from "./scripts/test-kit.mts";
import { settings } from "./settings.ts";

let dir = "";
const saved = new Map<string, string | undefined>();
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "draft-index-"));
	for (const name of [
		"PI_CODING_AGENT_DIR",
		"PI_HARNESS_FILE",
		...Object.values(settings.fields).map((field) => field.env),
	]) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(async () => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
	await rm(dir, { recursive: true, force: true });
});

const AMBER = `${filler(200)} This pivotal design is robust. It will foster a dynamic landscape.`;
const RED = `${filler(200)} This pivotal design is robust. It will foster a dynamic landscape. It underscores a vibrant realm. Moreover, it is a beacon.`;

type Entry = { customType: string; content: string; display: boolean; details?: CheckRecord };
type Result = { entries?: Entry[]; continue?: boolean; block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown) => Promise<Result> | Result | undefined;
function load(checker = checkReply) {
	const handlers = new Map<string, Handler>();
	const tools: unknown[] = [];
	draft(
		{
			events: createEventBus(),
			registerTool: (tool: unknown) => tools.push(tool),
			on: (name: string, handler: Handler) => void handlers.set(name, handler),
		} as never,
		checker,
	);
	const start = (messageType: "user" | "custom" = "user") => {
		const sections: Record<string, string> = { [RULES_SECTION]: "stale" };
		handlers.get("before_agent_start")?.({ messageType, systemPromptOptions: { sections } });
		return sections;
	};
	return {
		tools,
		start,
		tool: (toolName = "read") => handlers.get("tool_call")?.({ toolName, input: {} }) as Result,
		settle: (text: string, outcome = "completed") =>
			handlers.get("agent_before_settle")?.({
				outcome,
				context: { llmMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
			}),
	};
}
/** A loaded extension whose current run started from operator input. */
function operator(checker = checkReply) {
	const h = load(checker);
	h.start();
	return h;
}

test("hard findings request one hidden repair grouped by rule with the rule repair and a record", async () => {
	const result = await operator().settle("A plain line.\nA dash — here — and there.\n- **Label:** text");
	assert.equal(result?.continue, true);
	const entry = result?.entries?.[0];
	assert.equal(entry?.display, false);
	assert.match(entry?.content ?? "", /punctuation\.em-dash, 2 times on line 2: .*Repair: Split into two sentences/u);
	assert.match(entry?.content ?? "", /structure\.bold-label, 1 time on line 3/u);
	assert.match(entry?.content ?? "", /Hard findings: 3\. Fix every one\./u);
	assert.match(entry?.content ?? "", /Calibration: .*cohort/u);
	assert.match(entry?.content ?? "", /text only: tool calls are blocked/u);
	assert.equal(entry?.details?.trigger, "hard");
	assert.equal(entry?.details?.hard, 3);
	assert.deepEqual(entry?.details?.rules, { "punctuation.em-dash": 2, "structure.bold-label": 1 });
});
test("a hard-finding repair lists hard rules only", () => {
	const message = repairText(measure(`${AMBER} A dash — here.`), 12);
	assert.match(message, /punctuation\.em-dash/u);
	assert.doesNotMatch(message, /lexical\./u);
});
test("runs started by custom messages and replies before any run are not checked", async () => {
	let checks = 0;
	const counting = async () => {
		checks += 1;
		return { kind: "clean" } as const;
	};
	assert.equal(await load(counting).settle("A dash — here"), undefined);
	const h = load(counting);
	h.start("custom");
	assert.equal(await h.settle("A dash — here"), undefined);
	assert.equal(checks, 0);
	h.start("user");
	await h.settle("A dash — here");
	assert.equal(checks, 1);
});
test("the default gate repairs hard findings and red scores but not amber or short scored replies", async () => {
	assert.equal(await operator().settle(AMBER), undefined);
	assert.equal(await operator().settle("The pivotal design is robust and uses color."), undefined);
	const red = await operator().settle(RED);
	assert.equal(red?.continue, true);
	assert.match(red?.entries?.[0]?.content ?? "", /The score reached the red band/u);
	assert.match(red?.entries?.[0]?.content ?? "", /lexical\./u);
	assert.equal(red?.entries?.[0]?.details?.trigger, "band");
	process.env.PI_DRAFT_NOTIFY_BAND = "amber";
	assert.equal((await operator().settle(AMBER))?.continue, true);
});
test("tool calls are blocked only while a repaired reply is owed", async () => {
	const h = operator();
	assert.equal(h.tool(), undefined);
	assert.equal((await h.settle("A dash — here"))?.continue, true);
	assert.deepEqual(h.tool("draft"), { block: true, reason: REPAIR_BLOCK });
	assert.deepEqual(h.tool("bash"), { block: true, reason: REPAIR_BLOCK });
	assert.equal(await h.settle("Another — dash"), undefined);
	assert.equal(h.tool(), undefined);
	assert.equal((await h.settle("A dash — here"))?.continue, undefined);
	h.start();
	assert.equal((await h.settle("Another — dash"))?.continue, true);
	h.start();
	assert.equal(h.tool(), undefined);
});
test("the system prompt carries the hard prose rules while the check is enabled", () => {
	const sections = load().start();
	const rules = sections[RULES_SECTION] ?? "";
	assert.equal(rules, replyRulesText());
	assert.match(rules, /Bold label at the start of a list item\. Instead: Write the item as a plain sentence/u);
	assert.match(rules, /Em dash/u);
	assert.doesNotMatch(rules, /commit|Lowercase|subject/iu);
	process.env.PI_DRAFT_ENABLED = "0";
	assert.equal(load().start()[RULES_SECTION], undefined);
});
test("quoted lexical mentions stay exempt while quoted sentences still count", () => {
	const named = measure("The report flags “pivotal” and “robust” as stock vocabulary. Both findings occur on line 2.");
	assert.deepEqual(named.scored, []);
	const quoted = measure("The proposal says, “This pivotal design is robust.”");
	assert.ok(quoted.scored.some((finding) => finding.rule === "lexical.pivotal"));
	assert.ok(quoted.scored.some((finding) => finding.rule === "lexical.robust"));
});
test("clean, empty, aborted, failed and disabled replies add nothing", async () => {
	const h = operator();
	assert.equal(await h.settle("The parser rejects an empty file."), undefined);
	assert.equal(await h.settle("  "), undefined);
	assert.equal(await h.settle("A dash — here", "aborted"), undefined);
	assert.equal(await h.settle("A dash — here", "error"), undefined);
	process.env.PI_DRAFT_ENABLED = "0";
	assert.equal(await h.settle("A dash — here"), undefined);
});
test("the gate fails on hard findings or a reliable band at the notify band", () => {
	const clean = measure("The parser rejects an empty file.");
	assert.equal(needsRepair(clean, "green"), false);
	const scored = { ...clean, omitted: { ...clean.omitted, scored: 9 } };
	assert.equal(needsRepair(scored, "green"), false);
	const amber = { ...clean, score: { ...clean.score, reliable: true, band: "amber" as const } };
	assert.equal(needsRepair(amber, "amber"), true);
	assert.equal(needsRepair(amber, "red"), false);
	assert.equal(needsRepair({ ...amber, score: { ...amber.score, band: "green" as const } }, "green"), true);
	assert.equal(needsRepair({ ...clean, omitted: { ...clean.omitted, hard: 1 } }, "red"), true);
});
test("rules beyond the listing cap are counted, and omitted findings keep their total", () => {
	const report = measure(`Frankly, this — that.\n${"- **Label:** text\n".repeat(30)}`);
	const message = repairText(report, 1);
	assert.match(message, /more rules not listed/u);
	assert.match(message, /structure\.bold-label, 30 times on lines 2, 3, 4, 5, 6, 7, 8, 9 and more/u);
});
test("reliable green replies with several lexical findings settle without repair", async () => {
	const text = `${filler(200)} A pivotal design is robust.`;
	const report = measure(text);
	assert.equal(report.score.reliable, true);
	assert.equal(report.score.band, "green");
	assert.ok(report.scored.length >= 2);
	assert.equal(await operator().settle(text), undefined);
});
test("reply analysis excludes spelling from counts, omitted findings and score", async () => {
	for (const text of [
		"The color and behavior changed.",
		`${filler(100)} The color and behavior changed.`,
		"color ".repeat(60),
	]) {
		const explicit = measure(text);
		assert.ok(explicit.scored.some((finding) => finding.rule.startsWith("spelling.")));
		const reply = runMeter(text);
		assert.equal(reply.ok, true);
		if (!reply.ok) continue;
		assert.ok(reply.report.scored.every((finding) => !finding.rule.startsWith("spelling.")));
		assert.deepEqual(reply.report.score, explicit.score);
		assert.equal(reply.report.omitted.scored, 0);
		assert.deepEqual(reply.report.omitted.byRule, {});
		assert.equal(await operator().settle(text), undefined);
	}
});
test("the hook measures only the configured prefix", async () => {
	process.env.PI_DRAFT_MAX_CHARS = "100";
	assert.equal(await operator().settle(`${"x".repeat(100)} — unmeasured`), undefined);
});
test("an unavailable notice repeats only after analysis works again", async () => {
	let unavailable = true;
	const h = operator(async () =>
		unavailable
			? { kind: "unavailable", reason: "failed", text: unavailableText("failed", "rule data unavailable") }
			: { kind: "clean" },
	);
	assert.equal((await h.settle("reply"))?.entries?.[0]?.customType, "draft-notice");
	assert.equal(await h.settle("reply"), undefined);
	unavailable = false;
	await h.settle("reply");
	unavailable = true;
	assert.ok((await h.settle("reply"))?.entries);
});
test("the in-process hook stays fast at the maximum supported reply length", async () => {
	process.env.PI_DRAFT_MAX_CHARS = String(settings.fields.maxChars.max);
	for (const pattern of ["—".repeat(200), "- **Label:** a\n", "word-".repeat(200), "a".repeat(1000)]) {
		const text = pattern
			.repeat(Math.ceil(settings.fields.maxChars.max / pattern.length))
			.slice(0, settings.fields.maxChars.max);
		const started = performance.now();
		await operator().settle(text);
		assert.ok(performance.now() - started < 750, `hook exceeded 750 ms for ${pattern.slice(0, 20)}`);
	}
});
test("a checker outcome keeps the configured listing cap", async () => {
	const outcome = await checkReply("Frankly, this — that.\n- **Label:** text", {
		maxChars: 20000,
		notifyBand: "red",
		maxRules: 1,
	});
	assert.equal(outcome.kind, "repair");
	if (outcome.kind === "repair") assert.match(outcome.text, /more rules not listed/u);
});
