import type { SessionManager, SessionStartEvent } from "@earendil-works/pi-coding-agent";

/** Host projection of the first interactive input, independent of declared intent. */
export const EFFORT_PURPOSE_ENTRY = "agent.effort-purpose";
export interface RetainedPurpose {
	readonly text?: string;
	readonly complete: boolean;
	readonly canCapture: boolean;
}
export function purposeExcerpt(text: string): string {
	return Array.from(text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 256).join("");
}

/** Capture requires proof of no prior input, not merely a complete ancestry scan. */
export function firstInteractivePurpose(state: RetainedPurpose, input: { source: string; text: string }): string | undefined {
	if (!state.complete || !state.canCapture || state.text !== undefined || input.source !== "interactive") return undefined;
	return purposeExcerpt(input.text) || undefined;
}

interface PurposeScan { text?: string; history: boolean; historyBeforeProjection: boolean; invalidProjection: boolean }
function scanPurposeEntry(entry: NonNullable<ReturnType<SessionManager["getEntry"]>>, state: PurposeScan): void {
	if (entry.type === "message" || entry.type === "compaction" || entry.type === "branch_summary") {
		state.history = true;
		if (state.text !== undefined) state.historyBeforeProjection = true;
	}
	if (entry.type !== "custom" || entry.customType !== EFFORT_PURPOSE_ENTRY) return;
	const data = entry.data as { source?: unknown; text?: unknown } | undefined;
	if (data?.source !== "interactive") return;
	const candidate = typeof data.text === "string" ? purposeExcerpt(data.text) : "";
	if (!candidate) state.invalidProjection = true;
	else { state.text = candidate; state.historyBeforeProjection = false; }
}

/** An attributed projection must precede all message history on the bounded branch. */
export function retainedPurpose(session: Pick<SessionManager, "getLeafId" | "getEntry">, reason: SessionStartEvent["reason"] = "startup"): RetainedPurpose {
	let id = session.getLeafId();
	const state: PurposeScan = { history: false, historyBeforeProjection: false, invalidProjection: false };
	for (let visited = 0; id !== null && visited < 256; visited++) {
		const entry = session.getEntry(id);
		if (!entry) return { complete: false, canCapture: false };
		scanPurposeEntry(entry, state);
		id = entry.parentId;
	}
	if (id !== null) return { complete: false, canCapture: false };
	if (state.invalidProjection || state.historyBeforeProjection) return { complete: true, canCapture: false };
	return state.text === undefined ? { complete: true, canCapture: !state.history && (reason === "startup" || reason === "new") } : { text: state.text, complete: true, canCapture: false };
}
