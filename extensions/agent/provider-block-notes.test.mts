import assert from "node:assert/strict";
import { it } from "node:test";
import type { ProviderBlockFact } from "./provider-block-facts.ts";
import {
	appendProviderBlockReceipt,
	outcomeProvider,
	PROVIDER_BLOCK_NOTE_AGE_MS,
	PROVIDER_BLOCK_NOTE_LIMIT,
	PROVIDER_BLOCK_NOTES_KEY,
	PROVIDER_BLOCK_SECTION_BYTES,
	ProviderBlockNotes,
	processProviderBlockNotes,
	providerBlockReceiptText,
	renderProviderBlockSection,
} from "./provider-block-notes.ts";

const NOW = Date.parse("2026-11-14T03:00:00.000Z");

function block(provider: string, modelId: string, timestamp: number, error = "429: weekly usage limit reached", extra: Partial<ProviderBlockFact> = {}): ProviderBlockFact {
	return {
		blockId: `block-${provider}-${timestamp}`,
		conversationId: 1,
		providerSessionId: "provider-session",
		epoch: 0,
		model: { provider, modelId },
		error,
		errorRedacted: false,
		errorTruncated: false,
		source: "provider",
		timestamp,
		originalResults: [{ sessionId: `agent-${provider}`, submissionId: 3 }],
		omittedOriginalResults: 0,
		...extra,
	};
}

it("records the provider block of a delivered result and ignores other details", () => {
	const notes = new ProviderBlockNotes();
	assert.equal(notes.observe(undefined), false);
	assert.equal(notes.observe({ status: "done" }), false);
	assert.equal(notes.observe({ providerBlock: { blockId: "x" } }), false, "an invalid fact is not recorded");
	assert.equal(notes.observe({ providerBlock: block("alpha", "a-1", NOW - 60_000) }), true);
	assert.deepEqual(notes.current(NOW), [{ provider: "alpha", modelId: "a-1", timestamp: NOW - 60_000, evidence: "429: weekly usage limit reached", conversationId: "agent-alpha" }]);
});

it("keeps the newest block per provider, bounds the providers and drops old notes", () => {
	const notes = new ProviderBlockNotes();
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 120_000, "older") });
	notes.observe({ providerBlock: block("alpha", "a-2", NOW - 60_000, "newer") });
	assert.equal(notes.observe({ providerBlock: block("alpha", "a-1", NOW - 90_000, "late older") }), false);
	assert.equal(notes.forProvider("alpha", NOW)?.evidence, "newer");
	for (let index = 0; index < PROVIDER_BLOCK_NOTE_LIMIT + 2; index++) notes.observe({ providerBlock: block(`p${index}`, "m", NOW - 1000 + index) });
	assert.equal(notes.current(NOW).length, PROVIDER_BLOCK_NOTE_LIMIT);
	assert.equal(notes.forProvider("alpha", NOW), undefined, "the oldest recorded provider leaves first");
	const aged = new ProviderBlockNotes();
	aged.observe({ providerBlock: block("beta", "b", NOW - PROVIDER_BLOCK_NOTE_AGE_MS - 1) });
	assert.deepEqual(aged.current(NOW), []);
	assert.equal(renderProviderBlockSection(aged, NOW), undefined, "no section without a current note");
});

it("renders past evidence with its time, model and provider text, without control characters", () => {
	const notes = new ProviderBlockNotes();
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 3 * 60 * 60_000, "429:\u001b[31m {\"message\":\"Weekly limit exhausted\"}\n", { errorRedacted: true, errorTruncated: true }) });
	notes.observe({ providerBlock: block("beta", "b-1", NOW - 5 * 60_000) });
	const section = renderProviderBlockSection(notes, NOW);
	assert.ok(section);
	const lines = section.split("\n");
	assert.match(lines[0], /past evidence .* not current provider state/);
	assert.equal(lines[1], "- beta/b-1 at 2026-11-14T02:55:00.000Z, agent agent-beta: 429: weekly usage limit reached");
	assert.equal(lines[2], "- alpha/a-1 at 2026-11-14T00:00:00.000Z, agent agent-alpha: 429: [31m {\"message\":\"Weekly limit exhausted\"} [credential redacted] [truncated]");
	assert.match(lines[3], /nothing substitutes automatically/);
	assert.ok(!section.includes("\u001b"));
});

it("names an earlier refusal in a receipt only for the selected provider", () => {
	const notes = new ProviderBlockNotes();
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 60_000) });
	assert.equal(providerBlockReceiptText(notes, "beta", NOW), undefined);
	assert.equal(
		providerBlockReceiptText(notes, "alpha", NOW),
		"Earlier provider refusal for the selected provider, past evidence and not current state: alpha/a-1 at 2026-11-14T02:59:00.000Z (1 min ago), agent agent-alpha: 429: weekly usage limit reached",
	);
});

it("reads the agent provider from a spawn or configure outcome's compact status", () => {
	assert.equal(outcomeProvider({ sessionId: "s", status: { agent: { model: { provider: "alpha", modelId: "a-1" }, thinkingLevel: "high" } } }), "alpha");
	assert.equal(outcomeProvider({ sessionId: "s", snapshotError: "unavailable" }), undefined);
	assert.equal(outcomeProvider(null), undefined);
	assert.equal(outcomeProvider({ status: { agent: { model: { provider: "" } } } }), undefined);
});

