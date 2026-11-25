import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { compile, type Schema } from "@earendil-works/pi-schema";
import { createJobActivity, formatStatusRecord, recordId } from "./activity.ts";
import { COMPLETION_LIMITS, JOB_COMPLETION_MESSAGE, type JobCompletionDetails } from "./completion.ts";
import registerJobs from "./index.ts";
import { JOB_LIMITS, type JobLogs, type JobSnapshot } from "./manager.ts";
import { YIELD_ENDED_TEXT, YIELD_REFUSED, type YieldDetails } from "./yield.ts";

interface Result {
	isError?: boolean;
	structuredContent?: unknown;
	content: Array<{ type: string; text?: string }>;
	details?: { job?: JobSnapshot; jobs?: JobSnapshot[] } & Partial<JobLogs>;
}
interface Tool {
	name: string;
	outputSchema: Schema;
	parameters: { properties: Record<string, unknown>; additionalProperties?: boolean };
	execute(
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionToolContext,
	): Promise<Result>;
}
interface SentMessage {
	message: { customType: string; content: string; display?: boolean; details?: unknown };
	options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
}
class TestPi {
	tools = new Map<string, Tool>();
	sent: SentMessage[] = [];
	emitted: Array<{ channel: string; data: unknown }> = [];
	#listeners = new Map<string, Set<(data: unknown) => void>>();
	events = {
		emit: (channel: string, data: unknown) => {
			this.emitted.push({ channel, data });
			for (const handler of this.#listeners.get(channel) ?? []) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.#listeners.get(channel) ?? new Set<(data: unknown) => void>();
			handlers.add(handler);
			this.#listeners.set(channel, handlers);
			return () => handlers.delete(handler);
		},
	};
	#handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	/** Pi's idle state as `ctx.isIdle()` reports it. */
	idle = true;
	/** Session entries on the current branch; an idle send that starts no turn appends at once, as Pi does. */
	branch: Array<{ type: string; customType?: string; details?: unknown; message?: unknown }> = [];
	/** Every entry of the session file, on every branch. */
	entries: Array<{ type: string; message?: unknown }> = [];
	ctx: ExtensionContext | undefined;
	registerTool(tool: Tool) {
		this.tools.set(tool.name, tool);
	}
	commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) {
		this.commands.set(name, command);
	}
	renderers = new Map<string, unknown>();
	registerMessageRenderer(customType: string, renderer: unknown) {
		this.renderers.set(customType, renderer);
	}
	on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
		assert.ok(
			[
				"session_start",
				"before_agent_start",
				"tool_call",
				"tool_result",
				"agent_start",
				"message_end",
				"turn_end",
				"agent_end",
				"agent_before_settle",
				"agent_settled",
				"session_tree",
				"session_shutdown",
			].includes(name),
			`unexpected event ${name}`,
		);
		this.#handlers.set(name, [...(this.#handlers.get(name) ?? []), handler]);
	}
	sendFailure?: Error;
	sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
		if (this.sendFailure) throw this.sendFailure;
		this.sent.push({ message, options });
		if (this.idle && options?.triggerTurn === false)
			this.branch.push({ type: "custom_message", customType: message.customType, details: message.details });
	}
	tool(name: string): Tool {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool;
	}
	async emit(name: string, event: unknown = {}): Promise<void> {
		assert.ok(this.ctx, "context bound");
		for (const handler of this.#handlers.get(name) ?? []) await handler(event, this.ctx);
	}
	async shutdown(): Promise<void> {
		await this.emit("session_shutdown", { reason: "quit" });
	}
}
let root: string;
let oldAgentDir: string | undefined;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "jobs-adapter-"));
	oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	await mkdir(join(root, "agent"));
});
after(async () => {
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
	await rm(root, { recursive: true, force: true });
});

