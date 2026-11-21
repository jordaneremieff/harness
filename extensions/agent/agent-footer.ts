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
const clean = (text: string) =>
	stripVTControlCharacters(text.slice(0, 512))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
export function agentCacheShare(usage?: UsageState): { percent: number; read: boolean } | undefined {
	if (!usage) return undefined;
	let input = 0,
		read = 0,
		write = 0;
	for (const value of Object.values(usage.models)) {
		input += value.input;
		read += value.cacheRead;
		write += value.cacheWrite;
	}
	const total = input + read + write;
	if (
		![input, read, write, total].every((value) => Number.isFinite(value) && value >= 0) ||
		total <= 0 ||
		read + write === 0
	)
		return undefined;
	return { percent: Math.round((read / total) * 100), read: read > 0 };
}
export function agentContextBar(percent: number, theme: Pick<Theme, "fg">): string {
	const value = Math.max(0, Math.round(percent));
	const cells = Math.round(Math.min(100, value) / 10);
	const tone = value > 80 ? "error" : value > 60 ? "warning" : "success";
	return `${theme.fg(tone, "█".repeat(cells))}${theme.fg("dim", "░".repeat(10 - cells))} ${theme.fg(tone, `${value}%`)}`;
}
function projectLabel(
	cwd: string,
	branch: string | undefined,
	width: number,
	home: string,
	theme: Pick<Theme, "fg">,
): string {
	let folder = clean(cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd);
	let name = branch ? clean(branch) : "";
	const suffix = (text: string, columns: number) => {
		const size = visibleWidth(text);
		return size <= columns
			? text
			: `…${sliceByColumn(text, size - Math.max(0, columns - 1), Math.max(0, columns - 1), true)}`;
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
	// The main session's status line writes the route as provider/model; the agent's line matches it.
	const label = theme.fg("accent", clean(`${model.provider}/${model.modelId}`));
	const level = clean(model.thinkingLevel);
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return info?.reasoning && levels.includes(level)
		? label + theme.fg(`thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor, ` [${level}]`)
		: label;
}
function contextCells(
	context: number | undefined,
	capacity: number | undefined,
	theme: Pick<Theme, "fg">,
): [string, string] {
	if (context === undefined || !Number.isFinite(context) || context < 0) return ["", ""];
	if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0)
		return ["", theme.fg("dim", compactTokens(context))];
	return [
		agentContextBar((context / capacity) * 100, theme),
		theme.fg("dim", `${compactTokens(context)}/${compactTokens(capacity)}`),
	];
}
interface MetricParts {
	model: string;
	bar: string;
	tokens: string;
	cost: string;
	dot: string;
	rate: string;
}
function metricParts(
	row: AgentConversationSummary,
	theme: Pick<Theme, "fg">,
	context: number | undefined,
	info: AgentModelInfo | undefined,
	usage: UsageState | undefined,
): MetricParts {
	const [bar, tokens] = contextCells(context, info?.contextWindow, theme);
	const cache = agentCacheShare(usage);
	return {
		model: modelLabel(row, info, theme),
		bar,
		tokens,
		cost:
			Number.isFinite(row.cost) && row.cost >= 0.005 ? theme.fg("dim", `~${formatCost(row.cost, row.partial)}`) : "",
		dot: cache ? theme.fg(cache.read ? "success" : "error", "●") : "",
		rate: cache ? theme.fg("dim", `${cache.percent}% hit`) : "",
	};
}
function composeMetrics(parts: MetricParts, theme: Pick<Theme, "fg">): string {
	return [parts.model, parts.bar, parts.tokens, parts.cost, [parts.dot, parts.rate].filter(Boolean).join(" ")]
		.filter(Boolean)
		.join(theme.fg("dim", " │ "));
}
/** Columns the directory and branch take at most on the facts row, and at least before they leave it. */
const FACTS_PROJECT_MAX = 44;
const FACTS_PROJECT_MIN = 16;

/**
 * The agent's facts on one row: the metrics as the status line writes them, then the directory and
 * branch. When the row is short, the cache rate and token count leave first, then the directory
 * shortens from the left, then it leaves, then the cost; the model and the context bar stay.
 */
export function agentFactsLine(
	row: AgentConversationSummary,
	width: number,
	theme: Pick<Theme, "fg">,
	context?: number,
	info?: AgentModelInfo,
	usage?: UsageState,
	branch?: string,
	home = homedir(),
): string {
	const parts = metricParts(row, theme, context, info, usage);
	const separator = theme.fg("dim", " │ ");
	let project = projectLabel(row.cwd, branch, Math.min(FACTS_PROJECT_MAX, width), home, theme);
	const line = () => [composeMetrics(parts, theme), project].filter(Boolean).join(separator);
	for (const field of ["rate", "dot", "tokens"] as const) {
		if (visibleWidth(line()) <= width) break;
		parts[field] = "";
	}
	if (visibleWidth(line()) > width) {
		const room = width - visibleWidth(composeMetrics(parts, theme)) - visibleWidth(separator);
		project = room >= FACTS_PROJECT_MIN ? projectLabel(row.cwd, branch, room, home, theme) : "";
	}
	if (visibleWidth(line()) > width) parts.cost = "";
	return truncateToWidth(line(), width, "…");
}
