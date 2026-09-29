import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memory from "./index.ts";

interface Registered {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	execute(
		id: string,
		args: unknown,
		signal: AbortSignal,
	): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	renderCall: unknown;
	renderResult: unknown;
}
function tools() {
	const all = new Map<string, Registered>();
	memory({ registerTool: (tool: Registered) => all.set(tool.name, tool) } as unknown as ExtensionAPI);
	return all;
}
function call(tool: Registered, args: JsonObject, signal = new AbortController().signal) {
	const effective = validateToolArguments(tool as unknown as Tool, {
		type: "toolCall",
		id: "test",
		name: tool.name,
		arguments: args,
	});
	return tool.execute("test", effective, signal);
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
	assert.deepEqual([...all.keys()], ["memory_search", "memory_read", "memory_write", "memory_edit"]);
	for (const tool of all.values()) {
		assert.equal(typeof tool.renderCall, "function");
		assert.equal(typeof tool.renderResult, "function");
	}
	const guidance = [...all.values()].flatMap((tool) => tool.promptGuidelines ?? []).join("\n");
	for (const word of [
		"memo",
		"providers",
		"corrections",
		"Medium confidence",
		"Low confidence",
		"TODOs",
		"never grant",
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
