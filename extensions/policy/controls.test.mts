import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { type NamedData, snapshotData } from "./data.ts";
import {
	type DataSetEvent,
	type LocalRuleCandidate,
	namedDataRevision,
	type ProposalEvent,
	proposalRevision,
	type RuleEvent,
	RuleRegistry,
	reduceRuleEvents,
	validateLocalCandidate,
	validatePackageDefinitionRow,
	validateRuleEvent,
} from "./local-rules.ts";
import { PolicyPanel, type PolicyPanelActionHost, proposalDetailLines, ruleDetailLines } from "./panel.ts";
import { type FactsProgram, PROGRAM_LIMITS, RULE_CAPACITY } from "./program.ts";
import {
	type AgentRuleAudit,
	effectiveEffect,
	effectiveState,
	type OperatorRuleAudit,
	type PackageDefinitionRow,
	packageRowRevision,
} from "./rule.ts";
import {
	formatRulesTool,
	PolicyProposeParams,
	PolicyRulesParams,
	policyDataCommand,
	policyImportCommand,
	registerRuleTools,
	validateInspectionParams,
} from "./tools.ts";

const operator: OperatorRuleAudit = {
	surface: "command",
	at: "2026-09-10T10:00:00.000Z",
	session: "control-test",
	model: "provider/model",
};
const agent: AgentRuleAudit = { ...operator, surface: "agent-tool" };
const rename: FactsProgram = {
	phase: "input",
	selector: { tools: ["sample"] },
	when: { op: "exists", path: ["input", "old"] },
	action: { kind: "rename-key", path: [], from: "old", to: "new" },
	onUnavailable: "skip",
};
const facts = (id = "local.rename", program = rename): LocalRuleCandidate => ({
	id,
	purpose: "Use valid tool arguments.",
	authority: "exact",
	matcher: { kind: "declarative", language: "facts/v1", spec: structuredClone(program) },
	note: "Use the declared key.",
	scope: { models: ["provider/model"] },
});
const command = (id = "local.command"): LocalRuleCandidate => ({
	id,
	purpose: "Keep search output bounded.",
	authority: "steer-or-block",
	matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
	note: "Bound the search.",
});
const binding = (): NamedData => {
	const raw = {
		name: "identities",
		kind: "table" as const,
		source: "operator-table",
		capturedAt: 1000,
		maxAgeMs: 10000,
		rows: [{ key: "alias", value: "canonical" }],
	};
	return { ...raw, revision: namedDataRevision(raw) };
};
async function registry(t: TestContext, catalog: readonly PackageDefinitionRow[] = []): Promise<RuleRegistry> {
	const dir = await mkdtemp(join(tmpdir(), "policy-controls-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return new RuleRegistry(join(dir, "state"), { catalog });
}
async function approve(reg: RuleRegistry, candidate = facts()): Promise<ProposalEvent> {
	const proposal = await reg.proposeAdd(candidate, "Use an exact correction.", agent);
	await reg.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal));
	return proposal;
}
const summary = { fires: new Map<string, number>(), firesByModel: new Map(), partial: false };

