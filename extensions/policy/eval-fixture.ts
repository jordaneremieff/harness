import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NamedData } from "./data.ts";
import registerPolicy from "./index.ts";
import { namedDataRevision, proposalRevision, RuleRegistry } from "./local-rules.ts";
import type { Condition, FactsProgram } from "./program.ts";

const tools = [
	"policy_eval_call",
	"policy_eval_codec",
	"policy_eval_missing",
	"policy_eval_stale",
	"policy_eval_count",
	"policy_rules",
	"policy_propose",
];
const eq = (path: string[], value: string | number | boolean): Condition => ({ op: "eq", path, value });
const scenario = (value: string) => eq(["input", "scenario"], value);
const selected = { tools: ["policy_eval_call"] };
const note = "Synthetic policy fixture refused this call.";

async function seed(dir: string): Promise<void> {
	const registry = new RuleRegistry(dir);
	const audit = {
		surface: "command" as const,
		at: new Date().toISOString(),
		session: "synthetic-fixture",
		model: null,
	};
	const proposed = { ...audit, surface: "agent-tool" as const };
	const data: NamedData[] = [
		{
			name: "rooms",
			kind: "table",
			rows: [
				{ key: "lobby", value: "room-7" },
				{ key: "alias", value: "forbidden" },
			],
			source: "synthetic",
			capturedAt: 0,
			revision: "000000000000",
		},
		{
			name: "ambiguous",
			kind: "table",
			rows: [
				{ key: "shared", value: "room-a" },
				{ key: "shared", value: "room-b" },
			],
			source: "synthetic",
			capturedAt: 0,
			revision: "000000000000",
		},
		{
			name: "stale",
			kind: "table",
			rows: [{ key: "lobby", value: "room-7" }],
			source: "synthetic",
			capturedAt: 0,
			maxAgeMs: 1,
			revision: "000000000000",
		},
		{
			name: "operations",
			kind: "table",
			rows: [{ key: "old.fetch", value: "fetch" }],
			source: "synthetic",
			capturedAt: 0,
			revision: "000000000000",
		},
		{
			name: "fetch-shape",
			kind: "schema",
			schema: {
				type: "object",
				properties: { room: { const: "room-7" } },
				required: ["room"],
				additionalProperties: false,
			},
			source: "synthetic",
			capturedAt: 0,
			revision: "000000000000",
		},
	];
	for (const entry of data) await registry.setData({ ...entry, revision: namedDataRevision(entry) }, null, audit);
	const programs: Array<[string, FactsProgram, boolean?]> = [
		[
			"deny",
			{ phase: "input", selector: selected, when: scenario("denied"), action: { kind: "deny" }, onUnavailable: "skip" },
		],
		[
			"rename",
			{
				phase: "input",
				selector: selected,
				when: { any: [scenario("rename"), scenario("collision")] },
				action: { kind: "rename-key", path: [], from: "oldRoom", to: "room" },
				onUnavailable: "skip",
			},
		],
		[
			"map",
			{
				phase: "input",
				selector: selected,
				when: { any: [scenario("map"), scenario("effective-deny")] },
				data: ["rooms"],
				action: { kind: "substitute", path: ["room"], table: "rooms" },
				onUnavailable: "skip",
			},
		],
		[
			"effective",
			{
				phase: "input",
				selector: selected,
				inputView: "effective",
				when: { all: [scenario("effective-deny"), eq(["input", "room"], "forbidden")] },
				action: { kind: "deny" },
				onUnavailable: "skip",
			},
		],
		[
			"unknown",
			{
				phase: "input",
				selector: selected,
				when: { all: [scenario("unknown"), { not: eq(["input", "absent"], "safe") }] },
				action: { kind: "deny" },
				onUnavailable: "skip",
			},
		],
		[
			"ambiguous",
			{
				phase: "input",
				selector: selected,
				when: {
					all: [scenario("ambiguous"), { op: "lookup", path: ["input", "room"], table: "ambiguous", value: "unique" }],
				},
				data: ["ambiguous"],
				action: { kind: "substitute", path: ["room"], table: "ambiguous" },
				onUnavailable: "skip",
			},
		],
		[
			"missing",
			{
				phase: "input",
				selector: { tools: ["policy_eval_missing"] },
				data: ["absent-table"],
				when: { op: "exists", path: ["input"] },
				action: { kind: "deny" },
				onUnavailable: "deny",
			},
		],
		[
			"stale",
			{
				phase: "input",
				selector: { tools: ["policy_eval_stale"] },
				data: ["stale"],
				when: { op: "exists", path: ["input"] },
				action: { kind: "deny" },
				onUnavailable: "deny",
			},
		],
		[
			"result",
			{
				phase: "result",
				selector: selected,
				when: eq(["result", "details", "ok"], false),
				action: { kind: "assert-error" },
				onUnavailable: "skip",
			},
		],
		[
			"pending",
			{
				phase: "input",
				selector: selected,
				when: scenario("pending"),
				action: { kind: "deny" },
				onUnavailable: "skip",
			},
			false,
		],
		[
			"retry",
			{
				phase: "context",
				selector: selected,
				when: { op: "gte", path: ["state", "count"], value: 2 },
				state: { observe: { all: [scenario("retry"), eq(["outcome", "kind"], "execution-error")] }, once: "period" },
				action: {
					kind: "guide",
					text: "Use policy_eval_call with scenario recover now. Do not repeat scenario retry.",
				},
				onUnavailable: "skip",
			},
		],
		[
			"volume",
			{
				phase: "context",
				selector: selected,
				when: { op: "gte", path: ["state", "total"], value: 2500 },
				state: { observe: scenario("volume"), totalPath: ["outcome", "preGuidanceBytes"], once: "period" },
				action: {
					kind: "guide",
					text: "Use policy_eval_call with scenario summary now. Do not request another volume result.",
				},
				onUnavailable: "skip",
			},
		],
		[
			"operation",
			{
				phase: "input",
				selector: { tools: ["policy_eval_codec"] },
				when: eq(["input", "operation"], "old.fetch"),
				data: ["operations"],
				action: { kind: "substitute", path: ["operation"], table: "operations", stage: "logical-target" },
				onUnavailable: "skip",
			},
		],
	];
	const codec = {
		tools: ["policy_eval_codec"],
		operations: ["fetch"],
		codec: { argumentsPath: ["arguments"], operationPath: ["operation"], schemaData: "fetch-shape" },
	};
	programs.push(
		[
			"codec-key",
			{
				phase: "input",
				selector: codec,
				when: { op: "exists", path: ["input", "oldRoom"] },
				data: ["fetch-shape"],
				action: { kind: "rename-key", path: [], from: "oldRoom", to: "room" },
				onUnavailable: "skip",
			},
		],
		[
			"codec-value",
			{
				phase: "input",
				selector: codec,
				when: eq(["input", "room"], "lobby"),
				data: ["fetch-shape", "rooms"],
				action: { kind: "substitute", path: ["room"], table: "rooms" },
				onUnavailable: "skip",
			},
		],
	);
	for (const [id, program, approve = true] of programs) {
		const proposal = await registry.proposeAdd(
			{
				id: `eval.${id}`,
				purpose: "Exercise a declared engine mechanism with synthetic policy definitions.",
				authority: "exact",
				matcher: { kind: "declarative", language: "facts/v1", spec: program },
				note,
			},
			"Synthetic evaluation setup",
			proposed,
		);
		if (approve) await registry.decide(proposal.id, "approved", undefined, audit, proposalRevision(proposal));
	}
}

