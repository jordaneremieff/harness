import { truncateToWidth, visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
import type { AgentConversationSummary } from "./dashboard-types.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `${partial ? "≥" : ""}$${cost.toFixed(2)}`;
}
export function footerText(row: AgentConversationSummary, width: number): string {
	const tail = ` ${row.model?.thinkingLevel ?? "reasoning ?"} · ${formatCost(row.cost, row.partial)} · ${row.state}`;
	const model = row.model ? `${row.model.provider}/${row.model.modelId}` : "model ?";
	const available = Math.max(1, width - visibleWidth(tail));
	const shown =
		visibleWidth(model) <= available
			? model
			: `${sliceByColumn(model, 0, Math.ceil((available - 1) / 2))}…${sliceByColumn(model, visibleWidth(model) - Math.floor((available - 1) / 2), visibleWidth(model))}`;
	return truncateToWidth(`${shown}${tail}`, width);
}
