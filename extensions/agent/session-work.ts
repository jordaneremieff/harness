/** Session-wide sent-work scope, rebuilt from public ordinary Pi entries. */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { storageIdOf } from "./catalog.ts";

export const SENT_WORK_ENTRY = "agent.sent-work";

/** Keep exact conversations; the root's explicit :1 spelling has the same identity. */
export function sentWorkIdentity(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 256) return undefined;
	try {
		storageIdOf(value);
		const conversation = value.split(":")[1];
		if (conversation !== undefined && (!Number.isSafeInteger(Number(conversation)) || Number(conversation) < 1)) return undefined;
		return conversation === undefined ? value : Number(conversation) === 1 ? value.split(":")[0] : `${value.split(":")[0]}:${Number(conversation)}`;
	} catch { return undefined; }
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Successful native admission, correction, or scheduled work, never a report or idle attachment. */
function workTarget(tool: string, details: unknown): string | undefined {
	const value = object(details);
	if (["agent_send", "agent_steer", "agent_spawn", "agent_place"].includes(tool)) {
		const result = object(value.result);
		if (Number.isSafeInteger(result.submissionId) && Number(result.submissionId) > 0) return sentWorkIdentity(result.sessionId);
	}
	if (tool === "agent_rewind" && Number.isSafeInteger(value.submissionId) && Number(value.submissionId) > 0) return sentWorkIdentity(value.identity);
	if (tool === "agent_send" && Number.isSafeInteger(value.timerId) && Number(value.timerId) > 0) return sentWorkIdentity(value.identity ?? value.sessionId);
	return undefined;
}

/** Scan all branches once at session start; successful admissions add markers incrementally. */
export function retainedSentWork(entries: readonly SessionEntry[]): Set<string> {
	const identities = new Set<string>();
	for (const entry of entries) {
		let identity: string | undefined;
		if (entry.type === "custom" && entry.customType === SENT_WORK_ENTRY) identity = sentWorkIdentity(object(entry.data).sessionId);
		if (entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError) identity = workTarget(entry.message.toolName, entry.message.details);
		if (identity !== undefined) identities.add(identity);
	}
	return identities;
}