interface Tool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}
const context = {
	cwd: "/work",
	model: { provider: "provider", id: "model" },
	sessionManager: { getSessionId: () => "control-test" },
} as unknown as ExtensionContext;
function tools(
	reg: RuleRegistry,
	inspect?: (view: string, params: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>,
): Map<string, Tool> {
	const registered = new Map<string, Tool>();
	const pi = {
		registerTool(tool: Tool) {
			registered.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerRuleTools(pi, { registry: reg, loadRegistry: () => reg.snapshot(), ...(inspect ? { inspect } : {}) });
	return registered;
}
const call = (tool: Tool, params: Record<string, unknown>) =>
	tool.execute("inspect-call", params, undefined, undefined, context);

describe("general rule schema and exact authority", () => {
	it("accepts both current grammars and rejects open, incompatible, and excessive facts programs", () => {
		assert.equal(validateLocalCandidate(facts()).authority, "exact");
		assert.equal(validateLocalCandidate(command()).authority, "steer-or-block");
		assert.throws(() => validateLocalCandidate({ ...facts(), domain: "tool-call" }), /unknown field/);
		assert.throws(
			() => validateLocalCandidate({ ...facts(), suggestion: { command: "ignored" } }),
			/accept a suggestion/,
		);
		for (const program of [
			{ ...rename, extra: true },
			{ ...rename, phase: "result" },
			{ ...rename, action: { ...rename.action, tool: "another" } },
			{ ...rename, when: { not: { op: "exists", path: ["private", "secret"] } } },
			{ ...rename, when: { all: Array.from({ length: 17 }, () => ({ op: "exists", path: ["input"] })) } },
			{ ...rename, action: { kind: "substitute", path: ["name"], table: "undeclared" } },
		])
			assert.throws(() => validateLocalCandidate(facts("local.invalid", program as FactsProgram)), /matcher.spec/);
	});

	it("bounds positive purpose and rejects undeclared or unsafe authority", () => {
		for (const purpose of [undefined, "", " ", "x".repeat(401)])
			assert.throws(() => validateLocalCandidate({ ...command(), purpose }), /purpose/);
		assert.equal(validateLocalCandidate({ ...command(), purpose: "x".repeat(400) }).purpose.length, 400);
		for (const authority of [undefined, "", "correct", "operator", "steer-or-block"])
			assert.throws(() => validateLocalCandidate({ ...facts(), authority }), /authority/);
		for (const program of [
			{ ...rename, phase: "completion", action: { kind: "observe", label: "counter" } },
			{ ...rename, phase: "result", action: { kind: "guide", text: "Use the result." } },
		])
			assert.throws(
				() =>
					validateLocalCandidate({ ...facts("local.action", program as FactsProgram), authority: "steer-or-block" }),
				/authority/,
			);
	});

	it("permits steer/block control for declared input actions independent of syntax", async (t) => {
		const reg = await registry(t);
		const candidate = {
			...facts("local.admission", {
				...rename,
				action: { kind: "deny" },
			}),
			authority: "steer-or-block" as const,
		};
		const proposal = await reg.proposeAdd(candidate, "Choose the admission effect.", agent);
		await reg.decide(proposal.id, "approved", "steer", operator);
		let record = (await reg.snapshot()).records.get(candidate.id)!;
		assert.equal(effectiveEffect(record), "steer");
		await reg.setEffect(candidate.id, "block", "Deny the action.", operator);
		await reg.disable(candidate.id, "Pause the rule.", operator);
		await reg.enable(candidate.id, "Resume the rule.", operator);
		record = (await reg.snapshot()).records.get(candidate.id)!;
		assert.equal(effectiveEffect(record), "block");
		assert.equal(effectiveState(record), "active");
		assert.match(
			formatRulesTool(await reg.snapshot(), context),
			/operator selects steer or block; steer never denies; no correction authority/,
		);
	});

	it("binds exact compact guidance to its proposal without granting effect control", async (t) => {
		const reg = await registry(t);
		const candidate = { ...command("local.exact"), authority: "exact" as const };
		const proposal = await reg.proposeAdd(candidate, "Approve only this guidance.", agent);
		await assert.rejects(reg.decide(proposal.id, "approved", "block", operator), /exact proposed action/);
		await assert.rejects(reg.decide(proposal.id, "approved", undefined, operator), /exact proposal revision/);
		await reg.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal));
		assert.equal(effectiveEffect((await reg.snapshot()).records.get(candidate.id)!), "steer");
		await assert.rejects(reg.setEffect(candidate.id, "block", "Convert the action.", operator), /exact replacement/);
	});

	it("validates common applicability and binds it to exact definition revisions", async (t) => {
		const applicability = { op: "eq" as const, path: ["context", "tools", "read", "active"], value: true };
		assert.deepEqual(validateLocalCandidate({ ...command(), applicability }).applicability, applicability);
		for (const invalid of [
			null,
			{},
			{ all: [] },
			{ op: "exists", path: ["private", "secret"] },
			{ not: { op: "exists", path: ["__proto__"] } },
		])
			assert.throws(() => validateLocalCandidate({ ...command(), applicability: invalid }), /applicability/);
		assert.throws(
			() =>
				validateLocalCandidate({
					...command(),
					applicability: { op: "lookup", path: ["input", "id"], table: "unbound", value: "unique" },
				}),
			/applicability/,
		);
		const wide = {
			all: Array.from({ length: 4 }, () => ({
				all: Array.from({ length: 16 }, () => ({ op: "exists" as const, path: ["input"] })),
			})),
		};
		assert.throws(
			() => validateLocalCandidate({ ...facts("local.budget", { ...rename, when: wide }), applicability: wide }),
			/applicability.*bounds/,
		);
		const reg = await registry(t);
		const candidate = { ...facts(), applicability };
		const proposed = await reg.proposeAdd(candidate, "Require an active alternative.", agent);
		await reg.decide(proposed.id, "approved", undefined, operator, proposalRevision(proposed));
		const original = (await reg.snapshot()).records.get(candidate.id)!;
		assert.deepEqual(original.definition.applicability, applicability);
		const replacement = await reg.proposeReplace(
			{ ...candidate, applicability: { ...applicability, value: false } },
			original.definition.revision,
			"Change applicability.",
			agent,
		);
		await assert.rejects(
			reg.decide(replacement.id, "approved", undefined, operator, proposalRevision(proposed)),
			/exact proposal revision/,
		);
		await reg.decide(replacement.id, "approved", undefined, operator, proposalRevision(replacement));
		const record = (await reg.snapshot()).records.get(candidate.id)!;
		assert.notEqual(record.definition.revision, original.definition.revision);
		assert.deepEqual(record.definition.applicability, { ...applicability, value: false });
		assert.match(formatRulesTool(await reg.snapshot(), context), /applicability:.*context.*read.*false/);
	});

	it("keeps complete facts proposals inert until an exact operator decision", async (t) => {
		const reg = await registry(t);
		const proposed = await reg.proposeAdd(facts(), "Correct a declared key.", agent);
		assert.equal((await reg.snapshot()).records.size, 0);
		assert.deepEqual(proposed.candidate?.matcher, facts().matcher);
		await assert.rejects(reg.decide(proposed.id, "approved", undefined, operator), /exact proposal revision/);
		await assert.rejects(
			reg.decide(proposed.id, "approved", "block", operator, proposalRevision(proposed)),
			/exact proposed action/,
		);
		await assert.rejects(
			reg.decide(proposed.id, "approved", undefined, operator, "000000000000"),
			/exact proposal revision/,
		);
		await assert.rejects(
			reg.decide(proposed.id, "approved", undefined, agent, proposalRevision(proposed)),
			/operator surface/,
		);
		await reg.decide(proposed.id, "approved", undefined, operator, proposalRevision(proposed));
		const record = (await reg.snapshot()).records.get(proposed.ruleId)!;
		assert.equal(record.definition.effect, "correct");
		assert.equal(effectiveEffect(record), "correct");
		assert.equal(record.source.kind, "local");
		assert.equal((await reg.snapshot()).pending.length, 0);
	});

	it("does not grant authority when retained proposal content changes after a decision token", async (t) => {
		const reg = await registry(t);
		const original = await reg.proposeAdd(facts(), "Exact behavior.", agent);
		const revised = structuredClone(original);
		revised.candidate!.note = "A different note.";
		const reduced = reduceRuleEvents([
			revised,
			{
				kind: "decision",
				id: randomUUID(),
				proposalId: revised.id,
				decision: "approved",
				proposalRevision: proposalRevision(original),
				audit: operator,
			},
		]);
		assert.equal(reduced.records.size, 0);
		assert.equal(reduced.pending.length, 1);
	});

	it("replaces current revisions and preserves a disabled override", async (t) => {
		const reg = await registry(t);
		await approve(reg);
		const original = (await reg.snapshot()).records.get("local.rename")!;
		await reg.disable(original.id, "Pause this rule.", operator);
		const next = facts(original.id, {
			...rename,
			action: { kind: "rename-key", path: [], from: "old", to: "current" },
		});
		await assert.rejects(reg.proposeReplace(next, "000000000000", "Replace.", agent), /revision changed/);
		const replacement = await reg.proposeReplace(next, original.definition.revision, "Replace.", agent);
		await assert.rejects(reg.decide(replacement.id, "approved", undefined, operator), /exact proposal revision/);
		await reg.decide(replacement.id, "approved", undefined, operator, proposalRevision(replacement));
		const changed = (await reg.snapshot()).records.get(original.id)!;
		assert.notEqual(changed.definition.revision, original.definition.revision);
		assert.equal(effectiveState(changed), "disabled");
		assert.equal(changed.staleOverride, true);
		await reg.enable(changed.id, "Resume the exact action.", operator);
		assert.equal(effectiveState((await reg.snapshot()).records.get(changed.id)!), "active");
		await assert.rejects(reg.setEffect(changed.id, "block", "Try another effect.", operator), /exact replacement/);
	});

	it("rejects a stale replacement after target retirement", async (t) => {
		const reg = await registry(t);
		await approve(reg);
		const target = (await reg.snapshot()).records.get("local.rename")!;
		const proposal = await reg.proposeReplace(
			{ ...facts(), note: "Another note." },
			target.definition.revision,
			"Replace.",
			agent,
		);
		await reg.retire(target.id, "Retire target.", operator);
		await assert.rejects(
			reg.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal)),
			/retired/,
		);
		assert.equal((await reg.snapshot()).pending.length, 1);
	});

	it("retains command rules while exact replacement makes old steer/block overrides non-authoritative for corrections", async (t) => {
		const reg = await registry(t);
		const add = await reg.proposeAdd(command(), "Use command shape.", agent);
		await reg.decide(add.id, "approved", "block", operator);
		await reg.setEffect(add.ruleId, "steer", "Lower command effect.", operator);
		await reg.disable(add.ruleId, "Keep disabled.", operator);
		const old = (await reg.snapshot()).records.get(add.ruleId)!;
		const replacement = await reg.proposeReplace(
			facts(add.ruleId),
			old.definition.revision,
			"Use an exact key action.",
			agent,
		);
		await reg.decide(replacement.id, "approved", undefined, operator, proposalRevision(replacement));
		const record = (await reg.snapshot()).records.get(add.ruleId)!;
		assert.equal(record.override?.effect, "steer");
		assert.equal(effectiveEffect(record), "correct");
		assert.equal(effectiveState(record), "disabled");
		await reg.enable(record.id, "Resume exact action.", operator);
		assert.equal(effectiveEffect((await reg.snapshot()).records.get(record.id)!), "correct");
	});

	it("seeds exact facts and changes them only through ordinary approval or explicit import", async (t) => {
		const value = {
			id: "package.rename",
			purpose: "Use valid tool arguments.",
			authority: "exact" as const,
			matcher: { kind: "declarative" as const, language: "facts/v1" as const, spec: rename },
			effect: "correct" as const,
			note: "Use declared keys.",
		};
		const row: PackageDefinitionRow = { ...value, revision: packageRowRevision(value) };
		assert.equal(validatePackageDefinitionRow(row).effect, "correct");
		assert.throws(() => validatePackageDefinitionRow({ ...row, effect: "steer" }), /effect must match/);
		assert.throws(
			() => validatePackageDefinitionRow({ ...row, suggestion: { command: "unused" } }),
			/accept a suggestion/,
		);
		const reg = await registry(t, [row]);
		const snap = await reg.snapshot();
		assert.equal(snap.records.get(row.id)?.source.kind, "package");
		assert.equal(snap.records.get(row.id)?.matcherAvailable, true);
		assert.equal(snap.pending.length, 0);
		const edit = await reg.proposeReplace(facts(row.id), row.revision, "Replace seeded rule.", agent);
		await reg.decide(edit.id, "rejected", undefined, operator);
		await reg.disable(row.id, "Pause package action.", operator);
		const updatedValue = { ...value, note: "Another package note." };
		const updated = { ...updatedValue, revision: packageRowRevision(updatedValue) };
		const nextRegistry = new RuleRegistry(join(reg.path, ".."), { catalog: [updated] });
		const next = await nextRegistry.snapshot();
		assert.equal(next.records.get(row.id)?.definition.revision, row.revision);
		const plan = await nextRegistry.planImport(row.id);
		await nextRegistry.importCatalog(row.id, plan.revision, operator);
		assert.equal((await nextRegistry.snapshot()).records.get(row.id)?.definition.revision, updated.revision);
		assert.equal(effectiveState(next.records.get(row.id)!), "disabled");
		assert.equal(next.pending.length, 0);
	});
});

