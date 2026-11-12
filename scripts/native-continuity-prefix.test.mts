/**
 * Prefix stability of native provider requests with the Agent and Stash extensions loaded.
 *
 * The runtime is the production in-process Durable runtime over an isolated agent home. The
 * provider is synthetic and records the message array of every request it receives, which is
 * the array after every `beforeRequest` hook. No real provider, network, or operator store is
 * used.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog, hostMetadata } from "../extensions/agent/catalog.ts";
import { DurableHost } from "../extensions/agent/durable-host.ts";
import { answerMessage, completed } from "../extensions/agent/durable-host-fixture.mts";
import { createDurableRuntime } from "../extensions/agent/durable-runtime.ts";
import { createTestRuntime, testModel } from "../extensions/agent/test-runtime.mts";

const agentExtension = realpathSync(fileURLToPath(new URL("../extensions/agent/index.ts", import.meta.url)));
const stashExtension = realpathSync(fileURLToPath(new URL("../extensions/stash/index.ts", import.meta.url)));
const NOTE = /^Host-held continuity facts from the Agent extension for context head entry (\d+)\./u;
/** Environment inputs that select an agent home, a machine document, or a Stash store. */
const ISOLATED_ENV = ["PI_CODING_AGENT_DIR", "PI_HARNESS_FILE", "PI_STASH_DIR", "PI_STASH_CHECKPOINT_DIR"] as const;

function text(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function noteIndexes(messages: readonly Message[]): number[] {
	return messages.flatMap((message, index) => message.role === "user" && NOTE.test(text(message)) ? [index] : []);
}

/** Names of the tools the system messages of one request declare. */
function offeredTools(messages: readonly Message[]): string[] {
	return messages.flatMap((message) => message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
}

/**
 * Requires `later` to begin with exactly the messages of `earlier`. A failure names the first
 * differing index and a bounded excerpt of both values; a whole-array assertion would diff the
 * complete system prompt.
 */
function assertPrefix(earlier: readonly Message[], later: readonly Message[], label: string): void {
	assert.ok(later.length > earlier.length, `${label}: the later request has ${later.length} messages, the earlier one ${earlier.length}`);
	const index = earlier.findIndex((message, position) => !isDeepStrictEqual(message, later[position]));
	if (index < 0) return;
	const before = JSON.stringify(earlier[index]), after = JSON.stringify(later[index]);
	let offset = 0;
	while (offset < before.length && before[offset] === after[offset]) offset++;
	const from = Math.max(0, offset - 80);
	assert.fail(`${label}: message ${index} (${earlier[index].role}) differs at serialized offset ${offset}: ${before.slice(from, offset + 240)} became ${after.slice(from, offset + 240)}`);
}

/** An isolated agent home that loads only the Agent and Stash extensions, with a recording provider. */
async function nativeFixture(t: TestContext) {
	const parent = realpathSync(tmpdir());
	// A short root keeps every host socket path below the platform pathname limit.
	const root = mkdtempSync(join(Buffer.byteLength(parent) <= 28 ? parent : realpathSync("/tmp"), "ncp-"));
	const agentDir = join(root, "agent"), cwd = join(root, "work");
	mkdirSync(agentDir); mkdirSync(cwd);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		extensions: [agentExtension, stashExtension], cacheWarming: "off", retry: { enabled: false },
		// A manual compaction of a short conversation needs a cut point.
		compaction: { keepRecentTokens: 1 },
	}));
	writeFileSync(join(agentDir, "harness.json"), JSON.stringify({ version: 1 }));
	const previous = new Map(ISOLATED_ENV.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HARNESS_FILE = join(agentDir, "harness.json");
	process.env.PI_STASH_DIR = join(root, "stash");
	process.env.PI_STASH_CHECKPOINT_DIR = join(root, "stash-checkpoints");

	const requests: Message[][] = [];
	const models = await createTestRuntime();
	const stream = (_model: unknown, transcript: TranscriptContext) => {
		requests.push(structuredClone(transcript.messages));
		return completed(answerMessage(`answer ${requests.length}`));
	};
	models.registerNativeProvider({
		id: testModel.provider, name: "Prefix stability fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});

	const open = DurableHost.open.bind(DurableHost);
	let native: DurableHost | undefined;
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => {
		native = await open(...args);
		return native;
	});
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(async () => {
		try { await runtime?.close(); }
		finally {
			for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
			rmSync(root, { recursive: true, force: true });
		}
	});
	const record = new AgentCatalog(root).create({ cwd, agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", trust: true });
	const started = await createDurableRuntime(hostMetadata(record), { modelRuntime: models });
	runtime = started;
	assert.ok(native);
	const host = native;
	const context = withAbortSignal(t.signal, BACKGROUND_CONTEXT);
	let sequence = 0;

	return {
		runtime: started,
		/** Submit one input, wait for its answer, and return the provider request that generated it. */
		async ask(input: string): Promise<Message[]> {
			const id = `input-${++sequence}`;
			const receipt = await started.request("submit", { message: input, requestId: id }, id, t.signal) as { submissionId: number };
			assert.equal((await host.wait(receipt.submissionId as SubmissionId, context)).status, "done");
			// The input is the last user message of its generation request; a summarisation request ends otherwise.
			const generated = requests.filter((messages) => text(messages.findLast((message) => message.role === "user")) === input);
			assert.equal(generated.length, 1, `one provider request ends with the input "${input}"`);
			return generated[0];
		},
	};
}

it("keeps each provider request an exact prefix of the next with Agent and Stash loaded", { timeout: 60000 }, async (t) => {
	const fixture = await nativeFixture(t);
	const first = await fixture.ask("first input");
	const second = await fixture.ask("second input");
	const third = await fixture.ask("third input");

	const status = await fixture.runtime.request("status", {}, "status", t.signal) as { inventory: { contributions: { name: string; source: string }[] } };
	const sources = status.inventory.contributions.map((item) => item.source);
	assert.ok(sources.includes(agentExtension), "the Agent contribution comes from the repository extension");
	assert.ok(sources.includes(stashExtension), "the Stash contribution comes from the repository extension");
	const tools = offeredTools(first);
	assert.ok(tools.some((name) => name.startsWith("agent_")), "the provider is offered an Agent tool");
	assert.ok(tools.includes("stash_write"), "the provider is offered a Stash tool");

	assert.deepEqual(noteIndexes(third), [], "a conversation without a context head carries no continuity note");
	assertPrefix(first, second, "second request");
	assertPrefix(second, third, "third request");
});

it("keeps the request prefix and the continuity note position after a compaction", { timeout: 60000 }, async (t) => {
	const fixture = await nativeFixture(t);
	await fixture.ask("first input before compaction");
	await fixture.ask("second input before compaction");
	const compacted = await fixture.runtime.request("compact", { wait: true }, "compact", t.signal) as { status: string };
	assert.equal(compacted.status, "completed");

	const first = await fixture.ask("first input after compaction");
	const second = await fixture.ask("second input after compaction");
	const tools = offeredTools(first);
	assert.ok(tools.some((name) => name.startsWith("agent_")) && tools.includes("stash_write"), "both extensions stay loaded after the compaction");

	const notes = noteIndexes(first);
	assert.equal(notes.length, 1, "the first request after the compaction carries one continuity note");
	assertPrefix(first, second, "second request after the compaction");
	assert.deepEqual(noteIndexes(second), notes, "the continuity note keeps its position");
});
