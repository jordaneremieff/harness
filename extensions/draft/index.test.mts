import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { checkReply, needsRepair, repairText, unavailableText } from "./check.ts";
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

type Entry = { customType: string; content: string; display: boolean };
type Handler = (event: unknown) => Promise<{ entries?: Entry[]; continue?: boolean } | undefined> | undefined;
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
	return {
		tools,
		start: () => handlers.get("before_agent_start")?.({}),
		settle: (text: string, outcome = "completed") =>
			handlers.get("agent_before_settle")?.({
				outcome,
				context: { llmMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
			}),
	};
}

test("hard findings request one hidden repair with real line numbers and calibration", async () => {
	const result = await load().settle("A plain line.\nA dash — here.");
	assert.equal(result?.continue, true);
	assert.equal(result?.entries?.[0]?.display, false);
	assert.match(result?.entries?.[0]?.content ?? "", /punctuation\.em-dash line 2/u);
	assert.match(result?.entries?.[0]?.content ?? "", /Calibration: .*cohort/u);
	assert.match(result?.entries?.[0]?.content ?? "", /without another draft tool call/u);
});
test("a reply that only names lexical findings does not request a repair", async () => {
	const result = await load().settle('The report flags “pivotal” and “robust” as stock vocabulary. Both findings occur on line 2.');
	assert.equal(result, undefined);
});

test("a reply that uses lexical terms inside a quoted sentence still requests a repair", async () => {
	const result = await load().settle('The proposal says, “This pivotal design is robust.”');
	assert.equal(result?.continue, true);
	assert.match(result?.entries?.[0]?.content ?? "", /lexical\.pivotal/u);
	assert.match(result?.entries?.[0]?.content ?? "", /lexical\.robust/u);
});

test("clean, empty, aborted, failed and disabled replies add nothing", async () => {
	const h = load();
	assert.equal(await h.settle("The parser rejects an empty file."), undefined);
	assert.equal(await h.settle("  "), undefined);
	assert.equal(await h.settle("A dash — here", "aborted"), undefined);
	assert.equal(await h.settle("A dash — here", "error"), undefined);
	process.env.PI_DRAFT_ENABLED = "0";
	assert.equal(await h.settle("A dash — here"), undefined);
});
test("one automatic repair per run, then the guard resets", async () => {
	const h = load();
	assert.equal((await h.settle("A dash — here"))?.continue, true);
	assert.equal(await h.settle("Another — dash"), undefined);
	await h.start();
	assert.equal((await h.settle("Another — dash"))?.continue, true);
});
test("reliable bands ignore listed and omitted counts while short replies retain count triggers", () => {
	const clean = measure("The parser rejects an empty file.");
	const scored = { ...clean, hard: [], scored: [], omitted: { ...clean.omitted, scored: 2 } };
	assert.equal(needsRepair(scored, "amber", 2), true);
	assert.equal(needsRepair(scored, "amber", 3), false);
	const green = { ...scored, score: { ...scored.score, reliable: true, band: "green" as const } };
	assert.equal(needsRepair(green, "amber", 2), false);
	assert.equal(needsRepair(green, "red", 2), false);
	assert.equal(needsRepair(green, "green", 2), true);
	assert.equal(needsRepair({ ...clean, score: { ...clean.score, reliable: true, band: "amber" } }, "amber", 2), true);
	assert.equal(needsRepair({ ...clean, score: { ...clean.score, reliable: true, band: "amber" } }, "red", 2), false);
	assert.equal(needsRepair({ ...clean, omitted: { ...clean.omitted, hard: 1 } }, "red", 50), true);
	const report = measure("Frankly, this pivotal solution — unlocks a robust ecosystem.");
	const message = repairText(report, 1);
	assert.ok(message.indexOf(report.hard[0]?.rule ?? "") >= 0);
	assert.match(message, /more not listed/u);
});
test("reliable green replies with several lexical findings settle without repair", async () => {
	const text = `${filler(200)} A pivotal design is robust.`;
	const report = measure(text);
	assert.equal(report.score.reliable, true);
	assert.equal(report.score.band, "green");
	assert.ok(report.scored.length >= 2);
	assert.equal(await load().settle(text), undefined);
});
test("reply analysis excludes spelling from counts, omitted findings and score", async () => {
	for (const text of ["The color and behavior changed.", `${filler(100)} The color and behavior changed.`, "color ".repeat(60)]) {
		const explicit = measure(text);
		assert.ok(explicit.scored.some((finding) => finding.rule.startsWith("spelling.")));
		const reply = runMeter(text);
		assert.equal(reply.ok, true);
		if (!reply.ok) continue;
		assert.ok(reply.report.scored.every((finding) => !finding.rule.startsWith("spelling.")));
		assert.deepEqual(reply.report.score, explicit.score);
		assert.equal(reply.report.omitted.scored, 0);
		assert.deepEqual(reply.report.omitted.byRule, {});
		assert.equal(await load().settle(text), undefined);
	}
});
test("spelling does not add to the count for a short lexical reply", async () => {
	assert.equal(await load().settle("The pivotal design uses color."), undefined);
	const result = await load().settle("The pivotal design is robust and uses color.");
	assert.equal(result?.continue, true);
	assert.doesNotMatch(result?.entries?.[0]?.content ?? "", /spelling\./u);
});
test("the hook measures only the configured prefix", async () => {
	process.env.PI_DRAFT_MAX_CHARS = "100";
	assert.equal(await load().settle(`${"x".repeat(100)} — unmeasured`), undefined);
});
test("an unavailable notice repeats only after analysis works again", async () => {
	let unavailable = true;
	const h = load(async () =>
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
		await load().settle(text);
		assert.ok(performance.now() - started < 750, `hook exceeded 750 ms for ${pattern.slice(0, 20)}`);
	}
});
