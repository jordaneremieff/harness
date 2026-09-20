import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentHarness, BACKGROUND_CONTEXT, type Entry, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createExtensionRuntime,
	createSyntheticSourceInfo,
	type Extension,
	type ExtensionError,
	type ExtensionEvent,
	ExtensionRunner,
	type MessageEndEvent,
	ModelRegistry,
	ModelRuntime,
	type SessionBeforeCompactEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionView } from "./session-view.ts";
import { corePublicImportUrl } from "./store.ts";
import {
	BRANCH_DETAILS_FAMILY,
	COMPACTION_POINTER_FAMILY,
	installWorkerLifecycle,
	type WorkerNavigationDecision,
} from "./worker-lifecycle.ts";

const { value: valueAddress } = (await import(
	corePublicImportUrl("./harness/session")
)) as typeof import("@earendil-works/pi-agent-core/harness/session");

type SessionCompactFailedEvent = Extract<ExtensionEvent, { type: "session_compact_failed" }>;

const model: Model<"openai-completions"> = {
	api: "openai-completions",
	provider: "lifecycle-test",
	id: "test",
	name: "Test",
	baseUrl: "http://invalid.test",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const assistant: AssistantMessage = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	timestamp: 1,
	content: [{ type: "text", text: "generated" }],
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

async function fixture(
	handlers: Record<string, (event: unknown) => unknown> = {},
	failModel = false,
	takeNavigationDecision?: () => WorkerNavigationDecision | undefined,
) {
	const context = BACKGROUND_CONTEXT;
	const repository = new MemorySessionRepo();
	const session = await repository.create({}, context);
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const stream = () => {
		const output = createAssistantMessageEventStream();
		const message = failModel
			? { ...assistant, stopReason: "error" as const, errorMessage: "Synthetic summary failure" }
			: assistant;
		output.push({ type: "start", partial: message });
		if (failModel) output.push({ type: "error", reason: "error", error: message });
		else output.push({ type: "done", reason: "stop", message });
		output.end(message);
		return output;
	};
	models.registerNativeProvider({
		id: model.provider,
		name: "Test",
		getModels: () => [model],
		auth: {
			apiKey: { name: "Keyless", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) },
		},
		stream,
		streamSimple: stream,
	});
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model,
			tools: [],
			systemPrompt: "Test",
			compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
		},
		context,
	);
	const lane = await harness.lane("main", context);
	const view = new SessionView(
		{
			sessionId: session.metadata.id,
			cwd: process.cwd(),
			createdAtMs: session.metadata.createdAt,
			sessionDir: "memory",
		},
		{
			load: async () => ({
				entries: await lane.findEntries({ order: "oldestFirst" }, context),
				labels: [],
				name: undefined,
				tipId: await lane.getTipId(context),
			}),
			onEntryAdded: (listener) =>
				harness.events.on("entry_added", (event) => {
					if (event.lane === "main") listener(event.entry);
				}),
			onValueUpdate: () => () => {},
		},
	);
	await view.initialize();
	const sourceInfo = createSyntheticSourceInfo("<lifecycle-test>", { source: "test" });
	const extension: Extension = {
		path: sourceInfo.path,
		resolvedPath: sourceInfo.path,
		sourceInfo,
		handlers: new Map(
			Object.entries(handlers).map(([name, callback]) => [name, [async (event: unknown) => callback(event)]]),
		),
		tools: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		messageRenderers: new Map(),
	};
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		process.cwd(),
		view as never,
		new ModelRegistry(models),
	);
	const errors: ExtensionError[] = [];
	runner.onError((error) => errors.push(error));
	const pointers: Array<{ entryId: string; firstKeptEntryId: string }> = [];
	const detailsUpdates: Array<{ entryId: string; details: unknown }> = [];
	const remove = installWorkerLifecycle({
		harness,
		session,
		runner,
		view,
		context,
		takeNavigationDecision,
		onCompactionPointer: (entryId, firstKeptEntryId) => {
			pointers.push({ entryId, firstKeptEntryId });
			view.setCompactionPointer(entryId, firstKeptEntryId);
		},
		onBranchSummaryDetails: (entryId, details) => {
			detailsUpdates.push({ entryId, details });
			view.setBranchSummaryDetails(entryId, details);
		},
	});
	const seed = async () => {
		const first = await lane.appendMessage({ role: "user", content: "first", timestamp: 1 }, context);
		const second = await lane.appendMessage({ role: "user", content: "second", timestamp: 2 }, context);
		const third = await lane.appendMessage({ role: "user", content: "third", timestamp: 3 }, context);
		return { first, second, third };
	};
	return {
		session,
		pointers,
		detailsUpdates,
		context,
		lane,
		harness,
		view,
		errors,
		seed,
		remove,
		close: async () => {
			remove();
			await harness.close(context);
			await session.close(context);
		},
	};
}

