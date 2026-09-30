import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memory from "./index.ts";
import { memorySearchOutputSchema } from "./search-output.ts";

interface Registered {
	name: string;
	description: string;
	parameters: unknown;
	outputSchema?: unknown;
	promptGuidelines?: string[];
	execute(
		id: string,
		args: unknown,
		signal: AbortSignal,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
		structuredContent?: JsonObject;
	}>;
	renderCall: unknown;
	renderResult: unknown;
}
function tools() {
	const all = new Map<string, Registered>();
	memory({
		registerTool: (tool: Registered) => all.set(tool.name, tool),
		on: () => () => {},
	} as unknown as ExtensionAPI);
	return all;
}
function argumentsFor(tool: Registered, args: JsonObject) {
	return validateToolArguments(tool as unknown as Tool, {
		type: "toolCall",
		id: "test",
		name: tool.name,
		arguments: args,
	});
}
function call(tool: Registered, args: JsonObject, signal = new AbortController().signal) {
	return tool.execute("test", argumentsFor(tool, args), signal);
}
const input = {
	slug: "editor-choice",
	title: "Editor choice",
	tags: ["editor"],
	summary: "Use editor A.",
	details: "A confirmed durable preference.",
	sources: "- Operator statement today.",
	verified: true,
};

test("factory registers only the memory jobs, with native cards and trigger guidance", () => {
	const all = tools();
	assert.deepEqual(
		[...all.keys()],
		["memory_search", "memory_read", "memory_history", "memory_write", "memory_edit", "memory_review", "memory_retire"],
	);
	for (const tool of all.values()) {
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
	}
	assert.equal(all.get("memory_search")?.outputSchema, memorySearchOutputSchema);
	for (const tool of all.values()) {
		if (tool.name !== "memory_search") assert.equal(tool.outputSchema, undefined);
	}
	const searchParameters = JSON.stringify(all.get("memory_search")?.parameters);
	assert.match(searchParameters, /quoted, case-insensitive literal fragments/);
	assert.match(all.get("memory_read")?.description ?? "", /12,000 Unicode code points.*lifecycle/);
	const guidance = [...all.values()].flatMap((tool) => tool.promptGuidelines ?? []).join("\n");
	for (const word of [
		"memo",
		"providers",
		"corrections",
		"Medium confidence",
		"Low confidence",
		"TODOs",
		"never grant",
		"does not require a memory write",
		"only its disputed claim",
		"never reverses supersession",
	])
		assert.ok(guidance.includes(word), word);
});

