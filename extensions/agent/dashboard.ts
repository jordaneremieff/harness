import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import { displayPreview } from "./presentation.ts";
import type { projectInspection } from "./worker.ts";

export type AgentInspection = ReturnType<typeof projectInspection>;
export type AgentInspectionOptions = Parameters<typeof projectInspection>[2];
export interface AgentObservationSources {
	sessions(): Promise<AgentSessionSummary[]>;
	runs(): Promise<DetachedRunView[]>;
	inspect(sessionId: string, options: AgentInspectionOptions): Promise<AgentInspection>;
}
export type DashboardTarget = { kind: "session"; session: AgentSessionSummary } | { kind: "run"; run: DetachedRunView };
interface DashboardSection { records: DashboardTarget[]; error?: string }
export interface AgentDashboardSnapshot { observedAt: string; sessions: DashboardSection; runs: DashboardSection }
type Tab = "sessions" | "runs";
interface Reader {
	title: string;
	target?: DashboardTarget;
	lines: string[];
	scroll: number;
	sessionId?: string;
	inspection?: AgentInspection;
	entryIndex?: number;
	parent?: Reader;
	action?: boolean;
}
export interface DashboardState {
	snapshot?: AgentDashboardSnapshot;
	tab: Tab;
	filter: string;
	selected: Partial<Record<Tab, string>>;
	reader?: Reader;
}
export interface DashboardActions {
	run(target: DashboardTarget | undefined): Promise<string | undefined>;
}
interface DashboardActionRequest { target?: DashboardTarget }
const ROW_LIMIT = 50;
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\n" || character === "\t" ? character : " ");
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const idOf = (target: DashboardTarget) => target.kind === "session" ? target.session.sessionId : target.run.runId;
const sessionIdOf = (target: DashboardTarget) => target.kind === "session" ? target.session.sessionId : target.run.currentSessionId ?? target.run.sessionId;

function label(target: DashboardTarget): string {
	if (target.kind === "run") return `${target.run.state} · ${target.run.prompt}`;
	const row = target.session;
	return `${row.operation ? "Active work" : row.detachedRunId ? "Detached owner" : row.live ? "Open here" : "Stored; owner state unavailable"} · ${row.name || row.cwd}`;
}
function rosterLabel(target: DashboardTarget): string {
	const state = target.kind === "run" ? target.run.state : target.session.operation ? "Active" : target.session.detachedRunId ? "Detached" : target.session.live ? "Open" : "Stored";
	const name = target.kind === "run" ? target.run.prompt : target.session.name || target.session.cwd;
	return `${displayPreview(idOf(target), 12)} · ${state} · ${displayPreview(name, 300)}`;
}

function metadata(target: DashboardTarget): string[] {
	if (target.kind === "session") {
		const row = target.session;
		return [label(target), `Session: ${row.sessionId}`, `Directory: ${row.cwd}`, `Modified: ${new Date(row.modifiedAt).toISOString()}`, ...(row.operation ? [`Operation: ${row.operation}`] : []), ...(row.detachedRunId ? [`Run: ${row.detachedRunId}`] : [])];
	}
	const row = target.run;
	return [label(target), `Run: ${row.runId}`, `Session: ${sessionIdOf(target)}`, `Directory: ${row.cwd}`, `Started: ${row.startedAt}`, ...(row.finishedAt ? [`Finished: ${row.finishedAt}`] : []),
		"Recorded run data, not a live owner query. Result and progress text are retained summaries, not complete session results.",
		...(row.error ? [`Error: ${row.error}`] : []), ...(row.summary ? [`Result summary: ${row.summary}`] : []),
		...(row.progress ? [`Progress recorded: ${row.progress.updatedAt}`, `Entries recorded: ${row.progress.entryCount}`, ...(row.progress.currentTool ? [`Tool: ${row.progress.currentTool}`] : []), ...(row.progress.lastText ? [`Text: ${row.progress.lastText}`] : []), ...(row.progress.error ? [`Progress error: ${row.progress.error}`] : [])] : ["No progress record"]),
	];
}

