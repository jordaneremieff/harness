import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import * as Durable from "@earendil-works/pi-durable";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentContribution, type AgentContributionHost } from "./durable-agents.ts";
import registerAgentExtension from "./index.ts";

interface DeclaredTool { readonly name: string; readonly parameters: unknown }

/**
 * Some providers reject a tool schema whose parameters root is not `type: "object"`
 * or whose property schema has no `type` (for example a bare enum, const union, or
 * anyOf). Every model-facing agent tool, on both the ordinary and the native surface,
 * must declare types throughout its parameters. `additionalProperties` is excluded
 * because the open cursor map carries arbitrary JSON values that no single type covers.
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

function collectViolations(tools: readonly DeclaredTool[], surface: string): string[] {
	const violations: string[] = [];
	for (const tool of tools) {
		const root = tool.parameters as Record<string, unknown>;
		if (root.type !== "object") violations.push(`${surface} ${tool.name}: parameters root type is ${JSON.stringify(root.type)}`);
		const nodes: string[] = [];
		untypedNodes(root, "", nodes);
		for (const node of nodes) violations.push(`${surface} ${tool.name}: untyped schema at ${node}`);
	}
	return violations;
}

it("declares an explicit JSON Schema type on every agent tool parameter, ordinary and native", async (t) => {
	const priorAgentDir = process.env.PI_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "tool-schema-types-agent-"));
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "tool-schema-types-cwd-")));
	process.env.PI_AGENT_DIR = agentDir;
	t.after(() => {
		if (priorAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = priorAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	const ordinary: DeclaredTool[] = [];
	await registerAgentExtension({
		events: { on: () => () => {}, emit() {} },
		on() {},
		registerTool(tool: DeclaredTool) { ordinary.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);

	const contribution = createAgentContribution({ configureSettings: () => {}, source: "/abs/extensions/agent/index.ts" });
	const extension = contribution.create({
		onClose() {},
		durable: Durable,
		storageId: "tool-schema-storage",
		cwd,
		agentDir,
		services: { modelRuntime: { getModel: () => undefined } },
	} as unknown as AgentContributionHost) as Durable.Extension & { tools?: DeclaredTool[] };
	const native = extension.tools ?? [];

	for (const [surface, tools] of [["ordinary", ordinary], ["native", native]] as const) {
		assert.ok(tools.length > 0, `${surface} surface exposes agent tools`);
		for (const name of ["agent_spawn", "agent_send", "agent_configure", "agent_inspect", "agent_profile", "agent_collaborate", "agent_status"]) {
			assert.ok(tools.some((tool) => tool.name === name), `${surface} surface exposes ${name}`);
		}
	}
	assert.deepEqual([...collectViolations(ordinary, "ordinary"), ...collectViolations(native, "native")], []);
});