function detailsOf(result: Result) {
	assert.ok(result.details, "tool result details present");
	return result.details;
}
function jobOf(result: Result): JobSnapshot {
	const job = detailsOf(result).job;
	assert.ok(job, "job snapshot present");
	return job;
}
function textOf(result: Result): string {
	const text = result.content[0]?.text;
	assert.ok(text !== undefined, "text content present");
	return text;
}
function setup(
	cwd = root,
	trusted = false,
	terminal?: { writes: string[]; statuses: Array<[string, string | undefined]>; notices?: string[] },
	mode: ExtensionContext["mode"] = terminal ? "tui" : "print",
) {
	const pi = new TestPi();
	const activity = terminal
		? createJobActivity({ write: (text) => terminal.writes.push(text), isTTY: () => true, env: () => ({}) })
		: undefined;
	registerJobs(pi as unknown as ExtensionAPI, activity);
	const base = {
		cwd,
		isProjectTrusted: () => trusted,
		mode,
		hasUI: terminal !== undefined,
		ui: {
			setStatus: (key: string, text: string | undefined) => terminal?.statuses.push([key, text]),
			notify: (text: string) => terminal?.notices?.push(text),
			theme: { fg: (color: string, text: string) => `<${color}>${text}` },
		},
		model: { provider: "fixture", id: "deterministic" },
		thinkingLevel: "low",
		isIdle: () => pi.idle,
		sessionManager: {
			getSessionId: () => "job-session",
			getSessionFile: () => undefined,
			getBranch: () => pi.branch,
			getEntries: () => pi.entries,
		},
	} as unknown as ExtensionContext;
	pi.ctx = base;
	const ctx = {
		...base,
		tools: [],
		executeTool: async () => {
			throw new Error("Unexpected nested tool call");
		},
	} satisfies ExtensionToolContext;
	const call = async (name: string, params: unknown, signal?: AbortSignal) => {
		const tool = pi.tool(name);
		const result = await tool.execute("call", params, signal, undefined, ctx);
		assert.ok(compile(tool.outputSchema).check(result.structuredContent), "result matches its declared output schema");
		return result;
	};
	return { pi, call };
}
async function settled(call: ReturnType<typeof setup>["call"], id: string) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const result = await call("jobs", { action: "status", id });
		const job = jobOf(result);
		if (job.status !== "running") return job;
		assert.ok(Date.now() < deadline, "job settles within deadline");
		await delay(10);
	}
}
/** The completion message for one job, after bounded waiting for its delivery. */
async function completion(pi: TestPi, id: string): Promise<SentMessage> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const sent = pi.sent.find((entry) => (entry.message.details as JobCompletionDetails | undefined)?.job.id === id);
		if (sent) return sent;
		assert.ok(Date.now() < deadline, "completion is delivered within deadline");
		await delay(10);
	}
}
function completionDetails(sent: SentMessage): JobCompletionDetails {
	assert.equal(sent.message.customType, JOB_COMPLETION_MESSAGE);
	assert.equal(sent.message.display, true);
	assert.ok(sent.message.details, "completion details present");
	return sent.message.details as JobCompletionDetails;
}

