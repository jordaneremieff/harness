import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { readSnapshot } from "./index.ts";
import { lookup, type LookupResult } from "./lookup.ts";
import { MAX_RESULT_BYTES } from "./format.ts";
import { RegistryOutputSchema } from "./output.ts";

type Namespace = NonNullable<ToolInfo["namespace"]>;

const GUIDANCE = "Call lookup-doc with one topic string.";
const sourceInfo = { path: "mcp:fixture", source: "mcp", scope: "temporary" as const, origin: "top-level" as const };
const guidance = (repeat: number): string => `Docs server. ${`${GUIDANCE} `.repeat(repeat)}`;
const namespaceWith = (instructions?: string): Namespace => ({ name: "mcp__docs", description: "Search the docs", ...(instructions === undefined ? {} : { instructions }) });

function piWith(namespace: ToolInfo["namespace"]): ExtensionAPI {
	const tools: ToolInfo[] = ["lookup_doc", "list_topics", "search_docs"].map((name) => ({
		name: `mcp__docs__${name}`, description: `Fixture ${name}`, parameters: Type.Object({}), sourceInfo, exposure: "deferred" as const,
		...(namespace === undefined ? {} : { namespace }),
	}));
	return { getAllTools: () => tools, getActiveTools: () => [], getCommands: () => [] } as unknown as ExtensionAPI;
}

const run = (namespace: ToolInfo["namespace"], params: Parameters<typeof lookup>[0]["params"]) =>
	lookup({ params, snapshot: readSnapshot(piWith(namespace), null, 1000), session: {}, epoch: "fixture" });

function validate(result: LookupResult): LookupResult {
	assert.ok(Check(RegistryOutputSchema, result.structuredContent), JSON.stringify([...Errors(RegistryOutputSchema, result.structuredContent)]));
	const envelope = { content: [{ type: "text", text: result.text }], details: result.details, structuredContent: result.structuredContent };
	assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_RESULT_BYTES);
	assert.ok(!result.text.includes(GUIDANCE));
	assert.ok(!JSON.stringify(result.structuredContent).includes(GUIDANCE));
	assert.equal(result.details.pageBlocked, undefined);
	return result;
}

const records = (result: LookupResult) => result.details.records as Array<{ name: string; namespace?: Record<string, unknown> }>;

describe("tool namespace instructions", () => {
	const queries = [
		{ kind: "tool", search: "mcp__docs", match: "substring" },
		{ kind: "tool", name: "mcp__docs__lookup_doc", detail: true },
		{ kind: "tool", name: "mcp__docs__lookup_doc" },
	] as const;

	it("keeps records schema-valid and omits the text, flagging that longer guidance exists", async () => {
		for (const query of queries) {
			const result = validate(await run(namespaceWith(guidance(40)), query));
			assert.equal(result.outcome, "ok");
			assert.ok(records(result).length > 0);
			for (const record of records(result)) {
				assert.deepEqual(record.namespace, { name: "mcp__docs", description: "Search the docs", instructionsOmitted: true });
			}
			assert.match(result.text, /instructionsOmitted/);
			assert.match(result.text, /describeNamespace\(name\)/);
		}
	});

	it("produces the same result for one line of instructions and for text far past the result bound", async () => {
		const huge = guidance(Math.ceil((4 * MAX_RESULT_BYTES) / GUIDANCE.length));
		assert.ok(huge.length > 4 * MAX_RESULT_BYTES);
		for (const query of queries) {
			const short = validate(await run(namespaceWith(guidance(1)), query));
			const long = validate(await run(namespaceWith(huge), query));
			assert.equal(long.text, short.text);
			assert.deepEqual(long.details, short.details);
		}
	});

	it("reports no omission and no pointer when Pi supplied no non-empty instructions", async () => {
		for (const namespace of [namespaceWith(), namespaceWith(""), { name: "mcp__docs" }]) {
			const result = validate(await run(namespace, queries[0]));
			for (const record of records(result)) assert.equal(record.namespace?.instructionsOmitted, undefined);
			assert.doesNotMatch(result.text, /instructionsOmitted|describeNamespace/);
		}
		const bare = validate(await run(undefined, queries[0]));
		for (const record of records(bare)) assert.equal(record.namespace, undefined);
		assert.doesNotMatch(bare.text, /describeNamespace/);
	});

	it("copies only the namespace fields it names and retains no instruction text", () => {
		const future = { ...namespaceWith(guidance(40)), futureGuidance: "Not part of the projection." } as Namespace;
		const host = readSnapshot(piWith(future), null, 1000);
		assert.ok(host.tools.length > 0);
		for (const tool of host.tools) assert.deepEqual(tool.namespace, { name: "mcp__docs", description: "Search the docs", instructionsOmitted: true });
		const serialized = JSON.stringify(host);
		assert.ok(!serialized.includes(GUIDANCE));
		assert.ok(!serialized.includes("futureGuidance"));
	});

	it("invalidates a cursor when instructions appear or disappear, not when only their text changes", async () => {
		const query = { kind: "tool", search: "mcp__docs", match: "substring", limit: 1 } as const;
		const first = validate(await run(namespaceWith(guidance(3)), query));
		const cursor = first.details.cursor as string;
		assert.ok(cursor);
		const resumed = validate(await run(namespaceWith(`${guidance(9)} Edited.`), { cursor }));
		assert.equal(resumed.outcome, "ok");
		assert.equal(resumed.details.offset, 1);
		for (const changed of [namespaceWith(), namespaceWith("")]) {
			assert.equal(validate(await run(changed, { cursor })).outcome, "stale_cursor");
		}
		const plain = validate(await run(namespaceWith(), query));
		assert.equal(validate(await run(namespaceWith(guidance(3)), { cursor: plain.details.cursor as string })).outcome, "stale_cursor");
	});
});
