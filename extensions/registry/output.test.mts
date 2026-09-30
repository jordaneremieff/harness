import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { readSnapshot } from "./index.ts";
import { lookup, type LookupRequest, type LookupResult } from "./lookup.ts";
import { boundResult, MAX_RESULT_BYTES, MAX_RESULT_LINES } from "./format.ts";
import { RegistryOutputSchema } from "./output.ts";
import type { HostSnapshot } from "./records.ts";
import type { ModelSnapshot } from "./models.ts";

const sourceInfo = { path: "/fixtures/guide.md", source: "fixture", scope: "temporary" as const, origin: "top-level" as const };
const snapshot = (): HostSnapshot => ({ tools: ["a", "b"].map((name) => ({ name, sourceInfo, exposure: "direct",
	parameters: Type.Object({ path: Type.String() }), promptGuidelines: ["Read the source."] })), activeTools: ["a"], callableTools: ["b"],
	commands: [{ name: "guide", source: "prompt", sourceInfo }], observation: null,
	availability: { tools: true, activeTools: true, callableTools: true, commands: true }, at: 1000 });
const models: ModelSnapshot = { catalogAvailable: true, availableSnapshot: true, catalogError: false, scopeConfigured: false, scopeOrder: null,
	records: [{ kind: "model", name: "fixture/a", provider: "fixture", id: "a", displayName: "A", catalog: true, selected: true,
		reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, supportedThinkingLevels: ["off", "high"],
		available: true, configuredAuth: false, extensionProvider: false, inScope: true, evidence: "registration", at: 1000 }] };
const run = (params: LookupRequest["params"], overrides: Partial<LookupRequest> = {}) =>
	lookup({ params, snapshot: snapshot(), models, session: {}, epoch: "fixture", ...overrides });
function validate(result: LookupResult) {
	assert.ok(Check(RegistryOutputSchema, result.structuredContent), JSON.stringify([...Errors(RegistryOutputSchema, result.structuredContent)]));
	assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(result.details)));
	const envelope = { content: [{ type: "text", text: result.text }], details: result.details, structuredContent: result.structuredContent };
	assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= MAX_RESULT_BYTES);
	assert.ok(JSON.stringify(envelope, null, 2).replace(/\\n/g, "\n").split("\n").length <= MAX_RESULT_LINES);
	return result;
}