describe("worker structural lifecycle", () => {
	it("maps custom compaction pointers to native retained messages and emits success", async () => {
		let chosen = "";
		let success: SessionCompactEvent | undefined;
		const f = await fixture({
			session_before_compact: (raw) => {
				const event = raw as SessionBeforeCompactEvent;
				assert.ok(event.branchEntries.some((entry) => entry.id === event.preparation.firstKeptEntryId));
				assert.ok(event.signal);
				assert.equal(event.willRetry, false);
				event.preparation.tokensBefore += 1;
				return {
					compaction: {
						summary: "custom",
						firstKeptEntryId: chosen,
						tokensBefore: event.preparation.tokensBefore,
						details: { preserved: true },
					},
				};
			},
			session_compact: (raw) => {
				success = raw as SessionCompactEvent;
			},
		});
		try {
			const ids = await f.seed();
			chosen = ids.second;
			await f.lane.compact(undefined, f.context);
			const stored = await f.lane.findEntries({ type: "compaction" }, f.context);
			assert.equal(stored.length, 1);
			const compacted = stored[0] as Extract<Entry, { type: "compaction" }>;
			assert.deepEqual(
				compacted.retainedTail.map((message) => (message.role === "user" ? message.content : "")),
				["second", "third"],
			);
			assert.equal(success?.compactionEntry.firstKeptEntryId, ids.second);
			assert.equal(success?.fromExtension, true);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("honors compaction cancellation and reports the declined result", async () => {
		let failed: SessionCompactFailedEvent | undefined;
		const f = await fixture({
			session_before_compact: () => ({ cancel: true }),
			session_compact_failed: (raw) => {
				failed = raw as SessionCompactFailedEvent;
			},
		});
		try {
			await f.seed();
			await f.lane.compact(undefined, f.context);
			assert.equal(failed?.aborted, true);
			assert.equal(failed?.fromExtension, false);
			assert.equal((await f.lane.findEntries({ type: "compaction" }, f.context)).length, 0);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("ignores extension estimates as ordinary compaction storage does", async () => {
		let failed: SessionCompactFailedEvent | undefined;
		const f = await fixture({
			session_before_compact: (raw) => ({
				compaction: {
					summary: "custom",
					firstKeptEntryId: (raw as SessionBeforeCompactEvent).preparation.firstKeptEntryId,
					tokensBefore: 1,
					estimatedTokensAfter: 2,
				},
			}),
			session_compact_failed: (raw) => {
				failed = raw as SessionCompactFailedEvent;
			},
		});
		try {
			await f.seed();
			await f.lane.compact(undefined, f.context);
			assert.equal(failed, undefined);
			const entries = await f.lane.findEntries({ type: "compaction" }, f.context);
			assert.equal(entries.length, 1);
			assert.equal("estimatedTokensAfter" in entries[0], false);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("preserves a metadata-only first-kept pointer with the message tail", async () => {
		let pointer = "";
		const f = await fixture({
			session_before_compact: (raw) => ({
				compaction: {
					summary: "custom",
					firstKeptEntryId: pointer,
					tokensBefore: (raw as SessionBeforeCompactEvent).preparation.tokensBefore,
				},
			}),
		});
		try {
			await f.seed();
			pointer = await f.lane.appendCustomEntry("metadata", { kept: true }, f.context);
			await f.lane.appendMessage({ role: "user", content: "after metadata", timestamp: 4 }, f.context);
			await f.lane.compact(undefined, f.context);
			const tip = await f.lane.getTipId(f.context);
			assert.ok(tip);
			assert.equal((await f.session.getValue(valueAddress(COMPACTION_POINTER_FAMILY, tip), f.context))?.value, pointer);
			assert.deepEqual(f.pointers, [{ entryId: tip, firstKeptEntryId: pointer }]);
			const entry = f.view.getEntry(tip);
			assert.equal(entry?.type === "compaction" ? entry.firstKeptEntryId : undefined, pointer);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("consumes caller tree decisions without a duplicate before event", async () => {
		let before = 0;
		let taken = 0;
		const f = await fixture(
			{
				session_before_tree: () => {
					before += 1;
				},
			},
			false,
			() => {
				taken += 1;
				return { summary: { summary: "caller decision", details: { retained: true } } };
			},
		);
		try {
			const ids = await f.seed();
			await f.lane.navigateTree(ids.first, { summarize: true }, f.context);
			assert.equal(before, 0);
			assert.equal(taken, 1);
			assert.equal(f.view.getLeafEntry()?.type, "branch_summary");
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("reports native summary failures with the original error", async () => {
		let failed: SessionCompactFailedEvent | undefined;
		const f = await fixture(
			{
				session_compact_failed: (raw) => {
					failed = raw as SessionCompactFailedEvent;
				},
			},
			true,
		);
		try {
			await f.seed();
			await f.lane.compact(undefined, f.context);
			assert.equal(failed?.aborted, false);
			assert.match(failed?.errorMessage ?? "", /Synthetic summary failure/u);
		} finally {
			await f.close();
		}
	});

	it("emits actual tree preparation and persists a custom native branch summary", async () => {
		let before: SessionBeforeTreeEvent | undefined;
		let after: SessionTreeEvent | undefined;
		const f = await fixture({
			session_before_tree: (raw) => {
				before = raw as SessionBeforeTreeEvent;
				return { summary: { summary: "branch", details: { readFiles: ["read.txt"], modifiedFiles: ["write.txt"] } } };
			},
			session_tree: (raw) => {
				after = raw as SessionTreeEvent;
			},
		});
		try {
			const ids = await f.seed();
			await f.lane.navigateTree(ids.first, { summarize: true }, f.context);
			assert.equal(before?.preparation.oldLeafId, ids.third);
			assert.equal(before?.preparation.commonAncestorId, ids.first);
			assert.deepEqual(
				before?.preparation.entriesToSummarize.map((entry) => entry.id),
				[ids.second, ids.third],
			);
			assert.equal(after?.oldLeafId, ids.third);
			assert.equal(after?.summaryEntry?.summary, "branch");
			assert.deepEqual(after?.summaryEntry?.details, { readFiles: ["read.txt"], modifiedFiles: ["write.txt"] });
			assert.equal(after?.fromExtension, true);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("persists arbitrary tree metadata and plain navigation emits completion", async () => {
		let completed = 0;
		const f = await fixture({
			session_before_tree: () => ({ summary: { summary: "branch", details: { arbitrary: [true, "retained"] } } }),
			session_tree: () => {
				completed += 1;
			},
		});
		try {
			const ids = await f.seed();
			await f.lane.navigateTree(ids.first, { summarize: true }, f.context);
			const tip = await f.lane.getTipId(f.context);
			assert.ok(tip);
			assert.deepEqual((await f.session.getValue(valueAddress(BRANCH_DETAILS_FAMILY, tip), f.context))?.value, {
				arbitrary: [true, "retained"],
			});
			assert.deepEqual(f.detailsUpdates, [{ entryId: tip, details: { arbitrary: [true, "retained"] } }]);
			const entry = f.view.getEntry(tip);
			assert.equal(entry?.type, "branch_summary");
			assert.deepEqual(entry && "details" in entry ? entry.details : undefined, { arbitrary: [true, "retained"] });
			assert.deepEqual(f.errors, []);
			await f.lane.navigateTree(ids.first, undefined, f.context);
			assert.equal(completed, 2);
			assert.equal(f.view.getLeafId(), ids.first);
		} finally {
			await f.close();
		}
	});

	it("rewrites finalized assistant content before native persistence without duplicate callbacks", async () => {
		let assistantEnds = 0;
		let userEnds = 0;
		const f = await fixture({
			message_end: (raw) => {
				const event = raw as MessageEndEvent;
				if (event.message.role === "assistant") {
					assistantEnds += 1;
					return { message: { ...event.message, content: [{ type: "text", text: "rewritten" }] } };
				}
				userEnds += 1;
			},
		});
		try {
			await f.lane.prompt("hello", undefined, f.context);
			const entries = await f.lane.findEntries({ type: "message" }, f.context);
			const last = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant") as Extract<
				Entry,
				{ type: "message" }
			>;
			assert.equal(last.message.role, "assistant");
			assert.deepEqual(last.message.content, [{ type: "text", text: "rewritten" }]);
			assert.equal(assistantEnds, 1);
			assert.equal(userEnds, 1);
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

	it("reports unavailable user-message rewrites instead of duplicate append", async () => {
		const f = await fixture({
			message_end: (raw) => {
				const event = raw as MessageEndEvent;
				if (event.message.role === "user") return { message: { ...event.message, content: "changed" } };
			},
		});
		try {
			await f.lane.prompt("hello", undefined, f.context);
			const entries = await f.lane.findEntries({ type: "message" }, f.context);
			assert.equal(entries.length, 2);
			assert.match(f.errors[0]?.error ?? "", /notification-only/u);
		} finally {
			await f.close();
		}
	});
});
