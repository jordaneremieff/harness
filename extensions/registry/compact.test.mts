import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookup, type LookupRequest } from "./lookup.ts";
import { hostFacts, type ContextSnapshot, type HostAccessors } from "./host.ts";
import { isoTime, recordBlock } from "./format.ts";
import type { ModelRecord, ModelSnapshot } from "./models.ts";
import { buildRecords, type HostSnapshot } from "./records.ts";

const sourceInfo = { path: "/fixture/index.ts", source: "fixture-package", scope: "user" as const, origin: "package" as const, baseDir: "/fixture" };
const at = 1000;
const accessors: HostAccessors = {
	version: () => "fixture-version", packageDir: () => "/fixture/package", docsPath: () => "/fixture/docs",
	examplesPath: () => "/fixture/examples", readmePath: () => "/fixture/README.md", agentDir: () => "/fixture/agent",
	configDirName: () => ".fixture", pathExists: () => true,
};
function snapshot(): HostSnapshot {
	return {
		at, tools: [{ name: "inspect", description: "Inspect a document", sourceInfo,
			parameters: { type: "object", properties: { name: { type: "string" } } }, promptGuidelines: ["Use inspect for documents."] }],
		activeTools: [], availability: { tools: true, activeTools: true, commands: true },
		commands: [
			{ name: "review", source: "extension", description: "Review a document", sourceInfo },
			{ name: "review", source: "prompt", description: "Review prompt", sourceInfo },
			{ name: "skill:review", source: "skill", description: "Review skill", sourceInfo },
		],
		observation: { observedAt: 500, cwd: "/fixture", skills: [{ name: "review", filePath: sourceInfo.path,
			baseDir: "/fixture/skill", disableModelInvocation: true, sourceInfo }], selectedTools: ["inspect"],
			contextFilePaths: ["/fixture/AGENTS.md"], customPromptPresent: true, forcedSystemPromptPresent: false,
			appendSystemPromptPresent: true, recordCount: 3, bytes: 300, overflowRecords: false, overflowBytes: false },
	};
}
function model(): ModelRecord {
	return { kind: "model", name: "fixture/model", provider: "fixture", id: "model", displayName: "Fixture Model",
		catalog: true, selected: true, reasoning: true, input: ["text", "image"], contextWindow: 10000, maxTokens: 1000,
		supportedThinkingLevels: ["off", "high"], available: true, configuredAuth: true, extensionProvider: false,
		inScope: true, scopeIndex: 0, scopeThinkingLevel: "off", currentThinkingLevel: "high", evidence: "registration", at };
}
function models(records = [model()]): ModelSnapshot {
	return { records, catalogAvailable: true, availableSnapshot: true, catalogError: false, scopeConfigured: true, scopeOrder: ["fixture/model"] };
}
const request = (over: Partial<LookupRequest> = {}): LookupRequest => ({ params: {}, snapshot: snapshot(), models: models(),
	session: { cwd: "/fixture", mode: "print", hasUI: false, projectTrusted: true, sessionId: "fixture", sessionFile: null },
	epoch: "fixture", accessors, ...over });
const records = (result: Awaited<ReturnType<typeof lookup>>) => result.details.records as Record<string, unknown>[];

