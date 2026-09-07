import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Shard, slotFor, validateShard } from "./capacity.ts";
import { utcDay } from "./collector.ts";
import { PillarsStore } from "./store.ts";

const hostRoot = process.env.PI_PILLARS_TEST_HOST_ROOT;
const sdk: typeof import("@earendil-works/pi-coding-agent") = await import(hostRoot ? pathToFileURL(join(hostRoot, "dist/index.js")).href : "@earendil-works/pi-coding-agent");
const ai: typeof import("@earendil-works/pi-ai") = await import(hostRoot ? pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href : "@earendil-works/pi-ai");
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const entryBody = "# Synthetic lifecycle principle\nCheck the actual session boundary.\n";

async function fixture() {
	const root = await mkdtemp(join(process.cwd(), ".pillars-lifecycle-test-"));
	const skill = join(root, "package/skills/pillars/SKILL.md");
	try {
		await mkdir(join(root, "package/skills/pillars"), { recursive: true });
		await mkdir(join(root, "package/pillars"));
		await mkdir(join(root, "home"));
		await mkdir(join(root, "agent"));
		await writeFile(skill, "---\nname: pillars\ndescription: Consult the synthetic corpus for session checks.\ncompatibility: Requires ../../pillars\n---\nRead ../../pillars/README.md.\n");
		await writeFile(join(root, "package/pillars/README.md"), "# Synthetic lifecycle inventory\n[Lifecycle](principle-lifecycle.md)\n");
		await writeFile(join(root, "package/pillars/GOVERNANCE.md"), "# Synthetic governance\nRead the full selected body.\n");
		await writeFile(join(root, "package/pillars/principle-lifecycle.md"), entryBody);
		return { root, skill, agentDir: join(root, "agent"), store: join(root, "store") };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}

function summary(shard: Shard) {
	return {
		requests: shard.cells.reduce((total, cell) => total + cell.counters.readRequests, 0),
		results: shard.cells.reduce((total, cell) => total + cell.counters.readResults, 0),
		verified: shard.cells.reduce((total, cell) => total + cell.counters.bodyVerifiedAtObservation, 0),
	};
}

function committedShard(root: string, day: string): Shard {
	const slot = slotFor(day);
	const shard: unknown = JSON.parse(readFileSync(join(root, slot), "utf8"));
	validateShard(shard, slot);
	return shard;
}

test("the actual Pi CLI prints the Pillars inventory without a provider request", { timeout: 40000 }, async () => {
	const f = await fixture();
	try {
		const output = execFileSync(process.execPath, [
			join(hostRoot ?? sdk.getPackageDir(), "dist/cli.js"), "--print", "--offline", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--extension", entry, "--skill", f.skill, "--model", "anthropic/claude-sonnet-4-5", "/pillars",
		], {
			cwd: f.root, input: "", encoding: "utf8", stdio: "pipe", timeout: 30000, maxBuffer: 65536,
			env: {
				PATH: process.env.PATH, HOME: join(f.root, "home"), PI_CODING_AGENT_DIR: f.agentDir,
				PI_PILLARS_DIR: f.store, PI_PILLARS_COLLECT: "0", PI_OFFLINE: "1", NO_COLOR: "1",
			},
		});
		assert.match(output, /# Synthetic lifecycle inventory/);
		assert.match(output, /principle-lifecycle\.md/);
		assert.match(output, /Source: inventory; SHA-256: [a-f0-9]{64}\./);
		assert.doesNotMatch(output, /source_unavailable/);
		const invalid = spawnSync(process.execPath, [
			join(hostRoot ?? sdk.getPackageDir(), "dist/cli.js"), "--print", "--offline", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--extension", entry, "--skill", f.skill, "--model", "anthropic/claude-sonnet-4-5", "/pillars",
		], {
			cwd: f.root, input: "", encoding: "utf8", timeout: 30000, maxBuffer: 65536,
			env: { PATH: process.env.PATH, HOME: join(f.root, "home"), PI_CODING_AGENT_DIR: f.agentDir,
				PI_PILLARS_DIR: f.store, PI_PILLARS_COLLECT: "invalid", PI_OFFLINE: "1", NO_COLOR: "1" },
		});
		assert.equal(invalid.status, 0);
		assert.match(invalid.stdout, /# Synthetic lifecycle inventory/);
		assert.match(invalid.stderr, /PI_PILLARS_COLLECT requires 0 or 1/);
		assert.doesNotMatch(invalid.stdout, /PI_PILLARS_COLLECT requires/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const transition of ["fork", "reload"] as const) {
	test(`the actual Pi ${transition} awaits the old collector and starts a fresh owner without replay`, { timeout: 40000 }, async (t) => {
		const f = await fixture();
		const previousDirectory = process.env.PI_PILLARS_DIR;
		const previousCollect = process.env.PI_PILLARS_COLLECT;
		process.env.PI_PILLARS_DIR = f.store;
		process.env.PI_PILLARS_COLLECT = "1";
		let runtime: InstanceType<typeof sdk.AgentSessionRuntime> | undefined;
		let disposed = false;
		try {
			const faux = ai.fauxProvider({ provider: "pillars-lifecycle-test", models: [{ id: "reader", reasoning: true, contextWindow: 100000 }], tokensPerSecond: 0 });
			const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
			modelRuntime.registerNativeProvider(faux.provider);
			const errors: string[] = [];
			const createRuntime: import("@earendil-works/pi-coding-agent").CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
				const services = await sdk.createAgentSessionServices({
					cwd, agentDir, modelRuntime,
					settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
					resourceLoaderOptions: {
						noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
						additionalExtensionPaths: [entry], additionalSkillPaths: [f.skill],
					},
				});
				assert.deepEqual(services.diagnostics, []);
				assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
				return {
					...await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), thinkingLevel: "high", tools: ["pillars"] }),
					services, diagnostics: services.diagnostics,
				};
			};
			runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd: f.root, agentDir: f.agentDir, sessionManager: sdk.SessionManager.inMemory(f.root) });
			const bind = async (session: InstanceType<typeof sdk.AgentSession>) => {
				await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
			};
			runtime.setRebindSession(bind);
			await bind(runtime.session);
			const now = Date.now();
			const day = utcDay(now);
			// Hold the retry clock, not filesystem work, so shutdown owns the pending result flush.
			t.mock.method(Date, "now", () => now);
			const runRead = async () => {
				faux.setResponses([
					ai.fauxAssistantMessage(ai.fauxToolCall("pillars", { resource: "principle-lifecycle" }, { id: "reused-call-id" })),
					ai.fauxAssistantMessage("Synthetic read complete."),
				]);
				await runtime!.session.prompt("Read the synthetic lifecycle principle.");
				const result = runtime!.session.messages.findLast((message) => message.role === "toolResult");
				assert.ok(result && result.role === "toolResult");
				assert.equal(result.isError, false);
				const text = result.content.find((block) => block.type === "text");
				assert.ok(text && text.type === "text");
				assert.equal(JSON.parse(text.text).text, entryBody);
			};
			await runRead();
			const initial = committedShard(f.store, day);
			assert.deepEqual(summary(initial), { requests: 1, results: 0, verified: 0 });
			assert.equal(initial.receipts.length, 1);
			const originalOwner = initial.receipts[0].owner;
			const oldSession = runtime.session;
			const oldRunner = oldSession.extensionRunner;
			const boundaries: ReturnType<typeof summary>[] = [];
			// This synchronous host callback cannot wait for a late writer or acquire its lock.
			runtime.setBeforeSessionInvalidate(() => boundaries.push(summary(committedShard(f.store, day))));
			if (transition === "fork") {
				const leaf = oldSession.sessionManager.getLeafId();
				assert.ok(leaf);
				assert.deepEqual(await runtime.fork(leaf, { position: "at" }), { cancelled: false, selectedText: undefined });
				assert.notEqual(runtime.session, oldSession);
			} else {
				await oldSession.reload({ beforeSessionStart: async () => { boundaries.push(summary(committedShard(f.store, day))); } });
				assert.equal(runtime.session, oldSession);
			}
			assert.notEqual(runtime.session.extensionRunner, oldRunner);
			assert.deepEqual(boundaries, [{ requests: 1, results: 1, verified: 1 }]);
			const afterReplacement = committedShard(f.store, day);
			assert.deepEqual(summary(afterReplacement), { requests: 1, results: 1, verified: 1 });
			assert.deepEqual(afterReplacement.receipts, [{ owner: originalOwner, seq: 2 }]);
			assert.equal(runtime.session.messages.filter((message) => message.role === "toolResult").length, 1);
			await runRead();
			const beforeDispose = committedShard(f.store, day);
			assert.deepEqual(summary(beforeDispose), { requests: 2, results: 1, verified: 1 });
			assert.equal(beforeDispose.receipts.length, 2);
			const newReceipt = beforeDispose.receipts.find((receipt) => receipt.owner !== originalOwner);
			assert.ok(newReceipt);
			assert.equal(newReceipt.seq, 1);
			await runtime.dispose();
			disposed = true;
			assert.deepEqual(boundaries, [{ requests: 1, results: 1, verified: 1 }, { requests: 2, results: 2, verified: 2 }]);
			const snapshot = await new PillarsStore(f.store).capture(day);
			const final = snapshot.shards[day];
			assert.deepEqual(summary(final), { requests: 2, results: 2, verified: 2 });
			assert.equal(final.receipts.length, 2);
			assert.ok(final.receipts.every((receipt) => receipt.seq === 2));
			assert.equal(final.health.forkResets, transition === "fork" ? 1 : 0);
			assert.equal(final.health.writeFailures, 0);
			assert.equal(final.health.pendingDroppedEvents, 0);
			assert.deepEqual(errors, []);
		} finally {
			try { if (runtime && !disposed) await runtime.dispose(); }
			finally {
				if (previousDirectory === undefined) delete process.env.PI_PILLARS_DIR; else process.env.PI_PILLARS_DIR = previousDirectory;
				if (previousCollect === undefined) delete process.env.PI_PILLARS_COLLECT; else process.env.PI_PILLARS_COLLECT = previousCollect;
				await rm(f.root, { recursive: true, force: true });
			}
		}
	});
}
