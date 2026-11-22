import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type JsonObject,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import jobs from "./index.ts";

type Step = (context: Context) => ToolCall | undefined;

function lastResultText(context: Context): string {
	const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
	return result?.role === "toolResult"
		? result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
		: "";
}

test("an ordinary session refuses the third check of a running job in a row, past blocked calls and in a codemode loop", {
	timeout: 30_000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "jobs-check-guard-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: AgentSession | undefined;
	let plan: Step[] = [];
	let jobId = "";
	let sequence = 0;
	const errors: string[] = [];
	const model = {
		id: "deterministic",
		name: "Deterministic fixture",
		provider: "jobs-check-guard-fixture",
		api: "openai-completions" as const,
		baseUrl: "http://invalid.invalid",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 1024,
	};
	const call = (name: string, args: JsonObject): Step => {
		return () => ({ type: "toolCall", id: `call-${++sequence}`, name, arguments: args });
	};
	const status: Step = () => ({
		type: "toolCall",
		id: `call-${++sequence}`,
		name: "jobs",
		arguments: { action: "status", id: jobId },
	});
	const stream = (_model: unknown, context: Context) => {
		const events = createAssistantMessageEventStream();
		const text = lastResultText(context);
		jobId ||= /"id": "([^"]+)"/u.exec(text)?.[1] ?? "";
		const next = plan.shift()?.(context);
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: next ? [next] : [{ type: "text", text: "Done." }],
			stopReason: next ? "toolUse" : "stop",
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
	const results = () =>
		(session?.messages ?? []).flatMap((message) =>
			message.role === "toolResult"
				? [
						{
							name: message.toolName,
							isError: message.isError,
							text: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						},
					]
				: [],
		);
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
			cwd: root,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => "Execute only supplied deterministic tool calls.",
			extensionFactories: [
				jobs,
				createCodemodeExtension({ mode: "on", models: false }),
				(pi) => {
					pi.registerProvider(model.provider, {
						api: model.api,
						baseUrl: model.baseUrl,
						apiKey: "synthetic-fixture-only",
						models: [model],
						streamSimple: stream as never,
					});
					// Blocks sleep as a command policy does: a call that never runs is no work between checks.
					pi.on("tool_call", (event) =>
						event.toolName === "bash" && String(event.input.command).startsWith("sleep ")
							? { block: true, reason: "Never use sleep." }
							: undefined,
					);
				},
			],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			modelRuntime,
			resourceLoader: loader,
			settingsManager,
			sessionManager: SessionManager.inMemory(root),
			tools: ["bash", "jobs", "jobs_yield", "codemode"],
		}));
		await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });

		plan = [
			call("bash", { command: "exec node -e 'setTimeout(() => {}, 30000)'", background: true }),
			status,
			call("bash", { command: "sleep 10" }),
			status,
			status,
			call("bash", { command: "printf other" }),
			status,
		];
		await session.prompt("Check the job.", { source: "rpc" });
		const [, first, blocked, second, refused, , afterWork] = results();
		assert.equal(blocked.isError, true);
		assert.equal(blocked.text, "Never use sleep.");
		assert.match(first.text, /\n\nJob \S+ still runs\. If you are waiting for it to finish, do not check it again/u);
		assert.match(
			second.text,
			/\n\nThis is check 2 of job \S+ in a row while it runs, and check 3 in a row is refused\./u,
		);
		assert.equal(refused.isError, true);
		assert.match(refused.text, /^Refused: this would be check 3 of job \S+ in a row while it runs/u);
		assert.match(refused.text, /call jobs_yield now, and the completion starts your next turn\./u);
		assert.equal(afterWork.isError, false, "a call of another tool that ran starts a new streak");
		assert.match(afterWork.text, /\n\nJob \S+ still runs\./u);

		const loop = `
			const out = [];
			for (let index = 0; index < 4; index++) {
				try { out.push((await tools.jobs({action: "status", id: ${JSON.stringify(jobId)}})).job.status); }
				catch (error) { out.push(String(error?.message ?? error)); }
			}
			return out;`;
		plan = [call("codemode", { code: loop })];
		await session.prompt("Run the script.", { source: "rpc" });
		const script = results().at(-1);
		assert.equal(script?.name, "codemode");
		const outcome = JSON.parse(script?.text.slice(script.text.indexOf("[")) ?? "[]") as string[];
		assert.deepEqual(outcome.slice(0, 2), ["running", "running"]);
		assert.match(outcome[2] ?? "", /Refused: this would be check 3 of job/u, "a nested loop is refused too");
		assert.match(outcome[3] ?? "", /Refused: this would be check 4 of job/u);
		assert.deepEqual(errors, []);
	} finally {
		try {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(root, { recursive: true, force: true });
		}
	}
});
