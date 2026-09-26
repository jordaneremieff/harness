import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { access } from "./access.ts";
import { utcDay } from "./collector.ts";
import { draftAssessment, MAX_DRAFT_BYTES } from "./draft.ts";
import { PillarsStore } from "./store.ts";

const hostRoot = process.env.PI_PILLARS_TEST_HOST_ROOT;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(
	hostRoot ? pathToFileURL(join(hostRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent"
);
const ai: typeof import("@earendil-works/pi-ai") = await import(
	hostRoot ? pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href : "@earendil-works/pi-ai"
);
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const proposal = "A concrete proposed answer with a questionable qualification.";

function text(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("native draft assessment follows source results without a context transform or extra turn", { timeout: 30000 }, async (t) => {
	const root = await mkdtemp(join(process.cwd(), ".pillars-draft-test-"));
	const corpus = join(root, "corpus");
	const prior = {
		PI_PILLARS_DIR: process.env.PI_PILLARS_DIR,
		PI_PILLARS_COLLECT: process.env.PI_PILLARS_COLLECT,
		PI_PILLARS_CORPUS: process.env.PI_PILLARS_CORPUS,
	};
	let session: InstanceType<typeof sdk.AgentSession> | undefined;
	try {
		await mkdir(corpus);
		await writeFile(join(corpus, "README.md"), "# Inventory\n[Example](principle-example.md)\n");
		await writeFile(join(corpus, "GOVERNANCE.md"), "# Governance\nRead applicable bodies.\n");
		await writeFile(join(corpus, "principle-example.md"), "# Example\nCheck the authorized request.\n");
		process.env.PI_PILLARS_CORPUS = corpus;
		process.env.PI_PILLARS_DIR = join(root, "store");
		process.env.PI_PILLARS_COLLECT = "1";
		const faux = ai.fauxProvider({ provider: "pillars-draft-test", models: [{ id: "controlled", contextWindow: 100000 }], tokensPerSecond: 0 });
		const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
		modelRuntime.registerNativeProvider(faux.provider);
		const errors: string[] = [];
		async function create(manager: ReturnType<typeof sdk.SessionManager.create>) {
			const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
			const loader = new sdk.DefaultResourceLoader({
				cwd: root, agentDir: join(root, "agent"), settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [entry],
				extensionFactories: [(pi) => {
					pi.registerTool({ name: "fixture_echo", label: "Fixture echo", description: "Return synthetic data.", parameters: Type.Object({}),
						async execute() { return { content: [{ type: "text", text: "Other result." }], details: undefined }; },
					});
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const result = await sdk.createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime, model: faux.getModel(),
				settingsManager, resourceLoader: loader, sessionManager: manager, tools: ["pillars", "fixture_echo"] });
			await result.session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
			assert.equal(result.session.extensionRunner.hasHandlers("context"), false);
			assert.equal(result.session.extensionRunner.hasHandlers("context_with_system"), false);
			return result.session;
		}
		function active() { assert.ok(session); return session; }
		function tool() {
			const definition = active().extensionRunner.getToolDefinition("pillars");
			assert.ok(definition);
			return definition;
		}
		function assessments() { return active().messages.filter((message) => message.role === "custom" && message.customType === "pillars-draft"); }
		function responses(...steps: FauxResponseStep[]) {
			const before = faux.state.callCount;
			const failures: unknown[] = [];
			faux.setResponses(steps.map((step) => async (context, options, state, model) => {
				try {
					assert.deepEqual(context.messages, sdk.convertToLlm(active().sessionManager.buildSessionContext().messages));
				} catch (error) { failures.push(error); }
				try { return typeof step === "function" ? await step(context, options, state, model) : step; }
				catch (error) { failures.push(error); return ai.fauxAssistantMessage("Synthetic assertion failed."); }
			}));
			return () => {
				if (failures.length) throw failures[0];
				assert.equal(faux.state.callCount - before, steps.length, "no additional provider request");
				assert.equal(faux.getPendingResponseCount(), 0);
				assert.deepEqual(errors, []);
			};
		}
		session = await create(sdk.SessionManager.create(root, join(root, "sessions")));
		let sourceJSON = "";
		await t.test("registered validation rejects unsafe draft shapes without echoing contents or sending tasks", async () => {
			const definition = tool();
			const schema = definition.parameters as { type: string; properties: { draft: { maxLength: number } }; required?: string[] };
			assert.equal(schema.type, "object");
			assert.equal(schema.properties.draft.maxLength, MAX_DRAFT_BYTES);
			assert.ok(!schema.required?.includes("draft"));
			const prepare = definition.prepareArguments;
			assert.ok(prepare);
			assert.deepEqual(prepare({}), { resource: "inventory", offset: 0 });
			const valid = { resource: "principle-example", draft: "😀".repeat(MAX_DRAFT_BYTES / 4) };
			assert.deepEqual(prepare(valid), { ...valid, offset: 0 });
			for (const draft of ["", " \n", null, 731905, { private: "do not echo" }, "a".repeat(MAX_DRAFT_BYTES + 1), "😀".repeat(MAX_DRAFT_BYTES / 4 + 1), "\ud800"]) {
				const matches = (error: unknown) => {
					assert.ok(error instanceof Error);
					const result = JSON.parse(error.message);
					assert.equal(result.schema, "pillars-source-error");
					assert.equal(result.code, "invalid_input");
					assert.match(result.message, /8192 UTF-8 bytes/);
					assert.doesNotMatch(result.message, /private|731905|do not echo/);
					return true;
				};
				assert.throws(() => prepare({ draft }), matches);
				await assert.rejects(definition.execute("invalid-draft", { draft }, undefined, undefined, active().extensionRunner.createContext()), matches);
			}
			assert.equal(assessments().length, 0);
		});
		await t.test("a source-only call keeps its exact source JSON and sends no assessment", async () => {
			const done = responses(ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "principle-example" }, { id: "plain-read" })), (context) => {
				const result = context.messages.at(-1);
				assert.ok(result?.role === "toolResult" && !result.isError);
				assert.equal(result.content.length, 1);
				sourceJSON = text(result);
				return ai.fauxAssistantMessage("Source read completed.");
			});
			await active().prompt("Read the example source.");
			done();
			const expected = await access({ resources: [{ resourceId: "principle-example", resourceClass: "entry", path: join(corpus, "principle-example.md") }] }, { resource: "principle-example" });
			assert.equal(sourceJSON, JSON.stringify(expected));
			assert.equal(assessments().length, 0);
		});
		await t.test("a draft task reaches the actual next request after every result in a tool batch", async () => {
			const done = responses(ai.fauxAssistantMessage([
				ai.fauxToolCall("pillars", { resource: "principle-example", draft: proposal }, { id: "draft-read" }),
				ai.fauxToolCall("fixture_echo", {}, { id: "other-call" }),
			]), (context) => {
				const tail = context.messages.slice(-3);
				assert.deepEqual(tail.map((message) => message.role), ["toolResult", "toolResult", "user"]);
				assert.equal(text(tail[0]), sourceJSON);
				assert.equal(text(tail[1]), "Other result.");
				assert.equal(text(tail[2]), draftAssessment(proposal));
				return ai.fauxAssistantMessage("The corrected work is the answer.");
			});
			await active().prompt("Prepare the authorized answer.");
			done();
			assert.equal(assessments().length, 1);
			const message = assessments()[0];
			assert.ok(message.role === "custom" && !message.display);
			assert.match(text(message), /agent-authored DATA/);
			assert.doesNotMatch(text(message), /operator invoked/);
		});
		await t.test("source errors and already-cancelled access send no assessment", async () => {
			const before = assessments().length;
			const done = responses(ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "governance", draft: proposal, offset: 1, referenceBodyDigest: "0".repeat(64) }, { id: "source-error" })), (context) => {
				const result = context.messages.at(-1);
				assert.ok(result?.role === "toolResult" && result.isError);
				assert.equal(JSON.parse(text(result)).code, "source_changed");
				return ai.fauxAssistantMessage("Source error received.");
			});
			await active().prompt("Check a source with a stale digest.");
			done();
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(tool().execute("cancelled-read", { resource: "governance", draft: proposal }, controller.signal, undefined, active().extensionRunner.createContext()), /source_unavailable/);
			assert.equal(assessments().length, before);
		});
		await t.test("cancellation after admission preserves native assessment history without another request", async () => {
			const before = assessments().length;
			let aborted: Promise<void> | undefined;
			const unsubscribe = active().subscribe((event) => {
				if (event.type === "tool_execution_end" && event.toolCallId === "cancel-after-admission") aborted = active().abort();
			});
			try {
				const done = responses(ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "principle-example", draft: "A draft admitted before cancellation." }, { id: "cancel-after-admission" })));
				await active().prompt("Read and submit a draft before cancellation.");
				await aborted;
				assert.ok(aborted);
				done();
				assert.equal(assessments().length, before + 1);
			} finally { unsubscribe(); }
		});
		await t.test("reload and disk resume retain history without autonomous execution or duplicate tasks", async () => {
			const count = assessments().length;
			const before = faux.state.callCount;
			await active().reload();
			assert.equal(faux.state.callCount, before);
			assert.equal(assessments().length, count);
			const file = active().sessionFile;
			assert.ok(file);
			await active().extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			active().dispose();
			session = undefined;
			assert.ok((await readFile(file, "utf8")).includes("pillars-draft"));
			session = await create(sdk.SessionManager.open(file));
			assert.equal(faux.state.callCount, before);
			assert.equal(assessments().length, count);
			const done = responses((context) => {
				assert.ok(context.messages.some((message) => text(message) === draftAssessment(proposal)));
				return ai.fauxAssistantMessage("Resume completed.");
			});
			await active().prompt("Continue the reopened task.");
			done();
			assert.equal(assessments().length, count);
		});
		await active().extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const evidence = await new PillarsStore(join(root, "store")).capture(utcDay());
		assert.ok(Object.values(evidence.shards).flatMap((shard) => shard.cells).some((cell) => cell.resourceId === "principle-example" && cell.counters.bodyVerifiedAtObservation > 0));
		assert.ok(!JSON.stringify(evidence).includes(proposal));
		assert.deepEqual(errors, []);
	} finally {
		try {
			await session?.abort();
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
		} finally {
			for (const [key, value] of Object.entries(prior)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true });
		}
	}
});
