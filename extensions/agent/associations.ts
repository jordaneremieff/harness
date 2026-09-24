import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ASSOCIATION_ENTRY = "agent.association";

/** Native custom entries establish ownership, never tasks or model context. */
export interface AssociationEntry {
	version: 1;
	parentSessionId: string;
	storeRoot: string;
	childSessionId: string;
	attached: boolean;
	previousSessionId?: string;
}

export interface AssociationSource {
	sessionId: string;
	entries(): SessionEntry[];
	append(entry: AssociationEntry): void;
}

export function associatedSessions(entries: SessionEntry[], parentSessionId: string, storeRoot: string): Set<string> {
	const children = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ASSOCIATION_ENTRY) continue;
		const value = entry.data as Partial<AssociationEntry> | null;
		if (value?.version !== 1 || value.parentSessionId !== parentSessionId || value.storeRoot !== storeRoot
			|| typeof value.childSessionId !== "string" || !value.childSessionId || typeof value.attached !== "boolean"
			|| (value.previousSessionId !== undefined && (typeof value.previousSessionId !== "string" || !value.previousSessionId || !value.attached))) continue;
		if (value.previousSessionId) children.delete(value.previousSessionId);
		if (value.attached) children.add(value.childSessionId);
		else children.delete(value.childSessionId);
	}
	return children;
}

/** Search only known association edges, never the session store. */
export function associationReaches(from: string, target: string, children: (id: string) => Iterable<string>, visited = new Set<string>()): boolean {
	if (from === target) return true;
	if (visited.has(from)) return false;
	visited.add(from);
	for (const child of children(from)) if (associationReaches(child, target, children, visited)) return true;
	return false;
}