describe("native structured registry output", () => {
	it("validates all outcomes, source kinds, coverage and continuations", async () => {
		const outcomes = new Set<string>();
		const check = (result: LookupResult) => { validate(result); outcomes.add(result.outcome); return result; };
		for (const params of [{}, { kind: "tool" }, { kind: "tool", name: "a", detail: true }, { kind: "model" },
			{ kind: "model", health: true }, { kind: "prompt" }, { kind: "context_file" }, { name: "absent" }, { kind: "invalid" }]) check(await run(params));
		const page = check(await run({ kind: "tool", limit: 1 }));
		check(await run({ cursor: page.details.cursor as string }));
		check(await run({ cursor: page.details.cursor as string }, { epoch: "different" }));
		check(await run({}, { signal: AbortSignal.abort() }));
		const unavailable = snapshot(); unavailable.availability.commands = false;
		check(await run({ search: "a" }, { snapshot: unavailable }));
		const observed = snapshot();
		observed.observation = { observedAt: 1, cwd: "/fixtures", skills: [], selectedTools: [], contextFilePaths: ["/fixtures/AGENTS.md"],
			customPromptPresent: false, forcedSystemPromptPresent: false, appendSystemPromptPresent: false, recordCount: 1, bytes: 100,
			overflowRecords: false, overflowBytes: false };
		check(await run({ kind: "context_file" }, { snapshot: observed }));
		observed.observation.overflowRecords = true;
		check(await run({ kind: "context_file" }, { snapshot: observed }));
		const ambiguous = snapshot(); ambiguous.commands.push({ name: "guide", source: "skill", sourceInfo });
		check(await run({ name: "guide", contains: "read" }, { snapshot: ambiguous }));
		for (const outcome of ["ok", "partial", "io_error", "unavailable", "cancelled"] as const) {
			check(await run({ name: "guide", contains: "read" }, { scan: async () => ({ outcome, matches: [{ line: 2, text: "read this" }],
				bytesRead: 20, fileSize: 40, truncated: outcome === "partial", frontmatter: { state: outcome === "unavailable" ? "invalid" : "valid" },
				disableModelInvocation: false, error: outcome === "io_error" ? "read failed" : undefined }) }));
		}
		assert.deepEqual([...outcomes].sort(), ["ambiguous", "cancelled", "host_summary", "invalid_arguments", "io_error", "missing", "ok", "partial", "stale_cursor", "unavailable"]);
	});
	it("counts both structured copies before dropping whole records and advancing", async () => {
		const large = snapshot();
		large.tools = Array.from({ length: 30 }, (_, i) => ({ name: `tool-${String(i).padStart(2, "0")}`, sourceInfo, description: "漢".repeat(800) }));
		const first = validate(await run({ kind: "tool", limit: 100 }, { snapshot: large }));
		assert.equal(first.details.resultBounded, true);
		assert.ok(Number(first.details.returnedRecords) > 0);
		const next = validate(await run({ cursor: first.details.cursor as string }, { snapshot: large }));
		assert.equal(next.details.offset, first.details.returnedRecords);
		large.tools[0].description = "x".repeat(50000);
		const blocked = validate(await run({ kind: "tool" }, { snapshot: large }));
		assert.equal(blocked.details.pageBlocked, true);
		assert.equal(blocked.details.cursor, undefined);
		const outer = boundResult({ header: ["registry outcome=unavailable"], blocks: [], footer: [],
			details: { outcome: "unavailable", reason: "x".repeat(50000) } });
		validate({ ...outer, outcome: "unavailable" });
		assert.equal(outer.details.omittedDetails, true);
		assert.deepEqual(outer.structuredContent.records, []);
		const hugeSource = snapshot(); hugeSource.tools[0].parameters = Type.Object({ payload: Type.String({ description: "x".repeat(50000) }) });
		const detail = validate(await run({ kind: "tool", name: "a", detail: true }, { snapshot: hugeSource }));
		assert.equal(detail.details.pageBlocked, true);
		const manyLines = snapshot(); manyLines.tools[0].promptGuidelines = Array.from({ length: 1100 }, () => "x");
		const lineBound = validate(await run({ kind: "tool", name: "a", detail: true }, { snapshot: manyLines }));
		assert.equal(lineBound.details.pageBlocked, true);
	});
	it("retains exposure metadata and samples callable membership independently", async () => {
		const metadata = { name: "a", description: "a", parameters: Type.Object({}), sourceInfo, exposure: "hidden" as const,
			namespace: { name: "fixture", description: "group" }, annotations: { readOnlyHint: true, openWorldHint: false } };
		const pi = { getAllTools: () => [metadata], getActiveTools: () => ["a"], getCommands: () => [] } as unknown as ExtensionAPI;
		const ctx = { tools: [] } as Pick<ExtensionToolContext, "tools">;
		const host = readSnapshot(pi, null, 1, ctx);
		metadata.namespace.name = "changed"; metadata.annotations.readOnlyHint = false;
		const result = validate(await run({ kind: "tool" }, { snapshot: host }));
		const record = (result.details.records as Record<string, unknown>[])[0];
		assert.equal(record.active, true);
		assert.equal(record.callable, false);
		assert.equal(record.modelDeclared, null);
		assert.equal(record.exposure, "hidden");
		assert.deepEqual(record.namespace, { name: "fixture", description: "group" });
		assert.deepEqual(record.annotations, { readOnlyHint: true, openWorldHint: false });
		assert.equal(record.outputSchema, undefined);
		Object.defineProperty(ctx, "tools", { get: () => { throw new Error("unavailable"); } });
		const failed = validate(await run({ kind: "tool" }, { snapshot: readSnapshot(pi, null, 1, ctx) }));
		assert.equal((failed.details.records as Record<string, unknown>[])[0].callable, undefined);
		assert.equal((failed.details.availability as Record<string, unknown>).callableTools, false);
	});
	it("invalidates cursors for changed callable membership and exposure metadata", async () => {
		const first = await run({ kind: "tool", limit: 1 });
		for (const field of ["callable", "exposure", "namespace", "annotations"] as const) {
			const host = snapshot();
			if (field === "callable") host.callableTools = ["a"];
			if (field === "exposure") host.tools[0].exposure = "deferred";
			if (field === "namespace") host.tools[0].namespace = { name: "new" };
			if (field === "annotations") host.tools[0].annotations = { destructiveHint: true };
			assert.equal(validate(await run({ cursor: first.details.cursor as string }, { snapshot: host })).outcome, "stale_cursor");
		}
	});
});