/** Independent inventory reads never open a stored session for writing. */
export async function readAgentDashboard(sources: Pick<AgentObservationSources, "sessions" | "runs">): Promise<AgentDashboardSnapshot> {
	const [sessions, runs] = await Promise.allSettled([
		Promise.resolve().then(() => sources.sessions()).then((rows): DashboardTarget[] => [...rows].sort((a, b) => Number(Boolean(b.operation || b.detachedRunId)) - Number(Boolean(a.operation || a.detachedRunId)) || b.modifiedAt - a.modifiedAt).map((session) => ({ kind: "session", session }))),
		Promise.resolve().then(() => sources.runs()).then((rows): DashboardTarget[] => [...rows].sort((a, b) => Number(b.state === "running" || b.state === "launching") - Number(a.state === "running" || a.state === "launching") || b.startedAt.localeCompare(a.startedAt)).map((run) => ({ kind: "run", run }))),
	]);
	const section = (result: PromiseSettledResult<DashboardTarget[]>): DashboardSection => result.status === "fulfilled" ? { records: result.value } : { records: [], error: errorText(result.reason) };
	return { observedAt: new Date().toISOString(), sessions: section(sessions), runs: section(runs) };
}

export function dashboardRecords(section: DashboardSection | undefined, filter: string) {
	const query = filter.trim().toLocaleLowerCase();
	const matches = section?.records.filter((target) => `${idOf(target)} ${sessionIdOf(target)} ${target.kind === "session" ? `${target.session.name ?? ""} ${target.session.cwd}` : `${target.run.prompt} ${target.run.cwd}`}`.toLocaleLowerCase().includes(query)) ?? [];
	return { total: section?.records.length ?? 0, matching: matches.length, records: matches.slice(0, ROW_LIMIT), omitted: Math.max(0, matches.length - ROW_LIMIT) };
}
export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	return ["Agent dashboard", `Observed: ${snapshot.observedAt}`, "Read-only snapshot. Stored sessions have no live owner status. Run progress is recorded, not a live query.",
		...(["sessions", "runs"] as const).flatMap((key) => {
			const section = snapshot[key]; const view = dashboardRecords(section, "");
			return [`${key === "sessions" ? "Sessions" : "Detached runs"}: ${section.error !== undefined ? "unavailable" : `${view.total} total; ${view.records.length} shown; ${view.omitted} omitted`}`, ...(section.error !== undefined ? [displayPreview(section.error, 300)] : view.records.length ? view.records.flatMap((target) => metadata(target).map((line) => displayPreview(line, 180))) : ["None found."])];
		}), "Use /agent help for actions. Use agent_list and agent_runs for model-facing results.",
	].join("\n");
}

function ownerLines(data: AgentInspection): string[] {
	const owner = data.liveOwner ? data.execution.current ? `Active operation: ${data.execution.current.id}` : "Owner reports no current operation" : "Live owner state unavailable; current operation is unknown";
	return [`Session: ${data.sessionId}`, owner, `Recovery: ${data.execution.recovery}`,
		...(data.capture ? [`Read-only snapshot: ${data.capture.available ? "available" : "unavailable"}; ${data.capture.bytes} bytes; unfinished tail: ${data.capture.unfinishedTail}`, ...(data.capture.reason ? [data.capture.reason] : [])] : []),
		...(data.lastError ? [`Owner error${data.lastError.truncated ? " (partial; no error continuation endpoint)" : ""}:`, data.lastError.text] : []),
	];
}

function inspectionLines(data: AgentInspection, entryIndex = 0): string[] {
	const lines = ownerLines(data);
	if ("entryId" in data) return [...lines, `Entry: ${data.entryId} · offset ${data.offset}`, data.truncated ? `Partial entry; next offset ${data.nextOffset}. n reads the next chunk.` : "Final entry chunk (earlier chunks are not repeated).", data.text];
	const entry = data.entries[entryIndex];
	return [...lines, ...(data.result ? [`Retained result${data.result.truncated ? " (partial preview; open its source entry below)" : ""}:`, data.result.text] : ["No retained result in this inspection."]),
		`Entries: ${data.entries.length}, newest first. ${data.nextCursor === null ? "No older page." : `Older cursor: ${data.nextCursor}. o reads it.`}`,
		...data.entries.map((item, index) => `${index === entryIndex ? ">" : " "} ${item.id} · ${item.role ?? item.type}${item.truncated ? " · partial preview" : ""}`),
		...(entry ? [`Selected entry: ${entry.id}. [/] selects; Enter opens its serialized source.`, entry.text] : []),
	];
}