test("adapter rejects unavailable configuration without an inferred path", async (t) => {
	const old = process.env.PI_MEMORY_DIR;
	t.after(() => {
		if (old === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = old;
	});
	const all = tools();
	for (const value of [undefined, "", "relative"]) {
		if (value === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = value;
		await assert.rejects(call(all.get("memory_search") as Registered, {}), /Memory unavailable/);
		await assert.rejects(call(all.get("memory_read") as Registered, { slug: "README" }), /Memory unavailable/);
		await assert.rejects(call(all.get("memory_write") as Registered, input), /Memory unavailable/);
		await assert.rejects(
			call(all.get("memory_review") as Registered, {
				slug: input.slug,
				expectedDigest: "a".repeat(64),
				outcome: "confirmed",
				sources: "Current source.",
			}),
			/Memory unavailable/,
		);
		await assert.rejects(
			call(all.get("memory_retire") as Registered, {
				slug: input.slug,
				expectedDigest: "a".repeat(64),
				reason: "Withdrawn.",
				sources: "Operator statement.",
			}),
			/Memory unavailable/,
		);
		await assert.rejects(
			call(all.get("memory_edit") as Registered, {
				slug: input.slug,
				expectedDigest: "a".repeat(64),
				verified: false,
				edits: [{ oldText: "old", newText: "new" }],
			}),
			/Memory unavailable/,
		);
	}
});

test("registered jobs round-trip source evidence and serialize concurrent updates", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-adapter-"));
	const old = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = root;
	t.after(() => {
		if (old === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = old;
		rmSync(root, { recursive: true, force: true });
	});
	const all = tools();
	const writer = all.get("memory_write") as Registered;
	const first = await call(writer, input);
	assert.match(first.content[0].text, /Memory updated: editor-choice.md/);
	assert.doesNotMatch(first.content[0].text, /Memory updated: README\.md/);
	for (const query of ["", " ", [""]])
		await assert.rejects(call(all.get("memory_search") as Registered, { query }), /omit query to browse/);
	await assert.rejects(call(all.get("memory_search") as Registered, { query: "editor", limit: 26 }), /limit/);
	const search = await call(all.get("memory_search") as Registered, {
		query: ["editor choice", "durable preference"],
		limit: 3,
	});
	assert.ok(JSON.stringify(search.details).includes("editor-choice"));
	const requests: JsonObject[] = [
		{},
		{ query: "editor" },
		{ query: ["editor choice", "durable preference"] },
		{ query: "absenttoken" },
	];
	for (const args of requests) {
		const page = await call(all.get("memory_search") as Registered, args);
		Value.Assert(memorySearchOutputSchema, page.structuredContent);
		assert.equal(page.structuredContent, page.details);
		assert.deepEqual(page.structuredContent, JSON.parse(page.content[0].text));
		assert.ok(Buffer.byteLength(JSON.stringify(page.structuredContent)) + 1 <= 48 * 1024);
		assert.deepEqual(Object.keys(page).sort(), ["content", "details", "structuredContent"]);
	}
	const structured = search.structuredContent;
	assert.ok(structured);
	Value.Assert(memorySearchOutputSchema, structured);
	for (const invalid of [
		{ ...structured, nextCursor: 17 },
		{ ...structured, privateSource: "not public" },
		{ ...structured, notes: [{ slug: "incomplete" }] },
		{ ...structured, notes: [{ ...(structured.notes as JsonObject[])[0], digest: "not-a-digest" }] },
		{ ...structured, notes: [{ ...(structured.notes as JsonObject[])[0], sourceBuffer: "not public" }] },
	])
		assert.equal(Value.Check(memorySearchOutputSchema, invalid), false);
	await assert.rejects(
		call(all.get("memory_search") as Registered, {}, AbortSignal.abort()),
		/Memory retrieval cancelled/,
	);
	const read = await call(all.get("memory_read") as Registered, {
		slug: input.slug,
		digest: first.details.digest as string,
	});
	assert.ok(JSON.stringify(read.details).includes("Use editor A."));
	const updates = await Promise.allSettled([
		call(writer, { ...input, summary: "Use editor B.", expectedDigest: first.details.digest as string }),
		call(writer, { ...input, summary: "Use editor C.", expectedDigest: first.details.digest as string }),
	]);
	assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(updates.filter((result) => result.status === "rejected").length, 1);
	const current = updates.find((result) => result.status === "fulfilled");
	assert.ok(current?.status === "fulfilled");
	const replacement = await call(writer, {
		...input,
		slug: "new-editor",
		supersedes: [{ slug: input.slug, digest: current.value.details.digest as string }],
	});
	assert.match(replacement.content[0].text, /Memory updated: new-editor.md/);
	assert.match(replacement.content[0].text, /Memory updated: editor-choice.md/);
	assert.match(readFileSync(join(root, "editor-choice.md"), "utf8"), /superseded_by: "new-editor"/);
});

test("schema rejects empty payloads, excess formulations and unbounded pages", () => {
	const all = tools();
	assert.throws(() => call(all.get("memory_write") as Registered, { slug: "empty" }));
	assert.throws(() => call(all.get("memory_search") as Registered, { query: ["a", "b", "c", "d"] }));
	assert.throws(() => call(all.get("memory_search") as Registered, { limit: 513 }));
	assert.throws(() => call(all.get("memory_read") as Registered, { slug: "one", offset: -1 }));
	assert.throws(() => call(all.get("memory_read") as Registered, { slug: "one", digest: "A".repeat(64) }));
	const editor = all.get("memory_edit") as Registered;
	const edit = {
		slug: "one",
		expectedDigest: "a".repeat(64),
		verified: false,
		edits: [{ oldText: "old", newText: "" }],
	};
	for (const args of [
		{ slug: "one", edits: edit.edits },
		{ ...edit, edits: [] },
		{ ...edit, edits: Array.from({ length: 33 }, () => edit.edits[0]) },
		{ ...edit, edits: [{ oldText: "", newText: "new" }] },
		{ ...edit, expectedDigest: "bad" },
	])
		assert.throws(() => call(editor, args));
});

test("lifecycle schemas reject unsupported policies, incomplete plans and unbounded metadata", () => {
	const all = tools();
	const reviewer = all.get("memory_review") as Registered;
	const retire = all.get("memory_retire") as Registered;
	const review = { slug: "one", expectedDigest: "a".repeat(64), outcome: "confirmed", sources: "Source." };
	for (const args of [
		{ ...review, expectedDigest: "bad" },
		{ ...review, outcome: "automatic" },
		{ ...review, sources: "" },
		{ ...review, sources: "s".repeat(1501) },
		{ ...review, reason: "r".repeat(601) },
		{ ...review, reactivate: false },
		{ ...review, reviewPolicy: "monthly" },
		{ ...review, reviewAfter: "tomorrow" },
	])
		assert.throws(() => argumentsFor(reviewer, args));
	const retireCases: JsonObject[] = [
		{ slug: "one", expectedDigest: "a".repeat(64), sources: "Source." },
		{ slug: "one", expectedDigest: "a".repeat(64), reason: "", sources: "Source." },
	];
	for (const args of retireCases) assert.throws(() => argumentsFor(retire, args));
	const planCases: JsonObject[] = [
		{ capturedBefore: "2026-01-01T00:00:00.000Z" },
		{ keepNewest: 1 },
		{ capturedBefore: "2026-01-01", keepNewest: 1 },
		{ capturedBefore: "2026-01-01T00:00:00.000Z", keepNewest: -1 },
		{ capturedBefore: "2026-01-01T00:00:00.000Z", keepNewest: 16385 },
		{ capturedBefore: "2026-01-01T00:00:00.000Z", keepNewest: 0.5 },
	];
	for (const plan of planCases)
		assert.throws(() => argumentsFor(all.get("memory_history") as Registered, { slug: "one", plan }));
	assert.throws(() => argumentsFor(all.get("memory_search") as Registered, { includeRetired: "yes" }));
	const normalized = argumentsFor(all.get("memory_write") as Registered, { ...input, reviewPolicy: null });
	assert.equal(Object.hasOwn(normalized, "reviewPolicy"), false);
	const nullable = argumentsFor(reviewer, { ...review, reviewPolicy: null, reviewAfter: null });
	assert.equal(nullable.reviewPolicy, null);
	assert.equal(nullable.reviewAfter, null);
});

test("review and retirement adapters share receipts, preserve signals, and serialize with writers", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-adapter-"));
	const old = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = root;
	t.after(() => {
		if (old === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = old;
		rmSync(root, { recursive: true, force: true });
	});
	const all = tools();
	const writer = all.get("memory_write") as Registered;
	const reviewer = all.get("memory_review") as Registered;
	const retire = all.get("memory_retire") as Registered;
	const first = await call(writer, { ...input, reviewPolicy: "before-use", reviewAfter: "2000-01-01" });
	const review = {
		slug: input.slug,
		expectedDigest: first.details.digest as string,
		outcome: "unresolved",
		reason: "The current source differs.",
		sources: "Synthetic source comparison.",
	};
	const reviewResults = await Promise.allSettled([
		call(reviewer, review),
		call(all.get("memory_edit") as Registered, {
			slug: input.slug,
			expectedDigest: first.details.digest as string,
			verified: false,
			edits: [{ oldText: "Use editor A.", newText: "Use editor B." }],
		}),
	]);
	assert.equal(reviewResults[0].status, "fulfilled");
	assert.equal(reviewResults[1].status, "rejected");
	assert.ok(reviewResults[0].status === "fulfilled");
	const reviewed = reviewResults[0].value;
	assert.match(reviewed.content[0].text, /^Memory updated: editor-choice.md\n/);
	assert.deepEqual(reviewed.details.written, ["editor-choice.md"]);
	assert.deepEqual(reviewed.details.notWritten, []);
	assert.equal(reviewed.details.initialized, false);
	assert.equal((reviewed.details.captured as unknown[]).length, 1);
	const confirmed = await call(reviewer, {
		slug: input.slug,
		expectedDigest: reviewed.details.digest as string,
		outcome: "confirmed",
		sources: "Complete current source check.",
		reviewPolicy: null,
		reviewAfter: null,
	});
	const current = readFileSync(join(root, `${input.slug}.md`), "utf8");
	assert.match(current, /last_review:/);
	assert.doesNotMatch(current, /review_flag:|review_policy:|review_after:/);
	const retirement = {
		slug: input.slug,
		expectedDigest: confirmed.details.digest as string,
		reason: "The operator withdrew the preference.",
		sources: "Synthetic operator withdrawal.",
	};
	const retireResults = await Promise.allSettled([
		call(retire, retirement),
		call(writer, { ...input, expectedDigest: confirmed.details.digest as string }),
	]);
	assert.equal(retireResults[0].status, "fulfilled");
	assert.equal(retireResults[1].status, "rejected");
	assert.ok(retireResults[0].status === "fulfilled");
	const retired = retireResults[0].value;
	assert.match(retired.content[0].text, /^Memory updated: editor-choice.md\n/);
	assert.deepEqual(retired.details.written, ["editor-choice.md"]);
	assert.equal(retired.details.initialized, false);
	const reactivation = {
		slug: input.slug,
		expectedDigest: retired.details.digest as string,
		outcome: "confirmed",
		sources: "Synthetic restored operator preference.",
		reactivate: true,
	};
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(call(reviewer, reactivation, abort.signal), /abort|cancel/i);
	const restored = await call(reviewer, reactivation);
	await assert.rejects(
		call(retire, { ...retirement, expectedDigest: restored.details.digest as string }, abort.signal),
		/abort|cancel/i,
	);
	assert.match(readFileSync(join(root, `${input.slug}.md`), "utf8"), /status: "active"/);
});

test("edit adapter reports the receipt and notice and shares the write queue", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "memory-edit-adapter-"));
	const old = process.env.PI_MEMORY_DIR;
	process.env.PI_MEMORY_DIR = root;
	t.after(() => {
		if (old === undefined) delete process.env.PI_MEMORY_DIR;
		else process.env.PI_MEMORY_DIR = old;
		rmSync(root, { recursive: true, force: true });
	});
	const all = tools();
	const writer = all.get("memory_write") as Registered;
	const editor = all.get("memory_edit") as Registered;
	const first = await call(writer, input);
	const edit = {
		slug: input.slug,
		expectedDigest: first.details.digest as string,
		verified: false,
		edits: [{ oldText: "Use editor A.", newText: "Use editor B." }],
	};
	const results = await Promise.allSettled([
		call(editor, edit),
		call(writer, { ...input, summary: "Use editor C.", expectedDigest: first.details.digest as string }),
	]);
	assert.equal(results[0].status, "fulfilled");
	assert.equal(results[1].status, "rejected");
	assert.ok(results[0].status === "fulfilled");
	const result = results[0].value;
	assert.match(result.content[0].text, /^Memory updated: editor-choice.md\n/);
	assert.deepEqual(result.details.written, ["editor-choice.md"]);
	assert.deepEqual(result.details.notWritten, []);
	assert.equal(result.details.initialized, false);
	assert.equal(typeof result.details.digest, "string");
	assert.match(readFileSync(join(root, "editor-choice.md"), "utf8"), /Use editor B\./);
	await assert.rejects(call(editor, edit), /digest changed/);
});
