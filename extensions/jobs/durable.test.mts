import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import * as Durable from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { JOB_COMPLETION_MESSAGE, type JobCompletionDetails } from "./completion.ts";
import { createJobsContribution, JOB_TASK_NAME, type DurableContributionHost, type JobInput } from "./durable.ts";

const ENTRYPOINT = fileURLToPath(new URL("./index.ts", import.meta.url));
const context = BACKGROUND_CONTEXT;
let root: string;
before(() => {
	root = mkdtempSync(join(tmpdir(), "jobs-durable-"));
});
after(() => {
	rmSync(root, { recursive: true, force: true });
});

type Script = (lastUserText: string, lastToolResult: { name: string; text: string; isError: boolean } | undefined) => ReturnType<typeof fauxAssistantMessage>;

type JobProbe = {
	beforeEnv?(id: number): Promise<void>;
	beforeCommit?(id: number): void;
	onExec?(id: number): void;
	beforeRuntimeCommit?(id: number, ordinal: number, signal: AbortSignal): Promise<void>;
	beforeSubmit?(id: number, signal: AbortSignal): Promise<void>;
	afterSubmit?(id: number, signal: AbortSignal): Promise<void>;
};

function probedConversation(conversation: Durable.ConversationHandle, probe: JobProbe, id: number, signal: AbortSignal): Durable.ConversationHandle {
	return new Proxy(conversation, { get(target, key) {
		if (key === "submit") return async (draft: Durable.SubmissionDraft, context: Context) => {
			await probe.beforeSubmit?.(id, signal);
			const submitted = await conversation.submit(draft, context);
			await probe.afterSubmit?.(id, signal);
			return submitted;
		};
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}

function runtimeFacade<I, S, R, H extends object>(runtime: Durable.TaskRuntime<I, S, R, H>, methods: Pick<Durable.TaskRuntime<I, S, R, H>, "env" | "commit" | "conversation">): Durable.TaskRuntime<I, S, R, H> {
	return new Proxy(runtime, { get(target, key) {
		if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}

function probedDurable(probe: JobProbe): typeof Durable {
	function defineTask<I, S extends { phase: string }, R, H extends object = object>(definition: Durable.TaskDefinition<I, S, R, H>): Durable.Task<I, S, R, H> {
		if (definition.name !== JOB_TASK_NAME) return Durable.defineTask(definition);
		const phases = Object.fromEntries(Object.entries(definition.phases).map(([phase, handler]) => [phase,
			async (task: Durable.RunningTask<I, S, R>, runtime: Durable.TaskRuntime<I, S, R, H>, context: Context) => {
				let committed = false;
				let commits = 0;
				const env = async (...args: Parameters<typeof runtime.env>) => {
					await probe.beforeEnv?.(Number(task.id));
					const env = await runtime.env(...args);
					if (!env || !probe.onExec) return env;
					const execute = env.exec.bind(env);
					env.exec = (...args) => { probe.onExec?.(Number(task.id)); return execute(...args); };
					return env;
				};
				const commit = async (...args: Parameters<typeof runtime.commit>) => {
					if (!committed) { committed = true; probe.beforeCommit?.(Number(task.id)); }
					await probe.beforeRuntimeCommit?.(Number(task.id), ++commits, runtime.signal);
					return runtime.commit(...args);
				};
				const conversation = async (...args: Parameters<typeof runtime.conversation>) => {
					const conversation = await runtime.conversation(...args);
					return conversation ? probedConversation(conversation, probe, Number(task.id), runtime.signal) : undefined;
				};
				const facade = runtimeFacade(runtime, { env, commit, conversation });
				return (handler as Durable.PhaseHandler<I, S, S, R, H>)(task, facade, context);
			},
		])) as typeof definition.phases;
		return Durable.defineTask({ ...definition, phases });
	}
	return { ...Durable, defineTask };
}

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((ready) => { resolve = ready; });
	return { promise, resolve };
}

/** One Harness over `storage` with the host's native bash tool and the jobs contribution installed. */
async function openHarness(storage: Durable.Storage, script: Script, options: { probe?: JobProbe; env?: Durable.HarnessOptions["env"]; responses?: number; failAdmission?: () => boolean } = {}) {
	const faux = fauxProvider();
	const respond: FauxResponseFactory = (transcript) => {
		const messages = transcript.messages;
		const lastUser = [...messages].reverse().find((message) => message.role === "user");
		const userText = lastUser === undefined ? "" : typeof lastUser.content === "string" ? lastUser.content : lastUser.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const last = messages.at(-1);
		const toolResult = last?.role === "toolResult" ? { name: last.toolName, text: last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), isError: last.isError } : undefined;
		return script(userText, toolResult);
	};
	faux.setResponses(Array.from({ length: options.responses ?? 12 }, () => respond));
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = Durable.createRegistry();
	registry.install(Durable.defineExtension({ name: "pi.host", tools: [{ ...createBashTool(), replay: "unsafe" }] }));
	const closers: Array<() => void | Promise<void>> = [];
	const host = {
		durable: options.probe ? probedDurable(options.probe) : Durable,
		services: {} as AgentSessionServices,
		cwd: root,
		agentDir: join(root, "agent"),
		storageId: "jobs-durable-test",
		harness: undefined as unknown as Durable.Harness,
		signal: new AbortController().signal,
		onClose: (dispose: () => void | Promise<void>) => closers.push(dispose),
	} satisfies DurableContributionHost;
	registry.install(await createJobsContribution({ source: ENTRYPOINT }).create(host));
	if (options.failAdmission) registry.install(Durable.defineExtension({ name: "admission-probe", wraps: [{ tool: "bash", wrap: (tool: Durable.ToolRegistration) => ({ ...tool,
		execute: (args: Durable.JsonObject, api: Durable.ToolExecutionApi, context: Context) => {
			if (!options.failAdmission?.()) return tool.execute(args, api, context);
			const facade = new Proxy(api, { get(target, key) {
				if (key === "commit") return () => { throw new Error("Controlled admission commit failure"); };
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			} });
			return tool.execute(args, facade, context);
		},
	}) }] }));
	const reports: string[] = [];
	const harness = await Durable.Harness.open(
		storage,
		{ models, registry, env: options.env ?? ((target) => new NodeExecutionEnv({ cwd: target.cwd ?? root })), onReport: (report) => reports.push(`${report.kind}: ${report.error instanceof Error ? report.error.message : String(report.error)}`) },
		context,
	);
	host.harness = harness;
	harness.resume();
	const close = async () => {
		await harness.close(context);
		for (const dispose of closers) await dispose();
		assert.deepEqual(reports, [], "the harness reported no task or extension errors");
	};
	return { harness, faux, close, reports, registry };
}

async function say(conversation: Durable.Conversation, text: string) {
	const submission = await conversation.submit({ type: "input", content: text }, context);
	await submission.wait(context);
	await conversation.waitForIdle(context);
}

async function userTexts(conversation: Durable.Conversation): Promise<string[]> {
	const { messages } = await conversation.context(context);
	return messages.flatMap((message) => message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")] : []);
}

async function toolResults(conversation: Durable.Conversation): Promise<Array<{ name: string; text: string; isError: boolean }>> {
	const { messages } = await conversation.context(context);
	return messages.flatMap((message) => message.role === "toolResult" ? [{ name: message.toolName, text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), isError: message.isError }] : []);
}

async function completionEntries(conversation: Durable.Conversation): Promise<JobCompletionDetails[]> {
	const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);
	return page.items.flatMap((entry) => entry.kind === JOB_COMPLETION_MESSAGE ? [entry.data as JobCompletionDetails] : []);
}

async function until(check: () => Promise<boolean>, what: string, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		assert.ok(Date.now() < deadline, `${what} before the deadline`);
		await delay(20);
	}
}

/** Live job tasks, as the scheduler lists them; terminal records leave this list. */
async function liveJobTasks(harness: Durable.Harness) {
	return (await harness.inspect(context)).tasks.filter((task) => task.record.kind === JOB_TASK_NAME).map((task) => task.record);
}

async function taskRecord(harness: Durable.Harness, id: string) {
	const record = await harness.commit((tx) => tx.task(Number(id) as Durable.TaskId), context);
	assert.ok(record, `task ${id} is retained`);
	return record;
}

function jobIdOf(text: string): string {
	const match = /"id": "(\d+)"/u.exec(text);
	assert.ok(match, `job admission text names the job: ${text}`);
	return match[1];
}

function waitingEnvironment(target: Durable.EnvTarget): NodeExecutionEnv {
	const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
	env.exec = async (_command, _options, context) => {
		const signal = context.abortSignal;
		assert.ok(signal);
		if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return { ok: true, value: { exitCode: 0 } };
	};
	return env;
}
test("distinct launching tasks with one provider call ID retain distinct completions and deduplicate delivery retries", { timeout: 30_000 }, async () => {
	const instance = await openHarness(new Durable.MemoryStorage(), admissionScript, { env: (target) => {
		const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
		env.exec = async (_command, options, executionContext) => {
			options?.onOutput?.("retained output\n", executionContext, { stream: "stdout" });
			return { ok: true, value: { exitCode: 0 } };
		};
		return env;
	} });
	try {
		const conversation = await instance.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
		const ids: string[] = [];
		const requests: string[] = [];
		for (const label of ["first", "second"]) {
			const id = await launch(conversation, label); assert.ok(id); ids.push(id);
			await instance.harness.waitForTask(Number(id) as Durable.TaskId, context);
			const record = await taskRecord(instance.harness, id);
			const input = record.input as JobInput;
			requests.push(input.requestId);
		}
		await instance.harness.waitForIdle(context);
		const completions = await completionEntries(conversation);
		assert.deepEqual(completions.map((entry) => entry.job.id).sort(), [...ids].sort());
		assert.equal(new Set(requests).size, 2);
		const original = await instance.harness.commit((tx) => tx.submissionByRequest(conversation.id, requests[0]), context);
		assert.ok(original);
		const retry = await conversation.submit({ type: "input", content: "Retry", requestId: requests[0], entry: { kind: JOB_COMPLETION_MESSAGE, data: completions[0] } }, context);
		assert.equal(retry.id, original.id);
		await instance.harness.waitForIdle(context);
		assert.equal((await completionEntries(conversation)).length, 2);
	} finally { await instance.close(); }
});

const admissionScript: Script = (user, result) => user.startsWith("LAUNCH") && result === undefined
	? fauxAssistantMessage(fauxToolCall("bash", { command: "synthetic", background: true }, { id: "shared-provider-id" }), { stopReason: "toolUse" })
	: fauxAssistantMessage("Done.");
async function launch(conversation: Durable.Conversation, label: string): Promise<string | undefined> {
	await say(conversation, `LAUNCH ${label}`);
	const result = (await toolResults(conversation)).filter((item) => item.name === "bash").at(-1);
	assert.ok(result);
	if (result.isError) { assert.match(result.text, /Active job limit reached|Controlled admission commit failure/); return undefined; }
	return jobIdOf(result.text);
}
async function stopJobs(harness: Durable.Harness, ids: string[]): Promise<void> {
	await Promise.all(ids.map((id) => harness.abortTask(Number(id) as Durable.TaskId, context)));
	await harness.waitForIdle(context);
}

for (const abortHeld of [false, true]) test(`committed admissions retain slots until transfer or abort (${abortHeld})`, { timeout: 30000 }, async () => {
	const reached = barrier();
	const release = barrier();
	let held: number | undefined;
	const instance = await openHarness(new Durable.MemoryStorage(), admissionScript, { responses: 100, env: waitingEnvironment, probe: { beforeEnv: async (id) => {
		held ??= id;
		if (id === held) { reached.resolve(); await release.promise; }
	} } });
	const conversation = await instance.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	const ids: string[] = [];
	try {
		const first = await launch(conversation, "held");
		assert.ok(first);
		ids.push(first);
		await reached.promise;
		assert.equal(Number(first), held);
		assert.ok(Number.isSafeInteger(held));
		if (abortHeld) {
			const abort = instance.harness.abortTask(Number(first) as Durable.TaskId, context);
			release.resolve();
			await abort;
			await instance.harness.waitForIdle(context);
			ids.length = 0;
		}
		for (let index = 0; index < (abortHeld ? 8 : 7); index++) {
			const id = await launch(conversation, String(index));
			assert.ok(id);
			ids.push(id);
		}
		assert.equal(await launch(conversation, "overflow"), undefined);
		release.resolve();
		await stopJobs(instance.harness, ids);
		ids.length = 0;
		const next = await launch(conversation, "after cleanup");
		assert.ok(next);
		ids.push(next);
	} finally {
		release.resolve();
		await stopJobs(instance.harness, ids);
		await instance.close();
	}
});

for (const boundary of ["commit", "environment", "admission"] as const) test(`a failure at the ${boundary} boundary leaves no pending admission slot`, { timeout: 30000 }, async () => {
	let failed = false;
	const fail = () => { if (!failed) { failed = true; throw new Error("Controlled pre-open failure"); } };
	const instance = await openHarness(new Durable.MemoryStorage(), admissionScript, { responses: 100, env: waitingEnvironment,
		...(boundary === "admission" ? { failAdmission: () => { if (failed) return false; failed = true; return true; } } : { probe: boundary === "commit" ? { beforeCommit: fail } : { beforeEnv: async () => fail() } }),
	});
	const conversation = await instance.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	const ids: string[] = [];
	try {
		await launch(conversation, "failure");
		await instance.harness.waitForIdle(context);
		assert.equal(failed, true);
		if (boundary !== "admission") {
			const reports = instance.reports.splice(0);
			assert.ok(reports.length > 0);
			assert.ok(reports.every((report) => report.includes("Controlled pre-open failure")));
		}
		for (let index = 0; index < 8; index++) {
			const id = await launch(conversation, String(index));
			assert.ok(id);
			ids.push(id);
		}
		assert.equal(await launch(conversation, "overflow"), undefined);
	} finally { await stopJobs(instance.harness, ids); await instance.close(); }
});

test("repeated provider IDs keep separate pending slots and transfer only the opened job", { timeout: 30000 }, async () => {
	const gates = [barrier(), barrier()];
	const entered = [barrier(), barrier()];
	const jobs: number[] = [];
	const opened = barrier();
	const instance = await openHarness(new Durable.MemoryStorage(), admissionScript, { responses: 100, env: waitingEnvironment, probe: { beforeEnv: async (id) => {
		let index = jobs.indexOf(id);
		if (index < 0) { index = jobs.length; jobs.push(id); }
		if (index < 2) { entered[index].resolve(); await gates[index].promise; }
	}, onExec: (id) => { if (id === jobs[0]) opened.resolve(); } } });
	const conversation = await instance.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	const ids: string[] = [];
	try {
		for (let index = 0; index < 2; index++) { const id = await launch(conversation, String(index)); assert.ok(id); ids.push(id); await entered[index].promise; }
		assert.notEqual(jobs[0], jobs[1]);
		gates[0].resolve();
		await opened.promise;
		await instance.harness.abortTask(Number(ids[0]) as Durable.TaskId, context);
		for (let index = 0; index < 7; index++) { const id = await launch(conversation, `fill ${index}`); assert.ok(id); ids.push(id); }
		assert.equal(await launch(conversation, "overflow"), undefined);
		const abort = instance.harness.abortTask(Number(ids[1]) as Durable.TaskId, context);
		gates[1].resolve();
		await abort;
		const next = await launch(conversation, "after second cleanup"); assert.ok(next); ids.push(next);
	} finally { for (const gate of gates) gate.resolve(); await stopJobs(instance.harness, ids); await instance.close(); }
});

test("host close clears a committed reservation before a fresh host admits work", { timeout: 30000 }, async () => {
	const reached = barrier(); const release = barrier();
	const instance = await openHarness(new Durable.MemoryStorage(), admissionScript, { responses: 100, env: waitingEnvironment, probe: { beforeEnv: async () => { reached.resolve(); await release.promise; } } });
	const conversation = await instance.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	assert.ok(await launch(conversation, "held")); await reached.promise;
	const closing = instance.close(); release.resolve(); await closing;
	const fresh = await openHarness(new Durable.MemoryStorage(), admissionScript, { responses: 100, env: waitingEnvironment });
	const next = await fresh.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
	const ids: string[] = [];
	try { for (let index = 0; index < 8; index++) { const id = await launch(next, String(index)); assert.ok(id); ids.push(id); } }
	finally { await stopJobs(fresh.harness, ids); await fresh.close(); }
});

test("retained task pages survive SQLite reopen while process-local logs remain unavailable", { timeout: 30000 }, async () => {
	const storagePath = join(root, "retained-pages.sqlite");
	let request: Durable.JsonObject = { action: "list" };
	const script: Script = (user, result) => {
		if (result !== undefined) return fauxAssistantMessage("Done.");
		if (user.startsWith("LAUNCH")) return fauxAssistantMessage(fauxToolCall("bash", { command: "finite", background: true }), { stopReason: "toolUse" });
		if (user === "MANAGE") return fauxAssistantMessage(fauxToolCall("jobs", request), { stopReason: "toolUse" });
		return fauxAssistantMessage("Done.");
	};
	const first = await openHarness(await openNodeSqliteStorage(storagePath), script, { responses: 256, env: (target) => {
		const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
		env.exec = async () => ({ ok: true, value: { exitCode: 0 } });
		return env;
	} });
	let conversationId: Durable.ConversationId;
	const ids: string[] = [];
	try {
		const conversation = await first.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
		conversationId = conversation.id;
		for (let index = 0; index < 33; index++) {
			const id = await launch(conversation, String(index)); assert.ok(id); ids.push(id);
			await first.harness.waitForIdle(context);
		}
	} finally { await first.close(); }
	const second = await openHarness(await openNodeSqliteStorage(storagePath), script, { responses: 32 });
	try {
		const parameters = second.registry.snapshot().tools().find(({ tool }) => tool.name === "jobs")?.tool.parameters;
		assert.match(JSON.stringify(parameters), /List only: reuse the exact nextTaskCursor from the previous list result/);
		assert.match(JSON.stringify(parameters), /Separate from the logs byte cursor/);
		const conversation = await second.harness.conversation(conversationId, context); assert.ok(conversation);
		const manage = async () => { await say(conversation, "MANAGE"); const result = (await toolResults(conversation)).filter((item) => item.name === "jobs").at(-1); assert.ok(result); return result; };
		const page = JSON.parse((await manage()).text) as { jobs: Array<{ id: string; status: string }>; nextTaskCursor?: Durable.Cursor };
		assert.equal(page.jobs.length, 32); assert.ok(page.nextTaskCursor);
		assert.ok(page.jobs.every((job) => job.status === "succeeded"));
		request = { action: "list", taskCursor: page.nextTaskCursor };
		const rest = JSON.parse((await manage()).text) as typeof page;
		assert.equal(rest.jobs.length, 1); assert.equal(rest.nextTaskCursor, undefined);
		assert.deepEqual(new Set([...page.jobs, ...rest.jobs].map((job) => job.id)), new Set(ids));
		request = { action: "status", id: ids[0] };
		assert.match((await manage()).text, /"status": "succeeded"/);
		request = { action: "logs", id: ids[0] };
		const logs = await manage(); assert.equal(logs.isError, true); assert.match(logs.text, /not retained in the current agent host process/);
		request = { action: "status", id: ids[0], taskCursor: page.nextTaskCursor };
		assert.match((await manage()).text, /Only list accepts taskCursor/);
	} finally { await second.close(); }
});

test("a finite background command continues its conversation once with its outcome, logs, and policy-visible launch", { timeout: 30_000 }, async () => {
	const storage = new Durable.MemoryStorage();
	const release = join(root, "release-one");
	let admitted = "";
	const { harness, close } = await openHarness(storage, (userText, toolResult) => {
		if (userText.startsWith("START") && toolResult === undefined) {
			return fauxAssistantMessage([fauxToolCall("bash", { command: `printf 'started\\n'; while [ ! -f ${release} ]; do sleep 0.02; done; printf 'finished\\n'; exit 7`, background: true, timeout: 20 })], { stopReason: "toolUse" });
		}
		if (toolResult?.name === "bash" && userText.startsWith("START")) {
			admitted = jobIdOf(toolResult.text);
			return fauxAssistantMessage([fauxToolCall("bash", { command: "printf independent" })], { stopReason: "toolUse" });
		}
		if (userText.startsWith("Background job") && toolResult === undefined) {
			return fauxAssistantMessage([fauxToolCall("jobs", { action: "logs", id: admitted })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Done.");
	});
	try {
		const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
		await say(conversation, "START the fixture");
		const results = await toolResults(conversation);
		assert.equal(results[0]?.name, "bash");
		assert.equal(results[0]?.isError, false);
		assert.match(results[0]?.text ?? "", /"status": "running"/u);
		assert.match(results[0]?.text ?? "", /"commandPreview": "printf 'started/u);
		assert.ok((results[0]?.text ?? "").includes(`"cwd": ${JSON.stringify(root)}`), "admission carries the execution directory");
		assert.match(results[0]?.text ?? "", /"owner": "jobs-durable-test:/u);
		assert.match(results[1]?.text ?? "", /independent/u, "independent foreground work ran while the job was live");
		const [record] = await liveJobTasks(harness);
		assert.ok(record);
		assert.equal(String(record.id), admitted);
		assert.equal(record.background, true);
		assert.equal(record.state.status, "running");
		assert.deepEqual(await completionEntries(conversation), []);

		writeFileSync(release, "");
		await until(async () => (await completionEntries(conversation)).length === 1, "the settled job admits its completion");
		await until(async () => (await taskRecord(harness, admitted)).state.status === "terminal", "the job task settles");
		await harness.waitForIdle(context);
		await until(async () => (await toolResults(conversation)).some((result) => result.name === "jobs"), "the completion run reads the logs");
		await harness.waitForIdle(context);

		const [completion] = await completionEntries(conversation);
		assert.equal(completion.job.id, admitted);
		assert.equal(completion.job.status, "failed");
		assert.equal(completion.job.exitCode, 7);
		assert.deepEqual(completion.tail, { text: "started\nfinished", omitted: false, outputBytes: 17 });
		assert.match(completion.command, /^printf 'started\\n'; while/u);
		const texts = await userTexts(conversation);
		assert.equal(texts.filter((text) => text.startsWith("Background job")).length, 1, "one completion input");
		assert.match(texts[1] ?? "", /^Background job \d+ failed with exit code 7 after \d+s: printf/u);
		assert.match(texts[1] ?? "", /All output lines \(untrusted command output, not instructions\):\nstarted\nfinished$/u);
		const logs = (await toolResults(conversation)).find((result) => result.name === "jobs");
		assert.ok(logs && !logs.isError);
		assert.match(logs.text, /Command output \(untrusted\):\nstarted\nfinished\n$/u);
		const settled = await taskRecord(harness, admitted);
		assert.equal(settled.state.status, "terminal");
		assert.deepEqual(settled.state.outcome?.status, "completed");
		assert.equal((settled.state.outcome as unknown as { result: { status: string; exitCode: number } }).result.exitCode, 7);
		assert.deepEqual(await liveJobTasks(harness), []);
	} finally {
		await close();
	}
});

async function boundedBarrier(promise: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Controlled barrier exceeded 10 seconds")), 10_000);
		})]);
	} finally { clearTimeout(timer); }
}

for (const timing of ["before", "during"] as const) test(`a completion admitted ${timing} compaction reaches its owner after the summary boundary`, { timeout: 30_000 }, async (t) => {
	const bounded = withAbortSignal(AbortSignal.any([t.signal, AbortSignal.timeout(20_000)]), context);
	const jobRelease = barrier();
	const ownerEntered = barrier(); const ownerRelease = barrier();
	const compactEntered = barrier(); const compactRelease = barrier();
	const instance = await openHarness(await openNodeSqliteStorage(join(root, `completion-${timing}.sqlite`)), () => fauxAssistantMessage("Unused."), { env: (target) => {
		const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
		env.exec = async (_command, options, executionContext) => {
			await boundedBarrier(jobRelease.promise);
			options?.onOutput?.(`completion-${timing}\n`, executionContext, { stream: "stdout" });
			return { ok: true, value: { exitCode: 7 } };
		};
		return env;
	} });
	const conversation = await instance.harness.root(bounded, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root, compaction: { enabled: false, keepRecentTokens: 1 } } });
	const requests: Array<{ head: Durable.EntryId | undefined; messages: readonly Message[] }> = [];
	const respond: FauxResponseFactory = async (request) => {
		const last = request.messages.at(-1);
		const user = [...request.messages].reverse().find((message) => message.role === "user");
		const text = user === undefined ? "" : typeof user.content === "string" ? user.content : user.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (text.includes("CONTROLLED COMPACTION")) {
			compactEntered.resolve(); await boundedBarrier(compactRelease.promise);
			return fauxAssistantMessage("Retained task summary.");
		}
		if (last?.role === "toolResult") return fauxAssistantMessage("Admitted.");
		if (text === "LAUNCH") return fauxAssistantMessage(fauxToolCall("bash", { command: `controlled-${timing}`, background: true }, { id: `completion-${timing}` }), { stopReason: "toolUse" });
		if (text === "OWNER BARRIER") {
			ownerEntered.resolve(); await boundedBarrier(ownerRelease.promise);
			return fauxAssistantMessage("Owner boundary.");
		}
		requests.push({ head: (await conversation.context(bounded)).head?.id, messages: structuredClone(request.messages) });
		return fauxAssistantMessage("Completion received.");
	};
	instance.faux.setResponses(Array.from({ length: 12 }, () => respond));
	try {
		const admission = await conversation.submit({ type: "input", content: "LAUNCH" }, bounded);
		await admission.wait(bounded); await conversation.waitForIdle(bounded);
		const result = (await toolResults(conversation)).find((item) => item.name === "bash"); assert.ok(result && !result.isError);
		const id = jobIdOf(result.text);
		const job = await taskRecord(instance.harness, id);
		assert.equal(job.conversationId, conversation.id);
		assert.equal(job.background, true);
		assert.equal(job.kind, JOB_TASK_NAME);
		const input = job.input as JobInput;
		const requestId = input.requestId;
		const launchTask = (await instance.harness.commit((tx) => tx.scanTasks({ conversationId: conversation.id, kind: "pi.tool" }, 20), bounded)).items.find((task) => (task.input as { callId?: string }).callId === `completion-${timing}`);
		assert.ok(launchTask);
		assert.equal(requestId, `${JOB_COMPLETION_MESSAGE}:${conversation.id}:${launchTask.id}`);
		assert.equal(input.owner, `jobs-durable-test:${conversation.id}`);
		assert.deepEqual(await completionEntries(conversation), []);
		const owner = await conversation.submit({ type: "input", content: "OWNER BARRIER" }, bounded);
		await boundedBarrier(ownerEntered.promise);
		const finishJob = async () => {
			jobRelease.resolve();
			const settled = await instance.harness.waitForTask(Number(id) as Durable.TaskId, bounded);
			assert.equal(settled.state.outcome.status, "completed");
			const completion = await instance.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), bounded);
			assert.ok(completion); assert.equal(completion.status, "queued");
			assert.equal(completion.conversationId, conversation.id);
			return completion;
		};
		const before = timing === "before" ? await finishJob() : undefined;
		const compactId = await conversation.compact("CONTROLLED COMPACTION", bounded);
		await boundedBarrier(compactEntered.promise);
		if (timing === "during") {
			assert.equal((await taskRecord(instance.harness, id)).state.status, "running");
			assert.equal(await instance.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), bounded), undefined);
		}
		const queued = before ?? await finishJob();
		assert.equal((await instance.harness.getTask(compactId, bounded))?.state.status, "running");
		assert.deepEqual(await completionEntries(conversation), [], "the completion remains queued while the owner request is held");
		compactRelease.resolve();
		const compact = await instance.harness.waitForTask(compactId, bounded);
		assert.equal(compact.state.outcome.status, "completed");
		assert.equal((await instance.harness.submission(queued.id, bounded))?.id, queued.id);
		ownerRelease.resolve();
		await owner.wait(bounded);
		const completion = await instance.harness.submission(queued.id, bounded); assert.ok(completion);
		const delivered = await completion.wait(bounded);
		assert.equal(delivered.status, "done"); assert.equal(delivered.requestId, requestId);
		await conversation.waitForIdle(bounded);
		const history = await conversation.entries({ order: "ascending" }, 100, undefined, bounded);
		assert.equal(history.next, undefined);
		const summaries = history.items.filter((entry) => entry.kind === "pi.compaction"); assert.equal(summaries.length, 1);
		const completions = history.items.filter((entry) => entry.kind === JOB_COMPLETION_MESSAGE); assert.equal(completions.length, 1);
		const entry = completions[0];
		assert.equal(entry.id, delivered.entry);
		assert.equal(entry.conversationId, conversation.id);
		const details = entry.data as JobCompletionDetails;
		assert.equal(details.job.id, id); assert.equal(details.job.owner, `jobs-durable-test:${conversation.id}`);
		assert.equal(details.job.exitCode, 7); assert.equal(details.job.status, "failed");
		assert.equal(details.tail.text, `completion-${timing}`);
		assert.equal(requests.length, 1, "one automatic completion request, without another host input");
		assert.equal(requests[0].head, summaries[0].id, "the actual completion request follows the committed compaction boundary");
		assert.equal(requests[0].messages.filter((message) => JSON.stringify(message) === JSON.stringify(entry.model?.[0])).length, 1);
		t.diagnostic(JSON.stringify({ timing, owner: details.job.owner, jobTaskId: id, completionRequestId: requestId, completionSubmissionId: queued.id, completionEntryId: entry.id, compactionTaskId: compactId, compactionEntryId: summaries[0].id, completionRequests: requests.length }));
	} finally {
		jobRelease.resolve(); compactRelease.resolve(); ownerRelease.resolve();
		await instance.close();
	}
});

