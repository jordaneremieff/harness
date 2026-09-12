import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsPromises, { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { PACKAGE_CATALOG } from "./catalog.ts";
import {
	type CatalogEvent,
	type CatalogImportEvent,
	MAX_GUIDANCE_TEXT_BYTES,
	MAX_PENDING_PROPOSALS,
	MAX_RULE_ID_LENGTH,
	MAX_RULES,
	makeRuleAudit,
	namedDataRevision,
	type ProposalEvent,
	proposalRevision,
	RULES_FILE,
	type RuleEvent,
	RuleRegistry,
	reduceRuleEvents,
	ruleStoreHealthLine,
	validateLocalCandidate,
	validatePackageDefinitionRow,
	validateRuleEvent,
} from "./local-rules.ts";
import {
	contentRevision,
	effectiveEffect,
	effectiveState,
	type PackageDefinitionRow,
	packageRowRevision,
	type SessionRuleAudit,
} from "./rule.ts";

const sessionAudit = (surface: "agent-tool" | "command" | "panel" = "command"): SessionRuleAudit => ({
	at: "2026-09-01T10:00:00.000Z",
	session: "session-1",
	model: "provider/model",
	surface,
});
const agent = { ...sessionAudit(), surface: "agent-tool" as const };
const row = (id: string, note = "Bound this command."): PackageDefinitionRow => {
	const value = {
		id,
		purpose: "Keep output bounded.",
		authority: "steer-or-block" as const,
		matcher: { kind: "code" as const, key: "routing.cat-read" },
		effect: "block" as const,
		note,
	};
	return { ...value, revision: packageRowRevision(value) };
};
const catalog = (...rows: PackageDefinitionRow[]): CatalogEvent => ({
	kind: "catalog",
	rows,
	audit: { surface: "package" },
});
const candidate = (id = "operator.scan") => ({
	id,
	purpose: "Keep search output bounded.",
	authority: "steer-or-block" as const,
	matcher: { kind: "declarative" as const, language: "command-shape/v1" as const, spec: { command: "scan" } },
	note: "Prefer bounded search.",
	suggestion: { command: "scan", flags: ["--limit"] },
	scope: { models: ["provider/model"], cwdPrefixes: ["/work"] },
});
const proposal = (ruleId: string): ProposalEvent => {
	const { id: _id, ...value } = candidate(ruleId);
	return {
		kind: "proposal",
		id: randomUUID(),
		operation: "add",
		ruleId,
		candidate: value,
		reason: "Bound output.",
		audit: agent,
	};
};
async function directory(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "policy-rules-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return join(root, "store");
}
const registry = (dir: string, rows: PackageDefinitionRow[] = []) =>
	new RuleRegistry(dir, { catalog: rows, onNotice: assert.fail });
async function events(dir: string): Promise<RuleEvent[]> {
	return (await readFile(join(dir, RULES_FILE), "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => validateRuleEvent(JSON.parse(line)));
}
async function importRows(reg: RuleRegistry, selection = "--all") {
	return reg.importCatalog(selection, (await reg.planImport(selection)).revision, sessionAudit());
}

describe("strict rule events", () => {
	it("validates closed candidates, ids, scope, reasons, and guidance bytes", () => {
		assert.equal(validateLocalCandidate(candidate()).id, "operator.scan");
		const max = `a${"b".repeat(MAX_RULE_ID_LENGTH - 1)}`;
		assert.equal(validateLocalCandidate(candidate(max)).id, max);
		assert.throws(() => validateLocalCandidate(candidate(`${max}b`)), /between 1 and 80/);
		assert.throws(() => validateLocalCandidate({ ...candidate(), extra: true }), /unknown field/);
		assert.throws(
			() => validateLocalCandidate({ ...candidate(), matcher: { kind: "code", key: "../predicate" } }),
			/rule id/,
		);
		assert.throws(
			() => validateLocalCandidate({ ...candidate(), note: "x".repeat(MAX_GUIDANCE_TEXT_BYTES + 1) }),
			/guidance/,
		);
		assert.throws(() => validateLocalCandidate({ ...candidate(), scope: { cwdPrefixes: ["relative"] } }), /absolute/);
		assert.throws(() => validateRuleEvent({ ...proposal("operator.one"), reason: "" }), /reason/);
		assert.throws(() => validateRuleEvent({ ...proposal("operator.one"), surprise: true }), /unknown field/);
	});
	it("permits separate rule and predicate identities without arbitrary matcher fields", () => {
		const value = row("operator.read-file");
		assert.equal(validatePackageDefinitionRow(value).matcher.kind, "code");
		assert.equal(validateLocalCandidate({ ...candidate(), matcher: value.matcher }).matcher.kind, "code");
		assert.throws(
			() => validateLocalCandidate({ ...candidate(), matcher: { ...value.matcher, path: "/code" } }),
			/unknown field/,
		);
		for (const installed of PACKAGE_CATALOG) validatePackageDefinitionRow(installed);
	});
	it("retains the current initial catalog shape and rejects repeated package authority", () => {
		assert.deepEqual(validateRuleEvent(catalog()), catalog());
		assert.throws(() => validateRuleEvent(catalog(row("operator.a"), row("operator.a"))), /unique/);
		assert.throws(() => reduceRuleEvents([catalog(), catalog(row("operator.a"))]), /first event/);
	});
	it("ignores agent approvals, overrides, and direct retirement", () => {
		const add = proposal("operator.one");
		const initial = row("operator.initial");
		const reduced = reduceRuleEvents([
			catalog(initial),
			add,
			{ kind: "decision", id: randomUUID(), proposalId: add.id, decision: "approved", effect: "block", audit: agent },
			{
				kind: "override",
				id: randomUUID(),
				ruleId: initial.id,
				operation: "set",
				override: { state: "disabled", reason: "Pause.", audit: agent, againstDefinitionRevision: initial.revision },
			},
			{ kind: "definition", id: randomUUID(), ruleId: initial.id, state: "retired", reason: "Retire.", audit: agent },
		]);
		assert.equal(reduced.records.has(add.ruleId), false);
		assert.equal(reduced.pending.length, 1);
		assert.equal(effectiveState(reduced.records.get(initial.id)!), "active");
	});
	it("retains the explicit audit source and exact time", () => {
		assert.deepEqual(
			makeRuleAudit(
				{ sessionManager: { getSessionId: () => "s2" }, model: { provider: "provider", id: "model" } },
				"panel",
				new Date("2026-10-01T00:00:00Z"),
			),
			{ at: "2026-10-01T00:00:00.000Z", session: "s2", model: "provider/model", surface: "panel" },
		);
	});
});

describe("starter catalog ownership", () => {
	it("performs no filesystem work in the constructor", async (t) => {
		const dir = await directory(t);
		registry(dir, [row("operator.a")]);
		await assert.rejects(stat(dir), /ENOENT/);
	});
	it("publishes exactly one complete private seed under concurrent starters", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const b = row("operator.b");
		const snapshots = await Promise.all(
			Array.from({ length: 24 }, (_, index) => registry(dir, index % 2 ? [a, b] : [b, a]).snapshot()),
		);
		for (const snapshot of snapshots) {
			assert.equal(snapshot.records.size, 2);
			assert.equal(snapshot.health.incompleteFinalLine, undefined);
		}
		assert.deepEqual(await events(dir), [catalog(a, b)]);
		assert.deepEqual(await readdir(dir), [RULES_FILE]);
		assert.equal((await stat(join(dir, RULES_FILE))).mode & 0o777, 0o600);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
	});
	it("preserves intentionally empty existing files and empty seed events", async (t) => {
		for (const content of ["", `${JSON.stringify(catalog())}\n`]) {
			const dir = await directory(t);
			await mkdir(dir, { mode: 0o700 });
			await writeFile(join(dir, RULES_FILE), content, { mode: 0o600 });
			assert.equal((await registry(dir, [row("operator.a")]).snapshot()).records.size, 0);
			assert.equal(await readFile(join(dir, RULES_FILE), "utf8"), content);
		}
	});
	it("does not update, remove, restore, or supplement definitions on reload", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const b = row("operator.b");
		const reg = registry(dir, [a, b]);
		await reg.disable(a.id, "Pause this rule.", sessionAudit());
		await reg.retire(b.id, "Remove this rule.", sessionAudit());
		const before = await readFile(reg.path, "utf8");
		for (const nextRows of [[], [row(a.id, "Changed source."), row("operator.c")], [a, b]]) {
			const next = await registry(dir, nextRows).snapshot();
			assert.equal(next.records.get(a.id)?.definition.revision, a.revision);
			assert.equal(effectiveState(next.records.get(a.id)!), "disabled");
			assert.equal(effectiveState(next.records.get(b.id)!), "retired");
			assert.equal(next.records.size, 2);
			assert.equal(await readFile(reg.path, "utf8"), before);
		}
	});
	it("supports replacement, retirement, and disable for seeded and imported rules", async (t) => {
		const dir = await directory(t);
		const initial = row("operator.a");
		const reg = registry(dir, [initial]);
		await reg.setEffect(initial.id, "steer", "Calibrate effect.", sessionAudit());
		await reg.disable(initial.id, "Pause.", sessionAudit());
		const replacement = await reg.proposeReplace(
			{ ...candidate(initial.id), matcher: initial.matcher },
			initial.revision,
			"Edit seeded rule.",
			agent,
		);
		await assert.rejects(reg.decide(replacement.id, "approved", "block", sessionAudit()), /exact proposal revision/);
		await reg.decide(replacement.id, "approved", "block", sessionAudit(), proposalRevision(replacement));
		let record = (await registry(dir, [initial]).snapshot()).records.get(initial.id)!;
		assert.equal(record.definition.note, candidate().note);
		assert.equal(effectiveState(record), "disabled");
		assert.equal(effectiveEffect(record), "steer");
		await reg.enable(initial.id, "Resume.", sessionAudit());
		assert.equal(effectiveEffect((await reg.snapshot()).records.get(initial.id)!), "steer");
		const retirement = await reg.proposeRetire(initial.id, "Retire.", agent);
		await reg.decide(retirement.id, "approved", undefined, sessionAudit());
		await importRows(reg, initial.id);
		record = (await reg.snapshot()).records.get(initial.id)!;
		assert.equal(record.source.kind, "import");
		assert.equal(record.definition.revision, initial.revision);
		const edit = await reg.proposeReplace(candidate(initial.id), initial.revision, "Edit imported rule.", agent);
		await reg.decide(edit.id, "approved", "steer", sessionAudit(), proposalRevision(edit));
		await reg.retire(initial.id, "Retire directly.", sessionAudit());
		assert.equal((await registry(dir, [initial]).snapshot()).records.get(initial.id)?.definition.state, "retired");
	});
	it("refuses unavailable installed predicates at proposal admission", async (t) => {
		const reg = registry(await directory(t));
		await assert.rejects(
			reg.proposeAdd({ ...candidate(), matcher: { kind: "code", key: "unknown.predicate" } }, "Use code.", agent),
			/predicate.*unavailable/,
		);
		assert.equal((await reg.snapshot()).pending.length, 0);
	});
	it("reports absent predicate code without replacement or fallback", async (t) => {
		const dir = await directory(t);
		const initial = row("operator.a");
		await registry(dir, [initial]).snapshot();
		const next = await new RuleRegistry(dir, {
			catalog: [],
			matcherAvailable: () => false,
			onNotice: assert.fail,
		}).snapshot();
		assert.equal(next.records.get(initial.id)?.matcherAvailable, false);
		assert.equal(next.records.get(initial.id)?.definition.revision, initial.revision);
	});
});

describe("atomic explicit catalog import", () => {
	it("changes selected definitions only, restores retirement, and preserves overrides and data", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const b = row("operator.b");
		const reg = registry(dir, [a, b]);
		await reg.setEffect(a.id, "steer", "Keep this effect.", sessionAudit());
		await reg.disable(a.id, "Keep this pause.", sessionAudit());
		await reg.retire(a.id, "Retire before explicit adoption.", sessionAudit());
		await reg.retire(b.id, "Keep absent rule retired.", sessionAudit());
		const raw = {
			name: "values",
			kind: "table" as const,
			source: "operator",
			capturedAt: 1,
			maxAgeMs: 10,
			rows: [{ key: "a", value: "b" }],
		};
		await reg.setData({ ...raw, revision: namedDataRevision(raw) }, null, sessionAudit());
		const before = await reg.snapshot();
		const updated = row(a.id, "New bundled definition.");
		const next = registry(dir, [updated, row("operator.c")]);
		const plan = await next.planImport(a.id);
		assert.deepEqual(plan.current[0]?.override, before.records.get(a.id)?.override);
		assert.deepEqual(plan.resulting, [{ id: a.id, state: "disabled", effect: "steer" }]);
		const event = await next.importCatalog(a.id, plan.revision, sessionAudit());
		const after = await next.snapshot();
		assert.equal(after.records.get(a.id)?.definition.state, "active");
		assert.equal(after.records.get(a.id)?.definition.revision, updated.revision);
		assert.deepEqual(after.records.get(a.id)?.override, before.records.get(a.id)?.override);
		assert.deepEqual(after.records.get(b.id), before.records.get(b.id));
		assert.equal(after.records.has("operator.c"), false);
		assert.deepEqual(after.data, before.data);
		assert.equal((await events(dir)).at(-1)?.kind, "import");
		assert.deepEqual(Object.keys(event).sort(), ["audit", "id", "kind", "revision", "rows", "targets"]);
	});
	it("binds selected source rows and target identity, rejecting stale or agent authority", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const reg = registry(dir, [a]);
		const plan = await reg.planImport(a.id);
		await reg.disable(a.id, "Target changed.", sessionAudit());
		await assert.rejects(reg.importCatalog(a.id, plan.revision, sessionAudit()), /revision changed/);
		const fresh = await reg.planImport(a.id);
		await assert.rejects(reg.importCatalog(a.id, fresh.revision, agent), /operator surface/);
		const changed = registry(dir, [row(a.id, "New source.")]);
		await assert.rejects(changed.importCatalog(a.id, fresh.revision, sessionAudit()), /revision changed/);
		const forged: CatalogImportEvent = {
			kind: "import",
			id: randomUUID(),
			rows: fresh.rows,
			targets: fresh.targets,
			revision: fresh.revision,
			audit: agent,
		};
		assert.equal(reduceRuleEvents([...(await events(dir)), forged]).records.get(a.id)?.source.kind, "package");
		await assert.rejects(changed.writeEvent({ ...forged, audit: sessionAudit() }), /import source/);
		assert.throws(() => validateRuleEvent({ ...forged, revision: "000000000000" }), /complete plan/);
		assert.throws(() => validateRuleEvent({ ...forged, extra: true }), /unknown field/);
	});
	it("binds retirement even though the behavior revision remains unchanged", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const reg = registry(dir, [a]);
		const plan = await reg.planImport(a.id);
		await reg.retire(a.id, "Retire.", sessionAudit());
		assert.equal((await reg.snapshot()).records.get(a.id)?.definition.revision, a.revision);
		await assert.rejects(reg.importCatalog(a.id, plan.revision, sessionAudit()), /revision changed/);
	});
	it("keeps exact corrections immune to a preserved steer override", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const reg = registry(dir, [a]);
		await reg.setEffect(a.id, "steer", "Keep guidance.", sessionAudit());
		const value = {
			...a,
			authority: "exact" as const,
			matcher: {
				kind: "declarative" as const,
				language: "facts/v1" as const,
				spec: {
					phase: "input" as const,
					selector: { tools: ["sample"] },
					when: { op: "exists" as const, path: ["input", "old"] },
					action: { kind: "rename-key" as const, path: [], from: "old", to: "new" },
					onUnavailable: "skip" as const,
				},
			},
			effect: "correct" as const,
		};
		const { revision: _revision, ...definition } = value;
		const next = registry(dir, [{ ...definition, revision: packageRowRevision(definition) }]);
		await importRows(next, a.id);
		const record = (await next.snapshot()).records.get(a.id)!;
		assert.equal(record.override?.effect, "steer");
		assert.equal(effectiveEffect(record), "correct");
		await assert.rejects(next.setEffect(a.id, "block", "Change effect.", sessionAudit()), /exact replacement/);
	});
	it("commits a selected set in one event and rejects a stale set without partial adoption", async (t) => {
		const dir = await directory(t);
		const a = row("operator.a");
		const b = row("operator.b");
		await registry(dir).snapshot();
		const first = registry(dir, [a, b]);
		const second = registry(dir, [a, b]);
		const plan = await first.planImport("--all");
		const results = await Promise.allSettled([
			first.importCatalog("--all", plan.revision, sessionAudit()),
			second.importCatalog("--all", plan.revision, sessionAudit()),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		const snapshot = await registry(dir).snapshot();
		assert.equal(snapshot.health.status, "ok");
		assert.equal(snapshot.records.size, 2);
		const sources = [...snapshot.records.values()].map((record) => record.source);
		assert.deepEqual(sources[0], sources[1]);
	});
	it("keeps the first admissible disjoint import when concurrent additions exhaust capacity", async (t) => {
		const dir = await directory(t);
		await registry(
			dir,
			Array.from({ length: MAX_RULES - 1 }, (_, index) => row(`rule.n-${index}`)),
		).snapshot();
		const additions = [row("rule.extra-a"), row("rule.extra-b")];
		const registries = additions.map(() => registry(dir, additions));
		const plans = await Promise.all(registries.map((reg, index) => reg.planImport(additions[index].id)));
		const results = await Promise.allSettled(
			registries.map((reg, index) => reg.importCatalog(additions[index].id, plans[index].revision, sessionAudit())),
		);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		const snapshot = await registry(dir).snapshot();
		assert.equal(snapshot.health.status, "ok");
		assert.equal(snapshot.records.size, MAX_RULES);
		assert.equal(additions.filter((entry) => snapshot.records.has(entry.id)).length, 1);
	});
	it("allows a seeded rule edit at full capacity without a separate origin quota", async (t) => {
		const dir = await directory(t);
		const rows = Array.from({ length: MAX_RULES }, (_, index) => row(`rule.n-${index}`));
		const reg = registry(dir, rows);
		const edit = await reg.proposeReplace(candidate(rows[0].id), rows[0].revision, "Edit one rule.", agent);
		await reg.decide(edit.id, "approved", "steer", sessionAudit(), proposalRevision(edit));
		assert.equal((await reg.snapshot()).records.size, MAX_RULES);
		await assert.rejects(reg.proposeAdd(candidate("rule.additional"), "Add another.", agent), /already contains/);
	});
});