describe("Command Jobs adapter", () => {
	it("registers bash admission and a management-only tool without an alternate launch schema", async () => {
		const { pi, call } = setup();
		try {
			assert.deepEqual([...pi.tools.keys()], ["bash", "jobs", "jobs_yield"]);
			assert.deepEqual([...pi.renderers.keys()], [JOB_COMPLETION_MESSAGE]);
			assert.deepEqual(
				pi.emitted.map((event) => event.channel),
				["durable:contribution", "harness:tool-display:publish"],
			);
			const contribution = pi.emitted[0].data as {
				name: string;
				source: string;
				display: { version: number; entry: string; export: string };
			};
			assert.equal(contribution.name, "jobs");
			assert.equal(contribution.source, new URL("./index.ts", import.meta.url).pathname);
			assert.deepEqual(contribution.display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
			const schema = pi.tool("bash").outputSchema;
			assert.ok("anyOf" in schema && Array.isArray(schema.anyOf));
			assert.deepEqual(schema.anyOf[0], createBashToolDefinition(root).outputSchema);
			assert.deepEqual(Object.keys(pi.tool("jobs").parameters.properties), ["action", "id", "cursor"]);
			assert.equal(pi.tool("jobs").parameters.additionalProperties, false);
			const output = compile(pi.tool("jobs").outputSchema);
			const listed = { id: "fixture", status: "running", startedAt: 0, cancellationRequested: false };
			assert.equal(output.check({ jobs: [listed] }), true, "unfinished job fields remain optional");
			assert.equal(output.check({ jobs: [{ ...listed, extra: true }] }), true, "job records remain open");
			for (const key of Object.keys(listed)) {
				const incomplete: Record<string, unknown> = { ...listed };
				delete incomplete[key];
				assert.equal(output.check({ jobs: [incomplete] }), false, `${key} remains required`);
			}
			assert.equal(output.check({ jobs: [{ ...listed, endedAt: "invalid" }] }), false);
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
			await assert.rejects(call("jobs", { action: "status" }), /requires a job id/);
			await assert.rejects(call("jobs", { action: "list", id: "x" }), /no id or cursor/);
			await assert.rejects(call("jobs", { action: "status", id: "x", cursor: 0 }), /Only logs/);
			await assert.rejects(call("jobs", { action: "status", id: "unknown" }), /Unknown job/);
		} finally {
			await pi.shutdown();
		}
	});

	it("preserves foreground success and failure plus current session environment", async () => {
		const { pi, call } = setup();
		try {
			const result = await call("bash", { command: 'printf "%s/%s/%s" "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL"' });
			assert.equal(result.content[0].text, "job-session/fixture/deterministic");
			assert.equal((result.structuredContent as { output: string }).output, result.content[0].text);
			const failure = await call("bash", { command: "printf failure >&2; exit 7" });
			assert.equal(failure.isError, true);
			assert.equal((failure.structuredContent as { exit_code: number }).exit_code, 7);
			assert.match(textOf(failure), /failure[\s\S]*code 7/);
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		} finally {
			await pi.shutdown();
		}
	});

	it("returns before completion, survives turn abort, and retrieves bounded safe logs and exit status", async () => {
		const { pi, call } = setup();
		try {
			const controller = new AbortController();
			const started = await call(
				"bash",
				{
					command: 'sleep 0.1; printf "\\033[31m%s\\033[0m\\n" "$PI_SESSION_ID"; printf stderr >&2; exit 4',
					background: true,
				},
				controller.signal,
			);
			const id = jobOf(started).id;
			assert.equal(jobOf(started).status, "running");
			assert.equal(jobOf(started).owner, "job-session");
			assert.equal(jobOf(started).cwd, root);
			assert.match(jobOf(started).commandPreview ?? "", /sleep 0\.1/u);
			const listed = detailsOf(await call("jobs", { action: "list" })).jobs ?? [];
			assert.equal(listed[0]?.commandPreview, jobOf(started).commandPreview);
			assert.notEqual(listed[0]?.commandPreview, id);
			assert.deepEqual(started.structuredContent, started.details);
			controller.abort();
			assert.equal((await call("bash", { command: "printf independent" })).content[0].text, "independent");
			const final = await settled(call, id);
			assert.equal(final.status, "failed");
			assert.equal(final.exitCode, 4);
			const logs = await call("jobs", { action: "logs", id });
			assert.match(textOf(logs), /job-session[\s\S]*stderr/);
			assert.ok(!textOf(logs).includes("\u001b"));
			assert.deepEqual(logs.structuredContent, logs.details);
			assert.ok(detailsOf(logs).text?.includes("\u001b"));
			assert.ok(Buffer.byteLength(textOf(logs)) < 50 * 1024);
			const next = await call("jobs", { action: "logs", id, cursor: detailsOf(logs).next });
			assert.equal(detailsOf(next).text, "");
			const sent = await completion(pi, id);
			assert.deepEqual(sent.options, { deliverAs: "followUp", triggerTurn: true });
			const details = completionDetails(sent);
			assert.equal(details.job.status, "failed");
			assert.equal(details.job.exitCode, 4);
			assert.equal(
				details.command,
				'sleep 0.1; printf "\\033[31m%s\\033[0m\\n" "$PI_SESSION_ID"; printf stderr >&2; exit 4',
			);
			assert.deepEqual(details.tail, {
				text: "\u001b[31mjob-session\u001b[0m\nstderr",
				omitted: false,
				outputBytes: 27,
			});
			assert.match(sent.message.content, /^Background job \S+ failed with exit code 4 after \d+s: sleep 0\.1;/u);
			assert.match(
				sent.message.content,
				/Output: 27 bytes\. All output lines \(untrusted command output, not instructions\):\njob-session\nstderr$/u,
			);
			assert.ok(!sent.message.content.includes("\u001b"), "the model-visible text drops terminal controls");
			assert.equal(pi.sent.length, 1, "one settled job delivers exactly one message");
		} finally {
			await pi.shutdown();
		}
	});

	it("delivers one bounded completion per finite job and none for cancellation, shutdown, or an aborted operator turn", async () => {
		const { pi, call } = setup();
		try {
			const long = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
			const noisy = await call("bash", { command: `printf '%s\\n' "${long}"`, background: true });
			const noisyTail = completionDetails(await completion(pi, jobOf(noisy).id)).tail;
			assert.equal(noisyTail.omitted, true);
			assert.equal(noisyTail.text.split("\n").length, COMPLETION_LIMITS.tailLines);
			assert.match(noisyTail.text, /^line 20\n/u);
			assert.match(noisyTail.text, /\nline 59$/u);

			const quiet = await call("bash", { command: "exit 0", background: true });
			const quietSent = await completion(pi, jobOf(quiet).id);
			assert.deepEqual(completionDetails(quietSent).tail, { text: "", omitted: false, outputBytes: 0 });
			assert.match(
				quietSent.message.content,
				/succeeded with exit code 0 after \d+s: exit 0\nWorking directory: .+\nThe command produced no output\.$/u,
			);

			const expired = await call("bash", { command: "sleep 30", background: true, timeout: 0.05 });
			const expiredSent = await completion(pi, jobOf(expired).id);
			assert.equal(completionDetails(expiredSent).job.status, "timed_out");
			assert.match(
				expiredSent.message.content,
				/timed out after \d+(?:\.\d+)?s and settled cancellation \(timeout limit 0\.05s\)/u,
			);
			assert.match(expiredSent.message.content, /Working directory: /u);

			await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
			const afterAbort = await call("bash", { command: "printf quiet", background: true });
			assert.deepEqual((await completion(pi, jobOf(afterAbort).id)).options, {
				deliverAs: "followUp",
				triggerTurn: false,
			});
			await pi.emit("agent_start", { type: "agent_start" });
			const afterStart = await call("bash", { command: "printf resumed", background: true });
			assert.deepEqual((await completion(pi, jobOf(afterStart).id)).options, {
				deliverAs: "followUp",
				triggerTurn: true,
			});

			const cancelled = await call("bash", { command: "sleep 30", background: true });
			await call("jobs", { action: "cancel", id: jobOf(cancelled).id });
			assert.equal((await settled(call, jobOf(cancelled).id)).status, "cancelled");
			const owned = await call("bash", { command: "sleep 30", background: true });
			const delivered = pi.sent.length;
			await pi.shutdown();
			assert.equal(jobOf(await call("jobs", { action: "status", id: jobOf(owned).id })).status, "cancelled");
			await delay(20);
			assert.equal(pi.sent.length, delivered, "cancelled and shut-down jobs send no completion");
			assert.equal(
				pi.sent.filter((entry) => (entry.message.details as JobCompletionDetails).job.status === "cancelled").length,
				0,
			);
		} finally {
			await pi.shutdown();
		}
	});

	it("rejects an aborted start and cancels owned jobs on repeat shutdown", async (t) => {
		const { pi, call } = setup();
		t.after(() => pi.shutdown());
		await assert.rejects(call("bash", { command: "printf never", background: true }, AbortSignal.abort()));
		assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		const first = await call("bash", { command: "sleep 30", background: true });
		const second = await call("bash", { command: "sleep 30", background: true });
		const firstId = jobOf(first).id;
		await call("jobs", { action: "cancel", id: firstId });
		await call("jobs", { action: "cancel", id: firstId });
		assert.equal((await settled(call, firstId)).status, "cancelled");
		await pi.shutdown();
		await pi.shutdown();
		assert.equal(jobOf(await call("jobs", { action: "status", id: jobOf(second).id })).status, "cancelled");
		await assert.rejects(call("bash", { command: "printf never", background: true }), /closed/);
	});

	it("reports job activity to the footer and the terminal from the bash admission path", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		try {
			const failed = jobOf(await call("bash", { command: "printf hidden; exit 3", background: true }));
			const id = recordId(failed.id);
			assert.ok(id);
			assert.deepEqual(terminal.statuses[0], ["jobs", "<warning>● jobs: 1/1"]);
			await completion(pi, failed.id);
			await delay(0);
			assert.equal(
				terminal.writes[0],
				formatStatusRecord({ id, state: "working", title: "Background job", msg: "Background job running" }),
			);
			assert.equal(
				terminal.writes[1],
				formatStatusRecord({
					id,
					state: "error",
					title: "Background job",
					msg: "Background job failed · exit 3 · < 1 min · completion sent, not in the conversation",
				}),
			);
			assert.deepEqual(
				terminal.statuses.at(-1),
				["jobs", "<error>● jobs: 0/1"],
				"the entry stays and shows the failure",
			);
			assert.ok(!terminal.writes.join("").includes(Buffer.from("hidden").toString("base64")));

			const cancelled = jobOf(await call("bash", { command: "sleep 30", background: true }));
			await call("jobs", { action: "cancel", id: cancelled.id });
			await settled(call, cancelled.id);
			await delay(0);
			assert.equal(
				terminal.writes.at(-1),
				formatStatusRecord({ id: recordId(cancelled.id) as string, state: "clear" }),
			);

			const running = jobOf(await call("bash", { command: "sleep 30", background: true }));
			await pi.shutdown();
			assert.equal(terminal.writes.at(-1), formatStatusRecord({ id: recordId(running.id) as string, state: "clear" }));
			assert.equal(terminal.writes.filter((text) => text.includes("state=clear")).length, 2);
		} finally {
			await pi.shutdown();
		}
	});

	it("counts the jobs that earlier runtimes of the session started from its entries", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		const result = (toolName: string, details: unknown) => ({
			type: "message",
			message: { role: "toolResult", toolName, details },
		});
		pi.entries = [
			result("bash", { job: { id: "earlier-1", status: "running" } }),
			result("bash", { job: { id: "earlier-2", status: "running" } }),
			result("bash", { job: { id: "earlier-2", status: "running" } }),
			result("bash", { exitCode: 0 }),
			result("jobs", { job: { id: "earlier-1", status: "succeeded" } }),
			{ type: "custom_message", message: { details: { job: { id: "earlier-3" } } } },
		];
		try {
			await pi.emit("session_start", { reason: "resume" });
			assert.deepEqual(terminal.statuses, [["jobs", "<muted>○ jobs: 0/2"]]);
			const job = jobOf(await call("bash", { command: "printf done", background: true }));
			assert.deepEqual(terminal.statuses.at(-1), ["jobs", "<warning>● jobs: 1/3"]);
			await completion(pi, job.id);
			await delay(0);
			assert.deepEqual(terminal.statuses.at(-1), ["jobs", "<muted>○ jobs: 0/3"]);
		} finally {
			await pi.shutdown();
		}
		assert.deepEqual(terminal.statuses.at(-1), ["jobs", undefined], "shutdown clears the entry");
	});

	it("answers /jobs outside the interactive terminal with one line per job, newest first", async () => {
		const notices: string[] = [];
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]>, notices };
		const { pi, call } = setup(root, false, terminal, "rpc");
		const command = pi.commands.get("jobs");
		assert.ok(command, "/jobs is registered");
		assert.ok(pi.ctx);
		try {
			await command.handler("", pi.ctx);
			assert.deepEqual(notices, ["No background jobs in this session."]);
			const done = jobOf(await call("bash", { command: "printf done", background: true }));
			await completion(pi, done.id);
			const running = jobOf(await call("bash", { command: "tail -f /dev/null", background: true }));
			await command.handler("", pi.ctx);
			const lines = notices.at(-1)?.split("\n") ?? [];
			assert.equal(lines[0], "Jobs: 1 running · 2 started");
			assert.match(lines[1] ?? "", /^● running \d+s {2}tail -f \/dev\/null$/u);
			assert.match(lines[2] ?? "", /^○ succeeded \d+s {2}printf done$/u);
			await call("jobs", { action: "cancel", id: running.id });
			await command.handler("extra", pi.ctx);
			assert.equal(notices.at(-1), "/jobs takes no arguments.");
		} finally {
			await pi.shutdown();
		}
	});

	it("opens one /jobs view in the interactive terminal, cancels through it, and closes it at shutdown", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		const command = pi.commands.get("jobs");
		assert.ok(command && pi.ctx);
		let opened = 0;
		let view: { render(width: number): string[]; handleInput(data: string): void } | undefined;
		let finished = false;
		const plain = {
			fg: (_c: string, text: string) => text,
			bg: (_c: string, text: string) => text,
			bold: (text: string) => text,
		};
		const ctx = {
			...pi.ctx,
			ui: {
				...pi.ctx.ui,
				custom: (factory: (...args: unknown[]) => typeof view) =>
					new Promise<void>((resolve) => {
						opened += 1;
						view = factory({ terminal: { rows: 30 }, requestRender() {} }, plain, {}, () => {
							finished = true;
							resolve();
						});
					}),
			},
		} as unknown as ExtensionContext;
		try {
			const job = jobOf(await call("bash", { command: "printf 'one\\ntwo\\n'; tail -f /dev/null", background: true }));
			const first = command.handler("", ctx);
			await command.handler("", ctx);
			assert.equal(opened, 1, "a second /jobs while the view shows changes nothing");
			assert.ok(view);
			const deadline = Date.now() + 5000;
			let lines = view.render(80);
			while (!lines.some((line) => line.includes(" two")) && Date.now() < deadline) {
				await delay(50);
				(view as unknown as { refresh(): void }).refresh();
				lines = view.render(80);
			}
			assert.equal(lines.length, 18, "the view takes 60% of the rows");
			assert.match(lines[0] ?? "", /^─ Jobs ─+ 1 running · 1 started ─$/u);
			assert.match(lines[1] ?? "", /^›● running/u);
			assert.ok(
				lines.some((line) => line.startsWith(" two")),
				"the selected job's last output shows",
			);
			assert.match(lines.at(-1) ?? "", /^ c cancel {2}esc close/u);
			view.handleInput("c");
			assert.equal((await settled(call, job.id)).status, "cancelled");
			assert.equal(pi.sent.length, 0, "a job cancelled from the view sends no completion");
			await pi.shutdown();
			await first;
			assert.ok(finished, "shutdown closes the open view");
		} finally {
			await pi.shutdown();
		}
	});

	it("settles the terminal record and the footer when the completion message cannot be sent", async () => {
		const terminal = {
			writes: [] as string[],
			statuses: [] as Array<[string, string | undefined]>,
			notices: [] as string[],
		};
		const { pi, call } = setup(root, false, terminal);
		try {
			pi.sendFailure = new Error("send\n\x1b[31mfailed\x1b[0m");
			const job = jobOf(await call("bash", { command: "printf done", background: true }));
			await settled(call, job.id);
			await delay(10);
			assert.equal(
				terminal.writes.at(-1),
				formatStatusRecord({
					id: recordId(job.id) as string,
					state: "done",
					title: "Background job",
					msg: "Background job succeeded · exit 0 · < 1 min · completion not sent",
				}),
			);
			assert.deepEqual(terminal.statuses.at(-1), ["jobs", "<muted>○ jobs: 0/1"]);
			const writes = terminal.writes.length;
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
			assert.equal(terminal.writes.length, writes, "a completion that was never sent is not reconsidered");
			assert.deepEqual(terminal.notices, [`The completion message for job ${job.id} failed to send: send failed`]);
		} finally {
			await pi.shutdown();
		}
	});

	it("reports a completion sent while Pi is busy as queued until the message reaches the conversation", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		const record = (id: string, msg: string) =>
			formatStatusRecord({
				id: recordId(id) as string,
				state: "done",
				title: "Background job",
				msg: `Background job succeeded · exit 0 · < 1 min · ${msg}`,
			});
		try {
			pi.idle = false;
			const job = jobOf(await call("bash", { command: "printf done", background: true }));
			const sent = await completion(pi, job.id);
			await delay(0);
			assert.equal(terminal.writes.at(-1), record(job.id, "completion queued for the conversation"));
			await pi.emit("turn_end", { type: "turn_end" });
			await pi.emit("message_end", {
				type: "message_end",
				message: { role: "custom", customType: JOB_COMPLETION_MESSAGE, details: { job: { id: "other" } } },
			});
			assert.equal(
				terminal.writes.at(-1),
				record(job.id, "completion queued for the conversation"),
				"only an exact match changes the state",
			);
			await pi.emit("message_end", { type: "message_end", message: { role: "custom", ...sent.message } });
			assert.equal(terminal.writes.at(-1), record(job.id, "completion in the conversation"));
			const writes = terminal.writes.length;
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
			assert.equal(terminal.writes.length, writes, "a completion in the conversation stays there");

			const missing = jobOf(await call("bash", { command: "printf done", background: true }));
			const missingSent = await completion(pi, missing.id);
			await delay(0);
			await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
			assert.equal(
				terminal.writes.at(-1),
				record(missing.id, "completion not in the conversation"),
				"a settled run without the message claims no addition",
			);
			pi.branch.push({
				type: "custom_message",
				customType: JOB_COMPLETION_MESSAGE,
				details: missingSent.message.details,
			});
			await pi.emit("agent_end", { type: "agent_end" });
			assert.equal(
				terminal.writes.at(-1),
				record(missing.id, "completion in the conversation"),
				"a later retained entry establishes the addition",
			);
		} finally {
			await pi.shutdown();
		}
	});

	it("tells an agent that checks a running job to end the turn and refuses the third check of it in a row", async () => {
		const { pi, call } = setup(root, false, undefined, "rpc");
		const end =
			"Continue other ready work; if none is ready, call jobs_yield now, and the completion starts your next turn.";
		const arrival = "its completion message arrives only after your turn ends";
		const firstStep = (id: string) =>
			`Job ${id} still runs. If you are waiting for it to finish, do not check it again: ${arrival}, so another check only postpones it. ${end}`;
		const secondStep = (id: string) =>
			`This is check 2 of job ${id} in a row while it runs, and check 3 in a row is refused. If you are waiting for it to finish, stop checking: ${arrival}. ${end}`;
		const status = async (id: string) => textOf(await call("jobs", { action: "status", id }));
		const stepOf = (text: string) => text.slice(text.lastIndexOf("\n\n") + 2);
		const round = (content: unknown[]) => pi.emit("message_end", { message: { role: "assistant", content } });
		const statusCall = (id: string) => ({
			type: "toolCall",
			id: "c",
			name: "jobs",
			arguments: { action: "status", id },
		});
		try {
			const started = await call("bash", { command: "sleep 30", background: true });
			const id = jobOf(started).id;
			assert.equal(
				textOf(started),
				`${JSON.stringify(started.details, null, 2)}\n\nJob ${id} runs in the background. Its completion message arrives only after your turn ends; do not check its status or logs to wait for it. ${end}`,
			);
			assert.deepEqual(started.structuredContent, started.details, "the next step stays out of the structured result");

			const first = await call("jobs", { action: "status", id });
			assert.equal(textOf(first), `${JSON.stringify(first.details, null, 2)}\n\n${firstStep(id)}`);
			assert.deepEqual(first.structuredContent, first.details);
			assert.equal(stepOf(await status(id)), secondStep(id));
			for (const check of [3, 4])
				await assert.rejects(call("jobs", { action: "status", id }), {
					message: `Refused: this would be check ${check} of job ${id} in a row while it runs, and checks in a row only hold the turn open as a timed wait. This call returns nothing. Its completion message arrives only after your turn ends. ${end} A job that never exits, such as a server, sends no completion: to wait for a condition such as its readiness, start a finite job that exits once the condition holds.`,
				});

			// A call of another tool that ran, an answer, cancellation and a new run end the streak.
			await pi.emit("tool_result", { toolName: "read", input: { path: "a" } });
			assert.equal(stepOf(await status(id)), firstStep(id));
			await pi.emit("tool_result", { toolName: "jobs", input: { action: "list" } });
			await round([statusCall(id), { type: "toolCall", id: "d", name: "bash", arguments: { command: "sleep 10" } }]);
			await pi.emit("tool_call", { toolName: "bash", input: { command: "sleep 10" } });
			assert.equal(
				stepOf(await status(id)),
				secondStep(id),
				"a list read, a reply with calls and a call that never ran continue the streak",
			);
			await round([{ type: "text", text: "Still running." }]);
			assert.equal(stepOf(await status(id)), firstStep(id));
			await pi.emit("tool_result", { toolName: "jobs", input: { action: "cancel", id: "other" } });
			assert.equal(stepOf(await status(id)), firstStep(id));
			await pi.emit("agent_start");
			assert.equal(stepOf(await status(id)), firstStep(id));

			// A logs page with more output to read is reading; a read at the end of the output is a check.
			await pi.emit("tool_result", { toolName: "read", input: { path: "a" } });
			const marker = join(root, "printed");
			const long = jobOf(
				await call("bash", {
					command: `for index in $(seq 1 3000); do echo line $index; done; touch ${marker}; sleep 30`,
					background: true,
				}),
			).id;
			const deadline = Date.now() + 5000;
			while (!existsSync(marker)) {
				assert.ok(Date.now() < deadline, "the job prints its output within the deadline");
				await delay(10);
			}
			let page = await call("jobs", { action: "logs", id: long });
			for (let pages = 0; detailsOf(page).more; pages++) {
				assert.doesNotMatch(textOf(page), /still runs|This is check/u, "a page with more to read gets no next step");
				assert.ok(pages < 20, "the output ends within the retained pages");
				page = await call("jobs", { action: "logs", id: long, cursor: detailsOf(page).next });
			}
			const text = textOf(page);
			const step = text.indexOf(firstStep(long));
			assert.ok(step > 0 && step < text.indexOf("Command output (untrusted):"), "the next step precedes the output");
			const atEnd = { action: "logs", id: long, cursor: detailsOf(page).next };
			assert.match(textOf(await call("jobs", atEnd)), /This is check 2 of job/u);
			await assert.rejects(call("jobs", atEnd), { message: /^Refused: this would be check 3 of job/u });

			await call("jobs", { action: "cancel", id });
			const cancelling = await call("jobs", { action: "status", id });
			assert.equal(
				textOf(cancelling),
				JSON.stringify(cancelling.details, null, 2),
				"a cancelled job sends no completion",
			);
			assert.equal((await settled(call, id)).status, "cancelled");

			const quick = jobOf(await call("bash", { command: "printf done", background: true }));
			await completion(pi, quick.id);
			const read = await call("jobs", { action: "status", id: quick.id });
			assert.equal(jobOf(read).status, "succeeded");
			assert.equal(textOf(read), JSON.stringify(read.details, null, 2), "a settled job needs no next step");
		} finally {
			await pi.shutdown();
		}
	});

	it("keeps print and JSON results to the record, because those runs stop unfinished jobs when they answer", async () => {
		for (const mode of ["print", "json"] as const) {
			const { pi, call } = setup(root, false, undefined, mode);
			try {
				const started = await call("bash", { command: "sleep 30", background: true });
				assert.equal(textOf(started), JSON.stringify(started.details, null, 2));
				const status = await call("jobs", { action: "status", id: jobOf(started).id });
				assert.equal(textOf(status), JSON.stringify(status.details, null, 2));
			} finally {
				await pi.shutdown();
			}
		}
	});

	it("ends the turn with jobs_yield only while a job of the session is still to deliver its completion", async () => {
		const { pi, call } = setup();
		const yieldCall = (note: string) =>
			call("jobs_yield", { note }) as Promise<Result & { terminate?: boolean; details: YieldDetails }>;
		const refused = (error: Error) => error.message === YIELD_REFUSED;
		try {
			await assert.rejects(yieldCall("The suite runs."), refused, "no job: no completion is coming");

			pi.idle = false;
			const job = jobOf(await call("bash", { command: "sleep 30", background: true }));
			const running = await yieldCall("The suite runs; its result follows.");
			assert.equal(running.terminate, true);
			assert.deepEqual(running.content, [{ type: "text", text: YIELD_ENDED_TEXT }]);
			assert.deepEqual(running.details.jobs, [{ id: job.id, commandPreview: "sleep 30", state: "running" }]);
			await call("jobs", { action: "cancel", id: job.id });
			await assert.rejects(yieldCall("The suite runs."), refused, "a cancelled job delivers no completion");
			await settled(call, job.id);

			const quick = jobOf(await call("bash", { command: "printf done", background: true }));
			const sent = await completion(pi, quick.id);
			await delay(0);
			const held = await yieldCall("The check finished; its completion follows.");
			assert.deepEqual(
				held.details.jobs,
				[{ id: quick.id, commandPreview: "printf done", state: "settled" }],
				"Pi holds the completion, so it still starts a turn",
			);
			await pi.emit("message_end", { type: "message_end", message: { role: "custom", ...sent.message } });
			await assert.rejects(yieldCall("Done."), refused, "a delivered completion is in the conversation");

			const lost = jobOf(await call("bash", { command: "printf done", background: true }));
			await completion(pi, lost.id);
			await delay(0);
			assert.equal((await yieldCall("The check finished.")).terminate, true);
			await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
			await assert.rejects(
				yieldCall("Done."),
				refused,
				"a run that settled without the message leaves no completion to wait for",
			);

			pi.idle = true;
			const many = [];
			for (let index = 0; index < JOB_LIMITS.active; index++)
				many.push(jobOf(await call("bash", { command: `sleep 30 # ${index}`, background: true })));
			const full = await yieldCall("Eight checks run.");
			assert.deepEqual(
				full.details.jobs.map((row) => row.id),
				many.map((entry) => entry.id),
				"rows keep start order",
			);
			assert.equal(full.details.omitted, undefined);
		} finally {
			await pi.shutdown();
		}
	});

	it("rewrites the record of a job that still runs after Pi's own report for a quiet settled run", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		const running = (id: string) =>
			formatStatusRecord({
				id: recordId(id) as string,
				state: "working",
				title: "Background job",
				msg: "Background job running · its completion starts the next turn",
			});
		const tick = () => new Promise((resolve) => setImmediate(resolve));
		try {
			const job = jobOf(await call("bash", { command: "sleep 30", background: true }));
			pi.branch.push({
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "note", name: "note", arguments: {} }] },
			});
			pi.branch.push({
				type: "message",
				message: { role: "toolResult", toolCallId: "note", content: [{ type: "text", text: "noted" }] },
			});
			const writes = terminal.writes.length;
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
			assert.equal(terminal.writes.length, writes, "the update waits until the settled handlers have returned");
			await tick();
			assert.equal(
				terminal.writes.at(-1),
				running(job.id),
				"a run that ended in a tool call leaves the running job newest",
			);

			const quiet = terminal.writes.length;
			await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
			await tick();
			assert.equal(terminal.writes.length, quiet, "an aborted run writes no update");
			pi.branch.push({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "The answer." }] },
			});
			await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
			await tick();
			assert.equal(terminal.writes.length, quiet, "an answered run keeps Pi's record newest");
		} finally {
			await pi.shutdown();
		}
	});

	it("moves the delivery state with the branch that the session shows", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		const record = (id: string, msg: string) =>
			formatStatusRecord({
				id: recordId(id) as string,
				state: "done",
				title: "Background job",
				msg: `Background job succeeded · exit 0 · < 1 min · ${msg}`,
			});
		try {
			const job = jobOf(await call("bash", { command: "printf done", background: true }));
			const sent = await completion(pi, job.id);
			await delay(0);
			pi.branch.push({ type: "custom_message", customType: JOB_COMPLETION_MESSAGE, details: sent.message.details });
			await pi.emit("agent_end", { type: "agent_end" });
			assert.equal(terminal.writes.at(-1), record(job.id, "completion in the conversation"));
			pi.branch.length = 0;
			await pi.emit("session_tree", { type: "session_tree" });
			assert.equal(
				terminal.writes.at(-1),
				record(job.id, "completion not in the conversation"),
				"a branch without the message",
			);
			pi.branch.push({ type: "custom_message", customType: JOB_COMPLETION_MESSAGE, details: sent.message.details });
			await pi.emit("session_tree", { type: "session_tree" });
			assert.equal(
				terminal.writes.at(-1),
				record(job.id, "completion in the conversation"),
				"back on a branch with it",
			);
		} finally {
			await pi.shutdown();
		}
	});

	it("reports a completion that Pi appends before sendMessage returns as in the conversation", async () => {
		const terminal = { writes: [] as string[], statuses: [] as Array<[string, string | undefined]> };
		const { pi, call } = setup(root, false, terminal);
		try {
			await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
			const job = jobOf(await call("bash", { command: "printf done", background: true }));
			assert.equal((await completion(pi, job.id)).options?.triggerTurn, false);
			await delay(0);
			assert.equal(terminal.writes.length, 2, "the settled record is written once");
			assert.equal(
				terminal.writes.at(-1),
				formatStatusRecord({
					id: recordId(job.id) as string,
					state: "done",
					title: "Background job",
					msg: "Background job succeeded · exit 0 · < 1 min · completion in the conversation",
				}),
			);
		} finally {
			await pi.shutdown();
		}
	});

	it("rejects invalid shell setting types before either execution path", async () => {
		const cwd = join(root, "invalid-shell-settings");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		const { pi, call } = setup(cwd, true);
		try {
			for (const settings of [
				[],
				{ shellPath: false },
				{ shellPath: 3 },
				{ shellCommandPrefix: false },
				{ shellCommandPrefix: [] },
				{ shellCommandPrefix: null },
			]) {
				await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
				for (const background of [false, true]) {
					await assert.rejects(call("bash", { command: "printf never", background }), /shell settings/i);
				}
			}
			assert.deepEqual((await call("jobs", { action: "list" })).details, { jobs: [] });
		} finally {
			await pi.shutdown();
		}
	});

	it("honors trusted shell settings in both paths and ignores untrusted project settings", async () => {
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ shellCommandPrefix: "export JOB_FIXTURE=trusted", shellPath: "/bin/bash" }),
		);
		const trusted = setup(cwd, true);
		const untrusted = setup(cwd, false);
		try {
			assert.equal((await trusted.call("bash", { command: 'printf "%s" "$JOB_FIXTURE"' })).content[0].text, "trusted");
			const started = await trusted.call("bash", { command: 'printf "%s" "$JOB_FIXTURE"', background: true });
			const id = jobOf(started).id;
			await settled(trusted.call, id);
			assert.equal(detailsOf(await trusted.call("jobs", { action: "logs", id })).text, "trusted");
			assert.equal(
				(await untrusted.call("bash", { command: `printf "%s" "\${JOB_FIXTURE-unset}"` })).content[0].text,
				"unset",
			);
			await writeFile(join(cwd, ".pi", "settings.json"), "invalid json");
			await assert.rejects(
				trusted.call("bash", { command: "printf never", background: true }),
				/Cannot read shell settings/,
			);
		} finally {
			await trusted.pi.shutdown();
			await untrusted.pi.shutdown();
		}
	});
});
