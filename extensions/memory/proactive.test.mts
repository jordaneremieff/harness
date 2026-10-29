import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryNotice, noteKey, recallCandidate, storageCue } from "./proactive.ts";
import { memoryIndex, recallSources } from "./retrieval.ts";
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
	assert.equal(recallCandidate(`${recallText}${" ".repeat(2001)}`, scan.notes), undefined);
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
