/**
 * Primary statusline for native Durable agents. Cost comes from retained
 * Durable usage; the footer holds no local checkpoint and adds no deltas.
 */
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";

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

/** Primary statusline: working conversations and their retained native total cost. */
export function formatDurableFooter(
	rows: readonly AgentConversationSummary[],
	coverage?: AgentDashboardCoverage,
): string {
	const incomplete = Boolean(
		coverage && (!coverage.complete || coverage.nextCursor || coverage.skipped || coverage.omitted),
	);
	return `agents ${rows.filter((row) => row.state === "working").length} · ${price(rows, incomplete)}`;
}
