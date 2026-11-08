import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NamedData } from "./data.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { FactsProgram } from "./program.ts";
import type { RuleRecord } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";

const WIDE = "w".repeat(4096);

function substitution(key: string): RuleRecord {
	const program: FactsProgram = {
		phase: "input",
		when: { op: "exists", path: ["input"] },
		action: { kind: "substitute", path: [key], table: "wide" },
		data: ["wide"],
		onUnavailable: "skip",
	};
	return {
		id: `sub-${key}`,
		source: { kind: "package" },
		matcher: { kind: "declarative", language: "facts/v1", spec: program },
		definition: {
			purpose: `Substitute ${key}.`,
			authority: "exact",
			revision: "123456abcdef",
			state: "active",
			effect: "correct",
			note: `Rule ${key}.`,
		},
		matcherAvailable: true,
		staleOverride: false,
	};
}

const table: NamedData = {
	name: "wide",
	revision: "123456789abc",
	source: "operator-table",
	capturedAt: 1,
	kind: "table",
	rows: [{ key: "blue", value: WIDE }],
};

async function run(count: number) {
	const keys = Array.from({ length: count }, (_, index) => `k${String(index).padStart(2, "0")}`);
	const snapshot: RuleSnapshot = {
		records: new Map(keys.map((key) => [`sub-${key}`, substitution(key)])),
		pending: [],
		data: new Map([["wide", table]]),
		health: { status: "ok", path: "rules.jsonl" },
	};
	const pi = {
		getAllTools: () => [{ name: "sample", parameters: { type: "object", additionalProperties: true } }],
		getActiveTools: () => ["sample"],
		appendEntry: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "print",
		cwd: "/project",
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "session", buildContextEntries: () => [] },
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	const writer = { enqueue: () => true, close: async () => {}, health: () => ({ state: "ok" as const, lostRecords: 0, lostBytes: 0 }) };
	let runtime!: PolicyRuntime;
	runtime = new PolicyRuntime(
		pi,
		async () => {
			runtime.sync(snapshot);
			return snapshot;
		},
		() => "enforce",
		"/unused",
		() => true,
		writer,
	);
	runtime.sync(snapshot);
	const input: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, "blue"]));
	await runtime.toolStart({ toolName: "sample", toolCallId: "call", args: input }, ctx);
	const outcome = await runtime.toolCall({ type: "tool_call", toolName: "sample", toolCallId: "call", input }, ctx);
	return { input, outcome };
}

test("a correction within the JSON bounds reaches the live tool input", async () => {
	const { input, outcome } = await run(63);
	assert.equal(outcome, undefined);
	assert.equal(input.k00, WIDE);
});

test("a correction past the JSON bounds is refused and the live tool input stays unchanged", async () => {
	const { input, outcome } = await run(64);
	assert.equal(outcome?.block, true);
	assert.ok(Object.values(input).every((value) => value === "blue"));
});