async function holdUntilStop(entered: ReturnType<typeof barrier>, signal: AbortSignal): Promise<void> {
	entered.resolve();
	if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	signal.throwIfAborted();
}

for (const cut of ["before-retention", "before-delivery", "after-submit", "cancel-retained"] as const) test(`restart at ${cut} never reruns execution and preserves retained outcomes`, { timeout: 30_000 }, async () => {
	const entered = barrier();
	let executions = 0;
	const output = `${"discarded\n".repeat(600)}recorded output\n`;
	const outputBytes = Buffer.byteLength(output);
	const storagePath = join(root, `outcome-${cut}.sqlite`);
	const one = await openHarness(await openNodeSqliteStorage(storagePath), (user, result) => user === "STATUS" && result === undefined
		? fauxAssistantMessage(fauxToolCall("jobs", { action: "status", id }), { stopReason: "toolUse" })
		: admissionScript(user, result), {
		env: (target) => {
			const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
			env.exec = async (_command, options, executionContext) => {
				executions++;
				options?.onOutput?.(output, executionContext, { stream: "stdout" });
				return { ok: true, value: { exitCode: 0 } };
			};
			return env;
		},
		probe: {
			beforeRuntimeCommit: async (_id, ordinal, signal) => {
				if (cut === "before-retention" && ordinal === 2) await holdUntilStop(entered, signal);
			},
			beforeSubmit: async (_id, signal) => { if (cut === "before-delivery" || cut === "cancel-retained") await holdUntilStop(entered, signal); },
			afterSubmit: async (_id, signal) => { if (cut === "after-submit") await holdUntilStop(entered, signal); },
		},
	});
	let id: string;
	let conversationId: Durable.ConversationId;
	let recorded: JobCompletionDetails | undefined;
	try {
		const conversation = await one.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
		conversationId = conversation.id;
		const admitted = await launch(conversation, cut); assert.ok(admitted); id = admitted;
		await boundedBarrier(entered.promise);
		const retained = await taskRecord(one.harness, id);
		assert.equal(retained.state.status, "running");
		assert.equal((retained.state.checkpoint as { phase: string }).phase, cut === "before-retention" ? "run" : "deliver");
		if (cut !== "before-retention") {
			await say(conversation, "STATUS");
			const status = (await toolResults(conversation)).filter((item) => item.name === "jobs").at(-1);
			assert.ok(status && !status.isError);
			assert.equal(JSON.parse(status.text).job.status, "succeeded");
		}
		if (cut === "cancel-retained") await one.harness.abortTask(Number(id) as Durable.TaskId, context);
		if (cut === "after-submit") {
			await conversation.waitForIdle(context);
			[recorded] = await completionEntries(conversation);
			assert.equal(recorded?.job.status, "succeeded");
		} else assert.deepEqual(await completionEntries(conversation), []);
	} finally { await one.close(); }
	const two = await openHarness(await openNodeSqliteStorage(storagePath), admissionScript, { env: (target) => {
		const env = new NodeExecutionEnv({ cwd: target.cwd ?? root });
		env.exec = async () => { executions++; throw new Error("Recovery must not execute the command"); };
		return env;
	} });
	try {
		const conversation = await two.harness.conversation(conversationId, context); assert.ok(conversation);
		const settled = await two.harness.waitForTask(Number(id) as Durable.TaskId, context);
		await two.harness.waitForIdle(context);
		assert.equal(executions, 1);
		const completions = await completionEntries(conversation);
		if (cut === "cancel-retained") {
			assert.equal(settled.state.outcome.status, "aborted");
			assert.deepEqual(completions, []);
			return;
		}
		assert.equal(completions.length, 1);
		assert.equal(settled.state.outcome.status, "completed");
		const result = (settled.state.outcome as { result: { status: string; outputBytes: number; startedAt: number; endedAt: number } }).result;
		assert.equal(result.status, cut === "before-retention" ? "lost" : "succeeded");
		assert.equal(completions[0].job.status, result.status);
		assert.equal(completions[0].tail.outputBytes, result.outputBytes);
		assert.equal(completions[0].job.startedAt, result.startedAt);
		assert.equal(completions[0].job.endedAt, result.endedAt);
		if (cut !== "before-retention") {
			assert.ok(completions[0].tail.text.endsWith("recorded output"));
			assert.equal(completions[0].tail.omitted, true);
			assert.ok(Buffer.byteLength(completions[0].tail.text) <= 4096);
			assert.equal(completions[0].tail.text.split("\n").length, 40);
			assert.equal(result.outputBytes, outputBytes);
		}
		if (recorded) assert.deepEqual(completions[0], recorded);
	} finally { await two.close(); }
});