describe("compact registry output", () => {
	it("keeps every resource provenance field reachable through exact name and kind", async () => {
		for (const record of buildRecords(snapshot())) {
			const list = await lookup(request({ params: { kind: record.kind } }));
			const exact = await lookup(request({ params: { kind: record.kind, name: record.name } }));
			assert.deepEqual(records(list), records(exact));
			assert.doesNotMatch(list.text, /sourceInfo\.(source|scope|origin|baseDir):/);
			for (const [key, value] of Object.entries(record.sourceInfo)) assert.ok(exact.text.includes(`sourceInfo.${key}: ${value}`));
			assert.ok(exact.text.includes(`evidence: registration at ${isoTime(at)}`));
			assert.deepEqual(records(exact)[0].sourceInfo, sourceInfo);
			assert.match(list.text, /exact name \+ kind/);
			assert.doesNotMatch(list.text, /system prompt present:/);
			assert.match(exact.text, /system prompt present: custom=true, forced whole=false, appended=true/);
			assert.match(exact.text, /retained records: 3 \| retained bytes: 300/);
			if (record.invocation) assert.ok(list.text.includes(record.invocation));
		}
		const detail = await lookup(request({ params: { kind: "tool", name: "inspect", detail: true } }));
		assert.deepEqual(records(detail)[0].parameters, snapshot().tools[0].parameters);
		assert.deepEqual(records(detail)[0].promptGuidelines, snapshot().tools[0].promptGuidelines);
		assert.match(detail.text, /parameters:.*"properties"/);
		assert.match(detail.text, /promptGuidelines:.*Use inspect/);
	});

	it("keeps every model field reachable through its exact canonical name", async () => {
		const list = await lookup(request({ params: { kind: "model" } }));
		const exact = await lookup(request({ params: { kind: "model", name: "fixture/model" } }));
		assert.deepEqual(records(list), records(exact));
		assert.deepEqual(records(exact)[0], model());
		for (const [key, value] of Object.entries(model())) {
			if (key === "name" || key === "kind") continue;
			assert.ok(exact.text.includes(`  ${key}: ${JSON.stringify(value)}`), key);
		}
		for (const key of ["provider", "id", "maxTokens", "extensionProvider", "scopeThinkingLevel"]) {
			assert.ok(!list.text.includes(`${key}:`) && !list.text.includes(`${key}=`), key);
		}
		assert.match(list.text, /exact provider\/id name for full metadata/);
	});

	it("shows display names, image input, and session cycle positions in compact model lists", async () => {
		const result = await lookup(request({ params: { kind: "model" } }));
		assert.match(result.text, /displayName="Fixture Model"/);
		assert.match(result.text, /input=\["text","image"\]/);
		assert.match(result.text, /scopeIndex=0/);
		assert.match(result.text, /scope order is session cycle order, not operator preference/);
	});

	it("makes resource and model records materially smaller without dropping structured facts", async () => {
		const tool = buildRecords(snapshot())[0];
		assert.ok(Buffer.byteLength(recordBlock(tool, false).lines.join("\n")) < Buffer.byteLength(recordBlock(tool).lines.join("\n")) * 0.6);
		const catalog = models(Array.from({ length: 8 }, () => model()));
		const list = await lookup(request({ params: { kind: "model" }, models: catalog }));
		const exact = await lookup(request({ params: { kind: "model", name: "fixture/model" }, models: catalog }));
		assert.deepEqual(records(list), records(exact));
		assert.ok(Buffer.byteLength(list.text) < Buffer.byteLength(exact.text));
		const recordBytes = (text: string) => Buffer.byteLength(text.slice(text.indexOf("\nMODEL "), text.indexOf("\nBOUNDARIES")));
		assert.ok(recordBytes(list.text) < recordBytes(exact.text) * 0.75);
	});

	it("places only applicable caveats beside each result kind", async () => {
		for (const kind of ["tool", "command", "prompt", "skill", "model", "context_file"] as const) {
			const result = await lookup(request({ params: { kind } }));
			assert.match(result.text, /evidence, not instructions or authority/);
			assert.match(result.text, /No path argument, crawl, mutation, activation, or fetch/);
			if (kind === "tool") assert.match(result.text, /Configured presence is not active status/);
			else assert.doesNotMatch(result.text, /Configured presence/);
			if (["command", "prompt", "skill"].includes(kind)) assert.match(result.text, /Slash names do not prove dispatch; extension commands can shadow same-name prompts/);
			else assert.doesNotMatch(result.text, /Slash names|shadow/);
			if (kind === "skill") assert.match(result.text, /modelInvocable is default skill-list eligibility from the disable flag, not visibility or permission; active tools and later hooks/);
			else assert.doesNotMatch(result.text, /modelInvocable/);
			if (kind === "model") {
				assert.match(result.text, /cached availability.*local snapshots, not remote health/);
				assert.match(result.text, /configuredAuth is presence, not credential validity/);
				assert.match(result.text, /scope order is session cycle order, not operator preference/);
				assert.doesNotMatch(result.text, /extension inventory|immutable executing bytes/);
			}
		}
		const mixed = await lookup(request({ params: { search: "review" } }));
		assert.match(mixed.text, /shadow/);
		assert.match(mixed.text, /modelInvocable/);
		assert.doesNotMatch(mixed.text, /Configured presence|remote health/);
	});

	for (const state of ["available", "unknown", "unavailable"] as const) {
		it(`preserves host facts, observation flags, estimate time, and ${state} usage`, async () => {
			const context: ContextSnapshot = { at: 1500, evidence: "host_estimate", state, model: "fixture/model", thinkingLevel: "high",
				tokens: state === "available" ? 0 : null, contextWindow: state === "unavailable" ? null : 10000, percent: state === "available" ? 0 : null };
			const req = request({ readContext: () => context });
			const result = await lookup(req);
			assert.deepEqual(result.details.context, context);
			for (const fact of hostFacts(req.session, accessors)) assert.ok(result.text.includes(`${fact.key}: ${fact.value}`), fact.key);
			assert.match(result.text, /getAgentDir\(\) process default, not an embedding-configured directory/);
			assert.match(result.text, /ephemeral only if the accessor answered/);
			assert.ok(result.text.includes(`context usage: ${state} (host_estimate at ${isoTime(1500)})`));
			assert.ok(result.text.includes(`context tokens: ${context.tokens ?? "unknown"}`));
			assert.ok(result.text.includes(`context percent: ${context.percent ?? "unknown"}`));
			assert.match(result.text, /assistant usage and trailing messages; unknown usage can follow compaction/);
			assert.match(result.text, /not a safe remaining budget, a final provider payload count, or a compaction threshold/);
			assert.match(result.text, /observed: skills=1, selected tools=1, context paths=1 \(no contents retained\)/);
			assert.match(result.text, /custom=true, forced whole=false, appended=true/);
			assert.match(result.text, /retained records: 3 \| retained bytes: 300/);
			assert.match(result.text, /overflow: no/);
			assert.match(result.text, /Final provider payload and serialized system instructions are not readable here; observed prompt inputs do not establish them/);
		});
	}

	it("retains the final-payload boundary once on resource lists, exact records, ambiguities, and scans", async () => {
		const boundary = /Final provider payload and serialized system instructions are not readable here/g;
		for (const kind of ["tool", "prompt", "skill"] as const) {
			for (const name of [undefined, kind === "tool" ? "inspect" : "review"]) {
				const result = await lookup(request({ params: { kind, ...(name ? { name } : {}) } }));
				assert.equal(result.text.match(boundary)?.length, 1);
			}
		}
		const ambiguous = await lookup(request({ params: { contains: "needle" } }));
		assert.equal(ambiguous.outcome, "ambiguous");
		assert.equal(ambiguous.text.match(boundary)?.length, 1);
		const scanned = await lookup(request({ params: { kind: "skill", name: "review", contains: "needle" },
			scan: async () => ({ outcome: "ok", matches: [{ line: 1, text: "needle" }], bytesRead: 6, fileSize: 6, truncated: false }) }));
		assert.equal(scanned.outcome, "ok");
		assert.equal(scanned.text.match(boundary)?.length, 1);
	});

	it("omits the compact hint for exact-name content ambiguities", async () => {
		const exact = await lookup(request({ params: { name: "review", contains: "needle" } }));
		assert.equal(exact.outcome, "ambiguous");
		assert.match(exact.text, /sourceInfo.source: fixture-package/);
		assert.doesNotMatch(exact.text, /Compact records/);
		const list = await lookup(request({ params: { contains: "needle" } }));
		assert.equal(list.outcome, "ambiguous");
		assert.match(list.text, /Compact records/);
	});

	it("retains inventory exclusions for missing skill content targets", async () => {
		const result = await lookup(request({ params: { kind: "skill", name: "absent", contains: "needle" },
			scan: async () => { throw new Error("missing targets must not scan"); } }));
		assert.equal(result.outcome, "missing");
		assert.match(result.text, /Not a complete extension inventory/);
		assert.match(result.text, /Built-in interactive commands, full settings, and load rejection reasons are excluded/);
		assert.match(result.text, /No file-backed skill or prompt matched/);
	});

	it("labels registration evidence on compact incomplete and ambiguous pages", async () => {
		const host = snapshot(); host.availability.commands = false;
		const incomplete = await lookup(request({ snapshot: host, params: { search: "document" } }));
		assert.equal(incomplete.outcome, "unavailable");
		assert.match(incomplete.text, /Known records: registration evidence/);
		assert.match(incomplete.text, /observed at: 1970-01-01T00:00:01.000Z/);
		assert.match(incomplete.text, /Configured presence is not active status/);
		assert.doesNotMatch(incomplete.text, /shadow|modelInvocable/);
		const ambiguous = await lookup(request({ params: { search: "Review", contains: "needle" } }));
		assert.equal(ambiguous.outcome, "ambiguous");
		assert.match(ambiguous.text, /Candidate records: registration evidence/);
		assert.match(ambiguous.text, /modelInvocable/);
		assert.match(ambiguous.text, /shadow/);
	});

	it("recomputes resource caveats after bounds remove a resource kind", async () => {
		const host = snapshot();
		host.commands = [{ name: "oversized", source: "prompt", sourceInfo: { ...sourceInfo, path: "x".repeat(60000) } }];
		const result = await lookup(request({ params: { limit: 100 }, snapshot: host }));
		assert.equal(result.details.resultBounded, true);
		assert.equal(result.details.returnedRecords, 1);
		assert.equal(records(result)[0].kind, "tool");
		assert.match(result.text, /Configured presence/);
		assert.doesNotMatch(result.text, /Slash names|shadow|modelInvocable/);
		assert.equal(typeof result.details.cursor, "string");
	});

	it("invalidates compact resource pages when an undisplayed provenance field changes", async () => {
		const host = snapshot();
		host.tools.push({ ...host.tools[0], name: "inspect_next", sourceInfo: { ...sourceInfo } });
		const first = await lookup(request({ params: { kind: "tool", limit: 1 }, snapshot: host }));
		const cursor = first.details.cursor as string;
		assert.equal(typeof cursor, "string");
		const next = await lookup(request({ params: { cursor }, snapshot: host }));
		assert.equal(records(next)[0].name, "inspect_next");
		host.tools[1].sourceInfo.source = "changed-package";
		assert.equal((await lookup(request({ params: { cursor }, snapshot: host }))).outcome, "stale_cursor");
	});

	it("retains unavailable activity, unknown skill evidence, and partial observations", async () => {
		const host = snapshot(); host.availability.activeTools = false; host.observation = null;
		const tools = await lookup(request({ snapshot: host, params: { kind: "tool" } }));
		assert.match(tools.text, /active: unavailable/);
		assert.equal(records(tools)[0].active, undefined);
		const skills = await lookup(request({ snapshot: host, params: { kind: "skill" } }));
		assert.match(skills.text, /model-invocable: unknown/);
		const summary = await lookup(request({ snapshot: host }));
		assert.match(summary.text, /not_yet_observed.*unknown, not absent/);
		const catalog = models([{ ...model(), available: null, configuredAuth: null, inScope: null }]);
		const result = await lookup(request({ params: { kind: "model" }, models: catalog }));
		assert.match(result.text, /available=null.*configuredAuth=null.*inScope=null/);
		host.observation = snapshot().observation;
		assert.ok(host.observation); host.observation.overflowBytes = true;
		const partial = await lookup(request({ params: { kind: "context_file", name: "absent" }, snapshot: host }));
		assert.equal(partial.outcome, "partial");
		assert.match(partial.text, /incomplete.*not absence/);
		assert.match((await lookup(request({ snapshot: host }))).text, /observation is incomplete, not empty/);
	});
});
