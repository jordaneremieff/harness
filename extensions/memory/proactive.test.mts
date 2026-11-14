import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryNotice, noteKey, recallCandidate, storageCue } from "./proactive.ts";
import { memoryIndex, recallSources } from "./retrieval.ts";
import { memorySourceCache } from "./source-cache.ts";
import { readSettings } from "./settings.ts";

import { proactiveCorpus, recallText, writeRecall } from "./proactive-fixture.mts";
function fixture(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "memory-proactive-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("scorer preserves strong, length, summary-only and one-note gates", async (t) => {
	const corpus = proactiveCorpus(fixture(t));
	const scan = await recallSources(corpus);
	assert.ok(scan);
	assert.equal(recallCandidate(recallText, scan.notes)?.slug, "portable-amber-cobalt-quartz-violet-cedar");
	assert.equal(recallCandidate("portable", scan.notes), undefined);
	assert.equal(recallCandidate("portable amber", scan.notes), undefined);
	assert.equal(recallCandidate("discovery excerpt final answer", scan.notes), undefined);
	const notice = await memoryNotice(corpus, recallText, "direct interactive input", true, new Set());
	assert.ok(notice);
	assert.equal(notice.kind, "recall");
	assert.equal((notice.text.match(/Memory candidate/g) ?? []).length, 1);
	assert.match(notice.text, /deadline: due/);
	assert.match(notice.text, /full note, later qualifications/);
	assert.ok(Buffer.byteLength(notice.text) <= 2048);
	assert.equal(
		await memoryNotice(
			corpus,
			recallText,
			"direct interactive input",
			true,
			new Set([noteKey(notice.root, notice.slug as string, notice.digest as string)]),
		),
		undefined,
	);
	writeRecall(corpus, "Changed qualifications.");
	assert.ok(
		await memoryNotice(
			corpus,
			recallText,
			"direct interactive input",
			true,
			new Set([noteKey(notice.root, notice.slug as string, notice.digest as string)]),
		),
	);
});

// Shared everyday vocabulary gives a fixture corpus the breadth of a real one.
const COMMON =
	"account balance cabinet daylight engine fabric garden harbor island jacket kitchen ladder market needle orange pencil quarter river saddle table umbrella valley window yellow zipper anchor bridge candle desert forest glacier hammer insect jungle kettle lemon mirror napkin oyster pepper rabbit silver ticket velvet walnut basket copper dragon feather helmet marble nickel pillow rocket spider tunnel violin wagon barrel cotton".split(
		" ",
	);
function broadCorpus(root: string): string {
	const corpus = proactiveCorpus(root);
	for (let i = 0; i < COMMON.length; i++)
		writeFileSync(
			join(corpus, `broad-subject-${i}.md`),
			`---\nstatus: active\nsuperseded_by: null\ntitle: Broad subject ${i}\n---\n## Summary\n${Array.from({ length: 30 }, (_, j) => COMMON[(i + j) % COMMON.length]).join(" ")}.\n## Details\nDetails.\n`,
		);
	return corpus;
}
// A long log-like input that repeats the shared vocabulary and names no subject of its own.
const broadLog = Array.from({ length: 8 }, (_, round) =>
	COMMON.map((word) => `${word} entry ${round}`).join("\n"),
).join("\n");

