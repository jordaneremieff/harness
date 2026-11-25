/**
 * Source-ledger deliveries reach only the exact primary that owns them, in real Pi sessions: an empty session
 * without a file, a busy unrelated session and a returning owner.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { SubmissionId } from "@earendil-works/pi-durable";
import register from "./index.ts";
import { AgentCatalog } from "./catalog.ts";
import { recordReport } from "./durable-controls.ts";
import { deliveryState } from "./delivery-store.ts";
import { startDurableDelivery, type DurableDelivery } from "./durable-delivery.ts";
import { DurableHost } from "./durable-host.ts";
import {
	answerMessage,
	fixtureModelId,
	fixtureProvider,
	fixtureRegistry,
	hostOptions,
	scriptedRuntime,
} from "./durable-host-fixture.mts";
import { parseHostMetadata } from "./host-protocol.ts";
import type { AgentManager } from "./manager.ts";
import { connectPrimaryChannel, primaryRefusalKind } from "./primary-channel.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

type Entry = { type: string; customType?: string; details?: { sourceId?: string } };

/** Bounded wait on asynchronous delivery work; timers and I/O run between checks. */
async function until(label: string, check: () => boolean | Promise<boolean>, attempts = 500): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`timed out waiting for ${label}`);
}

function peerEntries(path: string | undefined, sourceId?: string): Entry[] {
	if (path === undefined || !existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Entry)
		.filter(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent.peer" &&
				(sourceId === undefined || entry.details?.sourceId === sourceId),
		);
}

