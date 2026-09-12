import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_LIMITS, RESULT_ERROR_SCHEMA } from "./catalog.ts";
import type { NamedData } from "./data.ts";
import registerPolicy from "./index.ts";
import { namedDataRevision, RuleRegistry } from "./local-rules.ts";

export const PRODUCT_TOOLS = [
	"policy_product_request",
	"policy_product_result",
	"policy_product_other",
	"policy_product_recover",
	"policy_product_volume",
	"policy_product_count",
	"policy_rules",
];
export type ProductFixtureOptions = { resultContract?: "approved" | "missing" | "stale" };

/** The fixture supplies approved data, never replacement policy definitions or proposals. */
export function registerProductFixture(pi: ExtensionAPI, options: ProductFixtureOptions = {}): void {
	const dir = join(tmpdir(), `policy-product-eval-${randomUUID()}`);
	let started = false;
	let executions = 0;
	pi.on("session_start", async () => {
		if (!started) {
			try {
				if (options.resultContract !== "missing") {
					const data: NamedData = {
						name: RESULT_ERROR_SCHEMA,
						kind: "schema",
						source: "synthetic-approved-result-contract",
						capturedAt: 0,
						...(options.resultContract === "stale" ? { maxAgeMs: 1 } : {}),
						revision: "000000000000",
						schema: {
							type: "object",
							required: ["tool", "details"],
							properties: {
								tool: { const: "policy_product_result" },
								details: {
									type: "object",
									required: ["status", "code"],
									properties: { status: { const: "refused" }, code: { const: "DEMO_REFUSAL" } },
								},
							},
						},
					};
					await new RuleRegistry(dir).setData({ ...data, revision: namedDataRevision(data) }, null, {
						surface: "command",
						at: new Date().toISOString(),
						session: "synthetic-product-fixture",
						model: null,
					});
				}
				started = true;
			} catch (error) {
				await rm(dir, { recursive: true, force: true });
				throw error;
			}
		}
		pi.setActiveTools(PRODUCT_TOOLS);
	});
	// Pi validates first; this earlier hook then changes the same argument object.
	pi.on("tool_call", (event) => {
		if (event.toolName === "policy_product_request" && event.input.scenario === "mutated-schema")
			event.input.count = "not-an-integer";
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
		name: "policy_product_request",
		label: "Inert request",
		description: "Attempt the exact requested scenario and count. No external actions occur.",
		parameters: Type.Object(
			{ scenario: StringEnum(["valid", "mutated-schema"]), count: Type.Integer({ minimum: 1, maximum: 8 }) },
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			executions++;
			if (!Number.isInteger(args.count)) throw new Error("BACKEND INVALID COUNT");
			return result(`REQUEST RECEIPT: ${args.count}`);
		},
	});
	for (const name of ["policy_product_result", "policy_product_other"])
		pi.registerTool({
			name,
			label: "Inert structured result",
			description:
				"Return synthetic structured evidence. Only policy_product_result has an approved failure contract. No external actions occur.",
			parameters: Type.Object(
				{
					scenario: StringEnum([
						"declared-error",
						"success",
						"missing-status",
						"missing-code",
						"wrong-code",
						"words-only",
						"backend-error",
					]),
				},
				{ additionalProperties: false },
			),
			async execute(_id, args) {
				executions++;
				if (args.scenario === "backend-error") throw new Error("BACKEND UNAVAILABLE");
				if (args.scenario === "success")
					return result("SUCCESS: no failure records", { status: "ok", code: "DEMO_REFUSAL" });
				if (args.scenario === "words-only") return result("Quoted example: error, failed, refused", {});
				const details: Record<string, unknown> = { status: "refused", code: "DEMO_REFUSAL" };
				if (args.scenario === "missing-status") delete details.status;
				if (args.scenario === "missing-code") delete details.code;
				if (args.scenario === "wrong-code") details.code = "OTHER";
				return result(`STRUCTURED: ${JSON.stringify(details)}`, details);
			},
		});
	pi.registerTool({
		name: "policy_product_recover",
		label: "Inert receipt lookup",
		description: "Try primary for a synthetic receipt. Alternate uses a different inert path and returns a receipt.",
		parameters: Type.Object(
			{
				path: StringEnum(["primary", "alternate"]),
				attempt: Type.Integer({ minimum: 1, maximum: DEFAULT_LIMITS.errorCount + 1 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			executions++;
			if (args.path === "primary") throw new Error("PRIMARY PATH UNAVAILABLE");
			return result("ALTERNATE RECEIPT: DEMO-9");
		},
	});
	pi.registerTool({
		name: "policy_product_volume",
		label: "Inert bounded data",
		description:
			"Return an exact bounded number of synthetic ASCII bytes. Compact returns the useful summary instead. Each result is at most half the package output limit.",
		parameters: Type.Object(
			{
				bytes: Type.Integer({ minimum: 0, maximum: Math.ceil(DEFAULT_LIMITS.outputBytes / 2) }),
				compact: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			executions++;
			return result(args.compact ? "COMPACT: 2 items" : "x".repeat(args.bytes));
		},
	});
	pi.registerTool({
		name: "policy_product_count",
		label: "Inert execution count",
		description: "Return the number of business tool executions, excluding this inspection.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return result(`EXECUTIONS=${executions}`);
		},
	});
}

export default function productFixture(pi: ExtensionAPI): void {
	registerProductFixture(pi);
}
