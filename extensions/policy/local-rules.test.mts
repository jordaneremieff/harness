import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	MAX_GUIDANCE_TEXT_BYTES,
	MAX_LOCAL_RULES,
	MAX_PENDING_PROPOSALS,
	MAX_RULE_ID_LENGTH,
	RULES_FILE,
	RuleRegistry,
	makeRuleAudit,
	reduceRuleEvents,
	ruleStoreHealthLine,
	validateLocalCandidate,
	validatePackageDefinitionRow,
	validateRuleEvent,
	type CatalogEvent,
	type DecisionEvent,
	type ProposalEvent,
	type RuleEvent,
} from "./local-rules.ts";
import { matchRuleRecords } from "./classify.ts";
import {
	effectiveEffect,
	effectiveState,
	packageRowRevision,
	type PackageDefinitionRow,
	type SessionRuleAudit,
} from "./rule.ts";
import { PACKAGE_CATALOG } from "./shell-rules.ts";

let nextId = 1;
const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
const sessionAudit = (surface: "agent-tool" | "command" | "panel" = "command"): SessionRuleAudit => ({
	at: "2026-09-01T10:00:00.000Z",
	session: "session-1",
	model: "openai/gpt-5",
	surface,
});
const row = (ruleId: string, note = `Prefer ${ruleId}.`, effect: "steer" | "block" = "block"): PackageDefinitionRow => {
	const value = {
		id: ruleId,
		domain: "tool-call" as const,
		matcher: { kind: "code" as const, key: ruleId },
		effect,
		note,
	};
	return { ...value, revision: packageRowRevision(value) };
};
const catalog = (...rows: PackageDefinitionRow[]): CatalogEvent => ({
	kind: "catalog",
	rows,
	audit: { surface: "package" },
});
const candidate = (ruleId = "local.prefer-rg") => ({
	id: ruleId,
	domain: "tool-call" as const,
	matcher: {
		kind: "declarative" as const,
		language: "command-shape/v1" as const,
		spec: { command: "grep", flags: ["-R"], operands: { min: 1 }, pipe: { to: false } },
	},
	note: "Prefer rg for bounded repository search.",
	suggestion: { command: "rg", flags: ["-n"] },
	scope: { modelProviders: ["openai"], models: ["openai/gpt-5"], cwdPrefixes: ["/work"] },
});
const proposal = (operation: "add" | "retire" | "disable", ruleId: string): ProposalEvent => ({
	kind: "proposal",
	id: id(),
	operation,
	ruleId,
	reason: `Please ${operation} this rule`,
	...(operation === "add"
		? {
				candidate: {
					domain: "tool-call" as const,
					matcher: candidate(ruleId).matcher,
					note: candidate(ruleId).note,
					suggestion: candidate(ruleId).suggestion,
					scope: candidate(ruleId).scope,
				},
			}
		: {}),
	audit: sessionAudit("agent-tool") as ReturnType<typeof makeRuleAudit> & { surface: "agent-tool" },
});
const decision = (
	proposalId: string,
	decisionValue: "approved" | "rejected",
	effect?: "steer" | "block",
	surface: "agent-tool" | "command" | "panel" = "command",
): DecisionEvent => ({
	kind: "decision",
	id: id(),
	proposalId,
	decision: decisionValue,
	...(effect ? { effect } : {}),
	audit: sessionAudit(surface),
});
const tempDir = async () => {
	const dir = join(await mkdtemp(join(tmpdir(), "policy-rules-")), "store");
	return dir;
};