/** A component owns only one snapshot and one bounded inspection page/chunk at a time. */
export class AgentDashboard implements Component {
	readonly state: DashboardState;
	private readonly input = new Input({ prompt: "Filter: " });
	private filtering = false;
	private loading = false;
	private reading = false;
	private closed = false;
	private generation = 0;
	private pageSize = 1;
	private readerHeight = 1;
	private readerLength = 1;
	private help = false;
	private helpScroll = 0;
	private helpLength = 0;
	private readonly sources: AgentObservationSources;
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (request?: DashboardActionRequest) => void;
	private readonly actions: boolean;
	constructor(sources: AgentObservationSources, tui: Pick<TUI, "requestRender" | "terminal">, theme: Theme, keys: KeybindingsManager, done: (request?: DashboardActionRequest) => void, state?: DashboardState, actions = false) {
		this.sources = sources; this.tui = tui; this.theme = theme; this.keys = keys; this.done = done; this.actions = actions;
		this.state = state ?? { tab: "sessions", filter: "", selected: {} };
		this.input.setValue(this.state.filter);
		if (!this.state.snapshot) void this.refresh();
	}
	private view() { return dashboardRecords(this.state.snapshot?.[this.state.tab], this.state.filter); }
	private selected(): DashboardTarget | undefined {
		const records = this.view().records;
		const target = records.find((row) => idOf(row) === this.state.selected[this.state.tab]) ?? records[0];
		this.state.selected[this.state.tab] = target ? idOf(target) : undefined;
		return target;
	}
	async refresh(): Promise<void> {
		if (this.closed || this.loading) return;
		this.loading = true; this.tui.requestRender();
		const snapshot = await readAgentDashboard(this.sources);
		if (this.closed) return;
		this.state.snapshot = snapshot; this.selected(); this.loading = false; this.tui.requestRender();
	}
	private async inspect(sessionId: string, options: AgentInspectionOptions = {}, parent?: Reader): Promise<void> {
		const generation = ++this.generation;
		const target = this.state.reader?.target ?? this.selected();
		this.reading = true;
		this.state.reader = { title: "Session inspection", target, sessionId, lines: ["Read in progress…"], scroll: 0, parent };
		this.tui.requestRender();
		try {
			const inspection = await this.sources.inspect(sessionId, { limit: 12, ...options });
			if (this.closed || generation !== this.generation) return;
			this.state.reader = { title: "Session inspection", target, sessionId, inspection, entryIndex: 0, lines: inspectionLines(inspection), scroll: 0, parent };
		} catch (error) {
			if (this.closed || generation !== this.generation) return;
			this.state.reader = { title: "Inspection unavailable", target, sessionId, lines: [errorText(error)], scroll: 0, parent };
		}
		this.reading = false; this.tui.requestRender();
	}
	private back(): void {
		this.generation++; this.reading = false;
		this.state.reader = this.state.reader?.parent;
	}
	private open(): void {
		const target = this.selected(); const section = this.state.snapshot?.[this.state.tab];
		if (section?.error !== undefined) { this.state.reader = { title: "Source unavailable", lines: [section.error], scroll: 0 }; return; }
		if (!target) return;
		if (target.kind === "session") void this.inspect(target.session.sessionId);
		else this.state.reader = { title: "Detached run record", target, lines: metadata(target), scroll: 0 };
	}
	handleInput(data: string): void {
		if (this.closed) return;
		const cancel = this.keys.matches(data, "tui.select.cancel");
		if (this.filtering) { this.filterInput(data, cancel); return; }
		if (matchesKey(data, "q")) { this.dispose(); this.done(); return; }
		if (this.help) { this.helpInput(data, cancel); return; }
		if (cancel || matchesKey(data, "b")) {
			if (this.state.reader) this.back();
			else if (cancel) { this.dispose(); this.done(); return; }
		} else if (matchesKey(data, "?")) { this.help = true; this.helpScroll = 0; }
		else if (matchesKey(data, "a") && this.actions && !this.reading) { this.openActions(); return; }
		else if (this.state.reader) this.readerInput(data);
		else this.listInput(data);
		this.tui.requestRender();
	}
	private openActions(): void {
		const target = this.state.reader?.target ?? this.selected();
		this.dispose(); this.done({ target });
	}
	private filterInput(data: string, cancel: boolean): void {
		if (cancel || this.keys.matches(data, "tui.select.confirm")) this.filtering = false;
		else { this.input.handleInput(data); this.state.filter = this.input.getValue(); this.selected(); }
		this.tui.requestRender();
	}
	private helpInput(data: string, cancel: boolean): void {
		if (cancel || matchesKey(data, "?") || matchesKey(data, "b")) this.help = false;
		else this.helpScroll = Math.max(0, Math.min(Math.max(0, this.helpLength - this.pageSize), this.helpScroll + this.direction(data)));
		this.tui.requestRender();
	}
	private listInput(data: string): void {
		if (matchesKey(data, "/")) { this.filtering = true; this.input.setValue(this.state.filter); }
		else if (matchesKey(data, "r")) void this.refresh();
		else if (matchesKey(data, "tab")) { this.state.tab = this.state.tab === "sessions" ? "runs" : "sessions"; this.selected(); }
		else if (this.keys.matches(data, "tui.select.confirm")) this.open();
		else {
			const records = this.view().records; const target = this.selected();
			const index = target ? records.indexOf(target) : 0;
			const delta = this.direction(data);
			if (records.length && delta) this.state.selected[this.state.tab] = idOf(records[Math.max(0, Math.min(records.length - 1, index + delta))]);
		}
	}
	private direction(data: string): number {
		if (this.keys.matches(data, "tui.select.pageDown")) return this.pageSize;
		if (this.keys.matches(data, "tui.select.pageUp")) return -this.pageSize;
		if (matchesKey(data, "j") || this.keys.matches(data, "tui.select.down")) return 1;
		if (matchesKey(data, "k") || this.keys.matches(data, "tui.select.up")) return -1;
		return 0;
	}
	private readerInput(data: string): void {
		const reader = this.state.reader;
		if (!reader) return;
		const inspection = reader.inspection;
		if (matchesKey(data, "r")) this.refreshReader(reader);
		else if (matchesKey(data, "s") && !reader.sessionId) {
			const target = reader.target; if (target?.kind === "run") void this.inspect(sessionIdOf(target), {}, reader);
		} else if (inspection && !this.reading) this.inspectionInput(data, reader, inspection);
		else this.scrollReader(data, reader);
	}
	private refreshReader(reader: Reader): void {
		if (!reader.sessionId) { this.back(); void this.refresh(); return; }
		const parent = reader.inspection && "entryId" in reader.inspection ? reader.parent?.parent : reader.parent;
		void this.inspect(reader.sessionId, {}, parent);
	}
	private inspectionInput(data: string, reader: Reader, inspection: AgentInspection): void {
		if ("entries" in inspection) { this.pageInput(data, reader, inspection); return; }
		if (matchesKey(data, "n") && inspection.nextOffset !== null) void this.inspect(inspection.sessionId, { entryId: inspection.entryId, offset: inspection.nextOffset }, reader.parent);
		else this.scrollReader(data, reader);
	}
	private pageInput(data: string, reader: Reader, inspection: Extract<AgentInspection, { entries: unknown }>): void {
		if (matchesKey(data, "o") && inspection.nextCursor !== null) void this.inspect(inspection.sessionId, { cursor: inspection.nextCursor }, reader.parent);
		else if (matchesKey(data, "[") || matchesKey(data, "]")) {
			reader.entryIndex = Math.max(0, Math.min(inspection.entries.length - 1, (reader.entryIndex ?? 0) + (matchesKey(data, "]") ? 1 : -1)));
			reader.lines = inspectionLines(inspection, reader.entryIndex); reader.scroll = 0;
		} else if (this.keys.matches(data, "tui.select.confirm")) {
			const entry = inspection.entries[reader.entryIndex ?? 0];
			if (entry) void this.inspect(inspection.sessionId, { entryId: entry.id, offset: 0 }, reader);
		} else this.scrollReader(data, reader);
	}
	private scrollReader(data: string, reader: Reader): void {
		reader.scroll = Math.max(0, Math.min(Math.max(0, this.readerLength - this.readerHeight), reader.scroll + this.direction(data)));
	}
	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(1, this.tui.terminal.rows - 2);
		const controls = this.filtering ? "Enter apply · Esc back · type filter" : this.help ? "b back · q close" : this.state.reader ? "b back · q close · ? help" : "Enter open · q close · ? help";
		if (height === 1) return [truncateToWidth(controls, width)];
		const contentHeight = height - 1;
		const lines = this.help ? this.renderHelp(width, contentHeight) : this.state.reader ? this.renderReader(width, contentHeight, this.state.reader) : this.renderList(width, contentHeight);
		return [...lines.slice(0, contentHeight), this.theme.fg("muted", controls)].map((line) => truncateToWidth(line, width));
	}
	private renderHelp(width: number, contentHeight: number): string[] {
		let lines = ["Agent dashboard keys", "List: ↑/↓ or j/k select; PgUp/PgDn move; Tab changes section.", "/ filters name, directory or exact ID before the display limit.", "Enter opens evidence; a opens actions; r refreshes; q closes.", "Reader: ↑/↓ or j/k scroll; [/] selects an entry; Enter opens it.", "o reads older entries; n reads the next source chunk; r reads newest.", "s inspects the current session of a detached run record.", "b or configured cancel returns; configured confirm opens.", "Actions use native dialogs, then return here. Escape cancels dialogs.", "Stored owner state is unavailable. Run progress is recorded.", "Result previews and run summaries are not complete source entries."];
		lines = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		this.helpLength = lines.length; this.pageSize = contentHeight;
		this.helpScroll = Math.max(0, Math.min(Math.max(0, lines.length - contentHeight), this.helpScroll));
		return lines.slice(this.helpScroll, this.helpScroll + contentHeight);
	}
	private renderReader(width: number, contentHeight: number, reader: Reader): string[] {
		const body = reader.lines.flatMap((line) => wrapTextWithAnsi(clean(line), width));
		this.readerHeight = Math.max(1, contentHeight - (contentHeight > 3 ? 2 : 0)); this.pageSize = this.readerHeight; this.readerLength = body.length;
		reader.scroll = Math.max(0, Math.min(Math.max(0, body.length - this.readerHeight), reader.scroll));
		const entry = reader.inspection && "entries" in reader.inspection ? reader.inspection.entries[reader.entryIndex ?? 0]?.id : undefined;
		const title = entry ? `${reader.title} · Selected entry: ${entry}` : reader.title;
		return [...(contentHeight > 3 ? [title, `Lines ${reader.scroll + 1}-${Math.min(body.length, reader.scroll + this.readerHeight)}/${body.length}${this.reading ? " · Read in progress" : ""}`] : []), ...body.slice(reader.scroll, reader.scroll + this.readerHeight)];
	}
	private renderList(width: number, contentHeight: number): string[] {
		const view = this.view(); const target = this.selected(); const section = this.state.snapshot?.[this.state.tab];
		const chrome = [this.theme.fg("accent", `Agent dashboard · ${this.state.tab}${this.loading ? " · Read in progress" : ""}`), section?.error !== undefined ? "Source unavailable · Enter reads the error" : `${view.total} total · ${view.matching} matching · ${view.records.length} shown · ${view.omitted} omitted`, `Filter: ${displayPreview(this.state.filter || "(none)", 160)} · ${this.state.snapshot?.observedAt ?? "No snapshot"}`];
		const header = chrome.slice(0, Math.max(0, Math.min(3, contentHeight - 1)));
		if (this.filtering) { this.input.focused = true; header.splice(Math.max(0, header.length - 1), 1, ...this.input.render(width)); }
		this.pageSize = Math.max(1, contentHeight - header.length);
		const index = target ? view.records.indexOf(target) : 0; const start = Math.floor(index / this.pageSize) * this.pageSize;
		const roster = view.records.slice(start, start + this.pageSize).map((row) => `${row === target ? ">" : " "} ${rosterLabel(row)}`);
		if (!roster.length) roster.push(this.emptyLabel(section));
		if (width >= 90 && target) {
			const leftWidth = Math.floor(width * 0.48); const rightWidth = width - leftWidth - 3;
			const preview = metadata(target).flatMap((line) => wrapTextWithAnsi(clean(line), rightWidth));
			return [...header, ...Array.from({ length: this.pageSize }, (_, i) => { const left = truncateToWidth(roster[i] ?? "", leftWidth); return `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(left)))} │ ${preview[i] ?? ""}`; })];
		}
		return [...header, ...roster];
	}
	private emptyLabel(section?: DashboardSection): string {
		if (section?.error !== undefined) return "Enter reads the source error";
		return this.loading ? "Read in progress…" : "None found.";
	}
	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.closed = true; this.generation++; }
}