describe("shared rule capacity", () => {
	it("admits a mixed maximum aggregate under the same engine limit", async (t) => {
		const catalog: PackageDefinitionRow[] = Array.from({ length: RULE_CAPACITY.catalog / 2 }, (_, index) => {
			const id = `package.rule-${index}`;
			const value: Omit<PackageDefinitionRow, "revision"> =
				index % 2 === 0
					? {
							id,
							purpose: "Use valid tool arguments.",
							authority: "steer-or-block",
							matcher: { kind: "code", key: id },
							effect: "block",
							note: "Use the declared behavior.",
						}
					: {
							id,
							purpose: "Use valid tool arguments.",
							authority: "exact",
							matcher: { kind: "declarative", language: "facts/v1", spec: rename },
							effect: "correct",
							note: "Use the declared behavior.",
						};
			return { ...value, revision: packageRowRevision(value) };
		});
		const reg = await registry(t, catalog);
		assert.equal((await reg.snapshot()).health.status, "ok");
		assert.equal((await reg.snapshot()).records.size, catalog.length);
		const events: RuleEvent[] = [{ kind: "catalog", rows: catalog, audit: { surface: "package" } }];
		for (let index = 0; index < RULE_CAPACITY.catalog - catalog.length; index++) {
			const { id: ruleId, ...candidate } =
				index % 2 === 0 ? command(`local.rule-${index}`) : facts(`local.rule-${index}`);
			const proposal: ProposalEvent = {
				kind: "proposal",
				id: randomUUID(),
				operation: "add",
				ruleId,
				candidate,
				reason: "Use the declared behavior.",
				audit: agent,
			};
			events.push(proposal, {
				kind: "decision",
				id: randomUUID(),
				proposalId: proposal.id,
				decision: "approved",
				...(candidate.authority === "exact"
					? { proposalRevision: proposalRevision(proposal) }
					: { effect: "block" as const }),
				audit: operator,
			});
		}
		const reduced = reduceRuleEvents(events);
		assert.equal(reduced.records.size, PROGRAM_LIMITS.rules);
		assert.equal(
			[...reduced.records.values()].filter((record) => effectiveState(record) === "active").length,
			RULE_CAPACITY.active,
		);
		assert.throws(() => new RuleRegistry(join(reg.path, ".."), { catalog: [...catalog, catalog[0]] }), /duplicate/);
	});

	it("rejects oversized catalog bytes before any package state exists", async (t) => {
		const longProgram: FactsProgram = {
			...rename,
			phase: "result",
			action: { kind: "guide", text: "x".repeat(2000) },
		};
		const catalog: PackageDefinitionRow[] = Array.from({ length: 300 }, (_, index) => {
			const row = {
				id: `package.long-${index}`,
				purpose: "Use valid tool arguments.",
				authority: "exact" as const,
				matcher: { kind: "declarative" as const, language: "facts/v1" as const, spec: longProgram },
				effect: "steer" as const,
				note: "Bound guidance.",
			};
			return { ...row, revision: packageRowRevision(row) };
		});
		await assert.rejects(registry(t, catalog), /installed package catalog exceeds/);
	});
});

