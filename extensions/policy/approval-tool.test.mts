/** Deterministic approval contracts, not a natural-language intent classifier. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import {
	type ProposalEvent,
	proposalRevision,
	reduceRuleEvents,
	RULES_FILE,
	RuleRegistry,
	validateRuleEvent,
} from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import { type OperatorRuleAudit, effectiveState } from "./rule.ts";
import { PolicyApproveParams, registerRuleTools } from "./tools.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
const ctx: ExtensionToolContext = {
	...({
		cwd: "/work",
		model: { provider: "test", id: "test" },
		sessionManager: { getSessionId: () => "approval-test" },
	} as unknown as ExtensionContext),
	tools: [],
	executeTool: async () => assert.fail("Policy approval must not execute another tool."),
};
const operator = { at: "2026-09-30T10:00:00.000Z", session: "approval-test", model: null, surface: "command" as const };
const agent = { ...operator, surface: "agent-tool" as const };
const authorization = "The operator approved the presented proposal as a blocking rule in the current conversation.";
const approvalAudit: OperatorRuleAudit = { ...operator, surface: "approval-tool", authorization };
const proposal = (id = "local.scan") => ({
	operation: "add",
	id,
	purpose: "Bound command output.",
	authority: "steer-or-block",
	reason: "Prevent unbounded scan output.",
	note: "Use bounded scan output.",
	match: { command: "scan" },
});
const approval = (p: ProposalEvent, effect: "steer" | "block" | "exact" = "block") => ({
	proposalId: p.id,
	proposalRevision: proposalRevision(p),
	effect,
	authorization,
});
async function setup(t: TestContext, mode: PolicyMode = "enforce") {
	const dir = await mkdtemp(join(tmpdir(), "policy-approval-tool-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const registry = new RuleRegistry(dir, { catalog: [] });
	const registered = new Map<string, Tool>();
	registerRuleTools({ registerTool: (tool: Tool) => registered.set(tool.name, tool) } as unknown as ExtensionAPI, {
		registry,
		loadRegistry: () => registry.snapshot(),
		getMode: () => mode,
	});
	const call = async (name: string, input: unknown, signal?: AbortSignal) => {
		const tool = registered.get(name);
		assert.ok(tool);
		return tool.execute("approval-call", input as never, signal, undefined, ctx);
	};
	const submit = async (input = proposal()) => {
		const result = await call("policy_propose", input);
		const p = (await registry.snapshot()).pending.find((entry) => entry.ruleId === input.id);
		assert.ok(p);
		assert.match(result.content[0].type === "text" ? result.content[0].text : "", new RegExp(proposalRevision(p)));
		return p;
	};
	const bytes = () => readFile(join(dir, RULES_FILE), "utf8");
	return { registry, registered, call, submit, bytes, dir };
}

describe("context-authorized policy approval tool", () => {
	for (const effect of ["steer", "block"] as const) {
		it(`activates ${effect} with a durable honest audit and scoped pending lookup`, async (t) => {
			const f = await setup(t);
			const p = await f.submit();
			assert.equal((await f.registry.snapshot()).records.size, 0);
			for (const id of [p.ruleId, p.id]) {
				const result = await f.call("policy_rules", { id });
				assert.match(JSON.stringify(result.content), new RegExp(proposalRevision(p)));
				const content = result.content[0];
				assert.equal(content.type, "text");
				if (content.type === "text") assert.deepEqual(JSON.parse(content.text).proposal, p);
			}
			const result = await f.call("policy_approve", approval(p, effect));
			const text = result.content[0];
			assert.equal(text.type, "text");
			if (text.type !== "text") return;
			const readback = JSON.parse(text.text);
			assert.equal(readback.state, "active");
			assert.equal(readback.effect, effect);
			assert.equal(readback.mode, "enforce");
			const snapshot = await new RuleRegistry(f.dir, { catalog: [] }).snapshot();
			assert.equal(snapshot.pending.length, 0);
			const record = snapshot.records.get(p.ruleId);
			assert.ok(record && record.source.kind === "local");
			assert.equal(record.source.approvedAudit.surface, "approval-tool");
			assert.deepEqual(record.source.approvedAudit, {
				...approvalAudit,
				at: record.source.approvedAudit.at,
				model: "test/test",
			});
			await assert.rejects(f.call("policy_approve", approval(p, effect)), /No pending proposal/);
		});
	}

	it("requires complete bounded call parameters without treating prose as intent proof", async (t) => {
		const f = await setup(t);
		const p = await f.submit();
		const schema = Compile(PolicyApproveParams);
		const base = approval(p);
		assert.equal(schema.Check(base), true);
		const before = await f.bytes();
		for (const key of Object.keys(base)) {
			const input = { ...base } as Record<string, unknown>;
			delete input[key];
			assert.equal(schema.Check(input), false);
			await assert.rejects(f.call("policy_approve", input), /requires/);
		}
		for (const input of [
			{ ...base, authorization: " " },
			{ ...base, authorization: "x".repeat(1001) },
			{ ...base, confirmed: true },
			{ ...base, effect: "deny" },
		])
			await assert.rejects(f.call("policy_approve", input), /requires/);
		assert.equal(await f.bytes(), before);
	});

	it("leaves missing, stale, effect-conflicting, and cancelled approvals inert", async (t) => {
		const f = await setup(t);
		const p = await f.submit();
		const before = await f.bytes();
		await assert.rejects(
			f.call("policy_approve", { ...approval(p), proposalRevision: "000000000000" }),
			/revision changed/,
		);
		await assert.rejects(f.call("policy_approve", approval(p, "exact")), /requires effect/);
		await assert.rejects(
			f.call("policy_approve", { ...approval(p), proposalId: "11111111-1111-4111-8111-111111111111" }),
			/No pending proposal/,
		);
		await assert.rejects(f.call("policy_approve", approval(p), AbortSignal.abort()), /cancelled/);
		assert.equal(await f.bytes(), before);
	});

	it("accepts exact actions without granting steer/block overrides", async (t) => {
		const f = await setup(t);
		const p = await f.submit({ ...proposal(), authority: "exact" });
		await assert.rejects(f.call("policy_approve", approval(p)), /exact proposed action/);
		const result = await f.call("policy_approve", approval(p, "exact"));
		assert.equal((result.details as { effect: string }).effect, "steer");
	});

	it("does not select among multiple pending proposals or combine their effects", async (t) => {
		const f = await setup(t);
		const first = await f.submit();
		const second = await f.submit(proposal("local.other"));
		await f.call("policy_approve", approval(second, "steer"));
		const snapshot = await f.registry.snapshot();
		assert.deepEqual(
			snapshot.pending.map((p) => p.id),
			[first.id],
		);
		assert.equal(snapshot.records.get(second.ruleId)?.definition.effect, "steer");
	});

	it("checks revisions inside the write transaction and serializes duplicate decisions", async (t) => {
		const f = await setup(t);
		const p = await f.submit();
		const results = await Promise.allSettled([
			f.call("policy_approve", approval(p)),
			f.call("policy_approve", approval(p)),
		]);
		assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
		assert.equal(results.filter((r) => r.status === "rejected").length, 1);
		const events = (await f.bytes())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(events.filter((event) => event.kind === "decision").length, 1);
	});

	it("preserves replacement disablement and exposes non-enforcing mode", async (t) => {
		const f = await setup(t, "observe");
		const p = await f.submit();
		await f.call("policy_approve", approval(p));
		await f.registry.disable(p.ruleId, "Keep this rule disabled.", operator);
		const record = (await f.registry.snapshot()).records.get(p.ruleId);
		assert.ok(record);
		await f.call("policy_propose", {
			...proposal(),
			operation: "replace",
			expectedRevision: record.definition.revision,
			note: "Bound scan output.",
		});
		const replacement = (await f.registry.snapshot()).pending[0];
		assert.ok(replacement);
		const result = await f.call("policy_approve", approval(replacement, "steer"));
		assert.equal((result.details as { state: string }).state, "disabled");
		assert.equal((result.details as { mode: string }).mode, "observe");
	});

	it("refuses a replacement after its target retires", async (t) => {
		const f = await setup(t);
		const p = await f.submit();
		await f.call("policy_approve", approval(p));
		const current = (await f.registry.snapshot()).records.get(p.ruleId);
		assert.ok(current);
		await f.call("policy_propose", {
			...proposal(),
			operation: "replace",
			expectedRevision: current.definition.revision,
		});
		const replacement = (await f.registry.snapshot()).pending[0];
		await f.registry.retire(p.ruleId, "Retire this rule.", operator);
		await assert.rejects(f.call("policy_approve", approval(replacement)), /retired/);
	});

	for (const operation of ["disable", "retire"] as const) {
		it(`binds ${operation} to its exact pending revision`, async (t) => {
			const f = await setup(t);
			const p = await f.submit();
			await f.call("policy_approve", approval(p));
			await f.call("policy_propose", { operation, id: p.ruleId, reason: "Stop this rule." });
			const next = (await f.registry.snapshot()).pending[0];
			await assert.rejects(f.call("policy_approve", approval(next)), /does not accept/);
			await assert.rejects(
				f.call("policy_approve", { ...approval(next, "exact"), proposalRevision: "000000000000" }),
				/revision changed/,
			);
			await f.call("policy_approve", approval(next, "exact"));
			const record = (await f.registry.snapshot()).records.get(p.ruleId);
			assert.ok(record);
			assert.equal(effectiveState(record), operation === "retire" ? "retired" : "disabled");
		});
	}

	it("returns complete large pending artifacts without the all-rules text cap", async (t) => {
		const f = await setup(t);
		const at = Object.fromEntries(
			Array.from({ length: 4 }, (_, index) => [String(index), Array.from({ length: 64 }, () => "\u007f".repeat(200))]),
		);
		await f.call("policy_propose", { ...proposal(), match: { command: "scan", operands: { at } } });
		const p = (await f.registry.snapshot()).pending[0];
		assert.ok(p);
		assert.ok(Buffer.byteLength(JSON.stringify(p), "utf8") > 50 * 1024);
		const result = await f.call("policy_rules", { id: p.ruleId });
		const content = result.content[0];
		assert.equal(content.type, "text");
		if (content.type !== "text") return;
		assert.ok(Buffer.byteLength(content.text, "utf8") <= 6 * 64 * 1024 + 256);
		assert.doesNotMatch(content.text, /[\u007f-\u009f]/);
		assert.deepEqual(JSON.parse(content.text), { proposalRevision: proposalRevision(p), proposal: p });
	});

	it("limits the approval surface to authorized pending decisions on write and replay", async (t) => {
		const f = await setup(t);
		const p = await f.submit();
		await assert.rejects(f.registry.decide(p.id, "approved", "block", agent, proposalRevision(p)), /operator surface/);
		await assert.rejects(
			f.registry.decide(p.id, "rejected", undefined, approvalAudit),
			/only pending proposal approval/,
		);
		await f.call("policy_approve", approval(p));
		await assert.rejects(f.registry.disable(p.ruleId, "Not allowed.", approvalAudit), /only pending proposal approval/);
		await assert.rejects(f.registry.retire(p.ruleId, "Not allowed.", approvalAudit), /only pending proposal approval/);
		const approved = (await f.bytes())
			.trim()
			.split("\n")
			.map((line) => validateRuleEvent(JSON.parse(line)));
		const decision = approved.find((event) => event.kind === "decision");
		assert.ok(decision?.kind === "decision");
		for (const input of [
			{ ...decision.audit, authorization: "" },
			{ ...decision.audit, authorization: undefined },
		])
			assert.throws(() => validateRuleEvent({ ...decision, audit: input }), /authorization/);
		const stale = { ...decision, proposalRevision: "000000000000" };
		assert.equal(reduceRuleEvents([approved[0], p, stale]).records.size, 0);
		assert.equal(reduceRuleEvents([approved[0], p, { ...decision, audit: agent }]).records.size, 0);
		const direct = validateRuleEvent({
			kind: "definition",
			id: "11111111-1111-4111-8111-111111111111",
			ruleId: p.ruleId,
			state: "retired",
			reason: "Not allowed.",
			audit: approvalAudit,
		});
		const record = reduceRuleEvents([...approved, direct]).records.get(p.ruleId);
		assert.ok(record);
		assert.equal(effectiveState(record), "active");
	});
});
