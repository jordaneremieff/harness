/**
 * Fixture for the reset and timer tests: one real DurableHost over a SQLite
 * file with the production agent contribution loaded, a faux provider, and an
 * optional held answer for the busy-boundary tests. No production runner
 * process is involved; the process tests use `durable-runtime-fixture.mts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DurableHost } from "./durable-host.ts";
import { reconcileDeliveries, type DeliveryReceipt } from "./durable-controls.ts";
import { createDurableServices, type DurableServices } from "./durable-services.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import type { Conversation } from "@earendil-works/pi-durable";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const FIXTURE_ANSWER = "schedule fixture answer";

export interface ScheduleFixtureOptions {
	/** Load the real agent extension, which registers the timer task. */
	readonly agentExtension?: boolean;
	/** Hold the first model request open until `releaseAnswer()` runs. */
	readonly deferFirstAnswer?: boolean;
	readonly answer?: string;
}

export interface ScheduleFixture {
	readonly root: string;
	readonly storageId: string;
	readonly storagePath: string;
	readonly ownerId: string;
	readonly runtime: ModelRuntime;
	readonly errors: unknown[];
	host: DurableHost;
	services: DurableServices;
	/** The root conversation handle. */
	conversation(): Promise<Conversation>;
	/** Admit one input with a delivery receipt and return its submission ID. */
	submitMessage(message: string): Promise<number>;
	/** Wait for the model request of the next run to begin. */
	waitForFirstRequest(): Promise<void>;
	/** Let the held model request finish. */
	releaseAnswer(): void;
	/** Wait for the delivery receipt of one request ID, event-based. */
	waitForReceipt(requestId: string, timeoutMs?: number): Promise<DeliveryReceipt>;
	/** Count committed entries whose text contains the query. */
	searchCount(query: string): Promise<number>;
	/** Model requests the faux provider has answered or held. */
	modelRequestCount(): number;
	/** Close the host and its services, then open both again on the same storage. */
	reopen(): Promise<void>;
	close(): Promise<void>;
}

interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}

function gate(): Gate {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

export async function scheduleFixture(t: { after(fn: () => void | Promise<void>): void }, options: ScheduleFixtureOptions = {}): Promise<ScheduleFixture> {
	const root = mkdtempSync(join(tmpdir(), "durable-schedule-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const storagePath = join(root, "store.sqlite");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false }, ...(options.agentExtension === true ? { extensions: [extension] } : {}) }));
	const runtime = await createTestRuntime();
	const answerText = options.answer ?? FIXTURE_ANSWER;
	const requested = gate();
	const firstGate: Gate | undefined = options.deferFirstAnswer === true ? gate() : undefined;
	let held = firstGate !== undefined;
	let requests = 0;
	const stream = (_model: unknown, _context: TranscriptContext) => {
		requests += 1;
		requested.release();
		const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: answerText }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() };
		const events = createAssistantMessageEventStream();
		if (held && firstGate !== undefined) {
			held = false;
			events.push({ type: "start", partial: message });
			void firstGate.promise.then(() => {
				events.push({ type: "done", reason: "stop", message });
				events.end(message);
			});
		} else {
			events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		}
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Schedule fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const storageId = "durable-schedule-fixture";
	const ownerId = "schedule-fixture-owner";
	const errors: unknown[] = [];

	const openFrom = async (): Promise<{ services: DurableServices; host: DurableHost }> => {
		const services = await createDurableServices({
			cwd,
			agentDir,
			storageId,
			trusted: true,
			modelRuntime: runtime,
			onReport: (error) => errors.push(error),
		});
		const host = await DurableHost.open({
			storagePath,
			storageId,
			cwd,
			models: runtime,
			registry: services.registry,
			settings: services.settings,
			env: services.env,
			agent: { model: { provider: testModel.provider, modelId: testModel.id } },
			meta: { name: "schedule fixture", owner: ownerId },
			resume: false,
		});
		await services.install(host.harness);
		host.harness.resume();
		await reconcileDeliveries(host.harness, BACKGROUND_CONTEXT);
		return { services, host };
	};

	const opened = await openFrom();
	const fixture: ScheduleFixture = {
		root,
		storageId,
		storagePath,
		ownerId,
		runtime,
		errors,
		host: opened.host,
		services: opened.services,
		conversation: async () => await fixture.host.conversation(undefined),
		submitMessage: async (message: string) => {
			const result = (await fixture.host.request("submit", { sessionId: storageId, message, requestId: `fixture-submit:${Math.random().toString(36).slice(2)}`, ownerId })) as { submissionId: number };
			return result.submissionId;
		},
		waitForFirstRequest: () => requested.promise,
		releaseAnswer: () => {
			firstGate?.release();
		},
		waitForReceipt: async (requestId: string, timeoutMs = 20000) => {
			const signal = AbortSignal.timeout(timeoutMs);
			for (;;) {
				const page = (await fixture.host.request("receipts", { ownerId, wait: true }, signal)) as { receipts: DeliveryReceipt[] };
				const found = page.receipts.find((receipt) => receipt.requestId === requestId);
				// A delivered receipt stays pending until its owner acknowledges it; ack every read so the next wait blocks.
				if (page.receipts.length > 0) await fixture.host.request("acknowledge", { ownerId, submissionIds: page.receipts.map((receipt) => receipt.submissionId) });
				if (found !== undefined) return found;
			}
		},
		searchCount: async (query: string) => {
			const page = (await fixture.host.request("inspect", { view: "search", query })) as { matches: unknown[] };
			return page.matches.length;
		},
		modelRequestCount: () => requests,
		reopen: async () => {
			await fixture.host.close();
			await fixture.services.close();
			const next = await openFrom();
			fixture.host = next.host;
			fixture.services = next.services;
		},
		close: async () => {
			await fixture.host.close();
			await fixture.services.close();
		},
	};
	t.after(async () => {
		await fixture.host.close().catch(() => undefined);
		await fixture.services.close().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	});
	return fixture;
}