describe("bundled catalog inspection and import approval", () => {
	const bundled = (): PackageDefinitionRow => {
		const value = {
			id: "operator.catalog",
			purpose: "Keep output bounded.",
			authority: "steer-or-block" as const,
			matcher: { kind: "code" as const, key: "routing.cat-read" },
			effect: "block" as const,
			note: "Use bounded file reads.",
		};
		return { ...value, revision: packageRowRevision(value) };
	};
	it("validates predicate proposals with exclusive authoring forms and bounded installed references", async (t) => {
		const reg = await registry(t, [bundled()]);
		const tool = tools(reg).get("policy_propose")!;
		const schema = Compile(PolicyProposeParams);
		const params = {
			operation: "replace",
			id: bundled().id,
			expectedRevision: bundled().revision,
			purpose: "Keep output bounded.",
			authority: "steer-or-block",
			predicate: "routing.cat-read",
			note: "Read a bounded file.",
			reason: "Edit the seeded definition.",
		};
		assert.equal(schema.Check(params), true);
		assert.equal(schema.Check({ ...params, match: { command: "cat" } }), false);
		assert.equal(schema.Check({ ...params, predicate: "../code" }), false);
		await call(tool, params);
		assert.equal((await reg.snapshot()).pending[0]?.candidate?.matcher.kind, "code");
		await assert.rejects(
			call(tool, { ...params, operation: "add", id: "operator.unknown", predicate: "unknown.matcher" }),
			/unavailable/,
		);
	});
	it("routes catalog inspection through a read-only tool with complete selected rows", async (t) => {
		const reg = await registry(t, [bundled()]);
		const tool = tools(reg).get("policy_rules")!;
		const before = await reg.snapshot();
		assert.equal(Compile(PolicyRulesParams).Check({ view: "catalog", id: bundled().id }), true);
		const result = await call(tool, { view: "catalog", id: bundled().id });
		assert.match(result.content[0].text, /bundled starter catalog/);
		assert.match(result.content[0].text, /routing.cat-read/);
		assert.deepEqual(await reg.snapshot(), before);
	});
	it("shows current overrides and resulting effects before confirmation and rejects target changes during confirmation", async (t) => {
		const reg = await registry(t, [bundled()]);
		await reg.setEffect(bundled().id, "steer", "Preserve this choice.", operator);
		await reg.disable(bundled().id, "Keep this pause.", operator);
		let saw = false;
		await assert.rejects(
			policyImportCommand(reg, bundled().id, operator, async (_title, message) => {
				saw = true;
				assert.match(message, /Keep this pause/);
				assert.match(message, /"resulting":\[\{"id":"operator.catalog","state":"disabled","effect":"steer"\}\]/);
				await reg.enable(bundled().id, "Target changed.", operator);
				return true;
			}),
			/revision changed/,
		);
		assert.equal(saw, true);
		assert.equal((await reg.snapshot()).records.get(bundled().id)?.source.kind, "package");
	});
	it("returns the full no-UI artifact and an exact revision command without an implicit write", async (t) => {
		const reg = await registry(t, [bundled()]);
		await reg.retire(bundled().id, "Retire this rule.", operator);
		const before = await readFile(reg.path, "utf8");
		const preview = await policyImportCommand(reg, bundled().id, operator, async () => false);
		assert.match(preview, /"current":/);
		assert.match(preview, /"rows":/);
		assert.match(preview, /"targets":/);
		assert.equal(await readFile(reg.path, "utf8"), before);
		const revision = / exact ([a-f0-9]{12})/.exec(preview)![1];
		await policyImportCommand(reg, `${bundled().id} exact ${revision}`, operator, async () =>
			assert.fail("Exact approval does not reopen confirmation"),
		);
		assert.equal(effectiveState((await reg.snapshot()).records.get(bundled().id)!), "active");
		await assert.rejects(
			policyImportCommand(reg, `${bundled().id} exact ${revision}`, operator, async () => true),
			/revision changed/,
		);
	});
	it("confirms all selected rows once and commits one event", async (t) => {
		const a = bundled();
		const value = { ...a, id: "operator.second" };
		const { revision: _revision, ...definition } = value;
		const b = { ...definition, revision: packageRowRevision(definition) };
		const reg = await registry(t, [a, b]);
		await reg.snapshot();
		const before = (await readFile(reg.path, "utf8")).trim().split("\n").length;
		let confirmations = 0;
		await policyImportCommand(reg, "--all", operator, async (_title, message) => {
			confirmations++;
			assert.match(message, /operator.catalog/);
			assert.match(message, /operator.second/);
			return true;
		});
		assert.equal(confirmations, 1);
		assert.equal((await readFile(reg.path, "utf8")).trim().split("\n").length, before + 1);
	});
});

