/**
 * Primary statusline for native Durable agents. Cost comes from retained
 * Durable usage; the footer holds no local checkpoint and adds no deltas.
 */
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";

const MAX_OWNER_DEPTH = 64;
const MAX_OWNER_READS = 1024;

/** Spend text: cents normally, four decimals for a positive sub-cent total, and `+?` for incomplete native cost. */
function price(rows: readonly AgentConversationSummary[], incompleteCoverage: boolean): string {
	let cost = 0;
	let incomplete = false;
	for (const row of rows) {
		if (Number.isFinite(row.cost) && row.cost >= 0) cost += row.cost;
		else incomplete = true;
		incomplete ||= row.partial;
	}
	const digits = cost > 0 && cost < 0.01 ? 4 : 2;
	return `${incompleteCoverage ? "≥" : ""}$${cost.toFixed(digits)}${incomplete ? "+?" : ""}`;
}

function figures(rows: readonly AgentConversationSummary[], incomplete: boolean): string {
	const working = rows.filter((row) => row.state === "working").length;
	const total = rows.length;
	const costText = price(rows, incomplete);
	return total === 0 ? "" : `agents this session: ${working} working · ${total} total · ${costText}`;
}

function incompleteCoverage(coverage?: AgentDashboardCoverage): boolean {
	return Boolean(coverage && (!coverage.complete || coverage.nextCursor || coverage.skipped || coverage.omitted));
}

/** Follow creating owners through storage identities, not writer claims or display names. */
export function sessionFigures(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
	coverage?: AgentDashboardCoverage,
): string {
	const owners = new Map<string, string | undefined>();
	let bounded = false;
	const ownerOf = (storageId: string): string | undefined => {
		if (owners.has(storageId)) return owners.get(storageId);
		if (owners.size === MAX_OWNER_READS) { bounded = true; return undefined; }
		const owner = readOwner(storageId);
		owners.set(storageId, owner);
		return owner;
	};
	const scoped = rows.filter((row) => {
		let identity = row.storageId;
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
		bounded = true;
		return false;
	});
	return figures(scoped, bounded || incompleteCoverage(coverage));
}

/** Primary statusline for already-scoped conversation rows. */
export function formatDurableFooter(
	rows: readonly AgentConversationSummary[],
	coverage?: AgentDashboardCoverage,
): string {
	return figures(rows, incompleteCoverage(coverage));
}