it("adds the receipt sentence only to model-choice tools whose outcome names a noted provider", () => {
	const notes = new ProviderBlockNotes();
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 60_000) });
	const outcome = { sessionId: "s", status: { agent: { model: { provider: "alpha", modelId: "a-2" } } } };
	const spawned: Array<{ type: string; text?: string }> = [{ type: "text", text: "{}" }];
	appendProviderBlockReceipt("agent_spawn", spawned, outcome, notes, NOW);
	assert.equal(spawned.length, 2);
	assert.match(String(spawned[1].text), /^Earlier provider refusal for the selected provider/);
	const status: Array<{ type: string }> = [{ type: "text" }];
	appendProviderBlockReceipt("agent_status", status, outcome, notes, NOW);
	assert.equal(status.length, 1, "observation tools carry no receipt sentence");
	const other: Array<{ type: string }> = [{ type: "text" }];
	appendProviderBlockReceipt("agent_configure", other, { status: { agent: { model: { provider: "beta", modelId: "b" } } } }, notes, NOW);
	assert.equal(other.length, 1, "another provider gets no sentence");
});

it("keeps the section bytes unchanged across turns until a note arrives or ages out", () => {
	const notes = new ProviderBlockNotes();
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 60_000) });
	const first = renderProviderBlockSection(notes, NOW);
	assert.equal(renderProviderBlockSection(notes, NOW + 6 * 60 * 60_000), first, "a later turn renders identical bytes");
	notes.observe({ providerBlock: block("alpha", "a-1", NOW - 60_000) });
	assert.equal(renderProviderBlockSection(notes, NOW + 60_000), first, "a repeated block changes nothing");
	notes.observe({ providerBlock: block("beta", "b-1", NOW) });
	assert.notEqual(renderProviderBlockSection(notes, NOW + 60_000), first, "a new block changes the section");
	assert.equal(renderProviderBlockSection(notes, NOW + PROVIDER_BLOCK_NOTE_AGE_MS + 120_000), undefined, "the section leaves when its notes age out");
});

it("bounds the section in bytes and says how many older notes it omits", () => {
	const notes = new ProviderBlockNotes();
	const wide = "\u{1F600}".repeat(400);
	for (let index = 0; index < PROVIDER_BLOCK_NOTE_LIMIT; index++)
		notes.observe({ providerBlock: block(`${"p".repeat(60)}${index}`, "m".repeat(200), NOW - 1000 + index, wide) });
	const section = renderProviderBlockSection(notes, NOW);
	assert.ok(section);
	assert.ok(Buffer.byteLength(section) <= PROVIDER_BLOCK_SECTION_BYTES, `section is ${Buffer.byteLength(section)} bytes`);
	const shown = section.split("\n").filter((text) => text.startsWith("- ")).length;
	assert.ok(shown >= 1 && shown < PROVIDER_BLOCK_NOTE_LIMIT);
	assert.match(section, new RegExp(`${PROVIDER_BLOCK_NOTE_LIMIT - shown} older notes? (is|are) omitted by the size bound`));
});

it("shares one process-wide store between callers and ignores entries of another shape", () => {
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	const previous = globals[PROVIDER_BLOCK_NOTES_KEY];
	try {
		delete globals[PROVIDER_BLOCK_NOTES_KEY];
		assert.equal(processProviderBlockNotes().observeBlock(block("alpha", "a-1", NOW - 60_000)), true);
		assert.equal(processProviderBlockNotes().forProvider("alpha", NOW)?.modelId, "a-1", "a second caller reads the same notes");
		const store = globals[PROVIDER_BLOCK_NOTES_KEY] as { notes: Map<string, unknown> };
		store.notes.set("beta", { provider: "beta", timestamp: "not a number" });
		assert.deepEqual(processProviderBlockNotes().current(NOW).map((note) => note.provider), ["alpha"], "a malformed entry is ignored");
		assert.equal(processProviderBlockNotes().observeBlock({ blockId: "x" }), false);
		store.notes.set("delta", { provider: "delta", modelId: "d", timestamp: 9e15, evidence: "e", conversationId: "c" });
		assert.equal(renderProviderBlockSection(processProviderBlockNotes(), NOW)?.includes("delta"), false, "a time outside the Date range is ignored");
		globals[PROVIDER_BLOCK_NOTES_KEY] = null;
		assert.deepEqual(processProviderBlockNotes().current(NOW), [], "a null value is not used");
		assert.equal(globals[PROVIDER_BLOCK_NOTES_KEY], null, "and stays in place");
		globals[PROVIDER_BLOCK_NOTES_KEY] = { version: 2, notes: "other" };
		const local = processProviderBlockNotes();
		assert.equal(local.observeBlock(block("gamma", "g", NOW)), true);
		assert.deepEqual(globals[PROVIDER_BLOCK_NOTES_KEY], { version: 2, notes: "other" }, "a value of another shape stays in place");
		assert.deepEqual(processProviderBlockNotes().current(NOW), [], "another caller does not see that caller's local notes");
	} finally {
		if (previous === undefined) delete globals[PROVIDER_BLOCK_NOTES_KEY];
		else globals[PROVIDER_BLOCK_NOTES_KEY] = previous;
	}
});