async function sessions(t: TestContext) {
	// Keep the primary sockets below the platform pathname limit.
	const root = realpathSync(mkdtempSync("/tmp/pi-pr-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	for (const path of [cwd, agentDir, sessionsRoot]) mkdirSync(path);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } }),
	);
	const saved = new Map(
		["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR"].map((key) => [key, process.env[key]]),
	);
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[
		Symbol.for("pi.extension.agent.owners")
	];
	const opened: AgentSession[] = [];
	const held: Array<() => void> = [];
	let holdNext = false;
	let holding!: () => void;
	const holdStarted = new Promise<void>((resolve) => {
		holding = resolve;
	});
	t.after(async () => {
		for (const release of held) release();
		try {
			for (const session of opened) await session.abort().catch(() => undefined);
			await owners.managers.get(sessionsRoot)?.close();
			owners.managers.delete(sessionsRoot);
			for (const session of opened) session.dispose();
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	const runtime = await createTestRuntime();
	const stream = () => {
		const message: AssistantMessage = {
			role: "assistant",
			api: testModel.api,
			provider: testModel.provider,
			model: testModel.id,
			content: [{ type: "text", text: "SESSION_ANSWER" }],
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		if (holdNext) {
			holdNext = false;
			held.push(() => {
				events.push({ type: "done", reason: "stop", message });
				events.end(message);
			});
			holding();
			return events;
		}
		events.push({ type: "done", reason: "stop", message });
		events.end(message);
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Recipient isolation provider",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const open = async (sessionManager: SessionManager): Promise<AgentSession> => {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [register],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			settingsManager,
			sessionManager,
			model: testModel,
			resourceLoader: loader,
			tools: [],
		});
		opened.push(session);
		await session.bindExtensions({});
		return session;
	};
	return {
		root,
		cwd,
		sessionsRoot,
		open,
		/** Start a run that holds its provider stream until teardown. */
		async busy(session: AgentSession): Promise<void> {
			holdNext = true;
			void session.prompt("Unrelated work in progress");
			await holdStarted;
		},
	};
}

async function source(t: TestContext, root: string, sessionsRoot: string) {
	const storageId = randomUUID();
	const storagePath = join(root, `${storageId}.sqlite`);
	const host = await DurableHost.open({
		...hostOptions(storagePath, await scriptedRuntime([answerMessage("RESULT_FOR_OWNER")]), fixtureRegistry()),
		storageId,
		cwd: root,
	});
	t.after(() => host.close());
	const metadata = parseHostMetadata({
		storageId,
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		storagePath,
		model: { provider: fixtureProvider, modelId: fixtureModelId },
		thinkingLevel: "off",
	});
	let watcher: DurableDelivery | undefined;
	t.after(() => watcher?.close());
	return {
		host,
		start() {
			watcher = startDurableDelivery({
				host,
				metadata,
				catalog: new AgentCatalog(join(root, "catalog")),
				sessionsRoot,
				signal: new AbortController().signal,
				retryDelayMs: 60_000,
			});
			return watcher;
		},
	};
}

function addressed(sourceId: string, owner: string, recipient: string, copy = false) {
	return {
		sourceId,
		text: "RESULT_FOR_OWNER",
		details: {
			kind: "report",
			sourceId,
			originalOwnerId: owner,
			deliveryRecipient: recipient,
			wake: !copy,
			...(copy ? { fallback: true, fallbackLabel: "no live owning session" } : {}),
		},
	};
}

async function refusal(sessionsRoot: string, recipient: string, message: ReturnType<typeof addressed>) {
	const connection = await connectPrimaryChannel({ id: recipient, sessionsRoot });
	try {
		await connection.deliver(message);
	} catch (error) {
		return primaryRefusalKind(error);
	} finally {
		await connection.close();
	}
	return "accepted";
}

it("keeps an absent owner's result from an empty and a busy session and delivers it once to the owner", {
	timeout: 60000,
}, async (t) => {
	const f = await sessions(t);
	// The owner saved a transcript earlier and has no live process now.
	const ownerManager = SessionManager.create(f.cwd, f.sessionsRoot);
	ownerManager.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
	const ownerId = ownerManager.getSessionId();
	const ownerFile = ownerManager.getSessionFile();
	assert.ok(ownerFile !== undefined && existsSync(ownerFile));

	const empty = await f.open(SessionManager.create(f.cwd, f.sessionsRoot));
	const emptyId = empty.sessionManager.getSessionId();
	const busy = await f.open(SessionManager.create(f.cwd, f.sessionsRoot));
	await busy.prompt("Earlier unrelated request");
	await f.busy(busy);
	const busyEntries = busy.sessionManager.getEntries().length;
	const busyFile = readFileSync(busy.sessionManager.getSessionFile() ?? "", "utf8");

	const s = await source(t, f.root, f.sessionsRoot);
	const report = await recordReport(
		s.host.harness,
		{ ownerId, senderIdentity: s.host.storageId, message: "REPORT_FOR_OWNER", requestId: "owner-report" },
		BACKGROUND_CONTEXT,
	);
	// A request ID may contain any text, including the words of a copy marker.
	await recordReport(
		s.host.harness,
		{ ownerId, senderIdentity: s.host.storageId, message: "TOTALS", requestId: "quarter:informational:totals" },
		BACKGROUND_CONTEXT,
	);
	const admitted = (await s.host.request(
		"submit",
		{ sessionId: s.host.storageId, message: "task", requestId: "owner-task", ownerId, origin: "model" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await s.host.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	const watcher = s.start();
	await until("both rows parked", async () => {
		const state = await deliveryState(s.host.harness, BACKGROUND_CONTEXT, true);
		return (
			state?.reports.every((row) => row.delivery?.state === "parked") === true &&
			state.receipts[String(admitted.submissionId)]?.delivery?.state === "parked"
		);
	});
	const parked = await deliveryState(s.host.harness, BACKGROUND_CONTEXT, true);
	assert.match(parked?.reports[0]?.delivery?.reason ?? "", /reaches no other session/u);
	assert.deepEqual(watcher.summary().parkedRecipients, [ownerId]);

	// An informational copy, a misaddressed row and an unsaved recipient's own row all refuse without effect.
	const sourceId = `${s.host.storageId}:${report.sourceId}`;
	assert.equal(
		await refusal(f.sessionsRoot, emptyId, addressed(`${sourceId}:informational:x`, ownerId, emptyId, true)),
		"copy",
	);
	assert.equal(
		await refusal(
			f.sessionsRoot,
			busy.sessionManager.getSessionId(),
			addressed(sourceId, ownerId, busy.sessionManager.getSessionId(), true),
		),
		"copy",
	);
	assert.equal(await refusal(f.sessionsRoot, emptyId, addressed(sourceId, ownerId, emptyId)), "misaddressed");
	assert.equal(await refusal(f.sessionsRoot, emptyId, addressed("own-row", emptyId, emptyId)), "unsaved");

	watcher.refresh();
	await until("a second pass", () => !watcher.busy);
	assert.equal(
		empty.sessionManager.getSessionFile() !== undefined && existsSync(empty.sessionManager.getSessionFile() ?? ""),
		false,
	);
	assert.equal(empty.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 0);
	assert.equal(empty.agent.peekQueuedMessages().length, 0);
	assert.equal(busy.sessionManager.getEntries().length, busyEntries, "the busy session took no entry");
	assert.equal(busy.agent.peekQueuedMessages().length, 0, "the busy session queued no message");
	assert.equal(readFileSync(busy.sessionManager.getSessionFile() ?? "", "utf8"), busyFile);

	// The owner returns; its own registration receives both rows in its file.
	const owner = await f.open(SessionManager.open(ownerFile, f.sessionsRoot));
	assert.equal(owner.sessionManager.getSessionId(), ownerId);
	await until("owner acknowledgement", async () => {
		// A delivery that the owner queued behind its run confirms at a later attempt.
		if (!watcher.busy) watcher.refresh();
		const state = await deliveryState(s.host.harness, BACKGROUND_CONTEXT, true);
		return (
			state?.reports.every((row) => row.acknowledged) === true &&
			state.receipts[String(admitted.submissionId)]?.acknowledged === true
		);
	});
	assert.equal(peerEntries(ownerFile, sourceId).length, 1);
	assert.equal(peerEntries(ownerFile).length, 3, "the owner holds both reports and the result");

	// A lost acknowledgement repeats the same source identity; the owner keeps one entry.
	const [retained] = peerEntries(ownerFile, sourceId);
	const replay = addressed(sourceId, ownerId, ownerId);
	assert.equal(
		await refusal(f.sessionsRoot, ownerId, { ...replay, details: { ...retained.details, ...replay.details } }),
		"accepted",
	);
	assert.equal(peerEntries(ownerFile, sourceId).length, 1);
	assert.equal(peerEntries(empty.sessionManager.getSessionFile()).length, 0);
	assert.equal(busy.sessionManager.getEntries().length, busyEntries);
});