describe("named data controls", () => {
	it("validates complete revisions and refuses agent writes, stale updates, and stale removals", async (t) => {
		const reg = await registry(t);
		const data = binding();
		await assert.rejects(reg.setData(data, null, agent), /operator surface/);
		await assert.rejects(reg.setData({ ...data, revision: "000000000000" }, null, operator), /complete contract/);
		await reg.setData(data, null, operator);
		const updated = { ...data, rows: [{ key: "alias", value: "other" }] };
		updated.revision = namedDataRevision(updated);
		await assert.rejects(reg.setData(updated, null, operator), /revision changed/);
		await reg.setData(updated, data.revision, operator);
		await assert.rejects(reg.removeData(data.name, data.revision, operator), /revision changed/);
		await reg.removeData(updated.name, updated.revision, operator);
		assert.equal((await reg.snapshot()).data.size, 0);
	});

	it("ignores forged agent events and stale retained data events", () => {
		const data = binding();
		const set: DataSetEvent = {
			kind: "data",
			id: randomUUID(),
			operation: "set",
			data,
			expectedRevision: null,
			audit: operator,
		};
		assert.equal(reduceRuleEvents([{ ...set, audit: agent }]).data.size, 0);
		const updated = { ...data, source: "another-source" };
		updated.revision = namedDataRevision(updated);
		const reduced = reduceRuleEvents([set, { ...set, id: randomUUID(), data: updated }]);
		assert.equal(reduced.data.get(data.name)?.revision, data.revision);
		assert.throws(() => validateRuleEvent({ ...set, file: "/arbitrary/path" }), /unknown field/);
		assert.throws(() => validateRuleEvent({ ...set, data: { ...data, rawResult: "do not retain" } }), /data:/);
	});

	it("requires full command confirmation and repeats the revision check after confirmation", async (t) => {
		const reg = await registry(t);
		const data = binding();
		let shown = "";
		const request = JSON.stringify({ data, expectedRevision: null });
		assert.match(
			await policyDataCommand(reg, `set ${request}`, operator, async (_title, body) => {
				shown = body;
				return false;
			}),
			/canceled/,
		);
		assert.equal((await reg.snapshot()).data.size, 0);
		assert.deepEqual(JSON.parse(shown), { data, expectedRevision: null });
		await assert.rejects(
			policyDataCommand(reg, `set ${request}`, operator, async () => {
				await reg.setData(data, null, operator);
				return true;
			}),
			/revision changed/,
		);
		assert.match(await policyDataCommand(reg, `show ${data.name}`, operator, async () => false), /operator-table/);
		await assert.rejects(
			policyDataCommand(reg, "list extra", operator, async () => true),
			/does not accept/,
		);
		await assert.rejects(
			policyDataCommand(reg, `set ${request}`, agent as never, async () => true),
			/operator surface/,
		);
		await policyDataCommand(reg, `remove ${data.name} ${data.revision}`, operator, async () => true);
		assert.equal((await reg.snapshot()).data.size, 0);
	});

	it("fills operator metadata before confirmation and leaves static tables revision-controlled", async (t) => {
		const reg = await registry(t);
		const request = {
			data: { name: "static-identities", kind: "table", rows: [{ key: "alias", value: "canonical" }] },
			expectedRevision: null,
		};
		let shown: { data: NamedData } | undefined;
		await policyDataCommand(reg, `set ${JSON.stringify(request)}`, operator, async (_title, message) => {
			shown = JSON.parse(message);
			return true;
		});
		assert.equal(shown?.data.source, "operator");
		assert.equal(shown?.data.capturedAt, Date.parse(operator.at));
		assert.equal(shown?.data.maxAgeMs, undefined);
		assert.equal(shown?.data.revision, namedDataRevision(shown!.data));
		assert.equal(
			snapshotData([shown!.data], Date.parse(operator.at) + 100000000000)[request.data.name].status,
			"ready",
		);
		assert.deepEqual((await reg.snapshot()).data.get(request.data.name), shown!.data);
	});

	it("supports no-UI exact data approval without a model mutation tool", async (t) => {
		const reg = await registry(t);
		const request = {
			data: { name: "static", kind: "table", rows: [{ key: "alias", value: "canonical" }] },
			expectedRevision: null,
		};
		const unconfirmed = await policyDataCommand(reg, `set ${JSON.stringify(request)}`, operator, async () => false);
		assert.equal((await reg.snapshot()).data.size, 0);
		const marker = "/policy data set ";
		const raw = unconfirmed.slice(unconfirmed.indexOf(marker) + marker.length);
		const artifact = JSON.parse(raw);
		await assert.rejects(
			policyDataCommand(
				reg,
				`set ${JSON.stringify({ ...artifact, approveRevision: "000000000000" })}`,
				operator,
				async () => true,
			),
			/exact complete artifact/,
		);
		await policyDataCommand(reg, `set ${raw}`, operator, async () => {
			throw new Error("Exact approval does not need a UI");
		});
		const saved = (await reg.snapshot()).data.get("static")!;
		assert.equal(saved.source, "operator");
		await assert.rejects(
			policyDataCommand(reg, `set ${raw}`, operator, async () => true),
			/revision changed/,
		);
		await policyDataCommand(reg, `remove static ${saved.revision} exact`, operator, async () => {
			throw new Error("Exact removal does not need a UI");
		});
		assert.equal((await reg.snapshot()).data.size, 0);
	});

	it("keeps data copies separate and reports fresh versus stale identities", async (t) => {
		const reg = await registry(t);
		await reg.setData(binding(), null, operator);
		const first = await reg.snapshot();
		const data = first.data.get("identities")!;
		assert.equal(snapshotData([data], 1001).identities.status, "ready");
		assert.equal(snapshotData([data], 11000).identities.status, "stale");
		data.source = "local mutation";
		assert.equal((await reg.snapshot()).data.get(data.name)?.source, "operator-table");
	});
});