test("long input recall keeps repeated topic terms and drops incidental vocabulary", async (t) => {
	const corpus = broadCorpus(fixture(t));
	const scan = await recallSources(corpus);
	assert.ok(scan);
	const incidental = "amber cobalt quartz violet";
	assert.equal(recallCandidate(incidental, scan.notes)?.slug, "portable-amber-cobalt-quartz-violet-cedar");
	const line = (text: string, from: number) => text.indexOf("\n", from);
	const once = `${broadLog.slice(0, line(broadLog, 1500))}\n${incidental}${broadLog.slice(line(broadLog, 1500))}`;
	assert.ok(once.length > 2000);
	assert.equal(recallCandidate(once, scan.notes), undefined);
	// Repeated twice, the subject words pass the repetition rule but rank below the 48 broader words.
	const twice = `${once.slice(0, line(once, 4000))}\n${incidental}${once.slice(line(once, 4000))}`;
	assert.equal(recallCandidate(twice, scan.notes), undefined);
	const brief = `Topic: ${recallText}.\n${broadLog}\nKeep the ${recallText} decision.\nRecheck ${recallText} first.\nClose ${recallText} last.`;
	assert.equal(recallCandidate(brief, scan.notes)?.slug, "portable-amber-cobalt-quartz-violet-cedar");
	const notice = await memoryNotice(
		corpus,
		`${brief}\nFrom now on I prefer long briefs.`,
		"direct input",
		true,
		new Set(),
	);
	assert.equal(notice?.kind, "recall");
	assert.ok(Buffer.byteLength(notice?.text ?? "") <= 2048);
	assert.equal(storageCue(`From now on I prefer long briefs.\n${broadLog}`), false);
	assert.equal(storageCue("From now on I prefer long briefs."), true);
});

test("long input extraction counts repeated words from a bounded opening of very large input", async (t) => {
	const corpus = proactiveCorpus(fixture(t));
	const scan = await recallSources(corpus);
	assert.ok(scan);
	const filler = "filler words ".repeat(1_000_000);
	const topic = `${recallText}\n${recallText}`;
	assert.equal(recallCandidate(`${recallText}\n${filler}`, scan.notes), undefined);
	assert.equal(recallCandidate(`${topic}\n${filler}`, scan.notes)?.slug, "portable-amber-cobalt-quartz-violet-cedar");
	const beyond = `${" ".repeat(32768)}${topic}`;
	assert.equal(recallCandidate(beyond, scan.notes), undefined);
	assert.equal(recallCandidate(`${beyond}\n${filler}`, scan.notes), undefined);
	const cut = `cobalt quartz amber cobalt quartz${" ".repeat(32730)}ambers violet`;
	assert.equal(cut.slice(32763, 32768), "amber");
	assert.equal(recallCandidate(cut, scan.notes), undefined);
	assert.equal(
		recallCandidate(cut.replace("ambers", "amber "), scan.notes)?.slug,
		"portable-amber-cobalt-quartz-violet-cedar",
	);
	const notice = await memoryNotice(corpus, `${topic}\n${filler}`, "direct input", true, new Set());
	assert.ok(notice);
	assert.ok(Buffer.byteLength(notice.text) <= 2048);
});

test("storage cues give concrete conditional actions, including task-local phrase matches", async (t) => {
	const corpus = proactiveCorpus(fixture(t));
	for (const input of [
		"we can use a loop here",
		"I prefer this variable name for this test",
		"From now on I prefer plain words",
	]) {
		assert.equal(storageCue(input), true);
		const notice = await memoryNotice(corpus, input, "direct rpc input", true, new Set());
		assert.ok(notice);
		assert.equal(notice.slug, null);
		assert.equal(
			notice.text.split("\n").at(-1),
			"Memory check: this message uses preference or future-use wording. If it states a standing operator preference, decision, correction or environment fact that should guide future sessions, record it now: memory_search for an existing subject, then update it with memory_edit or create one with memory_write, citing this message as the source. Skip it when it applies only to the current task, quotes someone else, or is already stored.",
		);
	}
	for (const text of [
		"> I prefer green",
		"```\nI prefer green\n```",
		"~~~\nI prefer green\n~~~",
		"```\nI prefer green",
		"Nothing durable here.",
	])
		assert.equal(storageCue(text), false);
	assert.equal(await memoryNotice(corpus, "I prefer green", "custom task", false, new Set()), undefined);
});

