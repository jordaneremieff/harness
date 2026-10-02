import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
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
		assert.match(inspect.description, /History and exact-entry reads omit provider signatures, image data, and redacted thinking with markers and counts/);
		assert.match(inspect.description, /branch\/search exclude those payloads/);
		const parameters = JSON.parse(JSON.stringify(inspect.parameters));
		assert.match(parameters.properties.offset.description, /UTF-16 offset/);
		assert.match(parameters.properties.offset.description, /not raw storage/);
		assert.deepEqual(Object.keys(parameters.properties).sort(), ["continuation", "cursor", "entryId", "fromId", "limit", "offset", "operationId", "query", "sessionId", "source", "view"]);
		assert.equal(parameters.additionalProperties, false);
		const list = result.extensions.flatMap((extension) => [...extension.tools.values()]).find((tool) => tool.definition.name === "agent_list")?.definition;
		assert.ok(list);
		const listing = JSON.parse(JSON.stringify(list.parameters));
		assert.deepEqual(Object.keys(listing.properties).sort(), ["cursor", "cwd", "limit", "query"]);
		assert.equal(listing.properties.limit.maximum, 20);
		assert.match(list.description, /not full transcript content/);
		const definitions = result.extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
		const bytes = definitions.reduce((total, { name, description, parameters }) => total + Buffer.byteLength(JSON.stringify({ name, description, parameters })), 0);
		assert.ok(bytes <= 13_051, `tool declarations exceed the byte budget: ${bytes}`);
		const guidelines = definitions.flatMap((tool) => tool.promptGuidelines ?? []).join("\n");
		assert.match(guidelines, /objective, output format, source guidance, and boundaries/);
		assert.match(guidelines, /AGENTS.md "Intent authority"/);
		assert.match(guidelines, /terminal response is the result/);
		assert.match(guidelines, /settlement returns to the recorded owner automatically/);
		assert.match(guidelines, /resolve live work before a final conclusion/);
		assert.match(guidelines, /Never poll with sleeps or repeated status\/inspection calls/);
		assert.match(guidelines, /agent_send to the owner ID in its session-ownership section/);
		const configure = definitions.find((tool) => tool.name === "agent_configure");
		assert.match(configure?.description ?? "", /Supply at least one of name, model, or thinkingLevel/);
		const place = definitions.find((tool) => tool.name === "agent_place");
		assert.match(place?.description ?? "", /durable owner/);
		assert.match(place?.description ?? "", /agent_spawn for a fresh task, agent_detach for execution beyond this process/);
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
