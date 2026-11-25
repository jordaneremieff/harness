import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type AssistantMessage,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { JOB_COMPLETION_MESSAGE, type JobCompletionDetails } from "./completion.ts";
import jobs from "./index.ts";
import { JOB_LIMITS } from "./manager.ts";

test("native codemode composes Bash and managed jobs in an ordinary session", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "jobs-codemode-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: AgentSession | undefined;
	let pending: ToolCall | undefined;
	let sequence = 0;
	const errors: string[] = [];
	const nested: Array<{ name: string; isError: boolean; details: unknown }> = [];
	const model = {
		id: "deterministic",
		name: "Deterministic fixture",
		provider: "jobs-codemode-fixture",
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
	async function script(code: string) {
		assert.ok(session);
		const id = `composition-${++sequence}`;
		pending = { type: "toolCall", id, name: "codemode", arguments: { code } };
		await session.prompt("Execute the supplied composition.", { source: "rpc" });
		const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
		assert.ok(result && result.role === "toolResult");
		assert.equal(result.isError, false, JSON.stringify(result.content));
		const text = result.content
			.slice(1)
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return JSON.parse(text);
	}
	async function settled(id: string) {
		for (let attempt = 0; attempt < 100; attempt++) {
			const result = await script(`return await tools.jobs({action: "status", id: ${JSON.stringify(id)}});`);
			if (result.job.status !== "running") return result.job;
		}
		assert.fail("Job did not settle within bounded session observations");
	}
	/** A finite job's completion arrives as a custom message that starts its own turn; wait for that turn to settle. */
	async function completed(id: string): Promise<JobCompletionDetails> {
		assert.ok(session);
		const deadline = Date.now() + 10_000;
		for (;;) {
			const message = session.messages.find(
				(entry) =>
					entry.role === "custom" &&
					entry.customType === JOB_COMPLETION_MESSAGE &&
					(entry.details as JobCompletionDetails).job.id === id,
			);
			if (message?.role === "custom" && session.isIdle) return message.details as JobCompletionDetails;
			assert.ok(Date.now() < deadline, "the completion message starts and settles a turn before the deadline");
			await new Promise((resolve) => setTimeout(resolve, 20));
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
						streamSimple: stream,
					});
					pi.on("tool_result", (event) => {
						if (event.parentToolCallId)
							nested.push({ name: event.toolName, isError: event.isError, details: event.details });
					});
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
			tools: ["bash", "jobs", "codemode"],
		}));
		await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
		const foreground = await script(`
			const success = await tools.bash({command: "printf composed"});
			const failure = await tools.bash({command: "printf failure >&2; exit 7"});
			let rejected = false;
			try { await tools.jobs({action: "status", id: "unknown"}); } catch { rejected = true; }
			return {success, failure, rejected, empty: await tools.jobs({action: "list"})};
		`);
		assert.equal(foreground.success.output, "composed");
		assert.equal(foreground.success.exit_code, 0);
		assert.equal(foreground.success.truncated, false);
		assert.equal(typeof foreground.success.wall_time_seconds, "number");
		assert.equal(foreground.failure.output, "failure");
		assert.equal(foreground.failure.exit_code, 7);
		assert.equal(foreground.rejected, true);
		assert.deepEqual(foreground.empty, { jobs: [] });
		assert.ok(nested.some((event) => event.name === "bash" && event.isError));

		const longLine = `node -e 'process.stdout.write("x".repeat(120_000) + "FINAL EVIDENCE\\n\\n")'`;
		const previousTemp = process.env.TMPDIR;
		try {
			process.env.TMPDIR = root;
			const saved = await session.executeBash(longLine);
			assert.equal(saved.truncated, true);
			assert.match(saved.output, /xFINAL EVIDENCE/u);
			assert.ok(saved.fullOutputPath);
			assert.equal(saved.fullOutputError, undefined);
			assert.equal((await readFile(saved.fullOutputPath, "utf8")).length, 120_016);
			const full = await script(`
				const {output, ...facts} = await tools.bash({command: ${JSON.stringify(longLine)}});
				return {...facts, length: output.length, ending: output.slice(-16)};
			`);
			assert.equal(full.truncated, false, "the program reads the saved output beyond the model-facing limit");
			assert.equal(full.full_output_path, undefined);
			assert.equal(full.length, 120_016);
			assert.equal(full.ending, "FINAL EVIDENCE\n\n");

			process.env.TMPDIR = join(root, "missing-temp-directory");
			const missing = await script(`
				const short = ${JSON.stringify(longLine)};
				const long = ${JSON.stringify(longLine.replace("120_000", "320_000"))};
				const summarize = ({output, ...facts}) => ({...facts, ending: output.slice(-20)});
				return {
					complete: summarize(await tools.bash({command: short})),
					success: summarize(await tools.bash({command: long})),
					failure: summarize(await tools.bash({command: long + "; exit 7"})),
				};
			`);
			assert.equal(missing.complete.truncated, false, "a failed spill does not itself truncate program output");
			assert.equal(missing.complete.full_output_error, undefined);
			const modelDetails = nested.at(-3)?.details as { truncation?: { truncated?: boolean }; fullOutputError?: string };
			assert.equal(modelDetails.truncation?.truncated, true);
			assert.match(modelDetails.fullOutputError ?? "", /ENOENT/u);
			for (const [result, exit] of [
				[missing.success, 0],
				[missing.failure, 7],
			] as const) {
				assert.equal(result.exit_code, exit);
				assert.equal(result.truncated, true);
				assert.equal(result.full_output_path, undefined);
				assert.match(result.full_output_error, /ENOENT/u);
				assert.match(result.ending, /xFINAL EVIDENCE/u);
			}
			assert.deepEqual(
				nested.slice(-2).map((event) => event.isError),
				[false, true],
			);

			const failed = await session.executeBash(`${longLine}; exit 7`);
			assert.equal(failed.exitCode, 7);
			assert.equal(failed.truncated, true);
			assert.equal(failed.fullOutputPath, undefined);
			assert.match(failed.fullOutputError ?? "", /ENOENT/u);
			assert.match(failed.output, /xFINAL EVIDENCE/u);
			await session.executeBash(`printf EXCLUDED_USER_BASH`, undefined, { excludeFromContext: true });
			const retained = session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message] : [],
				);
			assert.equal(retained.at(-2)?.fullOutputError, failed.fullOutputError);
			assert.equal(retained.at(-1)?.excludeFromContext, true);
			const projected = JSON.stringify(convertToLlm(retained));
			assert.match(projected, /Command exited with code 7/u);
			assert.match(projected, /Could not save the full output: ENOENT/u);
			assert.doesNotMatch(projected, /EXCLUDED_USER_BASH/u);
		} finally {
			if (previousTemp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTemp;
		}

		const admitted = await script(`return await tools.bash({
			command: ${JSON.stringify(`node -e 'process.stdout.write("x".repeat(${JOB_LIMITS.logBytes + 1000}))'`)}, background: true});`);
		assert.equal(admitted.job.status, "running");
		const delivered = await completed(admitted.job.id);
		assert.equal(delivered.job.status, "succeeded");
		assert.equal(delivered.tail.omitted, true, "a ring cut is reported as omitted output");
		assert.equal(delivered.tail.outputBytes, JOB_LIMITS.logBytes + 1000);
		assert.equal((await settled(admitted.job.id)).status, "succeeded");
		const observed = await script(`
			const id = ${JSON.stringify(admitted.job.id)};
			const logs = await tools.jobs({action: "logs", id});
			const next = await tools.jobs({action: "logs", id, cursor: logs.next});
			return {logs, next, list: await tools.jobs({action: "list"})};
		`);
		assert.equal(observed.logs.gap, true);
		assert.equal(observed.logs.earliest, 1000);
		assert.equal(Buffer.byteLength(observed.logs.text), JOB_LIMITS.pageBytes);
		assert.equal(observed.logs.more, true);
		assert.equal(observed.next.gap, false);
		assert.equal(observed.next.next, observed.logs.next + JOB_LIMITS.pageBytes);
		assert.equal(observed.list.jobs[0].id, admitted.job.id);

		execFileSync("mkfifo", [join(root, "gate")]);
		const timeout = await script(`
			try { await tools.bash({command: "read value < gate", timeout: 0.02}); }
			catch (error) { return {message: error.message}; }
			throw new Error("Foreground timeout did not reject");
		`);
		assert.match(timeout.message, /Command timed out/);
		const start = `await tools.bash({command: 'read value < gate', background: true})`;
		const cancelled = await script(`const {job} = ${start}; return await tools.jobs({action: "cancel", id: job.id});`);
		assert.equal(cancelled.job.cancellationRequested, true);
		assert.equal((await settled(cancelled.job.id)).status, "cancelled");
		const owned = await script(`return ${start};`);
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const shutdown = await script(`return await tools.jobs({action: "status", id: ${JSON.stringify(owned.job.id)}});`);
		assert.equal(shutdown.job.status, "cancelled");
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
