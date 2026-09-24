import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core";
import { discoverAndLoadExtensions, } from "@earendil-works/pi-coding-agent";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

const here = dirname(fileURLToPath(import.meta.url));

function tempBase(): string {
	return mkdtempSync(join(tmpdir(), "agent-discovery-"));
}

function rootContext(): { context: Context; abort: AbortController } {
	const abort = new AbortController();
	return { context: withAbortSignal(abort.signal, BACKGROUND_CONTEXT), abort };
}

describe("agent extension discovery", () => {
	it("discovers its own public package subpaths through the ordinary loader", async () => {
		const slice = join(here, "index.ts");
		if (!existsSync(slice)) return; // Not running inside the harness repo.
		const base = tempBase();
		const cwd = join(base, "work");
		mkdirSync(cwd, { recursive: true });
		const result = await discoverAndLoadExtensions([slice], cwd, join(base, "agent"), undefined);
		const toolNames = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
		assert.deepEqual(result.errors, []);
		assert.ok(toolNames.includes("agent_spawn") && toolNames.includes("agent_inspect"));
		const inspect = result.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "agent_inspect")?.definition;
		assert.ok(inspect);
		assert.match(inspect.description, /Provider signatures, image data, and redacted thinking are omitted/);
		assert.match(inspect.description, /not raw storage/);
		const parameters = JSON.parse(JSON.stringify(inspect.parameters));
		assert.match(parameters.properties.offset.description, /UTF-16 offset/);
		assert.deepEqual(Object.keys(parameters.properties).sort(), ["cursor", "entryId", "limit", "offset", "sessionId"]);
		assert.equal(parameters.additionalProperties, false);
		assert.equal(result.runtime, result.runtime);
		rmSync(base, { recursive: true, force: true });
	});

	it("puts discovered extension tools on the agent session tool surface", async () => {
		const slice = join(here, "testdata", "discovery", "index.ts");
		if (!existsSync(slice)) return;
		const base = tempBase();
		const sessionsRoot = join(base, "sessions");
		const cwd = join(base, "work");
		const agentDir = join(base, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot });
		const modelRuntime = await createTestRuntime({ refreshOnCreate: false });
		const { context } = rootContext();
		const worker = await AgentWorkerSession.create({
			cwd,
			agentDir,
			model: { provider: "agent-test", modelId: "model" },
			extensionPaths: [slice],
			store,
			modelRuntime,
			rootContext: context,
		});
		try {
			const status = await worker.status();
			assert.ok(status.extensions.length >= 1, `extension loaded (${status.extensions.length})`);
			assert.ok(status.tools.includes("agent_fixture"));
			assert.ok(status.activeTools.includes("agent_fixture"));
		} finally {
			await worker.close();
			await store.close(context);
			rmSync(base, { recursive: true, force: true });
		}
	});
});
