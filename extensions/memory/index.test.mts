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
	assert.deepEqual([...all.keys()], ["memory_search", "memory_read", "memory_write"]);
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
});
