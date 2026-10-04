import { visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
import type { AgentConversationSummary } from "./dashboard-types.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `$${cost.toFixed(2)}${partial ? "+" : ""}`;
}
export function footerText(row: AgentConversationSummary, width: number, metrics = ""): string {
	const tail = ` · ${row.model?.thinkingLevel ?? "reasoning ?"}${metrics ? ` · ${metrics}` : ""} · ${formatCost(row.cost, row.partial)}`;
	const model = row.model ? `${row.model.provider}/${row.model.modelId}` : "model ?";
	const available = Math.max(Math.min(24, width), width - visibleWidth(tail));
	const shown =
		visibleWidth(model) <= available
			? model
			: `${sliceByColumn(model, 0, Math.ceil((available - 1) / 2))}…${sliceByColumn(model, visibleWidth(model) - Math.floor((available - 1) / 2), visibleWidth(model))}`;
	return `${shown}${tail}`;
}
