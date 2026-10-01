/** Exact authorization boundaries independent of natural-language interpretation. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { PolicyControlParams } from "./control.ts";
import { normalizeDataArtifact } from "./data-import.ts";
import { proposalRevision, reduceRuleEvents, RuleRegistry, targetIdentity, validateRuleEvent } from "./local-rules.ts";
import { contentRevision, type OperatorRuleAudit } from "./rule.ts";
import { registerRuleTools } from "./tools.ts";

const operator = { at: "2026-10-01T00:00:00.000Z", session: "controls", model: null, surface: "command" as const };
const agent = { ...operator, surface: "agent-tool" as const };
const authorization = "The operator selected this exact control and target in the conversation.";
const candidate = (id = "local.sample") => ({
	id,
	purpose: "Bound scans.",
	authority: "steer-or-block" as const,
	note: "Bound scans.",
	matcher: { kind: "declarative" as const, language: "command-shape/v1" as const, spec: { command: "scan" } },
});
const artifact = {
	data: { name: "sample", kind: "table", source: "test", capturedAt: 1, rows: [{ key: "a", value: "b" }] },
	expectedRevision: null,
};
async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "policy-control-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const registry = new RuleRegistry(dir);
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	registerRuleTools(
		{
			registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI,
		{ registry, loadRegistry: () => registry.snapshot(), getMode: () => "observe" },
	);
	const ctx = { cwd: dir, sessionManager: { getSessionId: () => "controls" } } as ExtensionToolContext;
	const call = async (params: unknown, signal?: AbortSignal) => {
		const tool = tools.get("policy_control");
		assert.ok(tool);
		return tool.execute("control", params as never, signal, undefined, ctx);
	};
	const bytes = () => readFile(registry.path, "utf8");
	const add = async (id?: string) => {
		const p = await registry.proposeAdd(candidate(id), "Protect scans.", agent);
		await registry.decide(p.id, "approved", "block", operator);
		return p.ruleId;
	};
	return { dir, registry, call, bytes, add };
}

it("rejects only the inspected proposal and retains honest audit evidence", async (t) => {
	const f = await setup(t);
	const p = await f.registry.proposeAdd(candidate(), "Protect scans.", agent);
	const other = await f.registry.proposeAdd(candidate("local.other"), "Protect scans.", agent);
	const input = { operation: "reject", proposalId: p.id, revision: proposalRevision(p), authorization };
	const before = await f.bytes();
	for (const invalid of [
		{ ...input, revision: "000000000000" },
		{ ...input, authorization: " " },
		{ ...input, proposalId: "that proposal" },
		{ ...input, effect: "block" },
	])
		await assert.rejects(f.call(invalid));
	await assert.rejects(f.call(input, AbortSignal.abort()), /cancelled/);
	assert.equal(await f.bytes(), before);
	await f.call(input);
	assert.deepEqual(
		(await f.registry.snapshot()).pending.map((p) => p.id),
		[other.id],
	);
	const events = (await f.bytes())
		.trim()
		.split("\n")
		.map((line) => validateRuleEvent(JSON.parse(line)));
	const event = events.at(-1);
	assert.ok(event?.kind === "decision");
	assert.equal(event.audit.surface, "control-tool");
	assert.equal(reduceRuleEvents(events).pending.length, 1);
	const forged = { ...event, audit: { ...event.audit, targetRevision: "000000000000" } };
	assert.equal(reduceRuleEvents([...events.slice(0, -1), forged]).pending.length, 2);
	await f.registry.proposeAdd(candidate(), "New decision.", agent);
	await assert.rejects(f.call(input), /revision changed/);
	assert.equal((await f.registry.snapshot()).pending.length, 2);
});

it("checks full rule identity including overrides inside the transaction", async (t) => {
	const f = await setup(t);
	const id = await f.add();
	const revision = targetIdentity((await f.registry.snapshot()).records.get(id));
	assert.ok(revision);
	await f.registry.setEffect(id, "steer", "Another control.", operator);
	await assert.rejects(
		f.call({ operation: "disable", id, revision, reason: "Pause.", authorization }),
		/revision changed/,
	);
	for (const operation of ["disable", "enable", "effect", "retire"] as const) {
		const inspected = await f.call({ operation: "inspect", id });
		const revision = (inspected.details as { revision: string }).revision;
		const result = await f.call({
			operation,
			id,
			revision,
			reason: "Selected control.",
			authorization,
			...(operation === "effect" ? { effect: "block" } : {}),
		});
		assert.equal((result.details as { applied: boolean }).applied, true);
		assert.equal((result.details as { mode: string }).mode, "observe");
	}
});

it("keeps exact authority and command/proposal boundaries intact", async (t) => {
	const f = await setup(t);
	const p = await f.registry.proposeAdd({ ...candidate(), authority: "exact" }, "Exact action.", agent);
	await f.registry.decide(p.id, "approved", undefined, operator, proposalRevision(p));
	const revision = targetIdentity((await f.registry.snapshot()).records.get(p.ruleId));
	assert.ok(revision);
	await assert.rejects(
		f.call({ operation: "effect", id: p.ruleId, effect: "block", reason: "Switch.", revision, authorization }),
		/exact replacement/,
	);
	const audit: OperatorRuleAudit = {
		...operator,
		surface: "control-tool",
		targetRevision: proposalRevision(p),
		authorization,
	};
	const next = await f.registry.proposeAdd(candidate("local.next"), "Protect.", agent);
	await assert.rejects(f.registry.decide(next.id, "approved", "block", audit), /revision changed/);
	const transport = Compile(PolicyControlParams);
	assert.equal(transport.Check({ operation: "reject" }), true, "execution enforces operation-specific requirements");
	for (const input of [
		{ operation: "mode", authorization },
		{ operation: "reject", proposalId: next.id },
		{ operation: "approve" },
		{ operation: "disable", id: p.ruleId, revision, authorization, reason: "x", extra: true },
	])
		await assert.rejects(f.call(input), /Invalid policy control fields/);
});

it("binds data controls to complete normalized artifacts and prior binding revisions", async (t) => {
	const f = await setup(t);
	const inspected = await f.call({ operation: "data-preview", artifact });
	const revision = (inspected.details as { revision: string }).revision;
	assert.equal(revision, contentRevision(normalizeDataArtifact(artifact)));
	assert.equal((await f.registry.snapshot()).data.size, 0);
	await assert.rejects(
		f.call({
			operation: "data-set",
			artifact: { ...artifact, data: { ...artifact.data, source: "changed" } },
			revision,
			authorization,
		}),
		/artifact revision changed/,
	);
	await f.call({ operation: "data-set", artifact, revision, authorization });
	await assert.rejects(f.call({ operation: "data-set", artifact, revision, authorization }), /revision changed/);
	const data = (await f.registry.snapshot()).data.get("sample");
	assert.ok(data);
	await assert.rejects(
		f.call({ operation: "data-remove", name: "sample", revision: "000000000000", authorization }),
		/revision changed/,
	);
	await f.call({ operation: "data-remove", name: "sample", revision: data.revision, authorization });
	const path = join(f.dir, "source.json");
	await writeFile(path, JSON.stringify(artifact));
	await f.call({ operation: "data-preview", path });
	await writeFile(path, JSON.stringify({ ...artifact, data: { ...artifact.data, source: "changed" } }));
	await assert.rejects(
		f.call({ operation: "data-set-file", path, revision, authorization }),
		/artifact revision changed/,
	);
	await writeFile(path, JSON.stringify(artifact));
	await f.call({ operation: "data-set-file", path, revision, authorization });
	assert.equal((await f.registry.snapshot()).data.size, 1);
});

it("exposes the complete control identity of a large admitted rule", async (t) => {
	const f = await setup(t);
	const at = Object.fromEntries(
		Array.from({ length: 4 }, (_, index) => [String(index), Array.from({ length: 64 }, () => "\u007f".repeat(200))]),
	);
	const base = candidate();
	const p = await f.registry.proposeAdd(
		{ ...base, matcher: { ...base.matcher, spec: { command: "scan", operands: { at } } } },
		"Complete large matcher.",
		agent,
	);
	await f.registry.decide(p.id, "approved", "block", operator);
	const inspected = await f.call({ operation: "inspect", id: p.ruleId });
	const text = inspected.content[0];
	assert.equal(text.type, "text");
	if (text.type !== "text") return;
	assert.ok(Buffer.byteLength(text.text) > 50 * 1024);
	const parsed = JSON.parse(text.text);
	assert.deepEqual(parsed.record, (await f.registry.snapshot()).records.get(p.ruleId));
	await f.call({
		operation: "disable",
		id: p.ruleId,
		revision: parsed.revision,
		authorization,
		reason: "Pause the large rule.",
	});
	assert.equal((await f.registry.snapshot()).records.get(p.ruleId)?.override?.state, "disabled");
});

it("imports the reviewed plan and refuses changed override targets", async (t) => {
	const f = await setup(t);
	const all = await f.call({ operation: "import-preview", selection: "--all" });
	const allPlan = all.details as { rows: unknown[]; current: unknown[]; revision: string };
	assert.equal(allPlan.rows.length, (await f.registry.snapshot()).records.size);
	assert.equal(allPlan.current.length, allPlan.rows.length);
	assert.ok(allPlan.revision);
	const allText = all.content[0]; assert.equal(allText.type, "text");
	if (allText.type === "text") t.diagnostic(`Complete bundled all-import preview: ${Buffer.byteLength(allText.text)} bytes`);
	const selection = "routing.cat-read";
	const preview = await f.call({ operation: "import-preview", selection });
	const revision = (preview.details as { revision: string }).revision;
	await f.registry.disable(selection, "Preserve pause.", operator);
	await assert.rejects(f.call({ operation: "import", selection, revision, authorization }), /revision changed/);
	const next = await f.call({ operation: "import-preview", selection });
	await f.call({
		operation: "import",
		selection,
		revision: (next.details as { revision: string }).revision,
		authorization,
	});
	assert.equal((await f.registry.snapshot()).records.get(selection)?.override?.state, "disabled");
});
