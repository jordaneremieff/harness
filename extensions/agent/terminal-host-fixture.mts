import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { defineTool, ProviderDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import { boundCatalogView } from "./catalog-view.ts";
import { DurableHost, type DurableCommandHost } from "./durable-host.ts";
import type { DurableCommandCall } from "./durable-services.ts";
import { answerMessage, completed, fixtureRegistry, toolCallMessage } from "./durable-host-fixture.mts";
import type { ConversationStatus, RequestParams } from "./durable-observation.ts";
import { eventLog } from "./host-fixture.mts";
import { runHost, type HostProcess } from "./host-process.ts";
import { AgentManager } from "./manager.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

export function controlledGate() {
	const started = deferred<{ taskId: number; conversationId: number }>();
	const release = deferred<void>();
	return { started: started.promise, release: () => release.resolve(), enter: started.resolve, released: release.promise, calls: 0, aborts: 0 };
}

function lastUser(context: TranscriptContext) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const user = context.messages[index];
	if (user?.role !== "user") throw new Error("controlled model requires user input");
	const text = typeof user.content === "string" ? user.content : user.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
	const marker = /gate:([a-zA-Z0-9-]+)/u.exec(text)?.[1];
	if (!marker) throw new Error(`controlled model expected a gate marker, received ${text}`);
	return { marker, answered: context.messages.slice(index + 1).some((message) => message.role === "toolResult") };
}

export interface ControlledTerminalHost {
	readonly record: CatalogRecord;
	readonly durable: DurableHost;
	readonly gates: Map<string, ReturnType<typeof controlledGate>>;
	readonly requests: Array<{ marker?: string; sessionId: string | undefined }>;
	readonly calls: Array<{ method: string; params: RequestParams | undefined }>;
	readonly observations: Set<string>;
	readonly commandCalls: DurableCommandCall[];
	readonly contributionHost: DurableCommandHost;
	waitForObservations(count: number): Promise<unknown>;
	status(identity?: string): Promise<ConversationStatus>;
	identityState(identity?: string): Promise<unknown>;
	publish(): Promise<void>;
	settled(submissionId: number): Promise<unknown>;
	close(): Promise<void>;
}

