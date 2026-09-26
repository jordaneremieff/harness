import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_LIMITS } from "./catalog.ts";
import registerPolicy from "./index.ts";

export const PRODUCT_TOOLS = [
	"policy_product_request",
	"policy_product_result",
	"policy_product_other",
	"policy_product_recover",
	"policy_product_volume",
	"policy_product_count",
	"pillars",
	"policy_rules",
];

/** Repository corpus resources the synthetic pillars tool serves verbatim. */
export const PRODUCT_PILLARS_RESOURCES = ["pattern-grounding-preflight", "inventory", "governance"] as const;
function structuredOutcome(scenario: string): { text: string; details: Record<string, unknown> } {
	if (scenario === "success")
		return { text: "SUCCESS: no failure records", details: { status: "ok", code: "DEMO_REFUSAL" } };
	if (scenario === "words-only") return { text: "Quoted example: error, failed, refused", details: {} };
	const details: Record<string, unknown> = { status: "refused", code: "DEMO_REFUSAL" };
	if (scenario === "missing-status") delete details.status;
	if (scenario === "missing-code") delete details.code;
	if (scenario === "wrong-code") details.code = "OTHER";
	return { text: `STRUCTURED: ${JSON.stringify(details)}`, details };
}
/** The fixture supplies inert tools and seeds no data, rules, or proposals. */
export function registerProductFixture(pi: ExtensionAPI): void {
	const dir = join(tmpdir(), `policy-product-eval-${randomUUID()}`);
	let executions = 0;
	pi.on("session_start", () => {
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
				"Return synthetic structured evidence. No package rule asserts or corrects these results. No external actions occur.",
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
				const outcome = structuredOutcome(args.scenario);
				return result(outcome.text, outcome.details);
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
	// Public pillars argument contract only: optional resource and draft strings.
	pi.registerTool({
		name: "pillars",
		label: "Synthetic Pillars corpus",
		description:
			"Return the repository's actual Pillars corpus text for one resource: an entry, the inventory, or governance. A draft submission returns a byte receipt and executes nothing; an empty draft is refused. No external actions occur.",
		parameters: Type.Object(
			{
				resource: Type.Optional(StringEnum([...PRODUCT_PILLARS_RESOURCES])),
				draft: Type.Optional(Type.String({ maxLength: 8192 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, args) {
			executions++;
			if (args.draft !== undefined) {
				if (args.draft.length === 0) throw new Error("DRAFT REFUSED: EMPTY");
				return result(
					`DRAFT RECEIVED: ${Buffer.byteLength(args.draft, "utf8")} UTF-8 bytes. Receipt only; no assessment verdict or approval.`,
				);
			}
			const file =
				args.resource === undefined || args.resource === "inventory"
					? "README.md"
					: args.resource === "governance"
						? "GOVERNANCE.md"
						: `${args.resource}.md`;
			const text = await readFile(join(import.meta.dirname, "..", "..", "pillars", file), "utf8");
			return result(text);
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