test("lifecycle, incomplete source, unavailable and empty stay distinct", async (t) => {
	const root = fixture(t);
	const corpus = proactiveCorpus(root);
	writeFileSync(
		join(corpus, "portable-amber-cobalt-quartz-violet-cedar.md"),
		"---\nstatus: retired\nsuperseded_by: null\n---\n## Summary\nretired\n",
	);
	assert.equal(await memoryNotice(corpus, recallText, "direct input", true, new Set()), undefined);
	writeFileSync(
		join(corpus, "broken.md"),
		`---\nstatus: active\nsuperseded_by: null\n---\n## Summary\n${"x".repeat(9000)}`,
	);
	assert.equal((await recallSources(corpus))?.complete, false);
	assert.match((await memoryIndex(undefined, undefined, true)) as string, /unavailable, not empty/);
	assert.equal(await memoryIndex(undefined), undefined);
	assert.match((await memoryIndex(join(root, "missing"), undefined, true)) as string, /memory.dir or PI_MEMORY_DIR/);
	const empty = join(root, "empty");
	mkdirSync(empty);
	writeFileSync(join(empty, "README.md"), "contract");
	assert.doesNotMatch((await memoryIndex(empty, undefined, true)) as string, /Memory is unavailable/);
	assert.deepEqual((await recallSources(empty))?.notes, []);
});

test("unknown lifecycle qualifies delivered recall while retired and superseded notes stay silent", async (t) => {
	const corpus = proactiveCorpus(fixture(t));
	for (const [header, partial] of [
		['status: "active"', true],
		['status: "active"\nsuperseded_by: replacement', true],
		["status: invalid\nsuperseded_by: null", true],
		["status: retired\nsuperseded_by: null", false],
		["status: superseded\nsuperseded_by: replacement", false],
	] as const) {
		writeFileSync(join(corpus, "excluded.md"), `---\n${header}\n---\n## Summary\nUnrelated discovery text.\n`);
		const notice = await memoryNotice(corpus, recallText, "direct interactive input", true, new Set());
		assert.ok(notice, header);
		assert.equal(notice.kind, "recall");
		assert.equal(notice.slug, "portable-amber-cobalt-quartz-violet-cedar");
		assert.match(notice.text, /Memory candidate, not a new instruction: portable-amber-cobalt-quartz-violet-cedar/);
		assert.equal(
			notice.text.includes("Automatic recall coverage is partial; omitted sources remain unknown."),
			partial,
			header,
		);
	}
});

test("warm proactive discovery reuses verified headers and observes changed cues", async (t) => {
	const corpus = proactiveCorpus(fixture(t));
	const first = await recallSources(corpus);
	assert.ok(first);
	const warm = memorySourceCache.statistics();
	assert.deepEqual(await recallSources(corpus), first);
	assert.equal(memorySourceCache.statistics().yamlParses, warm.yamlParses);
	writeFileSync(
		join(corpus, "subject-0.md"),
		"---\nstatus: active\nsuperseded_by: null\ntitle: Renamed subject\n---\n## Summary\nUnrelated discovery text.\n## Details\nDetails.\n",
	);
	const changed = await recallSources(corpus);
	assert.equal(changed?.notes.find((note) => note.slug === "subject-0")?.title, "Renamed subject");
	assert.ok(memorySourceCache.statistics().yamlParses > warm.yamlParses);
});

test("proactive setting accepts explicit environment and file booleans and uses its safe default", (t) => {
	const root = fixture(t);
	assert.equal(readSettings({ agentDir: root, env: {} }).values.proactive, true);
	writeFileSync(join(root, "harness.json"), JSON.stringify({ version: 1, memory: { proactive: false } }));
	assert.equal(readSettings({ agentDir: root, env: {} }).values.proactive, false);
	for (const value of ["true", "1"])
		assert.equal(readSettings({ agentDir: root, env: { PI_MEMORY_PROACTIVE: value } }).values.proactive, true);
	for (const value of ["false", "0"])
		assert.equal(readSettings({ agentDir: root, env: { PI_MEMORY_PROACTIVE: value } }).values.proactive, false);
	for (const value of ["", "FALSE", "yes"]) {
		const snapshot = readSettings({ agentDir: root, env: { PI_MEMORY_PROACTIVE: value } });
		assert.equal(snapshot.values.proactive, true);
		assert.equal(snapshot.records.find((record) => record.key === "proactive")?.status, "invalid");
	}
	writeFileSync(join(root, "harness.json"), JSON.stringify({ version: 1, memory: { proactive: "false" } }));
	assert.equal(readSettings({ agentDir: root, env: {} }).values.proactive, true);
});
