import { commandPreview } from "./completion.ts";
import { JOB_LIMITS, type JobSnapshot } from "./manager.ts";

/** Agent rows are presentation only. Their keys are never addresses for the local job manager. */
export interface DisplayJob extends JobSnapshot {
	readonly agent?: { readonly identity: string; readonly name?: string };
}

/** Limit the list work of an open dashboard. The count still includes every reported row. */
export const AGENT_LIST_LIMIT = 64;

type JobFrame = { sessionId: string; storageId: string; rows: DisplayJob[] };

function agentJob(item: unknown, storageId: string): DisplayJob | undefined {
	if (!item || typeof item !== "object") return undefined;
	const { id, conversationId, label, startedAt, agentName } = item as Record<string, unknown>;
	if (
		typeof id !== "string" ||
		!/^\d{1,16}$/u.test(id) ||
		typeof conversationId !== "number" ||
		!Number.isSafeInteger(conversationId) ||
		conversationId < 1 ||
		typeof label !== "string" ||
		label.length > 1024 ||
		typeof startedAt !== "number" ||
		!Number.isSafeInteger(startedAt) ||
		startedAt < 0
	)
		return undefined;
	const identity = conversationId === 1 ? storageId : `${storageId}:${conversationId}`;
	const name = typeof agentName === "string" ? commandPreview(agentName.slice(0, 256)) : undefined;
	return {
		id: `agent:${storageId}:${conversationId}:${id}`,
		agent: { identity, ...(name && { name }) },
		commandPreview: commandPreview(label),
		startedAt,
		status: "running",
		cancellationRequested: false,
	};
}

/** A replacement from the live activity convention, never a retained task or a command to run. */
function frame(value: unknown): JobFrame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { source, sessionId, storageId, items } = value as Record<string, unknown>;
	if (
		source !== "jobs" ||
		typeof sessionId !== "string" ||
		!sessionId ||
		sessionId.length > 256 ||
		typeof storageId !== "string" ||
		!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(storageId) ||
		!Array.isArray(items) ||
		items.length > JOB_LIMITS.active
	)
		return undefined;
	const rows: DisplayJob[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const row = agentJob(item, storageId);
		if (!row || seen.has(row.id)) return undefined;
		seen.add(row.id);
		rows.push(row);
	}
	return { sessionId, storageId, rows };
}

class ActiveSources {
	readonly groups = new Map<string, readonly DisplayJob[]>();
	count = 0;

	replace({ storageId, rows }: JobFrame): void {
		this.count += rows.length - (this.groups.get(storageId)?.length ?? 0);
		if (rows.length) this.groups.set(storageId, rows);
		else this.groups.delete(storageId);
	}
}

/** Only connected sources with active jobs occupy the index. A changed source costs one map lookup and at most eight rows. */
export class ObservedAgentJobs {
	private sessionId?: string;
	private active = new ActiveSources();
	/** Another extension's session_start can publish before this extension receives its own session_start. */
	private beforeStart = new Map<string, ActiveSources>();

	bind(sessionId: string): void {
		if (sessionId === this.sessionId) return;
		this.sessionId = sessionId;
		this.active = this.beforeStart.get(sessionId) ?? new ActiveSources();
		this.beforeStart.clear();
	}

	receive(value: unknown): void {
		const next = frame(value);
		if (!next) return;
		if (this.sessionId === next.sessionId) this.active.replace(next);
		else if (this.sessionId === undefined) {
			const source = this.beforeStart.get(next.sessionId) ?? new ActiveSources();
			source.replace(next);
			if (source.count) this.beforeStart.set(next.sessionId, source);
			else this.beforeStart.delete(next.sessionId);
		}
	}

	get count(): number {
		return this.active.count;
	}

	list(): DisplayJob[] {
		const result: DisplayJob[] = [];
		for (const rows of this.active.groups.values()) {
			for (const row of rows) {
				result.push(row);
				if (result.length === AGENT_LIST_LIMIT) return result;
			}
		}
		return result;
	}
}
