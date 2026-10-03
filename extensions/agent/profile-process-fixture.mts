import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { getCurrentSystemPrompt, type AssistantMessage, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { eventLog, type EventLog, waitForProcessExit } from "./host-fixture.mts";
import { killHost } from "./durable-runtime-fixture.mts";

export interface Notice { event: "notice"; text: string; details: Record<string, unknown> }
interface Reply { id?: number; value?: unknown; error?: string; event?: string; pid?: number; storageId?: string }

export function guarded<T>(promise: Promise<T>, label: string): Promise<T> {
	const signal = AbortSignal.timeout(60000);
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error(`No producer event: ${label}`));
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export interface ProviderRequest {
	context: TranscriptContext;
	sessionId: string;
	pid: number;
	answer(text: string): void;
	tool(name: string, args: JsonObject): void;
}

export class Requester {
	readonly notices = eventLog<Notice>();
	readonly hosts = eventLog<{ storageId: string; pid: number }>();
	readonly process: ChildProcess;
	readonly identity: string;
	private sequence = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private stderr = "";
	readonly ready: Promise<void>;
	constructor(env: NodeJS.ProcessEnv, cwd: string, identity: string = randomUUID()) {
		this.identity = identity;
		this.process = fork(fileURLToPath(new URL("./profile-requester-fixture.mts", import.meta.url)), [], {
			cwd, env: { ...env, PROFILE_TEST_REQUESTER: this.identity }, stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		this.process.stderr?.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-12000); });
		this.ready = guarded(new Promise<void>((resolve, reject) => {
			this.process.on("message", (reply: Reply) => {
				if (reply.event === "ready") resolve();
				else this.receive(reply);
			});
			this.process.once("error", reject);
			this.process.once("exit", (code, signal) => {
				const error = new Error(`Requester exited (${code}, ${signal}): ${this.stderr}`);
				reject(error);
				for (const pending of this.pending.values()) pending.reject(error);
				this.pending.clear();
			});
		}), "requester readiness");
	}
	private receive(reply: Reply): void {
		if (reply.event === "notice") this.notices.push(reply as Notice);
		else if (reply.event === "host") this.hosts.push({ storageId: String(reply.storageId), pid: Number(reply.pid) });
		else if (reply.id !== undefined) {
			const pending = this.pending.get(reply.id);
			this.pending.delete(reply.id);
			if (reply.error) pending?.reject(new Error(reply.error));
			else pending?.resolve(reply.value);
		}
	}
	async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		await this.ready;
		const id = ++this.sequence;
		return guarded(new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject: (error) => reject(new Error(`${method} ${String(params.method ?? "")}: ${error.message}`, { cause: error })) });
			this.process.send({ id, method, params }, (error) => { if (error) { this.pending.delete(id); reject(error); } });
		}), `${method}: ${JSON.stringify(params)}`);
	}
	control<T = Record<string, unknown>>(method: string, input: Record<string, unknown>): Promise<T> { return this.call<T>("control", { method, input }); }
	raw<T = Record<string, unknown>>(sessionId: string, method: string, input: Record<string, unknown> = {}): Promise<T> { return this.call<T>("raw", { sessionId, method, input: { sessionId, ...input } }); }
	async close(): Promise<void> {
		if (this.process.exitCode !== null || this.process.signalCode !== null) return;
		await this.call("disconnect");
		this.process.disconnect();
		await waitForProcessExit(this.process);
	}
}

export async function profileFixture(t: TestContext): Promise<{
	root: string; cwd: string; agentDir: string; source: string;
	requests: EventLog<ProviderRequest>; requester(identity?: string): Promise<Requester>; next(): Promise<ProviderRequest>;
}> {
	const scratch = process.env.PROFILE_TEST_ROOT ?? tmpdir();
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "profile-process-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const source = join(cwd, "source.txt");
	writeFileSync(source, "The current archive region is east.\n");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		extensions: [fileURLToPath(new URL("./testdata/profile-process/provider.ts", import.meta.url)), fileURLToPath(new URL("./index.ts", import.meta.url))],
		cacheWarming: { mode: "off" }, retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 },
	}));
	const requests = eventLog<ProviderRequest>();
	const sockets = new Set<Socket>();
	const requesters: Requester[] = [];
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.removeAllListeners("data");
			const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as Pick<ProviderRequest, "context" | "sessionId" | "pid">;
			let answered = false;
			const send = (content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): void => {
				assert.equal(answered, false, "one response per provider request");
				answered = true;
				socket.end(`${JSON.stringify({ content, stopReason })}\n`);
			};
			requests.push({ ...request, answer: (text) => send([{ type: "text", text }], "stop"), tool: (name, args) => send([{ type: "toolCall", id: randomUUID(), name, arguments: args }], "toolUse") });
		});
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const env = { ...process.env, PI_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: join(root, "sessions"), PI_AGENT_IDLE_MINUTES: "0.03", PI_AGENT_CHECK_IN_MINUTES: "1", PROFILE_TEST_CWD: cwd, PROFILE_TEST_PORT: String(address.port) };
	let cursor = 0;
	t.after(async () => {
		await Promise.allSettled(requesters.map((requester) => requester.close()));
		for (const requester of requesters) for (const host of requester.hosts) killHost(host.pid);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root, cwd, agentDir, source, requests,
		requester: async (identity) => { const requester = new Requester(env, cwd, identity); requesters.push(requester); await requester.ready; return requester; },
		next: async () => { const index = cursor++; await requests.waitForCount(index + 1, 60000); return requests[index]; },
	};
}

export function lastTool(request: ProviderRequest, name: string): { text: string; details: unknown; isError: boolean } {
	const message = request.context.messages.findLast((item) => item.role === "toolResult" && item.toolName === name);
	assert.ok(message && message.role === "toolResult", `No ${name} tool result reached the provider`);
	return { text: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), details: message.details, isError: message.isError };
}

export function instructions(request: ProviderRequest): string {
	return getCurrentSystemPrompt(request.context.messages);
}
