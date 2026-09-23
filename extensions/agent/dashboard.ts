import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import { displayPreview } from "./presentation.ts";

export interface AgentObservationSources {
	sessions(): Promise<AgentSessionSummary[]>;
	runs(): Promise<DetachedRunView[]>;
}

const ROW_LIMIT = 50;
interface DashboardSection { total: number; rows: string[][]; error?: string }
export interface AgentDashboardSnapshot { observedAt: string; sessions: DashboardSection; runs: DashboardSection }

function sessionRows(rows: AgentSessionSummary[]): DashboardSection {
	const sorted = [...rows].sort((a, b) => Number(Boolean(b.operation || b.detachedRunId)) - Number(Boolean(a.operation || a.detachedRunId)) || b.modifiedAt - a.modifiedAt);
	return { total: rows.length, rows: sorted.slice(0, ROW_LIMIT).map((row) => [
		`${row.operation ? "Active work" : row.detachedRunId ? "Detached owner" : row.live ? "Open here" : "Stored; owner state unavailable"}${row.name ? ` · ${displayPreview(row.name, 120)}` : ""}`,
		`Session: ${displayPreview(row.sessionId, 160)}`,
		`Directory: ${displayPreview(row.cwd, 180)}`,
		row.detachedRunId ? `Run: ${displayPreview(row.detachedRunId, 160)}` : `Modified: ${new Date(row.modifiedAt).toISOString()}`,
	]) };
}

function runRows(rows: DetachedRunView[]): DashboardSection {
	const sorted = [...rows].sort((a, b) => Number(b.state === "running" || b.state === "launching") - Number(a.state === "running" || a.state === "launching") || b.startedAt.localeCompare(a.startedAt));
	return { total: rows.length, rows: sorted.slice(0, ROW_LIMIT).map((row) => [
		`${row.state} · ${displayPreview(row.prompt, 120)}`,
		`Run: ${displayPreview(row.runId, 160)} · Session: ${displayPreview(row.currentSessionId ?? row.sessionId, 160)}`,
		`Directory: ${displayPreview(row.cwd, 180)}`,
		row.error ? `Error: ${displayPreview(row.error, 180)}` : row.summary ? `Result: ${displayPreview(row.summary, 180)}` : row.progress ? `Recorded ${displayPreview(row.progress.updatedAt, 60)}: ${displayPreview(row.progress.currentTool ?? row.progress.lastText ?? "No tool or text recorded", 180)}` : "No progress record",
	]) };
}

/** Independent sources preserve usable observations when the other source fails. */
export async function readAgentDashboard(sources: AgentObservationSources): Promise<AgentDashboardSnapshot> {
	const [sessions, runs] = await Promise.allSettled([
		Promise.resolve().then(() => sources.sessions()).then(sessionRows),
		Promise.resolve().then(() => sources.runs()).then(runRows),
	]);
	const section = (result: PromiseSettledResult<DashboardSection>): DashboardSection => result.status === "fulfilled" ? result.value : { total: 0, rows: [], error: displayPreview(result.reason instanceof Error ? result.reason.message : String(result.reason), 300) };
	return { observedAt: new Date().toISOString(), sessions: section(sessions), runs: section(runs) };
}

function sectionTitle(name: string, section: DashboardSection): string {
	return section.error ? `${name}: unavailable` : `${name}: ${section.total} total; ${section.rows.length} shown; ${section.total - section.rows.length} omitted`;
}

export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	return ["Agent dashboard", `Observed: ${snapshot.observedAt}`, "Read-only snapshot. Stored sessions have no live owner status. Run progress is recorded, not a live query.",
		...(["sessions", "runs"] as const).flatMap((key) => [sectionTitle(key === "sessions" ? "Sessions" : "Detached runs", snapshot[key]), ...(snapshot[key].error ? [snapshot[key].error] : snapshot[key].rows.length ? snapshot[key].rows.flat() : ["None found."])]),
		"Use /agent help for actions. Use agent_list and agent_runs for model-facing results.",
	].join("\n");
}

/** One invocation owns its snapshot and refresh; no timers, subscriptions, or session opens. */
export class AgentDashboard implements Component {
	private snapshot?: AgentDashboardSnapshot;
	private tab: "sessions" | "runs" = "sessions";
	private page = 0;
	private pageSize = 1;
	private loading = false;
	private closed = false;
	private readonly sources: AgentObservationSources;
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: () => void;
	constructor(sources: AgentObservationSources, tui: Pick<TUI, "requestRender" | "terminal">, theme: Theme, keys: KeybindingsManager, done: () => void) {
		this.sources = sources; this.tui = tui; this.theme = theme; this.keys = keys; this.done = done;
		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.closed || this.loading) return;
		this.loading = true;
		this.tui.requestRender();
		const snapshot = await readAgentDashboard(this.sources);
		if (this.closed) return;
		this.snapshot = snapshot;
		this.loading = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
			this.dispose(); this.done(); return;
		}
		if (matchesKey(data, "r")) { void this.refresh(); return; }
		if (matchesKey(data, "tab")) { this.tab = this.tab === "sessions" ? "runs" : "sessions"; this.page = 0; }
		else if (matchesKey(data, "j") || matchesKey(data, "right") || this.keys.matches(data, "tui.select.down") || this.keys.matches(data, "tui.select.pageDown")) this.page++;
		else if (matchesKey(data, "k") || matchesKey(data, "left") || this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.pageUp")) this.page--;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows - 2);
		this.pageSize = Math.max(1, Math.floor((height - 7) / 5));
		const section = this.snapshot?.[this.tab];
		const pages = Math.max(1, Math.ceil((section?.rows.length ?? 0) / this.pageSize));
		this.page = Math.max(0, Math.min(pages - 1, this.page));
		const lines = [this.theme.fg("accent", "Agent dashboard"),
			`Tab: ${this.tab === "sessions" ? "Sessions" : "Detached runs"} · Page ${this.page + 1}/${pages}${this.loading ? " · Refresh in progress" : ""}`,
			this.snapshot ? `Observed: ${this.snapshot.observedAt}` : "Read in progress…",
			"Read-only. Stored owner status unavailable; run progress recorded.",
			...(section ? [sectionTitle(this.tab === "sessions" ? "Sessions" : "Detached runs", section), ...(section.error ? [this.theme.fg("error", section.error)] : section.rows.length ? section.rows.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize).flatMap((row) => [...row, ""]) : ["None found."])] : []),
		];
		const controls = "q close · r refresh · Tab view · j/k page · /agent help";
		return [...lines.slice(0, Math.max(0, height - 1)), this.theme.fg("muted", controls)].map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
	dispose(): void { this.closed = true; }
}

export async function showAgentDashboard(sources: AgentObservationSources, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode === "tui") {
		await ctx.ui.custom<void>((tui, theme, keys, done) => new AgentDashboard(sources, tui, theme, keys, done), {
			overlay: true,
			overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
		});
		return;
	}
	const text = dashboardText(await readAgentDashboard(sources));
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	// Print/JSON UI notifications are no-ops. Diagnostics leave protocol stdout untouched.
	else process.stderr.write(`${text}\n`);
}
