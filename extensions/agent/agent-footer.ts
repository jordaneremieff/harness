import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `$${cost.toFixed(2)}${partial ? "+" : ""}`;
}
export function modelSubheading(row: AgentConversationSummary, width: number, theme?: Pick<Theme, "fg">): string {
	if (!row.model) return "";
	const clean = (value: string) => stripVTControlCharacters(value).replace(/\s+/g, " ").trim();
	const level = clean(row.model.thinkingLevel);
	const tail = level ? ` · ${level}` : "";
	const model = truncateToWidth(clean(`${row.model.provider}/${row.model.modelId}`), Math.max(1, width - visibleWidth(tail)), "…");
	const shown = truncateToWidth(clean(model + tail), Math.max(1, width), "…");
	return theme ? theme.fg("muted", shown) : shown;
}
