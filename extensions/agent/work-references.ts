import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { PRIMARY_WORK_REFERENCE_LIMIT, validateWorkReference, type PrimaryWorkReference } from "./primary-channel.ts";

/** Event that producing extensions emit after a session used a stored work item; see docs/conventions/work-references.md. */
export const WORK_REFERENCE_EVENT = "harness:work-reference";
/** This extension's own retained copy of a session's references, restored on resume. */
export const WORK_REFERENCES_ENTRY = "agent.work-references";
/** A parent chain longer than this is malformed; a real branch ends at its root well before it. */
const RESTORE_VISITS = 10_000_000;

/** A checked event for one session, or undefined for a malformed or unsupported payload. */
export function parseWorkReferenceEvent(
	value: unknown,
): { sessionId: string; reference: PrimaryWorkReference } | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
	const title = typeof record.title === "string" ? displayTitle(record.title) : undefined;
	try {
		return {
			sessionId: record.sessionId,
			reference: validateWorkReference({
				kind: record.kind,
				id: record.id,
				...(title ? { title } : {}),
			}),
		};
	} catch {
		return undefined;
	}
}

/** One display line of at most 200 UTF-16 units, without splitting a surrogate pair. */
function displayTitle(text: string): string {
	let line = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	if (line.length <= 200) return line;
	line = line.slice(0, 200);
	return /[\uD800-\uDBFF]$/u.test(line) ? line.slice(0, -1) : line;
}

/**
 * Move one reference to the front of the newest-first list. `changed` is false when only the
 * order changed, so callers rewrite shared records for new members and new titles only.
 */
export function addWorkReference(
	list: readonly PrimaryWorkReference[],
	reference: PrimaryWorkReference,
): { list: PrimaryWorkReference[]; changed: boolean } {
	const previous = list.find((entry) => entry.kind === reference.kind && entry.id === reference.id);
	const title = reference.title ?? previous?.title;
	const entry: PrimaryWorkReference = {
		kind: reference.kind,
		id: reference.id,
		...(title === undefined ? {} : { title }),
	};
	const next = [entry, ...list.filter((item) => item !== previous)].slice(0, PRIMARY_WORK_REFERENCE_LIMIT);
	return { list: next, changed: previous === undefined || previous.title !== entry.title };
}

/** One retained copy; any malformed member discards the whole copy. */
function restoredCopy(data: unknown): PrimaryWorkReference[] {
	const refs = (data as { refs?: unknown } | undefined)?.refs;
	if (!Array.isArray(refs)) return [];
	try {
		return refs.slice(0, PRIMARY_WORK_REFERENCE_LIMIT).map(validateWorkReference);
	} catch {
		return [];
	}
}

/**
 * The newest retained copy on the current branch; an absent or malformed copy restores nothing. A
 * copy is written only when the list changes, so the walk follows the whole in-memory branch.
 */
export function retainedWorkReferences(
	session: Pick<SessionManager, "getLeafId" | "getEntry">,
): PrimaryWorkReference[] {
	let id = session.getLeafId();
	for (let visited = 0; id !== null && visited < RESTORE_VISITS; visited++) {
		const entry = session.getEntry(id);
		if (!entry) return [];
		if (entry.type === "custom" && entry.customType === WORK_REFERENCES_ENTRY) return restoredCopy(entry.data);
		id = entry.parentId;
	}
	return [];
}

/** References present in both lists, in `other`'s newest-first order. */
export function sharedWorkReferences(
	self: readonly PrimaryWorkReference[] | undefined,
	other: readonly PrimaryWorkReference[] | undefined,
): PrimaryWorkReference[] {
	if (!self?.length || !other?.length) return [];
	const keys = new Set(self.map((entry) => `${entry.kind}\0${entry.id}`));
	return other.filter((entry) => keys.has(`${entry.kind}\0${entry.id}`));
}
