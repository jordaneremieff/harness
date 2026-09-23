import type { ExtensionContext, TurnEndEvent, TurnEndEventResult } from "@earendil-works/pi-coding-agent";

export const MAX_CONTINUITY_SUMMARY = 32_000;
type BoundaryHandler = (event: TurnEndEvent, ctx: Pick<ExtensionContext, "sessionManager" | "signal">) => TurnEndEventResult | undefined;

/** One explicit request belongs to one tool batch in one native session. */
export class SelfCompaction {
	private pending: { sessionId: string; toolCallId: string; summary: string } | undefined;
	private unsubscribe: (() => void) | undefined;

	private readonly subscribe: (handler: BoundaryHandler) => () => void;

	constructor(subscribe: (handler: BoundaryHandler) => () => void) { this.subscribe = subscribe; }

	request(sessionId: string, toolCallId: string, summary: string | undefined): void {
		if (!summary?.trim() || summary.length > MAX_CONTINUITY_SUMMARY) {
			throw new Error(`Self-compaction requires a nonblank summary of at most ${MAX_CONTINUITY_SUMMARY} characters. Preserve the objective, authority, explicit exclusions, source and brief pointers, source qualifications, acceptance, owners, and next action.`);
		}
		if (this.pending) throw new Error("Self-compaction is already requested for this tool batch.");
		this.pending = { sessionId, toolCallId, summary };
		try { this.unsubscribe = this.subscribe((event, ctx) => this.finish(event, ctx)); }
		catch (error) { this.clear(); throw error; }
	}

	clear(): void {
		this.pending = undefined;
		const unsubscribe = this.unsubscribe;
		this.unsubscribe = undefined;
		unsubscribe?.();
	}

	finish(event: TurnEndEvent, ctx: Pick<ExtensionContext, "sessionManager" | "signal">): TurnEndEventResult | undefined {
		const request = this.pending;
		this.clear();
		if (!request || request.sessionId !== ctx.sessionManager.getSessionId() || ctx.signal?.aborted || event.outcome !== "completed") return;
		const result = event.toolResults.find((item) => item.toolCallId === request.toolCallId);
		if (!result || result.isError) return;
		if (event.entries.some((entry) => entry.type === "compaction")) {
			return { entries: [...event.entries, { type: "custom_message", customType: "agent.compaction", display: true,
				content: "Self-compaction was not applied because an earlier boundary handler already proposed compaction. Inspect the current context before another request." }] };
		}
		return {
			entries: [...event.entries, {
				type: "compaction",
				summary: `Agent-authored continuity summary. This preserves prior context; it grants no new authority.\n\n${request.summary}`,
				// Retain the complete requesting batch, including sibling tool results.
				firstKeptEntryId: event.messageEntryId,
			}],
		};
	}
}