async function lines(dir: string): Promise<RuleEvent[]> {
	return (await readFile(join(dir, RULES_FILE), "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => validateRuleEvent(JSON.parse(line)));
}

describe("strict event model", () => {
	it("validates closed command-shape candidates, id length, and guidance bytes", () => {
		assert.equal(validateLocalCandidate(candidate()).id, "local.prefer-rg");
		const maximumId = `a${"b".repeat(MAX_RULE_ID_LENGTH - 1)}`;
		assert.equal(validateLocalCandidate(candidate(maximumId)).id, maximumId);
		assert.throws(() => validateLocalCandidate(candidate(`${maximumId}b`)), /at most|between 1 and 80/);
		assert.throws(() => validateLocalCandidate({ ...candidate(), extra: true }), /unknown field/);
		assert.throws(
			() => validateLocalCandidate({ ...candidate(), matcher: { ...candidate().matcher, language: "regex/v1" } }),
			/command-shape\/v1/,
		);
		assert.throws(
			() => validateLocalCandidate({ ...candidate(), note: "x".repeat(MAX_GUIDANCE_TEXT_BYTES + 1) }),
			/guidance/,
		);
		assert.throws(() => validateLocalCandidate({ ...candidate(), scope: { cwdPrefixes: ["relative"] } }), /absolute/);
	});

	it("rejects unknown event fields and missing mandatory reasons", () => {
		const event = proposal("disable", "routing.cat-read");
		assert.throws(() => validateRuleEvent({ ...event, surprise: true }), /unknown field/);
		assert.throws(() => validateRuleEvent({ ...event, reason: "" }), /reason/);
		assert.throws(
			() =>
				validateRuleEvent({
					kind: "override",
					id: id(),
					ruleId: "routing.cat-read",
					operation: "clear",
					audit: sessionAudit(),
				}),
			/missing field "reason"/,
		);
	});

	it("enforces package id equals code matcher key", () => {
		const valid = row("routing.example");
		assert.equal(validatePackageDefinitionRow(valid).matcher.key, valid.id);
		const mismatched = {
			...valid,
			matcher: { kind: "code" as const, key: "routing.other" },
		};
		const withMatchingRevision = { ...mismatched, revision: packageRowRevision(mismatched) };
		assert.throws(() => validatePackageDefinitionRow(withMatchingRevision), /id must equal.*matcher key/);
		for (const installed of PACKAGE_CATALOG) assert.equal(installed.id, installed.matcher.key);
	});

	it("accepts an empty complete catalog and rejects duplicate rows", () => {
		assert.deepEqual(validateRuleEvent(catalog()), catalog());
		assert.throws(() => validateRuleEvent(catalog(row("routing.a"), row("routing.a"))), /unique/);
	});
});

describe("event reduction", () => {
	it("treats each catalog as the complete installed set and preserves overrides", () => {
		const firstA = row("routing.a", "A v1");
		const firstB = row("routing.b", "B v1");
		const changedA = row("routing.a", "A v2");
		const override = {
			kind: "override" as const,
			id: id(),
			ruleId: firstA.id,
			operation: "set" as const,
			override: {
				effect: "steer" as const,
				reason: "Operator calibration",
				audit: sessionAudit("command"),
				againstDefinitionRevision: firstA.revision,
			},
		};
		const reduced = reduceRuleEvents([catalog(firstA, firstB), override, catalog(changedA)]);
		assert.equal(reduced.records.get(firstA.id)?.definition.note, "A v2");
		assert.equal(reduced.records.get(firstA.id)?.override?.reason, "Operator calibration");
		assert.equal(reduced.records.get(firstA.id)?.staleOverride, true);
		assert.equal(reduced.records.get(firstB.id)?.definition.state, "retired");

		const returned = reduceRuleEvents([catalog(firstA, firstB), override, catalog(changedA), catalog(firstA, firstB)]);
		assert.equal(returned.records.get(firstB.id)?.definition.state, "active");
		assert.equal(returned.records.get(firstA.id)?.override?.effect, "steer");
	});

	it("requires an operator decision and keeps rejected proposals inert", () => {
		const add = proposal("add", "local.one");
		const agentApproval = decision(add.id, "approved", "block", "agent-tool");
		let reduced = reduceRuleEvents([add, agentApproval]);
		assert.equal(reduced.records.has("local.one"), false);
		assert.equal(reduced.pending.length, 1);
		reduced = reduceRuleEvents([add, decision(add.id, "rejected")]);
		assert.equal(reduced.records.has("local.one"), false);
		assert.equal(reduced.pending.length, 0);
	});

	it("creates an immutable local id only after add approval", () => {
		const add = proposal("add", "local.one");
		const reduced = reduceRuleEvents([add, decision(add.id, "approved", "steer")]);
		const record = reduced.records.get("local.one");
		assert.equal(record?.source.kind, "local");
		assert.equal(record?.definition.effect, "steer");
		assert.equal(record?.definition.state, "active");
		assert.equal(record?.matcher.kind, "declarative");
		assert.equal(reduced.pending.length, 0);
	});

	it("revises a minimal add candidate consistently when optional fields are absent", () => {
		const add: ProposalEvent = {
			kind: "proposal",
			id: id(),
			operation: "add",
			ruleId: "local.minimal",
			reason: "Minimal local rule",
			candidate: {
				domain: "tool-call",
				matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "scan" } },
				note: "Use scan carefully.",
			},
			audit: sessionAudit("agent-tool") as never,
		};
		const record = reduceRuleEvents([add, decision(add.id, "approved", "steer")]).records.get(add.ruleId);
		assert.match(record?.definition.revision ?? "", /^[0-9a-f]{12}$/);
	});

	it("composes approved disable with an existing effect override", () => {
		const installed = row("routing.a");
		const setEffect = {
			kind: "override" as const,
			id: id(),
			ruleId: installed.id,
			operation: "set" as const,
			override: {
				effect: "steer" as const,
				reason: "Lower failure cost",
				audit: sessionAudit("command"),
				againstDefinitionRevision: installed.revision,
			},
		};
		const disable = proposal("disable", installed.id);
		const revised = row(installed.id, "A revised before approval");
		const reduced = reduceRuleEvents([
			catalog(installed),
			setEffect,
			disable,
			catalog(revised),
			decision(disable.id, "approved", undefined, "panel"),
		]);
		const record = reduced.records.get(installed.id)!;
		assert.equal(record.override?.state, "disabled");
		assert.equal(record.override?.effect, "steer");
		assert.equal(record.override?.reason, disable.reason);
		assert.equal(record.override?.audit.surface, "panel");
		assert.equal(record.override?.againstDefinitionRevision, revised.revision);
		assert.equal(record.staleOverride, false);
	});

	it("ignores agent-surface override and definition events", () => {
		const installed = row("routing.a");
		const add = proposal("add", "local.one");
		const events: RuleEvent[] = [
			catalog(installed),
			{
				kind: "override",
				id: id(),
				ruleId: installed.id,
				operation: "set",
				override: {
					state: "disabled",
					reason: "Agent attempted authority",
					audit: sessionAudit("agent-tool"),
					againstDefinitionRevision: installed.revision,
				},
			},
			add,
			decision(add.id, "approved", "block"),
			{
				kind: "definition",
				id: id(),
				ruleId: "local.one",
				state: "retired",
				reason: "Agent attempted authority",
				audit: sessionAudit("agent-tool"),
			},
		];
		const reduced = reduceRuleEvents(events);
		assert.equal(reduced.records.get(installed.id)?.override, undefined);
		assert.equal(reduced.records.get("local.one")?.definition.state, "active");
	});

	it("does not count package rows toward the local rule cap", () => {
		const rows = Array.from({ length: MAX_LOCAL_RULES + 10 }, (_, index) => row(`routing.package-${index}`));
		assert.equal(reduceRuleEvents([catalog(...rows)]).records.size, MAX_LOCAL_RULES + 10);
	});
});

