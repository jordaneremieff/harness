/**
 * Primary statusline for native Durable agents. Cost comes from retained
 * Durable usage; the footer holds no local checkpoint and adds no deltas.
 */
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { sentWorkIdentity } from "./session-work.ts";

const MAX_OWNER_DEPTH = 64;
const MAX_OWNER_READS = 1024;

/** A terminal failure alone is history, not an outstanding intervention. */
function actionableAttention(row: AgentConversationSummary): boolean {
	if (row.attention === "provider-blocked" || row.attention === "task-blocked") return true;
	if (row.owner === "here" && row.health?.lastError) return true;
	return (
		(row.state === "unavailable" || row.owner === "unavailable") &&
		((row.unplaced ?? 0) > 0 || (row.openWorkCount ?? 0) > 0)
	);
}

/** The footer figures of one primary session and the agents in its scope that need intervention. */
export interface SessionFooter {
	readonly text: string;
	/**
	 * Every scoped agent that needs intervention, and every sent-work target that such an agent works under through
	 * its creating owners, in the form of `sentWorkIdentity`. Work sent to one of these waits in vain until someone
	 * intervenes.
	 */
	readonly stuck: readonly string[];
}

/** Creation lineage owns cost; sent-work descendants count while working or in need of intervention. */
export function sessionFigures(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
	sentWork: ReadonlySet<string> = new Set(),
	recoveryBlocked: (storageId: string) => boolean = () => false,
): string {
	return sessionFooter(rows, ownerId, readOwner, sentWork, recoveryBlocked).text;
}

/** The figures of `sessionFigures`, with the scoped agents that need intervention. */
export function sessionFooter(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
	sentWork: ReadonlySet<string> = new Set(),
	recoveryBlocked: (storageId: string) => boolean = () => false,
): SessionFooter {
	const needsAttention = (row: AgentConversationSummary) =>
		actionableAttention(row) || ((row.id === row.storageId || sentWork.has(row.id)) && recoveryBlocked(row.storageId));
	const owners = new Map<string, string | undefined>();
	const ownerOf = (storageId: string): string | undefined => {
		if (owners.has(storageId)) return owners.get(storageId);
		if (owners.size === MAX_OWNER_READS) return undefined;
		const owner = readOwner(storageId);
		owners.set(storageId, owner);
		return owner;
	};
	/** The first creating owner of a storage, walking up its owners, that is one of `roots`. */
	const lineageRoot = (storageId: string, roots: ReadonlySet<string>): string | undefined => {
		let identity = storageId;
		const visited = new Set<string>();
		for (let depth = 0; depth < MAX_OWNER_DEPTH; depth++) {
			const storageId = identity.split(":", 1)[0];
			if (visited.has(storageId)) return undefined;
			visited.add(storageId);
			const owner = ownerOf(storageId);
			if (owner !== undefined && roots.has(owner)) return owner;
			if (!owner) return undefined;
			identity = owner;
		}
		return undefined;
	};
	const inLineage = (storageId: string, roots: ReadonlySet<string>): boolean =>
		lineageRoot(storageId, roots) !== undefined;
	const creationRoots = new Set([ownerId]);
	const creationRows: AgentConversationSummary[] = [];
	const scopedRows = rows.filter((row) => {
		if (inLineage(row.storageId, creationRoots)) {
			creationRows.push(row);
			return true;
		}
		return (
			sentWork.has(row.id) ||
			((row.state === "working" || needsAttention(row)) &&
				(sentWork.has(row.storageId) || inLineage(row.storageId, sentWork)))
		);
	});
	const stuck = new Set<string>();
	for (const row of scopedRows) {
		if (!needsAttention(row)) continue;
		for (const identity of [row.id, row.storageId, lineageRoot(row.storageId, sentWork)])
			if (identity !== undefined) stuck.add(sentWorkIdentity(identity) ?? identity);
	}
	return { text: formatDurableFooter(scopedRows, creationRows), stuck: [...stuck].sort() };
}

/** Working and scoped agents with the recorded-pricing estimate; costs below half a cent are hidden. */
export function formatDurableFooter(
	rows: readonly AgentConversationSummary[],
	costRows: readonly AgentConversationSummary[] = rows,
): string {
	if (rows.length === 0) return "";
	const working = rows.filter((row) => row.state === "working").length;
	const cost = costRows.reduce((sum, row) => sum + (Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : 0), 0);
	const estimate = cost >= 0.005 ? ` · ~$${cost.toFixed(2)}` : "";
	return `agents: ${working}/${rows.length}${estimate}`;
}