describe("unreadable and partial stores", () => {
	it("leaves incompatible stores unchanged without fallback rules or writes", async (t) => {
		for (const bytes of [
			'{"kind":"broken"}\n',
			`${JSON.stringify(catalog())}\n${JSON.stringify(catalog(row("operator.a")))}\n`,
			`${JSON.stringify({ kind: "catalog", rows: [{ id: "operator.a", domain: "shell" }], audit: { surface: "package" } })}\n`,
		]) {
			const dir = await directory(t);
			await mkdir(dir, { mode: 0o700 });
			await writeFile(join(dir, RULES_FILE), bytes, { mode: 0o600 });
			const notices: string[] = [];
			const reg = new RuleRegistry(dir, { catalog: [row("operator.a")], onNotice: (notice) => notices.push(notice) });
			const snapshot = await reg.snapshot();
			assert.equal(snapshot.health.status, "degraded");
			assert.equal(snapshot.records.size, 0);
			assert.match(ruleStoreHealthLine(snapshot.health), /No rules are active/);
			await assert.rejects(reg.proposeAdd(candidate(), "Add rule.", agent), /writes are refused/);
			assert.equal(await readFile(reg.path, "utf8"), bytes);
			await reg.snapshot();
			assert.equal(notices.length, 1);
		}
	});
	it("reports a seed directory failure without publishing a store", async (t) => {
		const dir = await directory(t);
		await writeFile(dir, "not a directory", { mode: 0o600 });
		const reg = new RuleRegistry(dir, { catalog: [row("operator.a")], onNotice() {} });
		const snapshot = await reg.snapshot();
		assert.equal(snapshot.health.status, "degraded");
		assert.equal(snapshot.records.size, 0);
		assert.equal(snapshot.health.property, "directory type");
		assert.equal(await readFile(dir, "utf8"), "not a directory");
		assert.deepEqual(await readdir(dirname(dir)), ["store"]);
	});
	it("cleans only its staged seed after publication failure and leaves the final path absent", async (t) => {
		const dir = await directory(t);
		await mkdir(dir, { mode: 0o700 });
		const retained = ".rules-seed-another-owner";
		await writeFile(join(dir, retained), "Retain another starter's file.", { mode: 0o600 });
		const failure = t.mock.method(fsPromises, "link", async () => {
			throw Object.assign(new Error("Seed publication refused"), { code: "EACCES" });
		});
		syncBuiltinESMExports();
		try {
			const snapshot = await new RuleRegistry(dir, { catalog: [row("operator.a")], onNotice() {} }).snapshot();
			assert.equal(snapshot.health.status, "degraded");
			assert.equal(snapshot.records.size, 0);
			assert.match(snapshot.health.message ?? "", /Seed publication refused/);
			await assert.rejects(stat(join(dir, RULES_FILE)), /ENOENT/);
			assert.deepEqual(await readdir(dir), [retained]);
		} finally {
			failure.mock.restore();
			syncBuiltinESMExports();
		}
	});

	it("attributes pending-capacity failure to the concrete event line", async (t) => {
		const dir = await directory(t);
		await mkdir(dir, { mode: 0o700 });
		const values = Array.from({ length: MAX_PENDING_PROPOSALS + 1 }, (_, index) => proposal(`operator.n-${index}`));
		await writeFile(join(dir, RULES_FILE), `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, {
			mode: 0o600,
		});
		const snapshot = await new RuleRegistry(dir, { catalog: [], onNotice() {} }).snapshot();
		assert.equal(snapshot.health.line, MAX_PENDING_PROPOSALS + 1);
		assert.match(snapshot.health.repair ?? "", new RegExp(`remove line ${MAX_PENDING_PROPOSALS + 1}`));
	});
	it("refuses nonprivate existing files without permission repair or seeding", async (t) => {
		const dir = await directory(t);
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, RULES_FILE), "", { mode: 0o600 });
		await chmod(join(dir, RULES_FILE), 0o644);
		const snapshot = await new RuleRegistry(dir, { catalog: [row("operator.a")], onNotice() {} }).snapshot();
		assert.equal(snapshot.health.property, "file mode");
		assert.equal(snapshot.records.size, 0);
		assert.equal((await stat(join(dir, RULES_FILE))).mode & 0o777, 0o644);
	});
	it("keeps only complete stored events while an append is in flight, then resumes writes without catalog refresh", async (t) => {
		const dir = await directory(t);
		const stored = row("operator.a", "Stored definition.");
		await mkdir(dir, { mode: 0o700 });
		const prefix = `${JSON.stringify(catalog(stored))}\n`;
		await writeFile(join(dir, RULES_FILE), `${prefix}{"kind":"proposal"`, { mode: 0o600 });
		const notices: string[] = [];
		const reg = new RuleRegistry(dir, {
			catalog: [row(stored.id, "Changed bundle.")],
			onNotice: (notice) => notices.push(notice),
		});
		const snapshot = await reg.snapshot();
		assert.equal(snapshot.health.incompleteFinalLine, 2);
		assert.equal(snapshot.records.get(stored.id)?.definition.note, stored.note);
		await reg.snapshot();
		assert.equal(notices.length, 1);
		await assert.rejects(reg.disable(stored.id, "Pause.", sessionAudit()), /append in flight/);
		await writeFile(reg.path, prefix, { mode: 0o600 });
		await reg.disable(stored.id, "Pause after repair.", sessionAudit());
		assert.deepEqual(
			(await events(dir)).map((event) => event.kind),
			["catalog", "override"],
		);
	});
	it("rejects malformed import identity lists and nonmatching content revisions", () => {
		const rows = [row("operator.a")];
		const targets = [{ id: rows[0].id, identity: null }];
		const event = {
			kind: "import",
			id: randomUUID(),
			rows,
			targets,
			revision: contentRevision({ rows, targets }),
			audit: sessionAudit(),
		};
		assert.equal(validateRuleEvent(event).kind, "import");
		assert.throws(() => validateRuleEvent({ ...event, targets: [] }), /targets/);
		assert.throws(
			() => validateRuleEvent({ ...event, targets: [{ id: "operator.other", identity: null }] }),
			/target ids/,
		);
		assert.throws(() => validateRuleEvent({ ...event, targets: [{ ...targets[0], identity: "bad" }] }), /identity/);
	});
});
