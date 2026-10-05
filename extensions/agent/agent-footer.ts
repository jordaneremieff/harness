import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { homedir } from "node:os";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { UsageState } from "@earendil-works/pi-durable";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { compactTokens } from "./agent-usage.ts";
export function formatCost(cost: number | undefined, partial = false): string {
	return cost === undefined || !Number.isFinite(cost) ? "$?" : `$${cost.toFixed(2)}${partial ? "+" : ""}`;
}
export interface AgentModelInfo {
	name: string;
	reasoning: boolean;
	contextWindow: number;
}
export interface DelegatedFigures {
	active: number;
	total: number;
	incomplete: boolean;
	cost?: number;
}
const clean = (text: string) => stripVTControlCharacters(text.slice(0, 512)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
export function agentCacheShare(usage?: UsageState): { percent: number; read: boolean } | undefined {
	if (!usage) return undefined;
	let input = 0, read = 0, write = 0;
	for (const value of Object.values(usage.models)) {
		input += value.input; read += value.cacheRead; write += value.cacheWrite;
	}
	const total = input + read + write;
	if (![input, read, write, total].every((value) => Number.isFinite(value) && value >= 0) || total <= 0 || read + write === 0) return undefined;
	return { percent: Math.round(read / total * 100), read: read > 0 };
}
export function agentContextBar(percent: number, theme: Pick<Theme, "fg">): string {
	const value = Math.max(0, Math.round(percent));
	const cells = Math.round(Math.min(100, value) / 10);
	const tone = value > 80 ? "error" : value > 60 ? "warning" : "success";
	return `${theme.fg(tone, "█".repeat(cells))}${theme.fg("dim", "░".repeat(10 - cells))} ${theme.fg(tone, `${value}%`)}`;
}
function projectLabel(cwd: string, branch: string | undefined, width: number, home: string, theme: Pick<Theme, "fg">): string {
	let folder = clean(cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd);
	let name = branch ? clean(branch) : "";
	const suffix = (text: string, columns: number) => {
		const size = visibleWidth(text);
		return size <= columns ? text : `…${sliceByColumn(text, size - Math.max(0, columns - 1), Math.max(0, columns - 1), true)}`;
	};
	const leaf = Math.min(visibleWidth(folder), visibleWidth(folder.slice(folder.lastIndexOf("/") + 1)) + 1);
	folder = suffix(folder, Math.max(1, leaf, width - (name ? visibleWidth(name) + 3 : 0)));
	if (name && visibleWidth(folder) + visibleWidth(name) + 3 > width) {
		const available = width - visibleWidth(folder) - 3;
		name = available > 0 ? truncateToWidth(name, available, "…") : "";
	}
	folder = suffix(folder, Math.max(1, width - (name ? visibleWidth(name) + 3 : 0)));
	return theme.fg("muted", folder) + (name ? theme.fg("dim", ` (${name})`) : "");
}
function modelLabel(row: AgentConversationSummary, info: AgentModelInfo | undefined, theme: Pick<Theme, "fg">): string {
	if (!row.model) return "";
	const model = row.model;
	const label = theme.fg("accent", clean(info?.name || model.modelId));
	const level = clean(model.thinkingLevel);
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return info?.reasoning && levels.includes(level) ? label + theme.fg(`thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor, ` [${level}]`) : label;
}
function contextCells(context: number | undefined, capacity: number | undefined, theme: Pick<Theme, "fg">): [string, string] {
	if (context === undefined || !Number.isFinite(context) || context < 0) return ["", ""];
	if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0) return ["", theme.fg("dim", compactTokens(context))];
	return [agentContextBar(context / capacity * 100, theme), theme.fg("dim", `${compactTokens(context)}/${compactTokens(capacity)}`)];
}
function metricsLine(row: AgentConversationSummary, width: number, theme: Pick<Theme, "fg">, context: number | undefined, info: AgentModelInfo | undefined, usage: UsageState | undefined): string {
	const [bar, tokens] = contextCells(context, info?.contextWindow, theme);
	const cache = agentCacheShare(usage);
	const parts = { model: modelLabel(row, info, theme), bar, tokens,
		cost: Number.isFinite(row.cost) && row.cost >= 0.005 ? theme.fg("dim", `~${formatCost(row.cost, row.partial)}`) : "",
		dot: cache ? theme.fg(cache.read ? "success" : "error", "●") : "",
		rate: cache ? theme.fg("dim", `${cache.percent}% hit`) : "" };
	const compose = () => [parts.model, parts.bar, parts.tokens, parts.cost, [parts.dot, parts.rate].filter(Boolean).join(" ")].filter(Boolean).join(theme.fg("dim", " │ "));
	for (const field of ["rate", "dot", "tokens", "cost"] as const) {
		if (visibleWidth(compose()) <= width) break;
		parts[field] = "";
	}
	return truncateToWidth(compose(), width, "…");
}
export function agentStatusLines(row: AgentConversationSummary, width: number, theme: Pick<Theme, "fg">, context?: number, info?: AgentModelInfo, usage?: UsageState, branch?: string, delegated?: DelegatedFigures, home = homedir()): string[] {
	const paint = (color: ThemeColor, text: string) => theme.fg(color, text);
	const separator = paint("dim", " │ ");
	let children = delegated ? `agents: ${delegated.active}/${delegated.total}${delegated.incomplete ? "+" : ""} active` : "";
	if (delegated?.cost !== undefined && Number.isFinite(delegated.cost) && delegated.cost >= 0.005) children += ` · ~$${delegated.cost.toFixed(2)}`;
	const tail = children ? paint("text", children) : "";
	const project = projectLabel(row.cwd, branch, width - (tail ? visibleWidth(tail) + 3 : 0), home, theme);
	let second = project;
	if (tail) {
		if (visibleWidth(project) + visibleWidth(tail) + 3 <= width) second += separator + tail;
		else if (width >= 6) second = projectLabel(row.cwd, branch, width - 5, home, theme) + separator + paint("dim", "+1");
		else second = truncateToWidth(paint("dim", "+1"), width, "");
	}
	return [metricsLine(row, width, theme, context, info, usage), truncateToWidth(second, width, "…")];
}
