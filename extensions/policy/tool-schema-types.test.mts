import assert from "node:assert/strict";
import { it } from "node:test";
import type { Schema } from "@earendil-works/pi-schema";
import { PolicyApproveParams, PolicyProposeParams, PolicyRulesParams } from "./tools.ts";
import { PolicyControlParams } from "./control.ts";

/**
 * Some providers reject a tool schema whose parameters root is not `type: "object"`
 * or whose property schema has no `type` (for example a bare enum, const union, or
 * anyOf). Both the ordinary and the native policy entrypoints register these four
 * parameter schemas, so every property must declare a type.
 */
function untypedNodes(node: unknown, path: string, out: string[]): void {
	if (node === null || typeof node !== "object") return;
	const schema = node as Record<string, unknown>;
	if (schema.type === undefined) out.push(path || "(root)");
	for (const [name, child] of Object.entries((schema.properties ?? {}) as Record<string, unknown>)) untypedNodes(child, `${path}.properties.${name}`, out);
	if (schema.items !== undefined) untypedNodes(schema.items, `${path}.items`, out);
	for (const branch of ["anyOf", "oneOf", "allOf"] as const) {
		for (const [index, child] of ((schema[branch] ?? []) as unknown[]).entries()) untypedNodes(child, `${path}.${branch}[${index}]`, out);
	}
}

const parameters: Record<string, Schema> = {
	policy_rules: PolicyRulesParams as Schema,
	policy_propose: PolicyProposeParams as Schema,
	policy_approve: PolicyApproveParams as Schema,
	policy_control: PolicyControlParams as Schema,
};

it("declares an explicit JSON Schema type on every policy tool parameter", () => {
	const found: string[] = [];
	for (const [name, schema] of Object.entries(parameters)) {
		if (schema.type !== "object") found.push(`${name}: parameters root type is ${JSON.stringify(schema.type)}`);
		const nodes: string[] = [];
		untypedNodes(schema, "", nodes);
		for (const node of nodes) found.push(`${name}: untyped schema at ${node}`);
	}
	assert.deepEqual(found, []);
});
