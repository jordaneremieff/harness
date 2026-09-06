import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type AssistantMessage,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import jobs from "../extensions/jobs/index.ts";
import policy from "../extensions/policy/index.ts";

// Node's test runner isolates this file in its own process. Restore the environment before cleanup.
test("AgentSession admits command jobs through policy and owns their lifecycle", { timeout: 30_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "command-jobs-session-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "cwd");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const previous = new Map(
		["PI_CODING_AGENT_DIR", "PI_POLICY_DIR", "PI_POLICY_MODE"].map((key) => [key, process.env[key]]),
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_POLICY_DIR = join(agentDir, "policy");
	process.env.PI_POLICY_MODE = "enforce";
	let session: AgentSession | undefined;
	const errors: string[] = [];
	let pending: ToolCall | undefined;
	let sequence = 0;
	const model = {
		id: "deterministic",
		name: "Deterministic fixture",
		provider: "command-jobs-fixture",
		api: "openai-completions" as const,
		baseUrl: "http://invalid.invalid",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1024,
	};
	const stream = () => {
		const events = createAssistantMessageEventStream();
		const call = pending;
		pending = undefined;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: call ? [call] : [{ type: "text", text: "Done." }],
			stopReason: call ? "toolUse" : "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		events.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
		events.end();
		return events;
	};
	async function call(name: string, args: Record<string, unknown>, isError = false) {
		assert.ok(session);
		const id = `fixture-${++sequence}`;
		pending = { type: "toolCall", id, name, arguments: args };
		await session.prompt(`Execute fixture step ${sequence}.`, { source: "rpc" });
		const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
		assert.ok(result && result.role === "toolResult", "AgentSession must publish the tool result");
		assert.equal(result.isError, isError, JSON.stringify(result.content));
		return result;
	}
	async function data(name: string, args: Record<string, unknown>) {
		const result = await call(name, args);
		return JSON.parse(JSON.stringify(result.details));
	}
	async function until(check: () => Promise<boolean>) {
		const deadline = Date.now() + 5000;
		while (!(await check())) {
			assert.ok(Date.now() < deadline, "The observable condition must settle before the deadline");
			await delay(20);
		}
	}
	try {
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStorePath: join(agentDir, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Execute only the supplied deterministic fixture calls.",
			extensionFactories: [
				jobs,
				policy,
				(pi) =>
					pi.registerProvider(model.provider, {
						api: model.api,
						baseUrl: model.baseUrl,
						apiKey: "synthetic-fixture-only",
						models: [model],
						streamSimple: stream,
					}),
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 3);
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: ["bash", "jobs"],
		}));
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });

		// This real package rule rejects a file read before any shell side effect or job admission.
		writeFileSync(join(cwd, "input.txt"), "fixture input\n");
		await call(
			"bash",
			{ command: "printf launched > denied-marker; cat input.txt", background: true },
			true,
		);
		assert.equal(existsSync(join(cwd, "denied-marker")), false);
		assert.deepEqual((await data("jobs", { action: "list" })).jobs, []);

		const launched = await data("bash", {
			command: "printf 'started\\n'; while [ ! -f release ]; do sleep 0.02; done; printf 'finished\\n'; exit 7",
			background: true,
			timeout: 10,
		});
		const id = launched.job.id;
		assert.equal(typeof id, "string");
		assert.equal(launched.job.status, "running");
		await until(async () => (await data("jobs", { action: "logs", id })).text.includes("started\n"));
		const foreground = await call("bash", { command: "printf independent" });
		assert.match(JSON.stringify(foreground.content), /independent/);
		assert.equal((await data("jobs", { action: "status", id })).job.status, "running");
		writeFileSync(join(cwd, "release"), "");
		await until(async () => (await data("jobs", { action: "status", id })).job.status !== "running");
		const terminal = (await data("jobs", { action: "status", id })).job;
		assert.equal(terminal.status, "failed");
		assert.equal(terminal.exitCode, 7);
		const logs = await data("jobs", { action: "logs", id });
		assert.equal(logs.text, "started\nfinished\n");
		assert.equal(logs.gap, false);
		assert.equal((await data("jobs", { action: "logs", id, cursor: logs.next })).text, "");

		const cancel = (await data("bash", { command: "printf '%s' $$ > cancel-pid; exec sleep 30", background: true }))
			.job;
		await until(async () => existsSync(join(cwd, "cancel-pid")));
		const cancelPid = Number(readFileSync(join(cwd, "cancel-pid"), "utf8"));
		assert.equal((await data("jobs", { action: "cancel", id: cancel.id })).job.cancellationRequested, true);
		await until(async () => (await data("jobs", { action: "status", id: cancel.id })).job.status === "cancelled");
		assert.throws(() => process.kill(cancelPid, 0), { code: "ESRCH" });

		const owned = (await data("bash", { command: "printf '%s' $$ > shutdown-pid; exec sleep 30", background: true }))
			.job;
		await until(async () => existsSync(join(cwd, "shutdown-pid")));
		const shutdownPid = Number(readFileSync(join(cwd, "shutdown-pid"), "utf8"));
		assert.equal((await data("jobs", { action: "status", id: owned.id })).job.status, "running");
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.throws(() => process.kill(shutdownPid, 0), { code: "ESRCH" });
		assert.equal((await data("jobs", { action: "status", id: owned.id })).job.status, "cancelled");
		assert.deepEqual(errors, []);
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	}
});
