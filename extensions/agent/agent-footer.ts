import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { compactTokens, type AgentUsageFacts } from "./agent-usage.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `$${cost.toFixed(2)}${partial ? "+" : ""}`;
}
export function footerText(row: AgentConversationSummary, width: number, usage: AgentUsageFacts = {}, theme?: Pick<Theme, "fg">): string {
	const compact = width < 100;
	const context = usage.context === undefined ? "?" : compactTokens(usage.context) + (usage.window === undefined ? "" : `/${compactTokens(usage.window)} (${Math.round(usage.context / usage.window * 100)}%)`);
	const tokens = usage.input === undefined || usage.output === undefined ? "?"
		: compact ? `${compactTokens(usage.input)} / ${compactTokens(usage.output)}` : `${compactTokens(usage.input)} in · ${compactTokens(usage.output)} out`;
	const cost = formatCost(row.cost, row.partial);
	const clean = (value: string) => stripVTControlCharacters(value).replace(/\s+/g, " ").trim();
	const clip = (value: string, size: number) => stripVTControlCharacters(truncateToWidth(value, Math.max(1, size), "…"));
	const tail = row.model ? ` · ${clean(row.model.thinkingLevel)} · ${clean(row.model.provider)}` : "";
	const model = clean(row.model?.modelId ?? "?");
	const labelWidth = 9;
	const rightWidth = labelWidth + Math.max(visibleWidth(tokens), visibleWidth(cost));
	const leftWidth = Math.max(labelWidth + 1, Math.min(56, labelWidth + Math.max(visibleWidth(model + tail), visibleWidth(context)), width - rightWidth - 3));
	const field = (label: string, value: string, size: number) => {
		const key = label.padEnd(labelWidth);
		const shown = clip(value, size - labelWidth);
		const line = theme ? theme.fg("muted", key) + theme.fg("text", shown) : key + shown;
		return line + " ".repeat(Math.max(0, size - visibleWidth(line)));
	};
	const shownModel = clip(model, leftWidth - labelWidth - visibleWidth(tail)) + tail;
	return [
		`${field("Model", shownModel, leftWidth)}   ${field("Tokens", tokens, rightWidth)}`,
		`${field("Context", context, leftWidth)}   ${field("Cost", cost, rightWidth)}`,
	].join("\n");
}
