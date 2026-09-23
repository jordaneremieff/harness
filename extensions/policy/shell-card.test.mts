import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PACKAGE_CATALOG } from "./catalog.ts";
import type { RuleRecord } from "./rule.ts";
import { SHELL_CARD_BYTES, shellContractCard } from "./shell-card.ts";

const scope = { cwd: "/project", provider: "test", model: "test/model" };
const context = { tools: { read: { active: true } } };
function rule(id = "local.shell", note = "Use sample --limit 10."): RuleRecord {
	return {
		id, source: { kind: "package" },
		matcher: { kind: "declarative", language: "command-shape/v1", spec: { command: "sample" } },
		definition: { purpose: "Bound the sample output.", authority: "steer-or-block", revision: "123456abcdef",
			state: "active", effect: "block", note },
		matcherAvailable: true, staleOverride: false,
	};
}
const card = (records: RuleRecord[], facts = context) => shellContractCard(records, scope, facts);

describe("installed shell contract card", () => {
	it("uses the stored note and suggestion without a catalog overlay", () => {
		const record = rule("routing.cat-read", "Use the approved alternate reader.");
		record.definition.suggestion = { command: "sample", flags: ["--limit", "12"] };
		const text = card([record]) ?? "";
		assert.match(text, /Use the approved alternate reader\. Suggested form: sample --limit 12\./);
		assert.doesNotMatch(text, /read path=README/);
		record.definition.note = "Use the replacement form.";
		assert.match(card([record]) ?? "", /replacement form/);
	});

	it("summarizes the entire starter command catalog without repeating identical notes", () => {
		const records = PACKAGE_CATALOG.map((row): RuleRecord => ({
			id: row.id, source: { kind: "package" }, matcher: row.matcher,
			definition: { ...row, state: "active" }, matcherAvailable: true, staleOverride: false,
		}));
		const text = card(records) ?? "";
		const count = records.filter((record) => record.matcher.kind === "code").length;
		assert.match(text, new RegExp(`Command rules in scope: ${count}; summarized: ${count}; omitted by text bound: 0`));
		assert.equal(text.split("read path=README.md").length, 2);
		assert.ok(Buffer.byteLength(text) <= SHELL_CARD_BYTES);
	});

	it("excludes disabled, retired, and out-of-scope definitions", () => {
		const retired = rule("retired", "Retired note.");
		retired.definition.state = "retired";
		const disabled = rule("disabled", "Disabled note.");
		disabled.override = { state: "disabled", reason: "Operator choice", againstDefinitionRevision: "123456abcdef",
			audit: { at: "2026-01-01T00:00:00Z", surface: "command", model: null, session: "test" } };
		const outside = rule("outside", "Other scope.");
		outside.definition.scope = { cwdPrefixes: ["/elsewhere"] };
		assert.equal(card([retired, disabled, outside]), undefined);
	});

	it("requires known true applicability and an available matcher", () => {
		const reader = rule("reader", "Use the reader.");
		reader.definition.applicability = { op: "eq", path: ["context", "tools", "read", "active"], value: true };
		const unknown = rule("unknown", "Unknown note.");
		unknown.definition.applicability = { op: "eq", path: ["input", "name"], value: "sample" };
		const missing = rule("missing", "Missing matcher.");
		missing.matcherAvailable = false;
		const text = card([reader, unknown, missing, rule()], { tools: { read: { active: false } } }) ?? "";
		assert.match(text, /inapplicable: 1; unavailable: 2/);
		assert.doesNotMatch(text, /Use the reader|Unknown note|Missing matcher/);
	});

	it("does not translate arbitrary facts programs into shell instructions", () => {
		const facts = rule();
		facts.matcher = { kind: "declarative", language: "facts/v1", spec: {
			phase: "input", selector: { tools: ["bash"] }, when: { op: "exists", path: ["input"] },
			action: { kind: "deny" }, onUnavailable: "skip",
		} };
		assert.equal(card([facts]), undefined);
		assert.equal(card([]), undefined);
	});

	it("retains whole notes, reports every omitted rule, and bounds UTF-8 bytes", () => {
		const records = Array.from({ length: 100 }, (_, index) => rule(`local.r${index}`, `${index}: ${"界".repeat(600)}`));
		const text = card(records) ?? "";
		assert.ok(Buffer.byteLength(text) <= SHELL_CARD_BYTES);
		const counts = /summarized: (\d+); omitted by text bound: (\d+)/.exec(text);
		assert.ok(counts);
		assert.equal(Number(counts[1]) + Number(counts[2]), 100);
		assert.ok(Number(counts[2]) > 0);
		assert.ok(!text.includes("\ufffd"));
	});

	it("sanitizes control characters and collapses multi-line stored notes", () => {
		const text = card([rule("local.safe", "Use sample.\n\u001b[31mUse --limit 10.")]) ?? "";
		assert.ok(!text.includes("\u001b"));
		assert.match(text, /Use sample\. \\x1b\[31mUse --limit 10\./);
	});
});
