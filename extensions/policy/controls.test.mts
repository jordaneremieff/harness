import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { snapshotData, type NamedData } from "./data.ts";
import {
	RuleRegistry,
	namedDataRevision,
	proposalRevision,
	reduceRuleEvents,
	validateLocalCandidate,
	validatePackageDefinitionRow,
	validateRuleEvent,
	type DataSetEvent,
	type LocalRuleCandidate,
	type ProposalEvent,
	type RuleEvent,
} from "./local-rules.ts";
import { PolicyPanel, proposalDetailLines, ruleDetailLines, type PolicyPanelActionHost } from "./panel.ts";
import { PROGRAM_LIMITS, RULE_CAPACITY, type FactsProgram } from "./program.ts";
import {
	effectiveEffect,
	effectiveState,
	packageRowRevision,
	type AgentRuleAudit,
	type OperatorRuleAudit,
	type PackageDefinitionRow,
} from "./rule.ts";
import {
	PolicyProposeParams,
	PolicyRulesParams,
	formatRulesTool,
	policyDataCommand,
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
	domain: "facts",
	matcher: { kind: "declarative", language: "facts/v1", spec: structuredClone(program) },
	note: "Use the declared key.",
	scope: { models: ["provider/model"] },
});
const command = (id = "local.command"): LocalRuleCandidate => ({
	id,
	domain: "tool-call",
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
		assert.equal(validateLocalCandidate(facts()).domain, "facts");
		assert.equal(validateLocalCandidate(command()).domain, "tool-call");
		assert.throws(() => validateLocalCandidate({ ...facts(), domain: "tool-call" }), /domain must be facts/);
		assert.throws(() => validateLocalCandidate({ ...facts(), suggestion: { command: "ignored" } }), /do not accept/);
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

	it("replaces only local current revisions and preserves a disabled override", async (t) => {
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

	it("activates package facts through the installed catalog and keeps package updates outside local approval", async (t) => {
		const value = {
			id: "package.rename",
			domain: "facts" as const,
			matcher: { kind: "declarative" as const, language: "facts/v1" as const, spec: rename },
			effect: "correct" as const,
			note: "Use declared keys.",
		};
		const row: PackageDefinitionRow = { ...value, revision: packageRowRevision(value) };
		assert.equal(validatePackageDefinitionRow(row).effect, "correct");
		assert.throws(() => validatePackageDefinitionRow({ ...row, effect: "steer" }), /effect must match/);
		assert.throws(
			() => validatePackageDefinitionRow({ ...row, suggestion: { command: "unused" } }),
			/do not accept a shell suggestion/,
		);
		const reg = await registry(t, [row]);
		const snap = await reg.snapshot();
		assert.equal(snap.records.get(row.id)?.source.kind, "package");
		assert.equal(snap.records.get(row.id)?.matcherAvailable, true);
		assert.equal(snap.pending.length, 0);
		await assert.rejects(
			reg.proposeReplace(facts(row.id), row.revision, "Replace package.", agent),
			/not a local rule/,
		);
		await reg.disable(row.id, "Pause package action.", operator);
		const updatedValue = { ...value, note: "Another package note." };
		const updated = { ...updatedValue, revision: packageRowRevision(updatedValue) };
		const nextRegistry = new RuleRegistry(join(reg.path, ".."), { catalog: [updated] });
		const next = await nextRegistry.snapshot();
		assert.equal(next.records.get(row.id)?.definition.revision, updated.revision);
		assert.equal(effectiveState(next.records.get(row.id)!), "disabled");
		assert.equal(next.pending.length, 0);
	});
});

describe("shared rule capacity", () => {
	it("admits a mixed maximum aggregate under the same engine limit", async (t) => {
		const catalog: PackageDefinitionRow[] = Array.from({ length: RULE_CAPACITY.package }, (_, index) => {
			const id = `package.rule-${index}`;
			const value: Omit<PackageDefinitionRow, "revision"> =
				index % 2 === 0
					? {
							id,
							domain: "tool-call",
							matcher: { kind: "code", key: id },
							effect: "block",
							note: "Use the declared behavior.",
						}
					: {
							id,
							domain: "facts",
							matcher: { kind: "declarative", language: "facts/v1", spec: rename },
							effect: "correct",
							note: "Use the declared behavior.",
						};
			return { ...value, revision: packageRowRevision(value) };
		});
		const reg = await registry(t, catalog);
		assert.equal((await reg.snapshot()).health.status, "ok");
		assert.equal((await reg.snapshot()).records.size, RULE_CAPACITY.package);
		const events: RuleEvent[] = [{ kind: "catalog", rows: catalog, audit: { surface: "package" } }];
		for (let index = 0; index < RULE_CAPACITY.local; index++) {
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
				...(candidate.matcher.language === "facts/v1"
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
		assert.throws(() => new RuleRegistry(join(reg.path, ".."), { catalog: [...catalog, catalog[0]] }), /catalog rows/);
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
				domain: "facts" as const,
				matcher: { kind: "declarative" as const, language: "facts/v1" as const, spec: longProgram },
				effect: "steer" as const,
				note: "Bound guidance.",
			};
			return { ...row, revision: packageRowRevision(row) };
		});
		await assert.rejects(registry(t, catalog), /installed package catalog exceeds/);
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
			operation: "add",
			id: "local.rename",
			reason: "Exact rename.",
			note: "Use keys.",
			language: "facts/v1",
			program: rename,
		};
		assert.equal(schema.Check(add), true);
		assert.equal(schema.Check({ ...add, effect: "block" }), false);
		assert.equal(schema.Check({ ...add, operation: "approve" }), false);
		assert.equal(schema.Check({ ...add, operation: "replace" }), false);
		assert.equal(schema.Check({ ...add, operation: "replace", expectedRevision: "123456789abc" }), true);
		assert.equal(
			schema.Check({
				operation: "add",
				id: "local.command",
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
				result: { isError: false, details: { status: "ok" } },
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
			/optional details only/,
		);
	});

	it("keeps general tool proposals inert and supplies exact behavior to inspection", async (t) => {
		const reg = await registry(t);
		const registered = tools(reg);
		const result = await call(registered.get("policy_propose")!, {
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

	it("confirms the complete facts proposal and sends its exact revision without an effect menu", async (t) => {
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
				throw new Error("Facts actions do not use an effect menu");
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
