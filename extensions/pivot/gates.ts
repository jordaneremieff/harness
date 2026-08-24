/**
 * Pivot arming gates — pure fork-framing decision logic.
 *
 * A session arms when it is a fork with copied transcript content and no
 * user message yet beyond the recorded fork point on the active path.
 * The fork point is the last copied entry at fork time; it is recorded
 * once per session id so later session starts need no parent-file read.
 * The recorded leaf is part of the copied set, so a copied leaf that is
 * itself a user message (an interrupted parent) does not block arming.
 */

export const PIVOT_CUSTOM_TYPE = "pivot";

export interface SessionEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	message?: { role?: string };
	customType?: string;
	data?: unknown;
}

export interface ForkPointData {
	sessionId: string;
	forkPointLeafId: string | null;
}

export interface ArmInput {
	hasParent: boolean;
	entries: SessionEntryLike[];
	leafId: string | null;
	sessionId: string;
}

export interface ArmResult {
	arm: boolean;
	record: boolean;
	forkPointLeafId: string | null;
}

/** Walk the active branch from the leaf back to the root, root-first. */
export function activePath(entries: SessionEntryLike[], leafId: string | null): SessionEntryLike[] {
	if (!leafId) return [];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: SessionEntryLike[] = [];
	let current = byId.get(leafId);
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

/** Find the fork-point entry written for this session id, ignoring entries copied from parent forks. */
export function findForkPoint(entries: SessionEntryLike[], sessionId: string): ForkPointData | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PIVOT_CUSTOM_TYPE) continue;
		const data = entry.data as ForkPointData | undefined;
		if (data && typeof data.sessionId === "string" && data.sessionId === sessionId) {
			return data;
		}
	}
	return undefined;
}

/**
 * True when a user message exists strictly after the fork point on the
 * active path. Non-message entries (thinking changes, model changes, custom
 * entries) never count. A fork point outside the active path does not block.
 */
export function hasUserMessageAfter(
	entries: SessionEntryLike[],
	leafId: string | null,
	forkPointLeafId: string | null,
): boolean {
	const path = activePath(entries, leafId);
	const forkIndex = path.findIndex((entry) => entry.id === forkPointLeafId);
	if (forkIndex === -1) return false;
	return path.slice(forkIndex + 1).some((entry) => entry.type === "message" && entry.message?.role === "user");
}

/**
 * Decide whether the session should arm the fork boundary.
 * `record` is true exactly when the caller must persist the fork-point
 * entry for this session id (write once; never overwrite).
 */
export function shouldArm(input: ArmInput): ArmResult {
	if (!input.hasParent) return { arm: false, record: false, forkPointLeafId: null };
	const hasTranscript = input.entries.some((entry) => entry.type === "message");
	if (!hasTranscript) return { arm: false, record: false, forkPointLeafId: null };
	const existing = findForkPoint(input.entries, input.sessionId);
	if (!existing) {
		const forkPointLeafId = input.leafId ?? input.entries[input.entries.length - 1]?.id ?? null;
		return { arm: true, record: true, forkPointLeafId };
	}
	return {
		arm: !hasUserMessageAfter(input.entries, input.leafId, existing.forkPointLeafId),
		record: false,
		forkPointLeafId: existing.forkPointLeafId,
	};
}
