/**
 * One real `pi -p` or `pi --mode json` process over an isolated agent home, with the agent extension and a
 * scripted provider. The provider fixture forwards each request to a local server here, which answers it
 * from the test's script; no real model, network or operator store is used.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, JsonObject, TranscriptContext } from "@earendil-works/pi-ai";

/** The package `bin` of the installed Pi, which the `pi` command runs. */
export const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
export const agentExtension = fileURLToPath(new URL("./index.ts", import.meta.url));
const providerExtension = fileURLToPath(new URL("./testdata/profile-process/provider.ts", import.meta.url));

export type Reply = { content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" };
export const text = (value: string): Reply => ({ content: [{ type: "text", text: value }], stopReason: "stop" });
export const call = (name: string, args: JsonObject, before?: string): Reply => ({
	content: [...(before === undefined ? [] : [{ type: "text" as const, text: before }]), { type: "toolCall", id: randomUUID(), name, arguments: args }],
	stopReason: "toolUse",
});
export const work = (before?: string): Reply => call("agent_work", { action: "continue", note: "Nothing needs you now." }, before);

export interface PrintRun {
	stdout: string;
	stderr: string;
	code: number | null;
	/** The provider context of each request, in order. */
	requests: TranscriptContext[];
	/** The entries of the retained session file. */
	entries: Array<Record<string, unknown> & { type: string; message?: { role: string; toolName?: string; content: unknown; isError?: boolean; stopReason?: string; errorMessage?: string } }>;
}

/**
 * Run the CLI once. `script` answers request `index` from its context. An undefined answer fails that request
 * with a provider error, so a loop cannot run unbounded; an error thrown by `script` fails the request and is
 * thrown again once the process exits.
 */
export async function printRun(options: {
	mode: "text" | "json";
	prompt: string;
	script: (context: TranscriptContext, index: number) => Reply | Promise<Reply> | undefined;
	extensions?: string[];
	env?: Record<string, string>;
	timeoutMs?: number;
}): Promise<PrintRun> {
	const root = mkdtempSync(join(tmpdir(), "print-run-"));
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	const cwd = join(root, "work");
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
			const index = requests.push(context) - 1;
			void Promise.resolve(options.script(context, index)).then((reply) => {
				if (reply) socket.end(`${JSON.stringify(reply)}\n`);
				else socket.destroy();
			}, (error: unknown) => { failures.push(error); socket.destroy(); });
		});
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		const args = [
			piCli, ...(options.mode === "json" ? ["--mode", "json"] : []), "-p",
			"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp",
			"--session-dir", sessions,
			...[providerExtension, agentExtension, ...(options.extensions ?? [])].flatMap((path) => ["-e", path]),
			"--model", "profile-process-fixture/expert",
			options.prompt,
		];
		const child = spawn(process.execPath, args, {
			cwd,
			env: {
				...process.env, ...options.env,
				PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: join(root, "agent-sessions"), PI_OFFLINE: "1",
				PROFILE_TEST_PORT: String(address.port),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60000);
		const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", (exit) => resolve(exit)); });
		clearTimeout(timer);
		if (failures.length > 0) throw failures[0];
		const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"));
		assert.equal(files.length, 1, `one retained session file; stderr: ${stderr}`);
		const entries = readFileSync(join(sessions, files[0]), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as PrintRun["entries"][number]);
		return { stdout, stderr, code, requests, entries };
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}

/** The text of the latest `agent_work` tool result in a provider request. */
export function lastWorkResult(context: TranscriptContext): string | undefined {
	const message = context.messages.findLast((item) => item.role === "toolResult" && item.toolName === "agent_work");
	return message?.role === "toolResult" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") : undefined;
}
