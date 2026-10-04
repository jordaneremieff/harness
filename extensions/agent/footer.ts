/**
 * Primary statusline for native Durable agents. Cost comes from retained
 * Durable usage; the footer holds no local checkpoint and adds no deltas.
 */
import type { AgentConversationSummary } from "./dashboard-types.ts";

const MAX_OWNER_DEPTH = 64;
const MAX_OWNER_READS = 1024;

/** Follow creating owners through storage identities, not writer claims or display names. */
export function sessionFigures(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
): string {
	const owners = new Map<string, string | undefined>();
	const ownerOf = (storageId: string): string | undefined => {
		if (owners.has(storageId)) return owners.get(storageId);
		if (owners.size === MAX_OWNER_READS) return undefined;
		const owner = readOwner(storageId);
		owners.set(storageId, owner);
		return owner;
	};
	const inScope = (storageId: string): boolean => {
		let identity = storageId;
		const visited = new Set<string>();
		for (let depth = 0; depth < MAX_OWNER_DEPTH; depth++) {
			const storageId = identity.split(":", 1)[0];
			if (visited.has(storageId)) return false;
			visited.add(storageId);
			const owner = ownerOf(storageId);
			if (owner === ownerId) return true;
			if (!owner) return false;
			identity = owner;
		}
		return false;
	};
	return formatDurableFooter(rows.filter((row) => inScope(row.storageId)));
}

/** Recorded-pricing estimate for already-scoped rows; hide costs below half a cent. */
export function formatDurableFooter(rows: readonly AgentConversationSummary[]): string {
	if (rows.length === 0) return "";
	const working = rows.filter((row) => row.state === "working").length;
	const cost = rows.reduce((sum, row) => sum + (Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : 0), 0);
	return `agents: ${working}/${rows.length} active${cost >= 0.005 ? ` · ~$${cost.toFixed(2)}` : ""}`;
}
