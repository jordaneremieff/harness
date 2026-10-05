import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { compactTokens, type AgentUsageFacts } from "./agent-usage.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `$${cost.toFixed(2)}${partial ? "+" : ""}`;
}
export function footerText(row: AgentConversationSummary, width: number, usage: AgentUsageFacts = {}, theme?: Pick<Theme, "fg">): string {
	const clean = (value: string) => stripVTControlCharacters(value).replace(/\s+/g, " ").trim();
	const lines: string[] = [];
	if (row.model) {
		const level = clean(row.model.thinkingLevel);
		const tail = level ? ` · ${level}` : "";
		lines.push(truncateToWidth(clean(`${row.model.provider}/${row.model.modelId}`), Math.max(1, width - visibleWidth(tail)), "…") + tail);
	}
	const facts: string[] = [];
	if (usage.context !== undefined) {
		const context = compactTokens(usage.context) + (usage.window === undefined ? "" : `/${compactTokens(usage.window)} (${Math.round(usage.context / usage.window * 100)}%)`);
		facts.push(`${context} ctx`);
	}
	if (usage.input !== undefined) facts.push(`${compactTokens(usage.input)} in`);
	if (usage.output !== undefined) facts.push(`${compactTokens(usage.output)} out`);
	if (Number.isFinite(row.cost)) facts.push(formatCost(row.cost, row.partial));
	if (facts.length) lines.push(facts.join(" · "));
	return lines.map((line) => {
		const shown = truncateToWidth(clean(line), Math.max(1, width), "…");
		return theme ? theme.fg("muted", shown) : shown;
	}).join("\n");
}
