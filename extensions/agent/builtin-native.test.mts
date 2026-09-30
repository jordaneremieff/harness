import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { fixture } from "./native-fixture.mts";
import { AgentWorkerSession } from "./worker.ts";

let agentDir: string;
let previousAgentDir: string | undefined;
before(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-builtin-config-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

function native(worker: AgentWorkerSession): AgentSessionRuntime {
	return (worker as unknown as { runtime: AgentSessionRuntime }).runtime;
}

test("managed sessions register native discovery tools inactive with builtin source identities", async () => {
	const f = await fixture();
	try {
		const session = native(f.worker).session;
		const tools = session.getAllTools();
		assert.equal(tools.find((tool) => tool.name === "codemode")?.sourceInfo?.path, "builtin:codemode");
		assert.equal(tools.find((tool) => tool.name === "tool_search")?.sourceInfo?.path, "builtin:tool-search");
		assert.ok(!session.getActiveToolNames().includes("codemode"));
		assert.ok(!session.getActiveToolNames().includes("tool_search"));
		assert.ok(session.extensionRunner.getCommand("mcp"), "the MCP factory loads and registers its command");
		assert.equal(tools.some((tool) => tool.sourceInfo?.path === "builtin:mcp" || tool.name.startsWith("mcp__")), false);
		assert.equal(f.worker.lastErrorMessage(), undefined);
	} finally { await f.close(); }
});

test("native defaultTools settings activate managed discovery tools", async () => {
	const f = await fixture(undefined, {}, { defaultTools: ["+codemode", "+tool_search"] });
	try {
		assert.ok(native(f.worker).session.getActiveToolNames().includes("codemode"));
		assert.ok(native(f.worker).session.getActiveToolNames().includes("tool_search"));
	} finally { await f.close(); }
});

test("trusted project settings disable named builtins and select active tools", async () => {
	const f = await fixture();
	try {
		await f.worker.close();
		mkdirSync(join(f.cwd, ".pi"));
		writeFileSync(join(f.cwd, ".pi", "settings.json"), JSON.stringify({
			extensions: ["-builtin:codemode", "-builtin:mcp"],
			defaultTools: ["+tool_search"],
		}));
		const worker = await AgentWorkerSession.create({ ...f.options, trusted: true });
		try {
			const session = native(worker).session;
			assert.ok(!session.getAllTools().some((tool) => tool.name === "codemode"));
			assert.equal(session.extensionRunner.getCommand("mcp"), undefined);
			assert.equal(session.getAllTools().find((tool) => tool.name === "tool_search")?.sourceInfo?.path, "builtin:tool-search");
			assert.ok(session.getActiveToolNames().includes("tool_search"));
		} finally { await worker.close(); }
	} finally { await f.close(); }
});
