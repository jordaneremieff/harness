import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";

export interface ContinuityProjection<T> {
	readonly messages: T[];
	readonly mismatch?: "head-message" | "head-shape" | "missing-summary";
}

function note(text: string): Message { return { role: "user", content: text, timestamp: 0 }; }

/** The caller supplies exact mirrored identity; content checks only detect inconsistency. */
export function projectNativeContinuity(messages: readonly Message[], head: Pick<EntryRecord, "id" | "model">, text: string): ContinuityProjection<Message> {
	const model = head.model ?? [];
	if (model.length > 1) return { messages: [...messages], mismatch: "head-shape" };
	const systemCount = messages[0]?.role === "system" ? 1 : 0;
	if (model.length === 1 && !isDeepStrictEqual(messages[systemCount], model[0])) return { messages: [...messages], mismatch: "head-message" };
	const index = systemCount + model.length;
	return { messages: [...messages.slice(0, index), note(text), ...messages.slice(index)] };
}

/** This hook's local offset is after the summary, not an absolute final index across hooks. */
export function projectOrdinaryContinuity(messages: readonly AgentMessage[], head: Pick<CompactionEntry, "id" | "summary">, text: string): ContinuityProjection<AgentMessage> {
	let index = messages.length - 1;
	while (index >= 0 && messages[index].role !== "compactionSummary") index--;
	if (index < 0) return { messages: [...messages], mismatch: "missing-summary" };
	const summary = messages[index];
	if (summary.role !== "compactionSummary" || summary.summary !== head.summary) return { messages: [...messages], mismatch: "head-message" };
	return { messages: [...messages.slice(0, index + 1), note(text), ...messages.slice(index + 1)] };
}