describe("RuleRegistry catalog synchronization", () => {
	it("syncs package changes as full catalog events and preserves an override across removal and return", async () => {
		const dir = await tempDir();
		const a1 = row("routing.a", "A v1");
		const b = row("routing.b", "B");
		let registry = new RuleRegistry(dir, { catalog: [a1], matcherAvailable: () => true, onNotice: assert.fail });
		let snapshot = await registry.snapshot();
		assert.equal(snapshot.records.get(a1.id)?.definition.note, "A v1");
		assert.deepEqual(await lines(dir), [catalog(a1)]);
		await registry.snapshot();
		assert.deepEqual(await lines(dir), [catalog(a1)], "idempotent snapshot must not append a catalog event");

		const a2 = row("routing.a", "A v2");
		registry = new RuleRegistry(dir, { catalog: [a2, b], matcherAvailable: () => true, onNotice: assert.fail });
		snapshot = await registry.snapshot();
		assert.equal(snapshot.records.get(a2.id)?.definition.note, "A v2");
		assert.equal(snapshot.records.get(b.id)?.definition.state, "active");
		assert.deepEqual(await lines(dir), [catalog(a1), catalog(a2, b)]);

		registry = new RuleRegistry(dir, { catalog: [b, a2], matcherAvailable: () => true, onNotice: assert.fail });
		await registry.snapshot();
		assert.deepEqual(await lines(dir), [catalog(a1), catalog(a2, b)], "catalog order alone must not append an event");
		await registry.setEffect(b.id, "steer", "Keep this calibration", sessionAudit());

		registry = new RuleRegistry(dir, { catalog: [a2], matcherAvailable: () => true, onNotice: assert.fail });
		snapshot = await registry.snapshot();
		assert.equal(snapshot.records.get(b.id)?.definition.state, "retired");
		assert.equal(snapshot.records.get(b.id)?.override?.reason, "Keep this calibration");

		registry = new RuleRegistry(dir, { catalog: [a2, b], matcherAvailable: () => true, onNotice: assert.fail });
		snapshot = await registry.snapshot();
		assert.equal(snapshot.records.get(b.id)?.definition.state, "active");
		assert.equal(snapshot.records.get(b.id)?.override?.effect, "steer");
		assert.equal(snapshot.records.get(b.id)?.override?.reason, "Keep this calibration");
		const events = await lines(dir);
		assert.deepEqual(
			events.filter((event): event is CatalogEvent => event.kind === "catalog"),
			[catalog(a1), catalog(a2, b), catalog(a2), catalog(a2, b)],
		);
		assert.deepEqual(
			events.map((event) => event.kind),
			["catalog", "catalog", "override", "catalog", "catalog"],
		);
	});

	it("makes concurrent catalog payloads byte-identical across opposite installed row order", async () => {
		const dir = await tempDir();
		const a = row("routing.a");
		const b = row("routing.b");
		const first = { catalog: [a, b], matcherAvailable: () => true, onNotice: assert.fail };
		const second = { catalog: [b, a], matcherAvailable: () => true, onNotice: assert.fail };
		await Promise.all([new RuleRegistry(dir, first).snapshot(), new RuleRegistry(dir, second).snapshot()]);
		const payloads = (await readFile(join(dir, RULES_FILE), "utf8")).trim().split("\n");
		assert.ok(payloads.length === 1 || payloads.length === 2);
		assert.equal(new Set(payloads).size, 1);
		for (const payload of payloads) assert.deepEqual(validateRuleEvent(JSON.parse(payload)), catalog(a, b));
		assert.equal((await stat(join(dir, RULES_FILE))).mode & 0o777, 0o600);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
	});

	it("retains a colliding local record without degrading other overrides or writes", async () => {
		const dir = await tempDir();
		const collisionId = "routing.collision";
		const installedCollision = row(collisionId, "Package collision must be skipped");
		const other = row("routing.other", "Other package rule");
		const add = proposal("add", collisionId);
		const otherOverride: RuleEvent = {
			kind: "override",
			id: id(),
			ruleId: other.id,
			operation: "set",
			override: {
				effect: "steer",
				reason: "Keep this operator calibration",
				audit: sessionAudit(),
				againstDefinitionRevision: other.revision,
			},
		};
		await mkdir(dir, { mode: 0o700 });
		await writeFile(
			join(dir, RULES_FILE),
			`${[add, decision(add.id, "approved", "steer"), catalog(installedCollision, other), otherOverride]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
			{ mode: 0o600 },
		);
		const notices: string[] = [];
		const registry = new RuleRegistry(dir, {
			catalog: [installedCollision, other],
			matcherAvailable: () => true,
			onNotice: (message) => notices.push(message),
		});
		let snapshot = await registry.snapshot();
		const collision = snapshot.records.get(collisionId)!;
		assert.equal(collision.source.kind, "local");
		assert.equal(collision.definition.note, candidate(collisionId).note);
		assert.equal(snapshot.records.size, 2);
		assert.equal(snapshot.records.get(other.id)?.override?.reason, "Keep this operator calibration");
		assert.equal(snapshot.records.get(other.id)?.override?.effect, "steer");
		assert.equal(snapshot.health.status, "ok");
		assert.deepEqual(snapshot.health.catalogCollisions, [collisionId]);
		assert.match(ruleStoreHealthLine(snapshot.health), /degraded=false.*routing\.collision/);
		assert.deepEqual(
			matchRuleRecords("bash", "grep -R needle src", [collision], {
				cwd: "/work/project",
				provider: "openai",
				model: "openai/gpt-5",
			}),
			[collision],
		);
		assert.deepEqual(notices, []);

		await registry.disable(other.id, "Writes remain available", sessionAudit());
		snapshot = await registry.snapshot();
		assert.equal(effectiveState(snapshot.records.get(other.id)!), "disabled");
		assert.equal(snapshot.health.status, "ok");
		assert.deepEqual(snapshot.health.catalogCollisions, [collisionId]);
	});

	it("marks a package matcher unavailable without changing its definition", async () => {
		const installed = row("routing.unavailable");
		const registry = new RuleRegistry(await tempDir(), {
			catalog: [installed],
			matcherAvailable: () => false,
			onNotice: assert.fail,
		});
		const record = (await registry.snapshot()).records.get(installed.id)!;
		assert.equal(record.definition.state, "active");
		assert.equal(record.matcherAvailable, false);
	});

	it("performs no filesystem work in the constructor", async () => {
		const dir = await tempDir();
		new RuleRegistry(dir, { catalog: [row("routing.a")], matcherAvailable: () => true, onNotice: assert.fail });
		await assert.rejects(stat(dir), /ENOENT/);
	});
});

describe("RuleRegistry operator gates and override composition", () => {
	it("keeps an effect override through disable and enable", async () => {
		const dir = await tempDir();
		const installed = row("routing.a", "A", "block");
		const registry = new RuleRegistry(dir, {
			catalog: [installed],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		await registry.setEffect(installed.id, "steer", "Calibrate effect", sessionAudit("command"));
		await registry.disable(installed.id, "Pause this rule", sessionAudit("command"));
		let record = (await registry.snapshot()).records.get(installed.id)!;
		assert.equal(effectiveState(record), "disabled");
		assert.equal(effectiveEffect(record), "steer");
		assert.equal(record.override?.effect, "steer");
		assert.equal(record.override?.reason, "Pause this rule");

		await registry.enable(installed.id, "Resume but retain effect", sessionAudit("command"));
		record = (await registry.snapshot()).records.get(installed.id)!;
		assert.equal(effectiveState(record), "active");
		assert.equal(effectiveEffect(record), "steer");
		assert.equal(record.override?.state, undefined);
		assert.equal(record.override?.effect, "steer");
		assert.equal(record.override?.reason, "Resume but retain effect");

		const events = await lines(dir);
		const slots = events.filter((event) => event.kind === "override" && event.operation === "set");
		assert.deepEqual(
			slots.map((event) => ({
				state: event.override.state,
				effect: event.override.effect,
				againstDefinitionRevision: event.override.againstDefinitionRevision,
			})),
			[
				{ state: undefined, effect: "steer", againstDefinitionRevision: installed.revision },
				{ state: "disabled", effect: "steer", againstDefinitionRevision: installed.revision },
				{ state: undefined, effect: "steer", againstDefinitionRevision: installed.revision },
			],
		);
	});

	it("uses a clear when enable leaves no override fields", async () => {
		const installed = row("routing.a");
		const registry = new RuleRegistry(await tempDir(), {
			catalog: [installed],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		await registry.disable(installed.id, "Pause", sessionAudit("panel"));
		const clear = await registry.enable(installed.id, "Resume", sessionAudit("panel"));
		assert.equal(clear.operation, "clear");
		assert.equal((await registry.snapshot()).records.get(installed.id)?.override, undefined);
	});

	it("allows direct overrides for package rules but direct retirement only for local rules", async () => {
		const registry = new RuleRegistry(await tempDir(), {
			catalog: [row("routing.a")],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		await registry.disable("routing.a", "Operator pause", sessionAudit());
		await assert.rejects(registry.retire("routing.a", "Cannot retire package", sessionAudit()), /only local rules/);
		const add = await registry.proposeAdd(candidate("local.one"), "Add local", sessionAudit("agent-tool") as never);
		await registry.decide(add.id, "approved", "block", sessionAudit());
		const activeRevision = (await registry.snapshot()).records.get("local.one")?.definition.revision;
		await registry.retire("local.one", "No longer useful", sessionAudit("panel"));
		const retired = (await registry.snapshot()).records.get("local.one");
		assert.equal(retired?.definition.state, "retired");
		assert.equal(retired?.definition.revision, activeRevision);
	});

	it("refuses agent-surface decisions, overrides, and definitions at the writer", async () => {
		const registry = new RuleRegistry(await tempDir(), {
			catalog: [row("routing.a")],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		const add = await registry.proposeAdd(candidate("local.one"), "Add local", sessionAudit("agent-tool") as never);
		await assert.rejects(registry.decide(add.id, "approved", "block", sessionAudit("agent-tool")), /operator surface/);
		await assert.rejects(registry.disable("routing.a", "Agent pause", sessionAudit("agent-tool")), /operator surface/);
		await registry.decide(add.id, "approved", "block", sessionAudit("command"));
		await assert.rejects(
			registry.retire("local.one", "Agent retirement", sessionAudit("agent-tool")),
			/definition events require an operator surface/,
		);
	});

	it("refuses approval when the proposal target has since retired", async () => {
		const dir = await tempDir();
		const installed = row("routing.a");
		let registry = new RuleRegistry(dir, {
			catalog: [installed],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		const pending = await registry.proposeDisable(
			installed.id,
			"Pause after review",
			sessionAudit("agent-tool") as never,
		);
		registry = new RuleRegistry(dir, { catalog: [], matcherAvailable: () => true, onNotice: assert.fail });
		assert.equal((await registry.snapshot()).records.get(installed.id)?.definition.state, "retired");
		await assert.rejects(
			registry.decide(pending.id, "approved", undefined, sessionAudit("panel")),
			/cannot approve disable proposal: target "routing\.a" is retired/,
		);
		assert.equal((await registry.snapshot()).pending[0]?.id, pending.id);
	});

	it("approves against a changed definition revision and tracks later divergence", async () => {
		const dir = await tempDir();
		const first = row("routing.a", "First definition");
		let registry = new RuleRegistry(dir, {
			catalog: [first],
			matcherAvailable: () => true,
			onNotice: assert.fail,
		});
		const pending = await registry.proposeDisable(
			first.id,
			"Approve against the current definition",
			sessionAudit("agent-tool") as never,
		);
		const changed = row(first.id, "Changed before approval");
		registry = new RuleRegistry(dir, { catalog: [changed], matcherAvailable: () => true, onNotice: assert.fail });
		await registry.decide(pending.id, "approved", undefined, sessionAudit("command"));
		let record = (await registry.snapshot()).records.get(first.id)!;
		assert.equal(record.override?.againstDefinitionRevision, changed.revision);
		assert.equal(record.staleOverride, false);

		const changedAgain = row(first.id, "Changed after approval");
		registry = new RuleRegistry(dir, { catalog: [changedAgain], matcherAvailable: () => true, onNotice: assert.fail });
		record = (await registry.snapshot()).records.get(first.id)!;
		assert.equal(record.override?.againstDefinitionRevision, changed.revision);
		assert.equal(record.staleOverride, true);
	});

	it("makeRuleAudit records exact surface, model, session, and time", () => {
		const audit = makeRuleAudit(
			{ sessionManager: { getSessionId: () => "s2" }, model: { provider: "anthropic", id: "claude" } },
			"panel",
			new Date("2026-10-01T00:00:00Z"),
		);
		assert.deepEqual(audit, {
			at: "2026-10-01T00:00:00.000Z",
			session: "s2",
			model: "anthropic/claude",
			surface: "panel",
		});
	});
});

describe("unreadable and append-in-flight stores", () => {
	it("falls back to package defaults, reports a concrete line repair, and refuses writes", async () => {
		const dir = await tempDir();
		await mkdir(dir, { mode: 0o700 });
		const installed = row("routing.default");
		await writeFile(join(dir, RULES_FILE), `${JSON.stringify(catalog(installed))}\n{"kind":"broken"}\n`, {
			mode: 0o600,
		});
		const notices: string[] = [];
		const registry = new RuleRegistry(dir, {
			catalog: [installed],
			matcherAvailable: () => true,
			onNotice: (message) => notices.push(message),
		});
		let snapshot = await registry.snapshot();
		assert.equal(snapshot.health.status, "degraded");
		assert.equal(snapshot.health.line, 2);
		assert.match(snapshot.health.message ?? "", new RegExp(`${RULES_FILE}.*line 2`));
		assert.match(
			snapshot.health.repair ?? "",
			/append-only JSONL with one event per line; edit or remove line 2, then start a new policy session/,
		);
		assert.deepEqual([...snapshot.records.keys()], [installed.id]);
		assert.equal(notices.length, 1);
		snapshot = await registry.snapshot();
		assert.equal(snapshot.health.status, "degraded");
		assert.equal(notices.length, 1);
		await assert.rejects(registry.disable(installed.id, "Should fail", sessionAudit()), /writes are refused/);
	});

	it("attributes a reduction invariant failure to the event line that exceeded the bound", async () => {
		const dir = await tempDir();
		await mkdir(dir, { mode: 0o700 });
		const events = Array.from({ length: MAX_PENDING_PROPOSALS + 1 }, (_, index) =>
			proposal("add", `local.pending-${index}`),
		);
		await writeFile(join(dir, RULES_FILE), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
			mode: 0o600,
		});
		const registry = new RuleRegistry(dir, { catalog: [], matcherAvailable: () => true, onNotice: () => {} });
		const snapshot = await registry.snapshot();
		assert.equal(snapshot.health.status, "degraded");
		assert.equal(snapshot.health.line, MAX_PENDING_PROPOSALS + 1);
		assert.match(
			snapshot.health.message ?? "",
			new RegExp(`line ${MAX_PENDING_PROPOSALS + 1}: rule store exceeds ${MAX_PENDING_PROPOSALS} pending proposals`),
		);
		assert.match(snapshot.health.repair ?? "", new RegExp(`edit or remove line ${MAX_PENDING_PROPOSALS + 1}`));
	});

	it("reports a file-level failure as the failing property with its repair action", async () => {
		const dir = await tempDir();
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, RULES_FILE), "", { mode: 0o600 });
		await chmod(join(dir, RULES_FILE), 0o644);
		const registry = new RuleRegistry(dir, { catalog: [], matcherAvailable: () => true, onNotice: () => {} });
		const snapshot = await registry.snapshot();
		assert.equal(snapshot.health.status, "degraded");
		assert.equal(snapshot.health.line, undefined);
		assert.equal(snapshot.health.property, "file mode");
		assert.match(snapshot.health.message ?? "", /failing property "file mode"/);
		assert.doesNotMatch(snapshot.health.message ?? "", /line 0/);
		assert.match(snapshot.health.repair ?? "", /set .*rules\.jsonl mode to 0600/);
	});

	it("skips only an incomplete final line, reports it once, and refuses writes until repaired", async () => {
		const dir = await tempDir();
		const stored = row("routing.default", "Stored v1");
		const installed = row("routing.default", "Installed v2");
		const completeOverride: RuleEvent = {
			kind: "override",
			id: id(),
			ruleId: stored.id,
			operation: "set",
			override: {
				effect: "steer",
				reason: "Complete preceding event",
				audit: sessionAudit(),
				againstDefinitionRevision: stored.revision,
			},
		};
		const completePrefix = `${JSON.stringify(catalog(stored))}\n${JSON.stringify(completeOverride)}\n`;
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, RULES_FILE), `${completePrefix}{"kind":"proposal"`, { mode: 0o600 });
		const notices: string[] = [];
		const registry = new RuleRegistry(dir, {
			catalog: [installed],
			matcherAvailable: () => true,
			onNotice: (message) => notices.push(message),
		});
		const snapshot = await registry.snapshot();
		assert.equal(snapshot.health.status, "ok");
		assert.equal(snapshot.health.incompleteFinalLine, 3);
		assert.equal(snapshot.records.get(installed.id)?.definition.note, "Installed v2");
		assert.equal(snapshot.records.get(installed.id)?.override?.effect, "steer");
		await registry.snapshot();
		assert.equal(notices.length, 1);
		await assert.rejects(
			registry.disable(installed.id, "Wait", sessionAudit()),
			/append in flight.*writes are refused/i,
		);

		await writeFile(join(dir, RULES_FILE), completePrefix, { mode: 0o600 });
		await chmod(join(dir, RULES_FILE), 0o600);
		await registry.disable(installed.id, "Repaired", sessionAudit());
		const repairedEvents = await lines(dir);
		assert.equal(repairedEvents[2]?.kind, "catalog");
		if (repairedEvents[2]?.kind === "catalog") assert.equal(repairedEvents[2].rows[0]?.revision, installed.revision);
		assert.equal(repairedEvents[3]?.kind, "override");
		if (repairedEvents[3]?.kind === "override" && repairedEvents[3].operation === "set") {
			assert.equal(repairedEvents[3].override.effect, "steer");
			assert.equal(repairedEvents[3].override.againstDefinitionRevision, installed.revision);
		}
	});
});