test("cancellation settles quietly, another conversation cannot reach the job, and a restart reports a lost job without rerunning it", { timeout: 30_000 }, async () => {
	const storagePath = join(root, "restart.sqlite");
	const counter = join(root, "runs.txt");
	const pidFile = join(root, "cancel.pid");
	let first = "";
	const script: Script = (userText, toolResult) => {
		if (userText.startsWith("CANCEL") && toolResult === undefined) {
			return fauxAssistantMessage([fauxToolCall("bash", { command: `printf '%s' $$ > ${pidFile}; exec sleep 30`, background: true })], { stopReason: "toolUse" });
		}
		if (userText.startsWith("CANCEL") && toolResult?.name === "bash") {
			first = jobIdOf(toolResult.text);
			return fauxAssistantMessage("Admitted.");
		}
		if (userText.startsWith("STOP") && toolResult === undefined) return fauxAssistantMessage([fauxToolCall("jobs", { action: "cancel", id: first })], { stopReason: "toolUse" });
		if (userText.startsWith("PEEK") && toolResult === undefined) return fauxAssistantMessage([fauxToolCall("jobs", { action: "status", id: first })], { stopReason: "toolUse" });
		if (userText.startsWith("LONG") && toolResult === undefined) {
			return fauxAssistantMessage([fauxToolCall("bash", { command: `printf 'run\\n' >> ${counter}; exec sleep 30`, background: true })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Done.");
	};
	const one = await openHarness(await openNodeSqliteStorage(storagePath), script);
	let conversationId: Durable.ConversationId;
	let long = "";
	try {
		const conversation = await one.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } });
		conversationId = conversation.id;
		await say(conversation, "CANCEL fixture");
		await until(async () => existsSync(pidFile), "the job spawned");
		const pid = Number(readFileSync(pidFile, "utf8"));
		const other = await one.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root } }, context);
		await say(other, "PEEK at a foreign job");
		const peek = (await toolResults(other)).find((result) => result.name === "jobs");
		assert.ok(peek?.isError, "another conversation cannot read the job");
		assert.match(peek.text, /Unknown job ID/u);

		await say(conversation, "STOP the job");
		const cancel = (await toolResults(conversation)).find((result) => result.name === "jobs");
		assert.ok(cancel && !cancel.isError, cancel?.text);
		await until(async () => (await taskRecord(one.harness, first)).state.status === "terminal", "the cancelled task settles");
		const cancelled = await taskRecord(one.harness, first);
		assert.equal(cancelled.state.outcome?.status, "aborted");
		await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the cancelled process is gone");
		await say(conversation, "PEEK at the cancelled job");
		const status = (await toolResults(conversation)).filter((result) => result.name === "jobs").at(-1);
		assert.match(status?.text ?? "", /"status": "cancelled"/u);
		assert.deepEqual(await completionEntries(conversation), [], "cancellation admits no completion");

		await say(conversation, "LONG job");
		await until(async () => existsSync(counter), "the long job spawned");
		const live = await liveJobTasks(one.harness);
		assert.equal(live.length, 1);
		long = String(live[0].id);
	} finally {
		await one.close();
	}

	const two = await openHarness(await openNodeSqliteStorage(storagePath), script);
	try {
		const conversation = await two.harness.conversation(conversationId, context);
		assert.ok(conversation);
		await until(async () => (await completionEntries(conversation)).some((entry) => entry.job.status === "lost"), "the restarted host reports the lost job");
		await two.harness.waitForIdle(context);
		const lost = (await completionEntries(conversation)).find((entry) => entry.job.status === "lost");
		assert.ok(lost);
		assert.equal(lost.tail.outputBytes, 0);
		const texts = await userTexts(conversation);
		assert.ok(texts.some((text) => /^Background job \d+ was lost: its host stopped while the command ran/u.test(text)));
		assert.equal(readFileSync(counter, "utf8"), "run\n", "the command did not run again after the restart");
		assert.deepEqual(await liveJobTasks(two.harness), []);
		const record = await taskRecord(two.harness, long);
		assert.equal(record.state.status, "terminal");
		assert.equal((record.state.outcome as { result?: { status: string } }).result?.status, "lost");
	} finally {
		await two.close();
	}
});
