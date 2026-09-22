import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SessionManager,
	type BoundaryResult,
	type ContextUsage,
	type ExtensionContext,
	type SessionBoundaryDraft,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CAPACITY_REQUEST,
	CAPACITY_STATE,
	capacityConfig,
	capacityReset,
	capacityStatus,
	capacityTurnEnd,
	readCapacityState,
} from "./capacity.ts";
import { transcriptEntries } from "./test-fixtures.mts";

const defaults = capacityConfig({});

function fixture() {
	const manager = SessionManager.inMemory("/workspace");
	let usage: ContextUsage | undefined = { tokens: 100, percent: 10, contextWindow: 1000 };
	let reads = 0;
	const controller = new AbortController();
	const ctx: Pick<ExtensionContext, "sessionManager" | "getContextUsage" | "signal"> = {
		sessionManager: manager,
		getContextUsage: () => {
			reads++;
			return usage;
		},
		signal: controller.signal,
	};
	const event = (): TurnEndEvent => {
		const entry = transcriptEntries([
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		])[0];
		assert.equal(entry.type, "message");
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("fixture");
		const messageEntryId = manager.appendMessage(entry.message);
		return {
			type: "turn_end",
			turnIndex: 0,
			message: entry.message,
			toolResults: [],
			messageEntryId,
			toolResultEntryIds: [],
			entries: [],
			continue: false,
			outcome: "completed",
			context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
		};
	};
	const commit = (result: BoundaryResult | undefined) => {
		for (const draft of result?.entries ?? []) {
			switch (draft.type) {
				case "custom":
					manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
					break;
				case "compaction":
					manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 0);
					break;
				case "context_edit":
					manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
			}
		}
	};
	return {
		manager,
		ctx,
		controller,
		event,
		commit,
		reads: () => reads,
		setUsage: (value: ContextUsage | undefined) => {
			usage = value;
		},
		percent: (percent: number) => {
			usage = { tokens: percent * 10, contextWindow: 1000, percent };
		},
	};
}

function requests(result: BoundaryResult | undefined) {
	return (
		result?.entries?.filter((entry) => entry.type === "custom_message" && entry.customType === CAPACITY_REQUEST) ?? []
	);
}

function requestContent(result: BoundaryResult | undefined): string {
	return requests(result)
		.map((entry) => (entry.type === "custom_message" ? String(entry.content) : ""))
		.join("\n");
}

describe("capacity configuration", () => {
	it("uses documented defaults and accepts explicit overrides", () => {
		assert.deepEqual(defaults, {
			enabled: true,
			checkpointPercent: 60,
			decisionPercent: 70,
			intakeTokenBudget: undefined,
		});
		assert.deepEqual(
			capacityConfig({
				PI_STASH_CHECKPOINT_PERCENT: "50",
				PI_STASH_DECISION_PERCENT: "75",
				PI_STASH_INTAKE_TOKEN_BUDGET: "2500",
			}),
			{ enabled: true, checkpointPercent: 50, decisionPercent: 75, intakeTokenBudget: 2500 },
		);
		assert.equal(capacityConfig({ PI_STASH_CAPACITY: "0", PI_STASH_CHECKPOINT_PERCENT: "bad" }).enabled, false);
	});
	it("rejects malformed, reversed, nonfinite, and out-of-range configuration", () => {
		for (const env of [
			{ PI_STASH_CAPACITY: "true" },
			{ PI_STASH_CHECKPOINT_PERCENT: "NaN" },
			{ PI_STASH_CHECKPOINT_PERCENT: "0" },
			{ PI_STASH_CHECKPOINT_PERCENT: "80" },
			{ PI_STASH_DECISION_PERCENT: "101" },
			{ PI_STASH_INTAKE_TOKEN_BUDGET: "1.5" },
			{ PI_STASH_INTAKE_TOKEN_BUDGET: "Infinity" },
		])
			assert.throws(() => capacityConfig(env));
	});
});