async function interactiveDashboard(sources: AgentObservationSources, ctx: ExtensionCommandContext, actions?: DashboardActions): Promise<void> {
	const state: DashboardState = { tab: "sessions", filter: "", selected: {} };
	for (;;) {
		const request = await ctx.ui.custom<DashboardActionRequest | undefined>((tui, theme, keys, done) => new AgentDashboard(sources, tui, theme, keys, done, state, Boolean(actions)), {
			overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
		});
		if (!request || !actions) return;
		// Close the native overlay before opening dialogs; never leave a hidden focused component.
		const parent = state.reader?.action ? state.reader.parent : state.reader;
		try {
			const result = await actions.run(request.target);
			if (result !== undefined) state.reader = { title: "Action result", target: request.target, lines: [result], scroll: 0, parent, action: true };
		} catch (error) { state.reader = { title: "Action refused", target: request.target, lines: [errorText(error)], scroll: 0, parent, action: true }; }
	}
}

export async function showAgentDashboard(sources: AgentObservationSources, ctx: ExtensionCommandContext, actions?: DashboardActions): Promise<void> {
	if (ctx.mode === "tui") return interactiveDashboard(sources, ctx, actions);
	const text = dashboardText(await readAgentDashboard(sources));
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else process.stderr.write(`${text}\n`);
}