describe("bounded tools and operator panel", () => {
	it("exposes one closed proposal schema for both languages and no tool mutation gate", () => {
		const schema = Compile(PolicyProposeParams);
		const add = {
			purpose: "Use valid tool arguments.",
			authority: "exact",
			operation: "add",
			id: "local.rename",
			reason: "Exact rename.",
			note: "Use keys.",
			language: "facts/v1",
			program: rename,
		};
		assert.equal(schema.Check(add), true);
		assert.equal(schema.Check({ ...add, purpose: "x".repeat(401) }), false);
		assert.equal(schema.Check({ ...add, authority: "correct" }), false);
		assert.equal(schema.Check({ ...add, effect: "block" }), false);
		assert.equal(schema.Check({ ...add, operation: "approve" }), false);
		assert.equal(schema.Check({ ...add, operation: "replace" }), false);
		assert.equal(schema.Check({ ...add, operation: "replace", expectedRevision: "123456789abc" }), true);
		assert.equal(
			schema.Check({
				operation: "add",
				id: "local.command",
				purpose: "Keep search output bounded.",
				authority: "steer-or-block",
				reason: "Bound.",
				note: "Use shape.",
				match: { command: "scan" },
			}),
			true,
		);
		assert.equal(Compile(PolicyRulesParams).Check({ view: "data", operation: "set" }), false);
	});

	it("rejects preview misuse and bounded raw JSON overflow", () => {
		assert.doesNotThrow(() =>
			validateInspectionParams({
				view: "preview",
				tool: "sample",
				input: { name: "alias" },
				result: { isError: false, details: { status: "ok" }, content: [{ type: "text", text: "The request failed." }] },
			}),
		);
		assert.throws(() => validateInspectionParams({ view: "preview", tool: "sample" }), /input object/);
		assert.throws(() => validateInspectionParams({ view: "state", input: {} }), /not valid/);
		assert.throws(() => validateInspectionParams({ view: "explain" }), /requires id/);
		assert.throws(
			() => validateInspectionParams({ view: "preview", tool: "sample", input: { value: "x".repeat(70000) } }),
			/byte bound/,
		);
		assert.throws(
			() =>
				validateInspectionParams({
					view: "preview",
					tool: "sample",
					input: {},
					result: { isError: false, content: "raw" },
				}),
			/text blocks/,
		);
		for (const content of [
			[{ type: "image", data: "data" }],
			[{ type: "text", text: "value", extra: true }],
			[{ type: "text", text: 1 }],
			Array.from({ length: 65 }, () => ({ type: "text", text: "" })),
		]) {
			const request = { view: "preview", tool: "sample", input: {}, result: { isError: false, content } };
			assert.equal(Compile(PolicyRulesParams).Check(request), false);
			assert.throws(() => validateInspectionParams(request), /text blocks/);
		}
		const textResult = {
			view: "preview",
			tool: "sample",
			input: {},
			result: { isError: false, content: [{ type: "text", text: "The request failed." }] },
		};
		assert.equal(Compile(PolicyRulesParams).Check(textResult), true);
		assert.throws(
			() => validateInspectionParams({ ...textResult, result: { ...textResult.result, usage: {} } }),
			/text content only/,
		);
		assert.throws(
			() =>
				validateInspectionParams({
					...textResult,
					result: { isError: false, content: [{ type: "text", text: "x".repeat(70000) }] },
				}),
			/byte bound/,
		);
	});

	it("keeps general tool proposals inert and supplies exact behavior to inspection", async (t) => {
		const reg = await registry(t);
		const registered = tools(reg);
		const result = await call(registered.get("policy_propose")!, {
			purpose: "Use valid tool arguments.",
			authority: "exact",
			operation: "add",
			id: "local.rename",
			reason: "Exact rename.",
			note: "Use keys.",
			language: "facts/v1",
			program: rename,
		});
		assert.equal(result.details.state, "pending");
		assert.match(String(result.details.proposalRevision), /^[a-f0-9]{12}$/);
		const snap = await reg.snapshot();
		assert.equal(snap.records.size, 0);
		const text = formatRulesTool(snap, context);
		assert.match(text, /rename-key/);
		assert.match(text, /revision=/);
		await reg.decide(snap.pending[0].id, "approved", undefined, operator, proposalRevision(snap.pending[0]));
		const active = (await reg.snapshot()).records.get("local.rename")!;
		assert.match(formatRulesTool(await reg.snapshot(), context), /effect=correct/);
		assert.match(ruleDetailLines(active, { cwd: "/work" }, summary).join("\n"), /action:.*rename-key/);
	});

	it("routes inspection through one callback and never changes data or approvals for preview", async (t) => {
		const reg = await registry(t);
		await approve(reg);
		await reg.setData(binding(), null, operator);
		const before = await readFile(reg.path, "utf8");
		const inspected: string[] = [];
		const registered = tools(reg, async (view, params) => {
			inspected.push(view);
			return { view, tool: params.tool, message: "x".repeat(100000) };
		});
		const result = await call(registered.get("policy_rules")!, { view: "preview", tool: "sample", input: { old: 1 } });
		assert.deepEqual(inspected, ["preview"]);
		assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
		assert.match(result.content[0].text, /truncated/);
		assert.equal(await readFile(reg.path, "utf8"), before);
		assert.match((await call(registered.get("policy_rules")!, { view: "data" })).content[0].text, /identities/);
		assert.deepEqual(inspected, ["preview"]);
		const noCallback = tools(reg);
		await assert.rejects(call(noCallback.get("policy_rules")!, { view: "state" }), /runtime callback absent/);
	});

	it("confirms the complete exact proposal and sends its revision without an effect menu", async (t) => {
		const reg = await registry(t);
		const proposal = await reg.proposeAdd(facts(), "Exact rename.", agent);
		const snapshot = await reg.snapshot();
		let confirmation = "";
		let result: [string, string | undefined, string | undefined] | undefined;
		let finished!: () => void;
		const done = new Promise<void>((resolve) => {
			finished = resolve;
		});
		const host: PolicyPanelActionHost = {
			async select() {
				throw new Error("Exact actions do not use an effect menu");
			},
			async confirm(_title, message) {
				confirmation = message;
				return true;
			},
			async approve(id, effect, revision) {
				result = [id, effect, revision];
				finished();
				return { snapshot, outcome: "Approved exact action." };
			},
			async reject() {
				throw new Error("Unused");
			},
		};
		const panel = new PolicyPanel({
			data: {
				snapshot,
				fireSummary: summary,
				activity: { records: [], partial: false, byteLimited: false, recordLimited: false, bytesRead: 0 },
			},
			scopeContext: { cwd: "/work" },
			theme: {
				fg: (_color: unknown, text: string) => text,
				bg: (_color: unknown, text: string) => text,
				bold: (text: string) => text,
			} as never,
			tui: { requestRender() {} },
			getMaxRows: () => 24,
			done() {},
			actionHost: host,
			initialView: "proposals",
		});
		panel.handleInput("a");
		await done;
		assert.deepEqual(result, [proposal.id, undefined, proposalRevision(proposal)]);
		assert.match(confirmation, /rename-key/);
		assert.ok(proposalDetailLines(proposal).every((line) => confirmation.includes(line)));
	});
});