/** Real catalog, SQLite writers, native model/tool execution and Unix service transport. */
export function terminalHostFixture(t: { after(fn: () => void | Promise<void>): void }) {
	const root = mkdtempSync(join(tmpdir(), "terminal-host-"));
	const agentDir = join(root, "agent");
	const sessionsDir = join(root, "sessions");
	mkdirSync(agentDir);
	mkdirSync(sessionsDir);
	const previous = { PI_AGENT_DIR: process.env.PI_AGENT_DIR, PI_AGENT_SESSIONS_DIR: process.env.PI_AGENT_SESSIONS_DIR };
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsDir;
	const packageDir = getPackageDir();
	const catalog = new AgentCatalog(agentDir);
	const hosts: ControlledTerminalHost[] = [];
	const managers: AgentManager[] = [];
	t.after(async () => {
		for (const host of hosts) for (const gate of host.gates.values()) gate.release();
		for (const manager of managers) await manager.close();
		for (const host of hosts) await host.close();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		agentDir,
		manager() {
			const manager = new AgentManager({ root: agentDir, agentDir, packageDir });
			managers.push(manager);
			return manager;
		},
		async host(name: string): Promise<ControlledTerminalHost> {
			const cwd = join(root, name);
			mkdirSync(cwd);
			const record = catalog.create({ cwd, agentDir, packageDir, model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", name });
			const gates = new Map<string, ReturnType<typeof controlledGate>>();
			const requests: ControlledTerminalHost["requests"] = [];
			const calls: ControlledTerminalHost["calls"] = [];
			const observations = new Set<string>();
			const observationEvents = eventLog<number>();
			const runtime = await createTestRuntime();
			const stream = (_model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => {
				const request: ControlledTerminalHost["requests"][number] = { sessionId: options?.sessionId };
				requests.push(request);
				const { marker, answered } = lastUser(context);
				request.marker = marker;
				return completed(answered ? answerMessage(`answer:${marker}`) : toolCallMessage("terminal-gate", { marker }));
			};
			runtime.registerNativeProvider({ id: testModel.provider, name: "Terminal host test provider", getModels: () => [testModel, { ...testModel, id: "alternate", name: "Alternate test model" }], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
			const tool = defineTool({
				name: "terminal-gate",
				description: "Wait for an explicit test release.",
				parameters: Type.Object({ marker: Type.String() }),
				replay: "unsafe",
				async execute(args, api, context) {
					const gate = gates.get(args.marker);
					if (!gate) throw new Error(`gate ${args.marker} is not registered`);
					gate.calls++;
					gate.enter({ taskId: api.taskId, conversationId: api.conversationId });
					const aborted = () => { gate.aborts++; };
					context.abortSignal?.addEventListener("abort", aborted, { once: true });
					try { await gate.released; }
					finally { context.abortSignal?.removeEventListener("abort", aborted); }
					return { content: [{ type: "text", text: `released:${args.marker}` }] };
				},
			});
			let durable!: DurableHost;
			const commandCalls: DurableCommandCall[] = [];
			const contributionHost = {
				durable: Durable, services: {}, cwd, agentDir, storageId: record.storageId,
				get harness() { return durable.harness; },
				signal: new AbortController().signal, onClose() {},
				inventory: { contributions: [], ordinaryOnly: [] },
			} as unknown as DurableCommandHost;
			const commands = [{ name: "echo", description: "Return command arguments", async run(call: DurableCommandCall) {
				commandCalls.push(call);
				return `command:${call.conversation.id}:${call.args}`;
			} }];
			const ready = deferred<void>();
			const processHost: HostProcess = await runHost(async () => {
				durable = await DurableHost.open({ storageId: record.storageId, storagePath: record.storagePath, cwd, models: runtime, registry: fixtureRegistry([tool]), agent: { model: record.model }, meta: { name }, commands, contributionHost, settings: { compaction: { enabled: false }, retry: { enabled: false } } });
				return {
					async request(method, raw, _requestId, signal) {
						const params = raw as RequestParams | undefined;
						calls.push({ method, params });
						const result = await durable.request(method, params, signal ?? BACKGROUND_CONTEXT);
						if (typeof params?.token === "string") {
							if (method === "observe-open") observations.add(params.token);
							if (method === "observe-close") observations.delete(params.token);
							observationEvents.push(observations.size);
						}
						return result;
					},
					close: () => durable.close(),
					isIdle: () => durable.isIdle(),
					onChange: (listener) => durable.harness.subscribeCommits(() => listener()),
				};
			}, { metadata: hostMetadata(record), idleMs: 0, announceReady: () => ready.resolve() });
			await ready.promise;
			const host: ControlledTerminalHost = {
				record, durable, gates, requests, calls, observations, commandCalls, contributionHost,
				waitForObservations: (count) => observations.size === count ? Promise.resolve() : observationEvents.waitFor(() => observations.size === count),
				async status(identity = record.storageId) {
					return (await durable.request("status", { sessionId: identity }) as { conversation: ConversationStatus }).conversation;
				},
				async identityState(identity = record.storageId) {
					const conversation = await durable.conversation(identity);
					const status = await this.status(identity);
					const provider = await durable.harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT);
					return { tasks: status.tasks, submissions: status.submissions, provider };
				},
				async publish() {
					const projection = await durable.catalogProjection();
					catalog.updateView(record.storageId, boundCatalogView({ updatedAt: projection.updatedAt, rows: projection.rows, storageId: record.storageId }));
				},
				async settled(submissionId) {
					const submission = await durable.harness.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT);
					if (!submission) throw new Error(`submission ${submissionId} is absent`);
					return submission.wait(BACKGROUND_CONTEXT);
				},
				close: () => processHost.close(),
			};
			hosts.push(host);
			await host.publish();
			return host;
		},
	};
}

export async function createSibling(host: ControlledTerminalHost): Promise<string> {
	const conversation = await host.durable.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: host.record.model } }, BACKGROUND_CONTEXT);
	return host.durable.identity(conversation.id as ConversationId);
}
