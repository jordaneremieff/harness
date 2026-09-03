import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureFor, classify, matchRuleRecords, notesFor, redactFor, ruleScopeMatches } from "./classify.ts";
import type { RuleRecord } from "./rule.ts";

describe("captureFor", () => {
	it("returns the text the owning domain declares", () => {
		assert.equal(captureFor("bash", { command: "ls -R ." }), "ls -R .");
	});

	it("returns nothing for a tool no domain owns", () => {
		assert.equal(captureFor("read", { path: "/etc/hosts" }), undefined);
	});

	it("returns nothing when the declared field has another type", () => {
		assert.equal(captureFor("bash", { command: 7 }), undefined);
		assert.equal(captureFor("bash", {}), undefined);
	});
});

describe("classify", () => {
	it("dispatches to the domain that owns the tool", () => {
		assert.deepEqual(classify("bash", { command: "cat notes.md" }), ["routing.cat-read"]);
	});

	it("returns no class for a tool no domain owns", () => {
		assert.deepEqual(classify("write", { path: "/tmp/x", content: "cat notes.md" }), []);
	});

	it("returns no class when the domain captures nothing", () => {
		assert.deepEqual(classify("bash", { timeout: 5 }), []);
	});
});

describe("redactFor", () => {
	it("applies the owning domain's redaction", () => {
		assert.equal(redactFor("bash", "TOKEN=abcdef cat x"), "TOKEN=[redacted] cat x");
	});

	it("keeps an unowned tool's capture unchanged", () => {
		const opaque = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature";
		assert.equal(redactFor("read", opaque), opaque);
	});
});

describe("unified record dispatch", () => {
	const codeRecord = (changes: Partial<RuleRecord> = {}): RuleRecord => ({
		id: "routing.test",
		source: { kind: "package" },
		domain: "tool-call",
		matcher: { kind: "code", key: "routing.test" },
		definition: {
			revision: "000000000000",
			state: "active",
			effect: "block",
			note: "Use the structured tool.",
		},
		matcherAvailable: true,
		staleOverride: false,
		...changes,
	});
	const declarativeRecord = (changes: Partial<RuleRecord> = {}): RuleRecord => ({
		id: "local.grep-r",
		source: {
			kind: "local",
			proposalId: "00000000-0000-4000-8000-000000000001",
			approvedAudit: {
				at: "2026-09-01T00:00:00.000Z",
				session: "s1",
				model: "openai/gpt-5",
				surface: "command",
			},
		},
		domain: "tool-call",
		matcher: {
			kind: "declarative",
			language: "command-shape/v1",
			spec: {
				command: "grep",
				flags: ["-R"],
				absentFlags: ["-q"],
				operands: { min: 1, max: 2, any: ["src"], at: { "0": ["needle"] } },
				pipe: { from: false, to: true, next: ["head"], later: ["head"] },
			},
		},
		definition: {
			revision: "000000000001",
			state: "active",
			effect: "steer",
			note: "Prefer rg.",
			scope: { modelProviders: ["openai"], models: ["openai/gpt-5"], cwdPrefixes: ["/work/project"] },
		},
		matcherAvailable: true,
		staleOverride: false,
		...changes,
	});

	it("filters disabled and retired code records before predicate dispatch", () => {
		let calls = 0;
		const resolver = () => {
			calls++;
			return () => true;
		};
		const retired = codeRecord({ definition: { ...codeRecord().definition, state: "retired" } });
		const disabled = codeRecord({
			id: "routing.disabled",
			override: {
				state: "disabled",
				reason: "pause",
				audit: { at: "2026-09-01T00:00:00.000Z", session: "s", model: null, surface: "command" },
				againstDefinitionRevision: "000000000000",
			},
		});
		assert.deepEqual(matchRuleRecords("bash", "anything", [retired, disabled], { cwd: "/work" }, resolver), []);
		assert.equal(calls, 0);
	});

	it("filters unavailable and out-of-scope records before resolution", () => {
		let calls = 0;
		const resolver = () => {
			calls++;
			return () => true;
		};
		const unavailable = codeRecord({ matcherAvailable: false });
		const scoped = codeRecord({
			id: "routing.scoped",
			definition: { ...codeRecord().definition, scope: { models: ["openai/gpt-5"] } },
		});
		assert.deepEqual(
			matchRuleRecords(
				"bash",
				"anything",
				[unavailable, scoped],
				{ cwd: "/work", model: "anthropic/claude" },
				resolver,
			),
			[],
		);
		assert.equal(calls, 0);
	});

	it("keeps declarative matching separate from the code predicate registry", () => {
		let resolutions = 0;
		const matched = matchRuleRecords(
			"bash",
			"grep -R needle src | head -20",
			[declarativeRecord()],
			{ cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" },
			() => {
				resolutions++;
				return () => false;
			},
		);
		assert.deepEqual(
			matched.map((record) => record.id),
			["local.grep-r"],
		);
		assert.equal(resolutions, 0);
	});

	it("uses exact declared scope dimensions and exact command-shape fields", () => {
		const record = declarativeRecord();
		const context = { cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" };
		assert.equal(ruleScopeMatches(record.definition.scope, context), true);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, provider: "OpenAI" }), false);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, model: "openai/gpt-5-mini" }), false);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, cwd: "/other" }), false);
		assert.equal(matchRuleRecords("bash", "grep -R -q needle src | head -20", [record], context).length, 0);
		assert.equal(matchRuleRecords("bash", "grep -R needle lib | head -20", [record], context).length, 0);
		assert.equal(matchRuleRecords("bash", "grep -R needle src | sort | head -20", [record], context).length, 0);
	});

	it("resolves active code records by domain plus matcher key", () => {
		const record = codeRecord();
		const keys: string[] = [];
		const matched = matchRuleRecords("bash", "echo ok", [record], { cwd: "/work" }, (domain, key) => {
			keys.push(`${domain}:${key}`);
			return () => true;
		});
		assert.deepEqual(keys, ["tool-call:routing.test"]);
		assert.deepEqual(
			matched.map((entry) => entry.id),
			[record.id],
		);
	});

	it("returns package matches before id-sorted local matches", () => {
		const packageMatch = codeRecord({
			id: "routing.zzz",
			matcher: { kind: "code", key: "routing.zzz" },
		});
		const localMatch = declarativeRecord({ id: "a.local" });
		const matched = matchRuleRecords(
			"bash",
			"grep -R needle src | head -20",
			[localMatch, packageMatch],
			{ cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" },
			() => () => true,
		);
		assert.deepEqual(
			matched.map((record) => record.id),
			[packageMatch.id, localMatch.id],
		);
	});
});

describe("notesFor", () => {
	it("returns guidance in the order the ids are given", () => {
		const notes = notesFor("bash", ["form.env-grep", "routing.cat-read"]);
		assert.equal(notes.length, 2);
		assert.match(notes[0], /printenv/);
		assert.match(notes[1], /read tool/);
	});

	it("returns one line for ids that share wording", () => {
		assert.deepEqual(
			notesFor("bash", ["bounds.du-uncapped", "bounds.find-output-uncapped"]),
			notesFor("bash", ["bounds.du-uncapped"]),
		);
	});

	it("skips an unknown id and an unowned tool", () => {
		assert.deepEqual(notesFor("bash", ["routing.no-such-rule"]), []);
		assert.deepEqual(notesFor("read", ["routing.cat-read"]), []);
	});
});