/** Engine coverage uses synthetic recipes, not evidence of package-default outcomes. */
export default function policyEvalFixture(pi: ExtensionAPI): void {
	// No directory exists until session_start, after the runner resolves its model and credentials.
	const dir = join(tmpdir(), `policy-eval-${randomUUID()}`);
	let started = false;
	let calls = 0;
	pi.on("session_start", async () => {
		if (!started) {
			try {
				await seed(dir);
				started = true;
			} catch (error) {
				await rm(dir, { recursive: true, force: true });
				throw error;
			}
		}
		pi.setActiveTools(tools);
	});
	const previous = process.env.PI_POLICY_DIR;
	try {
		process.env.PI_POLICY_DIR = dir;
		registerPolicy(pi);
	} finally {
		if (previous === undefined) delete process.env.PI_POLICY_DIR;
		else process.env.PI_POLICY_DIR = previous;
	}
	pi.on("session_shutdown", async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const result = (text: string, details: Record<string, unknown> = {}) => ({
		content: [{ type: "text" as const, text }],
		details,
	});
	pi.registerTool({
		name: "policy_eval_call",
		label: "Synthetic policy operation",
		description:
			"Run an inert synthetic operation. Use exactly the scenario and arguments requested. Recover returns a receipt; summary returns compact data. No external actions occur.",
		parameters: Type.Object(
			{
				scenario: Type.String({ maxLength: 40 }),
				attempt: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
				oldRoom: Type.Optional(Type.String({ maxLength: 128 })),
				room: Type.Optional(Type.String({ maxLength: 128 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			calls++;
			if (args.scenario === "retry") throw new Error("NO RECEIPT");
			if (args.scenario === "recover") return result("RECEIPT: DEMO-7");
			if (args.scenario === "volume") return result(`VOLUME:${"x".repeat(1500)}`);
			if (args.scenario === "summary") return result("SUMMARY: 2 items");
			if (args.scenario === "semantic-error") return result("APPLICATION REFUSED", { ok: false });
			if (args.scenario === "semantic-success") return result("SUCCESS: zero failure records", { ok: true });
			if (["rename", "map"].includes(args.scenario) && (args.room !== "room-7" || args.oldRoom !== undefined))
				throw new Error("BACKEND REJECTED ARGUMENTS");
			return result(`EXECUTED:${JSON.stringify(args)}`);
		},
	});
	pi.registerTool({
		name: "policy_eval_codec",
		label: "Synthetic encoded operation",
		description: "Run an inert encoded operation. Supply the exact requested operation and JSON argument string.",
		parameters: Type.Object(
			{ operation: Type.String({ maxLength: 80 }), arguments: Type.String({ maxLength: 4096 }) },
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			calls++;
			let inner: unknown;
			try {
				inner = JSON.parse(args.arguments);
			} catch {
				throw new Error("BACKEND REJECTED JSON");
			}
			if (args.operation !== "fetch" || JSON.stringify(inner) !== '{"room":"room-7"}')
				throw new Error("BACKEND REJECTED ARGUMENTS");
			return result("FETCHED: room-7");
		},
	});
	for (const name of ["policy_eval_missing", "policy_eval_stale"])
		pi.registerTool({
			name,
			label: "Synthetic binding operation",
			description: "Echo a synthetic value without external effects.",
			parameters: Type.Object({ value: Type.String({ maxLength: 128 }) }, { additionalProperties: false }),
			async execute(_id, args) {
				calls++;
				return result(`EXECUTED:${args.value}`);
			},
		});
	pi.registerTool({
		name: "policy_eval_count",
		label: "Synthetic execution count",
		description:
			"Read the number of synthetic business tool invocations. Inspection and previews do not increment this counter.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return result(`COUNT=${calls}`);
		},
	});
}