describe("capacity boundary", () => {
	it("reads usage once per turn and stays out of model context below threshold", () => {
		const f = fixture();
		for (let i = 0; i < 50; i++) {
			const result = capacityTurnEnd(f.event(), f.ctx, defaults);
			assert.equal(result?.continue, undefined);
			assert.equal(requests(result).length, 0);
			f.commit(result);
		}
		assert.equal(f.reads(), 50);
		assert.equal(f.manager.buildSessionProjection().messages.length, 50);
	});
	it("requests checkpoint and decision once, even after usage falls and rises", () => {
		const f = fixture();
		for (const [percent, expected] of [
			[59, 0],
			[60, 1],
			[65, 0],
			[70, 1],
			[95, 0],
			[20, 0],
			[90, 0],
		]) {
			f.percent(percent);
			const result = capacityTurnEnd(f.event(), f.ctx, defaults);
			assert.equal(requests(result).length, expected);
			assert.equal(result?.continue, expected ? true : undefined);
			if (percent === 60) assert.match(requestContent(result), /checkpoint: true/);
			if (percent === 70) assert.match(requestContent(result), /choose and execute/);
			f.commit(result);
		}
		assert.equal(readCapacityState(f.ctx).decisionRequested, true);
	});
	it("combines a jump across both thresholds into one continuation", () => {
		const f = fixture();
		f.percent(85);
		const result = capacityTurnEnd(f.event(), f.ctx, defaults);
		assert.equal(requests(result).length, 1);
		assert.equal(result?.continue, true);
		assert.match(requestContent(result), /stop substantive work/);
		assert.match(requestContent(result), /does not authorize/);
		f.commit(result);
		assert.equal(capacityTurnEnd(f.event(), f.ctx, defaults)?.continue, undefined);
	});
	it("preserves earlier drafts and leaves an earlier continuation unchanged", () => {
		const f = fixture();
		const event = f.event();
		event.entries = [{ type: "custom", customType: "another-extension", data: 1 }];
		event.continue = true;
		const result = capacityTurnEnd(event, f.ctx, defaults);
		assert.deepEqual(result?.entries?.[0], event.entries[0]);
		assert.equal(result?.continue, undefined);
	});
	it("suppresses duplicate dispatch and reload repeats from persisted source ids", () => {
		const f = fixture();
		f.percent(60);
		const event = f.event();
		const first = capacityTurnEnd(event, f.ctx, defaults);
		f.commit(first);
		assert.equal(capacityTurnEnd(event, { ...f.ctx }, defaults), undefined);
		assert.equal(capacityTurnEnd(f.event(), { ...f.ctx }, defaults)?.continue, undefined);
	});
	it("recovers a latch from the request when a later state append fails", () => {
		const f = fixture();
		f.percent(60);
		const event = f.event();
		const first = capacityTurnEnd(event, f.ctx, defaults);
		f.commit({ entries: requests(first) });
		assert.equal(readCapacityState(f.ctx).checkpointRequested, true);
		assert.equal(capacityTurnEnd(event, f.ctx, defaults), undefined);
	});
	it("starts fresh after committed or earlier-draft compaction", () => {
		const f = fixture();
		f.percent(70);
		f.commit(capacityTurnEnd(f.event(), f.ctx, defaults));
		f.manager.appendCompaction("summary", null, 700);
		assert.equal(readCapacityState(f.ctx).checkpointRequested, false);
		assert.equal(capacityTurnEnd(f.event(), f.ctx, defaults)?.continue, true);
		const event = f.event();
		event.entries = [{ type: "compaction", summary: "summary", firstKeptEntryId: null }];
		const result = capacityTurnEnd(event, f.ctx, defaults);
		assert.equal(result?.continue, undefined, "pre-compaction usage must not trigger a stale request");
		f.commit(result);
		assert.deepEqual(readCapacityState(f.ctx).usage, { kind: "unknown" });
	});
	it("starts fresh on a fork with inherited custom data and preserved message ids", () => {
		const f = fixture();
		f.percent(70);
		f.commit(capacityTurnEnd(f.event(), f.ctx, defaults));
		const state = readCapacityState(f.ctx);
		const fork = fixture();
		fork.percent(70);
		fork.manager.appendCustomEntry(CAPACITY_STATE, state);
		assert.equal(readCapacityState(fork.ctx).checkpointRequested, false);
		assert.equal(capacityTurnEnd(fork.event(), fork.ctx, defaults)?.continue, true);
	});
	it("explicit reset re-arms a high-pressure episode without rewriting history", () => {
		const f = fixture();
		f.percent(70);
		f.commit(capacityTurnEnd(f.event(), f.ctx, defaults));
		f.manager.appendCustomEntry(CAPACITY_STATE, capacityReset(f.ctx));
		assert.equal(capacityTurnEnd(f.event(), f.ctx, defaults)?.continue, true);
	});
	it("does not continue or latch on aborted, failed, or cancelled turns", () => {
		for (const outcome of ["aborted", "error", "completed"] as const) {
			const f = fixture();
			f.percent(70);
			if (outcome === "completed") f.controller.abort();
			const event = f.event();
			event.outcome = outcome;
			const result = capacityTurnEnd(event, f.ctx, defaults);
			assert.equal(result?.continue, undefined);
			f.commit(result);
			assert.equal(readCapacityState(f.ctx).checkpointRequested, false);
		}
	});
	it("keeps missing, malformed, throwing, and post-compaction usage unknown", () => {
		for (const usage of [
			undefined,
			{ tokens: null, percent: null, contextWindow: 1000 },
			{ tokens: NaN, percent: 90, contextWindow: 1000 },
			{ tokens: 900, percent: Infinity, contextWindow: 1000 },
		]) {
			const f = fixture();
			f.setUsage(usage);
			const result = capacityTurnEnd(f.event(), f.ctx, defaults);
			f.commit(result);
			assert.equal(result?.continue, undefined);
			assert.deepEqual(readCapacityState(f.ctx).usage, { kind: "unknown" });
		}
		const f = fixture();
		f.ctx.getContextUsage = () => {
			throw new Error("unavailable");
		};
		f.commit(capacityTurnEnd(f.event(), f.ctx, defaults));
		assert.deepEqual(readCapacityState(f.ctx).usage, { kind: "unknown" });
	});
	it("uses only the configured text-intake estimate when usage is unknown", () => {
		const f = fixture();
		f.setUsage(undefined);
		const config = capacityConfig({ PI_STASH_INTAKE_TOKEN_BUDGET: "10" });
		f.manager.appendMessage({ role: "user", content: "x".repeat(20), timestamp: 0 });
		f.commit(capacityTurnEnd(f.event(), f.ctx, config));
		f.manager.appendMessage({
			role: "toolResult",
			toolCallId: "t",
			toolName: "example",
			content: [{ type: "text", text: "x".repeat(20) }],
			isError: false,
			timestamp: 0,
		});
		const result = capacityTurnEnd(f.event(), f.ctx, config);
		assert.equal(result?.continue, true);
		assert.match(requestContent(result), /context use is unknown/);
		assert.doesNotMatch(requestContent(result), /\d+%/);
		f.commit(result);
		assert.equal(readCapacityState(f.ctx).intakeChars, 40);
		assert.equal(capacityTurnEnd(f.event(), f.ctx, config)?.continue, undefined);
	});
	it("counts earlier message drafts once and resets draft intake at compaction", () => {
		const f = fixture();
		f.setUsage(undefined);
		const config = capacityConfig({ PI_STASH_INTAKE_TOKEN_BUDGET: "10" });
		const message: SessionBoundaryDraft = {
			type: "custom_message",
			customType: "external-note",
			content: "x".repeat(40),
			display: true,
		};
		const event = f.event();
		event.entries = [message];
		const result = capacityTurnEnd(event, f.ctx, config);
		assert.equal(result?.continue, true);
		f.commit(result);
		assert.equal(readCapacityState(f.ctx).intakeChars, 40);
		f.commit(capacityTurnEnd(f.event(), f.ctx, config));
		assert.equal(readCapacityState(f.ctx).intakeChars, 40);
		const compacted = f.event();
		compacted.entries = [
			message,
			{ type: "compaction", summary: "summary", firstKeptEntryId: null },
			{ ...message, content: "tiny" },
		];
		const after = capacityTurnEnd(compacted, f.ctx, config);
		assert.equal(after?.continue, undefined);
		f.commit(after);
		assert.equal(readCapacityState(f.ctx).intakeChars, 4);
	});

	it("does no usage or history work when disabled", () => {
		const f = fixture();
		assert.equal(capacityTurnEnd(f.event(), f.ctx, { ...defaults, enabled: false }), undefined);
		assert.equal(f.reads(), 0);
	});
	it("reports observations as historical and requests as unconfirmed", () => {
		const f = fixture();
		f.percent(60);
		f.commit(capacityTurnEnd(f.event(), f.ctx, defaults));
		assert.match(capacityStatus(f.ctx, defaults), /not a live reading/);
		assert.match(capacityStatus(f.ctx, defaults), /do not prove a checkpoint was saved/);
	});
	it("fails explicitly on corrupt or unavailable ancestry, with a bounded scan", () => {
		const f = fixture();
		f.manager.appendCustomEntry(CAPACITY_STATE, { sessionId: f.manager.getSessionId(), checkpointRequested: "yes" });
		assert.throws(() => readCapacityState(f.ctx), /malformed/);
		f.manager.appendCustomEntry(CAPACITY_STATE, capacityReset(f.ctx));
		assert.equal(readCapacityState(f.ctx).checkpointRequested, false);
		const entry = f.manager.getLeafEntry();
		assert.ok(entry);
		let visits = 0;
		const sessionManager = new Proxy(f.manager, {
			get(target, property) {
				if (property === "getEntry")
					return () => {
						visits++;
						return { ...entry, type: "custom", customType: "unrelated", parentId: "cycle" };
					};
				return Reflect.get(target, property);
			},
		});
		assert.throws(() => readCapacityState({ sessionManager }), /scan limit/);
		assert.equal(visits, 4096);
	});
	it("respects state drafts already supplied in the boundary", () => {
		const f = fixture();
		f.percent(70);
		const event = f.event();
		const first = capacityTurnEnd(event, f.ctx, defaults);
		event.entries = first?.entries as SessionBoundaryDraft[];
		assert.equal(capacityTurnEnd(event, f.ctx, defaults), undefined);
	});
});
