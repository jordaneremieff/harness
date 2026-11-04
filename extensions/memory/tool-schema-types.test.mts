import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import memory from "./index.ts";
import { createMemoryContribution } from "./durable.ts";

interface DeclaredTool { readonly name: string; readonly parameters: unknown }

/**
 * Some providers reject a tool schema whose parameters root is not `type: "object"`
 * or whose property schema has no `type` (for example a bare enum, const union, or
 * anyOf). Every model-facing memory tool, on both the ordinary and the native
 * surface, must declare types throughout its parameters.
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

function violations(tools: readonly DeclaredTool[], surface: string): string[] {
	const found: string[] = [];
	for (const tool of tools) {
		const root = tool.parameters as Record<string, unknown>;
		if (root.type !== "object") found.push(`${surface} ${tool.name}: parameters root type is ${JSON.stringify(root.type)}`);
		const nodes: string[] = [];
		untypedNodes(root, "", nodes);
		for (const node of nodes) found.push(`${surface} ${tool.name}: untyped schema at ${node}`);
	}
	return found;
}

it("declares an explicit JSON Schema type on every memory tool parameter, ordinary and native", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "memory-schema-agent-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const ordinary: DeclaredTool[] = [];
	const bus = { emit() {}, on: () => () => {} };
	memory({ registerTool(tool: DeclaredTool) { ordinary.push(tool); }, registerCommand() {}, events: bus, on: () => () => {} } as unknown as ExtensionAPI);
	const extension = createMemoryContribution("/abs/extensions/memory/index.ts", bus, () => {}).create({
		durable: Durable,
		services: {} as never,
		cwd: agentDir,
		agentDir,
		storageId: "memory-schema-storage",
		harness: {} as never,
		signal: new AbortController().signal,
		onClose: () => {},
		inventory: { contributions: [], ordinaryOnly: [] },
	} as never) as Durable.Extension & { tools?: DeclaredTool[] };
	const native = extension.tools ?? [];

	for (const [surface, tools] of [["ordinary", ordinary], ["native", native]] as const) {
		assert.ok(tools.length > 0, `${surface} surface exposes memory tools`);
		for (const name of ["memory_search", "memory_read", "memory_history", "memory_write", "memory_edit", "memory_review", "memory_retire"]) {
			assert.ok(tools.some((tool) => tool.name === name), `${surface} surface exposes ${name}`);
		}
	}
	assert.deepEqual([...violations(ordinary, "ordinary"), ...violations(native, "native")], []);
});
