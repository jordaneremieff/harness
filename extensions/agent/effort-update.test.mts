import assert from "node:assert/strict";
import { it } from "node:test";
import {
	type BranchAwareness,
	branchAwareness,
	EFFORT_AWARENESS_UNAVAILABLE,
	EFFORT_BASELINE_ENTRY,
	EFFORT_UPDATE_MESSAGE,
	ordinaryEffortRun,
} from "./effort-baseline.ts";
import {
	applyChanges,
	EFFORT_UPDATE_BYTES,
	type EffortPromptRow,
	effortDelta,
	effortRowKey,
	formatEffortUpdate,
	seenInSection,
	seenOf,
} from "./effort-update.ts";

const effort = (id: string, extra: Record<string, unknown> = {}): EffortPromptRow => ({
	key: effortRowKey("Related effort", id),
	label: "Related effort",
	value: { id, cwd: "/work", ...extra },
});
const thread = (id: string, title = "Coordination"): EffortPromptRow => ({
	key: effortRowKey("Active thread", id),
	label: "Active thread",
	value: { id, title, purpose: "Shared work" },
});
const section = (rows: EffortPromptRow[]) =>
	["Header line.", ...rows.map((row) => `${row.label}: ${JSON.stringify(row.value)}`), "Pointer."].join("\n");

it("reports added, replaced and removed rows, and nothing when the model already has the rows", () => {
	const before = [effort("a"), effort("b"), thread("s/1")];
	const seen = seenOf(before);
	assert.equal(effortDelta(seen, before), undefined);
	const after = [effort("a", { sessionName: "renamed" }), effort("c"), thread("s/1")];
	const delta = effortDelta(seen, after);
	assert.deepEqual(
		delta?.rows.map((row) => row.key),
		["effort:a", "effort:c"],
	);
	assert.deepEqual(delta?.removed, [{ key: "effort:b", label: "Related effort", id: "b" }]);
	assert.ok(delta);
	const update = formatEffortUpdate(delta);
	assert.ok(update);
	assert.match(update.text, /^<agent-efforts-update>\n/u);
	assert.match(update.text, /Related effort: \{"id":"a","cwd":"\/work","sessionName":"renamed"\}/u);
	assert.match(update.text, /Related effort removed: \{"id":"b"\}/u);
	assert.equal(update.bytes, Buffer.byteLength(update.text));
	assert.deepEqual(applyChanges(seen, [update.change]), seenOf(after), "the change brings the model to the rows");
});

it("refuses an update larger than its byte bound", () => {
	const rows = Array.from({ length: 40 }, (_, index) => effort(`e${index}`, { purposeClaim: "x".repeat(200) }));
	const delta = effortDelta({}, rows);
	assert.ok(delta);
	assert.equal(formatEffortUpdate(delta), undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(rows)) > EFFORT_UPDATE_BYTES);
});

it("reads the rows of a rendered section and skips shortened rows", () => {
	const rows = [effort("a"), thread("s/1")];
	const text = `${section(rows)}\nRelated effort: {"id":"b","intentOmitted":true}\nRelated effort: {broken`;
	assert.deepEqual(seenInSection(text), seenOf(rows));
});

type Entry = { id: string; parentId: string | null } & Record<string, unknown>;
function branch(entries: Entry[]) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry: (id: string) => byId.get(id) as never,
	};
}
function chain(...items: Record<string, unknown>[]): Entry[] {
	return items.map((item, index) => ({ id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, ...item }));
}
const message = { type: "message", message: { role: "user", content: "work" } };
const baselineEntry = (rows: EffortPromptRow[]) => ({
	type: "custom",
	customType: EFFORT_BASELINE_ENTRY,
	data: { version: 1, text: section(rows), seen: seenOf(rows) },
});
const updateEntry = (rows: EffortPromptRow[], removed: string[] = []) => ({
	type: "custom_message",
	customType: EFFORT_UPDATE_MESSAGE,
	display: false,
	details: { version: 1, set: seenOf(rows), removed, bytes: 100 },
});

it("derives what the model has from the branch's newest baseline and the updates its context holds", () => {
	const base = [effort("a")];
	assert.equal(branchAwareness(branch(chain(message))), undefined, "a branch without a baseline has none");
	const plain = branchAwareness(branch(chain(baselineEntry(base), message)));
	assert.deepEqual(plain, { text: section(base), seen: seenOf(base), bytes: 0 });
	const updated = branchAwareness(
		branch(chain(baselineEntry(base), message, updateEntry([effort("b")]), message, updateEntry([], ["effort:a"]))),
	);
	assert.deepEqual(updated?.seen, seenOf([effort("b")]));
	assert.equal(updated?.bytes, 200);
	assert.equal(updated?.text, section(base), "updates never change the section text");
	const malformed = { ...updateEntry([effort("z")]), details: { version: 2 } };
	assert.deepEqual(branchAwareness(branch(chain(baselineEntry(base), malformed)))?.seen, seenOf(base));
});

it("drops the changes of updates that a compaction summarized away", () => {
	const base = [effort("a")];
	const entries = chain(baselineEntry(base), updateEntry([effort("b")]), message, updateEntry([effort("c")]), message);
	entries.push({ id: "c1", parentId: "e4", type: "compaction", firstKeptEntryId: "e3", summary: "summary" });
	entries.push({ id: "after", parentId: "c1", ...updateEntry([effort("d")]) });
	const state = branchAwareness(branch(entries));
	assert.deepEqual(state?.seen, seenOf([effort("a"), effort("c"), effort("d")]), "b left the context");
	assert.equal(state?.bytes, 200);
});

it("keeps the current section after a failed read and never makes the failed text a baseline", () => {
	const rows = [effort("a")];
	const current: BranchAwareness = { text: section(rows), seen: seenOf(rows), bytes: 0 };
	assert.deepEqual(ordinaryEffortRun(current, undefined), { section: current.text });
	const failed = ordinaryEffortRun(undefined, undefined);
	assert.equal(failed.section, EFFORT_AWARENESS_UNAVAILABLE);
	assert.equal(failed.baseline, undefined, "the next working read makes the baseline");
	assert.ok(ordinaryEffortRun(undefined, { text: section(rows), rows }).baseline);
});

it("keeps the section between baseline points and replaces it only past the update budget", () => {
	const rows = [effort("a")];
	const prompt = { text: section(rows), rows };
	const first = ordinaryEffortRun(undefined, prompt);
	assert.equal(first.section, prompt.text);
	assert.deepEqual(first.baseline, { version: 1, text: prompt.text, seen: seenOf(rows) });
	assert.equal(first.update, undefined);
	const current: BranchAwareness = { text: prompt.text, seen: seenOf(rows), bytes: 0 };
	assert.deepEqual(ordinaryEffortRun(current, prompt), { section: prompt.text }, "nothing changed");
	const next = [effort("a"), effort("b")];
	const changed = ordinaryEffortRun(current, { text: section(next), rows: next });
	assert.equal(changed.section, prompt.text, "the section keeps its bytes");
	assert.equal(changed.baseline, undefined);
	assert.equal(changed.update?.display, false);
	assert.equal(changed.update?.customType, EFFORT_UPDATE_MESSAGE);
	assert.deepEqual(changed.update?.details.set, seenOf([effort("b")]));
	const spent = ordinaryEffortRun({ ...current, bytes: 16 * 1024 - 10 }, { text: section(next), rows: next });
	assert.equal(spent.section, section(next), "past the budget the section is replaced");
	assert.deepEqual(spent.baseline?.seen, seenOf(next));
	assert.equal(spent.update, undefined);
});
