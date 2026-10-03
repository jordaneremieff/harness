/**
 * Fixture for the reset and timer tests: one real DurableHost over a SQLite
 * file with the production agent contribution loaded, a faux provider, and an
 * optional held answer for the busy-boundary tests. As a runner, it serves
 * paused scheduling over the host protocol with an explicit native clock.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { runHost } from "./host-process.ts";
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
	/** Keep model requests open across host reopens until released. */
	readonly deferAnswers?: boolean;
	readonly answer?: string;
	/** Native clock shared across reopen. */
	readonly now?: () => number;
	/** Leave scheduling paused until the test explicitly resumes it. */
	readonly resume?: boolean;
	/** Existing storage paths for a subprocess reopen. */
	readonly metadata?: HostMetadata;
	readonly storageId?: string;
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
	const root = options.metadata === undefined ? mkdtempSync(join(tmpdir(), "durable-schedule-")) : dirname(options.metadata.storagePath);
	const cwd = options.metadata?.cwd ?? join(root, "work");
	const agentDir = options.metadata?.agentDir ?? join(root, "agent");
	const storagePath = options.metadata?.storagePath ?? join(root, "store.sqlite");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false }, ...(options.agentExtension === true ? { extensions: [extension] } : {}) }));
	const runtime = await createTestRuntime();
	const answerText = options.answer ?? FIXTURE_ANSWER;
	const requested = gate();
	const firstGate: Gate | undefined = options.deferFirstAnswer === true || options.deferAnswers === true ? gate() : undefined;
	let held = firstGate !== undefined;
	let requests = 0;
	const stream = (_model: unknown, _context: TranscriptContext, requestOptions?: { signal?: AbortSignal }) => {
		requests += 1;
		requested.release();
		const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: answerText }], api: testModel.api, provider: testModel.provider, model: testModel.id, usage: USAGE, stopReason: "stop", timestamp: Date.now() };
		const events = createAssistantMessageEventStream();
		if ((held || options.deferAnswers === true) && firstGate !== undefined) {
			held = false;
			events.push({ type: "start", partial: message });
			let ended = false;
			const abort = () => {
				if (ended) return;
				ended = true;
				const aborted: AssistantMessage = { ...message, content: [], stopReason: "aborted" };
				events.push({ type: "error", reason: "aborted", error: aborted });
				events.end(aborted);
			};
			requestOptions?.signal?.addEventListener("abort", abort, { once: true });
			void firstGate.promise.then(() => {
				if (ended) return;
				ended = true;
				requestOptions?.signal?.removeEventListener("abort", abort);
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
	const storageId = options.metadata?.storageId ?? options.storageId ?? "durable-schedule-fixture";
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
			...(options.now === undefined ? {} : { now: options.now }),
			agent: { model: { provider: testModel.provider, modelId: testModel.id } },
			meta: { name: "schedule fixture", owner: ownerId },
			resume: false,
		});
		await services.install(host.harness);
		if (options.resume !== false) host.harness.resume();
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
			const result = (await fixture.host.request("submit", { sessionId: storageId, message, requestId: `fixture-submit:${Math.random().toString(36).slice(2)}`, ownerId, origin: "operator" })) as { submissionId: number };
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
		if (options.metadata === undefined) rmSync(root, { recursive: true, force: true });
	});
	return fixture;
}

/** A paused native timer host with a caller-controlled clock, for process-loss tests. */
async function main(): Promise<void> {
	const raw = process.argv[2];
	if (!raw) throw new Error("schedule fixture requires host metadata");
	const metadata = parseHostMetadata(JSON.parse(raw));
	const now = Number(process.env.DURABLE_TEST_NOW);
	if (!Number.isSafeInteger(now) || now <= 0) throw new Error("DURABLE_TEST_NOW must be a positive integer");
	const fixture = await scheduleFixture({ after() {} }, { agentExtension: true, metadata, now: () => now, resume: false });
	const host = await runHost(() => ({
		request: async (method, params) => {
			if (method === "fixture-clock") return { now };
			if (method === "fixture-resume") { fixture.host.harness.resume(); return { resumed: true }; }
			return fixture.host.request(method, params as Record<string, unknown> | undefined);
		},
		close: () => fixture.close(),
		isIdle: () => fixture.host.isIdle(),
		onChange: (listener) => fixture.host.harness.subscribeCommits(() => listener()),
	}), { metadata, idleMs: 0 });
	await host.done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	});
}
