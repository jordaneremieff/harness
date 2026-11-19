/**
 * Real `pi -p` and `pi --mode json` runs with the jobs extension and a scripted provider. Text print mode prints
 * only the final assistant message, so a job completion that arrives after the run's answer gets one request
 * for the complete answer, and the printed answer includes the earlier report. The runs do not offer
 * `jobs_yield`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, JsonObject, TranscriptContext } from "@earendil-works/pi-ai";
import { COMPLETE_ANSWER, COMPLETE_ANSWER_TYPE, YIELD_TOOL } from "./yield.ts";

const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const jobsExtension = fileURLToPath(new URL("./index.ts", import.meta.url));
const providerExtension = fileURLToPath(new URL("./testdata/print-provider.ts", import.meta.url));

type Reply = { content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" };
const say = (value: string): Reply => ({ content: [{ type: "text", text: value }], stopReason: "stop" });
const call = (name: string, args: JsonObject): Reply => ({
	content: [{ type: "toolCall", id: randomUUID(), name, arguments: args }],
	stopReason: "toolUse",
});
type Entry = { type: string; customType?: string; content?: unknown; display?: boolean };

/** One CLI run in an isolated agent home. `script` answers request `index`; undefined fails that request. */
async function printRun(
	mode: "text" | "json",
	prompt: string,
	script: (context: TranscriptContext, index: number) => Reply | undefined,
) {
	const root = mkdtempSync(join(tmpdir(), "jobs-print-"));
	const [agentDir, sessions, cwd] = ["agent", "sessions", "work"].map((name) => join(root, name));
	for (const dir of [agentDir, sessions, cwd]) mkdirSync(dir);
	const requests: TranscriptContext[] = [];
	const failures: unknown[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.removeAllListeners("data");
			const { context } = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { context: TranscriptContext };
			try {
				const reply = script(context, requests.push(context) - 1);
				if (reply) socket.end(`${JSON.stringify(reply)}\n`);
				else socket.destroy();
			} catch (error) {
				failures.push(error);
				socket.destroy();
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		const child = spawn(
			process.execPath,
			[
				piCli,
				...(mode === "json" ? ["--mode", "json"] : []),
				"-p",
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-mcp",
				"--session-dir",
				sessions,
				"-e",
				providerExtension,
				"-e",
				jobsExtension,
				"--model",
				"jobs-print-fixture/scripted",
				prompt,
			],
			{
				cwd,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					PI_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					JOBS_PRINT_TEST_PORT: String(address.port),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		clearTimeout(timer);
		if (failures.length > 0) throw failures[0];
		const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) =>
			name.endsWith(".jsonl"),
		);
		assert.equal(files.length, 1, `one session file; stderr: ${stderr}`);
		const entries = readFileSync(join(sessions, files[0] as string), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Entry);
		return { stdout, stderr, code, requests, entries };
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}

type Job = { id: string; status: string };
function latestJob(context: TranscriptContext): Job | undefined {
	const result = context.messages.findLast(
		(message) => message.role === "toolResult" && (message.toolName === "bash" || message.toolName === "jobs"),
	);
	return result?.role === "toolResult" ? (result.details as { job?: Job } | undefined)?.job : undefined;
}
const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.flatMap((part: { type?: string; text?: string }) => (part.type === "text" && part.text ? [part.text] : []))
					.join("\n")
			: "";
const completionArrived = (context: TranscriptContext, id: string) =>
	context.messages.some((message) => message.role === "user" && textOf(message.content).includes(id));
const askedForAnswer = (context: TranscriptContext) =>
	context.messages.some((message) => message.role === "user" && textOf(message.content) === COMPLETE_ANSWER);

/**
 * The scripted model starts a quick background job, reads its status until it settled, and reports; the queued
 * completion then starts another turn, which answers it alone; the request for the complete answer follows.
 */
function lateCompletionScript(report: string, reply: string, complete: string) {
	let phase: "start" | "poll" | "reported" | "replied" | "done" = "start";
	return (context: TranscriptContext, index: number): Reply | undefined => {
		if (index > 60 || phase === "done") return undefined;
		if (phase === "start") {
			phase = "poll";
			return call("bash", { command: "printf 'check passed\\n'", background: true });
		}
		const job = latestJob(context);
		assert.ok(job, "the bash and jobs results carry the job");
		if (phase === "poll") {
			if (job.status === "running") return call("jobs", { action: "status", id: job.id });
			assert.equal(completionArrived(context, job.id), false, "Pi holds the completion while the run works");
			phase = "reported";
			return say(report);
		}
		if (phase === "reported") {
			assert.ok(completionArrived(context, job.id), "the completion continues the run");
			assert.equal(askedForAnswer(context), false);
			phase = "replied";
			return say(reply);
		}
		assert.ok(askedForAnswer(context), "the run asks for the complete answer before it settles");
		phase = "done";
		return say(complete);
	};
}

it("prints the complete answer after a job completion that arrives after the first answer", {
	timeout: 90000,
}, async () => {
	const complete = "The check started in the background and passed.";
	const run = await printRun(
		"text",
		"Run the check in the background.",
		lateCompletionScript("The check runs in the background.", "The check passed.", complete),
	);
	assert.deepEqual(
		{ stdout: run.stdout, stderr: run.stderr, code: run.code },
		{ stdout: `${complete}\n`, stderr: "", code: 0 },
	);
	const requests = run.entries.filter(
		(entry) => entry.type === "custom_message" && entry.customType === COMPLETE_ANSWER_TYPE,
	);
	assert.deepEqual(
		requests.map(({ content, display }) => ({ content, display })),
		[{ content: COMPLETE_ANSWER, display: false }],
		"one context-only request",
	);
	for (const context of run.requests)
		assert.doesNotMatch(
			JSON.stringify(context.messages),
			new RegExp(YIELD_TOOL, "u"),
			"the run does not offer jobs_yield",
		);
	assert.match(JSON.stringify(run.requests[0]?.messages), /"jobs"/u, "the request carries the tool declarations");
});

it("ends a JSON stream with the complete answer after a late job completion", { timeout: 90000 }, async () => {
	const complete = "The check started in the background and passed.";
	const run = await printRun(
		"json",
		"Run the check in the background.",
		lateCompletionScript("The check runs in the background.", "The check passed.", complete),
	);
	assert.equal(run.code, 0, run.stderr);
	const events = run.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; message?: { role?: string; content?: unknown } });
	const last = events.findLast((event) => event.type === "message_end" && event.message?.role === "assistant");
	assert.equal(textOf(last?.message?.content), complete);
	for (const context of run.requests)
		assert.doesNotMatch(JSON.stringify(context.messages), new RegExp(YIELD_TOOL, "u"));
});
