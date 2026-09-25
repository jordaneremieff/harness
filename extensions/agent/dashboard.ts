import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentSessionSummary } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import { displayPreview } from "./presentation.ts";
import type { projectInspection } from "./worker.ts";

export type AgentInspection = ReturnType<typeof projectInspection>;
export type AgentInspectionOptions = Parameters<typeof projectInspection>[2];
export interface AgentSessionDescription {
	name?: string;
	model?: { provider: string; modelId: string; thinkingLevel: string };
	provenance: "live" | "stored";
	parentSessionIds: string[];
}
export interface AgentObservationSources {
	describe?(sessionId: string): Promise<AgentSessionDescription>;
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
	return `${stateOf(target)}${row.hostState ? "; stored metadata" : !row.live && !row.detachedRunId ? "; owner state unavailable" : ""} · ${titleOf(target)}`;
}
function titleOf(target: DashboardTarget): string {
	return target.kind === "run" ? target.run.prompt : target.session.name || target.session.firstMessage || target.session.cwd;
}
function stateOf(target: DashboardTarget): string {
	return target.kind === "run" ? target.run.state : target.session.hostState ? `Host ${target.session.hostState}` : target.session.operation ? "Active" : target.session.detachedRunId ? "Detached" : target.session.live ? "Open here" : "Stored";
}
function configuration(data?: Partial<Pick<AgentSessionDescription, "model" | "provenance">>): string {
	return data?.model ? `${data.model.provider}/${data.model.modelId} · ${data.model.thinkingLevel} · ${data.provenance ?? "live"}` : "Model unavailable";
}
function descriptionLines(data: AgentSessionDescription): string[] {
	return [configuration(data), data.parentSessionIds.length ? `Known parents: ${data.parentSessionIds.join(", ")}` : "No parent association in the available records"];
}

function sessionMetadata(target: Extract<DashboardTarget, { kind: "session" }>): string[] {
	const row = target.session;
	return [label(target), `Session: ${row.sessionId}`, `Directory: ${row.cwd}`, `Modified: ${new Date(row.modifiedAt).toISOString()}`, ...(row.operation ? [`Operation: ${row.operation}`] : []), ...(row.detachedRunId ? [`Run: ${row.detachedRunId}`] : []), ...(row.model ? [`Model: ${configuration(row)}`] : []), ...(row.parentSessionIds?.length ? [`Known parents: ${row.parentSessionIds.join(", ")}`] : [])];
}
function metadata(target: DashboardTarget): string[] {
	if (target.kind === "session") return sessionMetadata(target);
	const row = target.run;
	return [label(target), `Run: ${row.runId}`, `Session: ${sessionIdOf(target)}`, `Directory: ${row.cwd}`, `Started: ${row.startedAt}`, ...(row.finishedAt ? [`Finished: ${row.finishedAt}`] : []),
		"Recorded run data, not a live owner query. Result and progress text are retained summaries, not complete session results.",
		...(row.error ? [`Error: ${row.error}`] : []), ...(row.summary ? [`Result summary: ${row.summary}`] : []),
		...(row.progress ? [`Progress recorded: ${row.progress.updatedAt}`, `Entries recorded: ${row.progress.entryCount}`, ...(row.progress.currentTool ? [`Tool: ${row.progress.currentTool}`] : []), ...(row.progress.lastText ? [`Text: ${row.progress.lastText}`] : []), ...(row.progress.error ? [`Progress error: ${row.progress.error}`] : [])] : ["No progress record"]),
	];
}

function runPreview(target: Extract<DashboardTarget, { kind: "run" }>): string[] {
	const run = target.run;
	return [titleOf(target), `Recorded ${run.state} · not a live query`, "Run summaries are not complete session results.", "", ...(run.error ? [`Error: ${run.error}`] : []), ...(run.progress?.lastText ? ["Latest recorded progress", run.progress.lastText, `Progress recorded: ${run.progress.updatedAt}`, ""] : ["No progress text recorded"]), ...(run.summary ? ["Result summary", run.summary, ""] : []), `Run: ${run.runId}`, `Session: ${sessionIdOf(target)}`, `Directory: ${run.cwd}`, `Started: ${run.startedAt}`, ...(run.finishedAt ? [`Finished: ${run.finishedAt}`] : []), ...(run.progress ? [`Entries recorded: ${run.progress.entryCount}`, ...(run.progress.currentTool ? [`Tool: ${run.progress.currentTool}`] : []), ...(run.progress.error ? [`Progress error: ${run.progress.error}`] : [])] : [])];
}
function readerState(reader: Reader): string {
	const data = reader.inspection;
	if (!data) return reader.title;
	if (!data.liveOwner) return "Live owner state unavailable";
	return data.execution.current ? "Active operation" : "Owner reports no current operation";
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
	const matches = section?.records.filter((target) => `${idOf(target)} ${sessionIdOf(target)} ${target.kind === "session" ? `${target.session.name ?? ""} ${target.session.firstMessage ?? ""} ${target.session.cwd}` : `${target.run.prompt} ${target.run.cwd}`}`.toLocaleLowerCase().includes(query)) ?? [];
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

function omissionLines(omissions: Extract<AgentInspection, { entryId: string }>["omissions"]): string[] {
	return omissions ? [`Omitted from this entry: ${omissions.providerSignatures} provider signatures; ${omissions.imagePayloads} image payloads; ${omissions.redactedThinking} redacted thinking blocks.`] : [];
}

function inspectionLines(data: AgentInspection, entryIndex = 0): string[] {
	const lines = ownerLines(data);
	if ("entryId" in data) return [...lines, `Entry: ${data.entryId} · offset ${data.offset}`, "Inspection source, not raw storage. Offsets count UTF-16 code units.", ...omissionLines(data.omissions), data.truncated ? `Partial entry; next offset ${data.nextOffset}. n reads the next chunk.` : "Final entry chunk (earlier chunks are not repeated).", data.text];
	const entry = data.entries[entryIndex];
	return [
		...(entry ? [`${entry.role ?? entry.type} · entry ${entryIndex + 1}/${data.entries.length}${entry.truncated ? " · partial preview" : ""}`, entry.preview?.text ?? "Readable preview unavailable. Enter opens the inspection source.", ...omissionLines(entry.omissions), ...(entry.preview?.truncated ? ["Partial text. Enter opens the inspection source; n continues it."] : [])] : ["No entries in this snapshot."]),
		"", `Entries: ${data.entries.length}, newest first. ${data.nextCursor === null ? "No older page." : `Older cursor: ${data.nextCursor}. o reads it.`}`,
		...data.entries.map((item, index) => `${index === entryIndex ? ">" : " "} ${item.role ?? item.type} · ${item.id}${item.truncated ? " · partial preview" : ""}`),
		"", ...lines,
		...(data.result ? ["", `Retained result source${data.result.truncated ? " (partial preview; open its source entry)" : ""}:`, data.result.text] : []),
	];
}

/** A component owns only one snapshot and one bounded inspection page/chunk at a time. */
export class AgentDashboard implements Component {
	readonly state: DashboardState;
	private readonly input = new Input({ prompt: "/ " });
	private hostFocused = false;
	private description?: { sessionId: string; data?: AgentSessionDescription; error?: string };
	private descriptionGeneration = 0;
	get focused(): boolean { return this.hostFocused; }
	set focused(value: boolean) { this.hostFocused = value; this.input.focused = value && this.filtering; }
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
		else this.updateDescription();
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
		this.state.snapshot = snapshot; this.selected(); this.loading = false; this.updateDescription(true); this.tui.requestRender();
	}
	private updateDescription(force = false, target = this.selected()): void {
		if (!target || !this.sources.describe) return;
		const sessionId = sessionIdOf(target);
		if (!force && this.description?.sessionId === sessionId) return;
		const generation = ++this.descriptionGeneration;
		this.description = { sessionId };
		void this.sources.describe(sessionId).then((data) => {
			if (this.closed || generation !== this.descriptionGeneration) return;
			this.description = { sessionId, data }; this.tui.requestRender();
		}, (error) => {
			if (this.closed || generation !== this.descriptionGeneration) return;
			this.description = { sessionId, error: errorText(error) }; this.tui.requestRender();
		});
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
		else this.state.reader = { title: "Detached run record", target, lines: runPreview(target), scroll: 0 };
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
		this.updateListDescription();
		this.tui.requestRender();
	}
	private updateListDescription(): void {
		if (!this.state.reader) this.updateDescription();
	}
	private openActions(): void {
		const target = this.state.reader?.target ?? this.selected();
		this.dispose(); this.done({ target });
	}
	private filterInput(data: string, cancel: boolean): void {
		if (cancel || this.keys.matches(data, "tui.select.confirm")) {
			this.filtering = false; this.input.focused = false;
			if (cancel) { this.state.filter = ""; this.input.setValue(""); }
		} else { this.input.handleInput(data); this.state.filter = this.input.getValue(); }
		this.selected(); this.updateDescription(); this.tui.requestRender();
	}
	private helpInput(data: string, cancel: boolean): void {
		if (cancel || matchesKey(data, "?") || matchesKey(data, "b")) this.help = false;
		else this.helpScroll = Math.max(0, Math.min(Math.max(0, this.helpLength - this.pageSize), this.helpScroll + this.direction(data)));
		this.tui.requestRender();
	}
	private listInput(data: string): void {
		if (matchesKey(data, "/")) { this.filtering = true; this.input.focused = this.hostFocused; this.input.setValue(this.state.filter); }
		else if (matchesKey(data, "r")) void this.refresh();
		else if (matchesKey(data, "tab")) { this.state.tab = this.state.tab === "sessions" ? "runs" : "sessions"; this.selected(); }
		else if (this.keys.matches(data, "tui.select.confirm")) this.open();
		else this.moveSelection(data);
	}
	private moveSelection(data: string): void {
		const records = this.view().records; const target = this.selected();
		const index = target ? records.indexOf(target) : 0;
		const delta = this.direction(data);
		const next = matchesKey(data, "home") ? 0 : matchesKey(data, "end") ? records.length - 1 : Math.max(0, Math.min(records.length - 1, index + delta));
		if (records.length && (delta || next !== index)) this.state.selected[this.state.tab] = idOf(records[next]);
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
		this.updateDescription(true, reader.target);
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
	private controls(width: number): string[] {
		if (this.filtering) return ["Type to filter · Enter keep · Esc clear"];
		if (this.help) return ["↑↓ scroll · PgUp/PgDn page", "b back · q close"];
		if (this.state.reader) return this.readerControls(this.state.reader);
		const action = this.actionHint(this.selected());
		return width >= 90 ? ["↑↓ select · Enter open · / filter · Tab runs/sessions · r refresh", `q close · ? help${action} · Home/End jump`]
			: ["Enter open · / filter · Tab section", `q close · ? help${action} · r refresh`];
	}
	private actionHint(target?: DashboardTarget): string {
		if (!this.actions || this.reading) return "";
		return target ? " · a actions" : " · a all actions";
	}
	private readerControls(reader: Reader): string[] {
		const data = reader.inspection;
		let navigation = "↑↓ scroll";
		if (data && "entries" in data) navigation = `${data.entries.length ? "[/] entry · Enter source" : "No entries"}${data.nextCursor !== null ? " · o older" : ""}`;
		else if (data && "entryId" in data) navigation = `${data.nextOffset !== null ? "n next chunk · " : ""}r newest`;
		else if (reader.target?.kind === "run") navigation = "s session · r refresh";
		return [navigation, `b back · q close · ? help${this.actionHint(reader.target)}`];
	}
	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(1, this.tui.terminal.rows - 2);
		const framed = width >= 12 && height >= 8;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const controls = this.controls(inner);
		if (height < 4) return [truncateToWidth(this.state.reader ? "b back · q close · ? help" : "q close · ? help", width)];
		const footer = height >= 8 ? controls : controls.slice(-1);
		const contentHeight = height - footer.length - (framed ? 3 : 0);
		const content = this.help ? this.renderHelp(inner, contentHeight) : this.state.reader ? this.renderReader(inner, contentHeight, this.state.reader) : this.renderList(inner, contentHeight);
		const pad = (line: string) => { const clipped = truncateToWidth(line, inner); return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))); };
		const body = Array.from({ length: contentHeight }, (_, i) => content[i] ?? "");
		if (!framed) return [...body, ...footer].map((line) => truncateToWidth(line, width));
		const heading = this.help ? " Agent help " : this.state.reader ? " Agents / Detail " : " Agents ";
		const border = (left: string, text: string, right: string) => this.theme.fg("border", left + truncateToWidth(text, width - 2) + "─".repeat(Math.max(0, width - 2 - visibleWidth(text))) + right);
		return [border("┌", heading, "┐"), ...body.map((line) => `│ ${pad(line)} │`), border("├", "", "┤"), ...footer.map((line) => `│ ${pad(this.theme.fg("muted", line))} │`), border("└", "", "┘")];
	}
	private renderHelp(width: number, contentHeight: number): string[] {
		let lines = ["Find a session", "↑/↓ or j/k selects. PgUp/PgDn pages. Home/End jumps. Tab switches sessions and detached runs.", "/ filters the complete inventory by name, first message, directory or ID. Enter keeps the filter. Escape clears it.", "", "Read the work", "Enter opens the selected session. [/] selects a message. ↑/↓ scrolls. Enter opens exact serialized source; n continues a source chunk. o reads older entries. r reads newest.", "s opens the session from a detached run. b or configured cancel returns one level. q closes the dashboard.", "", "Act without losing context", "a opens native action dialogs for the exact selected target. Escape cancels a dialog. The dashboard returns to the same selection and filter.", "", "Evidence boundaries", "Live describes an owner snapshot, not continuous monitoring. Stored configuration comes from retained entries; its owner state is unknown. Known parents come only from recorded associations.", "Run progress and result summaries are recorded, not a live owner query. Readable entry previews are bounded. Exact source remains available. r refreshes explicitly."];
		lines = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		this.helpLength = lines.length; this.pageSize = contentHeight;
		this.helpScroll = Math.max(0, Math.min(Math.max(0, lines.length - contentHeight), this.helpScroll));
		return lines.slice(this.helpScroll, this.helpScroll + contentHeight);
	}
	private renderReader(width: number, contentHeight: number, reader: Reader): string[] {
		const selectedDescription = reader.sessionId && reader.sessionId === this.description?.sessionId ? this.description : undefined;
		const description = selectedDescription?.data;
		const heading = reader.target ? displayPreview(titleOf(reader.target), 300) : reader.title;
		const info = this.readerDescription(selectedDescription);
		const body = [...info, ...reader.lines].flatMap((line) => wrapTextWithAnsi(clean(line), width));
		const headerSize = contentHeight > 5 ? 3 : contentHeight > 3 ? 2 : 0;
		this.readerHeight = Math.max(1, contentHeight - headerSize); this.pageSize = this.readerHeight; this.readerLength = body.length;
		reader.scroll = Math.max(0, Math.min(Math.max(0, body.length - this.readerHeight), reader.scroll));
		const selected = reader.inspection && "entries" in reader.inspection ? reader.inspection.entries[reader.entryIndex ?? 0] : undefined;
		const position = `Lines ${reader.scroll + 1}-${Math.min(body.length, reader.scroll + this.readerHeight)}/${body.length}`;
		const state = readerState(reader);
		const header = [this.theme.fg("accent", heading), this.theme.fg("muted", clean(`${state === heading ? "" : state}${description ? ` · ${configuration(description)}` : ""}`)), this.theme.fg("muted", `${selected ? `Selected entry: ${selected.id} · ` : ""}${position}${this.reading ? " · Read in progress" : ""}`)];
		return [...header.slice(0, headerSize), ...body.slice(reader.scroll, reader.scroll + this.readerHeight)];
	}
	private readerDescription(selected?: { data?: AgentSessionDescription; error?: string }): string[] {
		if (selected?.error) return [`Configuration unavailable: ${selected.error}`, ""];
		if (selected?.data) return [descriptionLines(selected.data)[1], ""];
		return selected ? ["Configuration read in progress…", ""] : [];
	}
	private previewLines(target: DashboardTarget): string[] {
		if (target.kind === "run") return runPreview(target);
		const session = target.session;
		const current = this.description?.sessionId === session.sessionId ? this.description : undefined;
		return [titleOf(target), label(target).split(" · ")[0], "", ...(current?.data ? descriptionLines(current.data) : [configuration(session), current?.error ? `Configuration unavailable: ${current.error}` : current ? "Read in progress…" : "Enter reads session details"]), "", ...(session.firstMessage ? ["First message", session.firstMessage, ""] : []), `Directory: ${session.cwd}`, `Session: ${session.sessionId}`, ...(session.operation ? [`Operation: ${session.operation}`] : []), ...(session.detachedRunId ? [`Run: ${session.detachedRunId}`] : []), `Modified: ${new Date(session.modifiedAt).toISOString()}`, "", "Enter reads messages · a opens actions"];
	}
	private renderList(width: number, contentHeight: number): string[] {
		const view = this.view(); const target = this.selected(); const section = this.state.snapshot?.[this.state.tab];
		const index = target ? view.records.indexOf(target) : 0;
		const count = `${view.total} total · ${view.matching} matching · ${view.records.length} shown · ${view.omitted} omitted`;
		const chrome = [this.theme.fg("accent", `${this.state.tab === "sessions" ? "SESSIONS" : "DETACHED RUNS"} · ${target ? index + 1 : 0}/${view.records.length}${this.loading ? " · Read in progress" : ""}`), section?.error !== undefined ? "Source unavailable · Enter reads the error" : count];
		if (this.filtering) chrome.push(...this.input.render(width));
		else if (this.state.filter) chrome.push(`Filter: ${displayPreview(this.state.filter, 160)} · / edits or clears`);
		const header = chrome.slice(0, Math.max(0, Math.min(chrome.length, contentHeight - 1)));
		const remaining = Math.max(1, contentHeight - header.length);
		const split = width >= 96;
		const detailHeight = !split && target && remaining >= 7 ? Math.min(4, Math.floor(remaining / 3)) : 0;
		const listHeight = remaining - detailHeight;
		this.pageSize = Math.max(1, Math.floor(listHeight / 2));
		const start = Math.floor(index / this.pageSize) * this.pageSize;
		const leftWidth = split ? Math.floor(width * 0.43) : width;
		const roster = view.records.slice(start, start + this.pageSize).flatMap((row) => this.rosterLines(row, row === target, leftWidth));
		if (!roster.length) roster.push(this.emptyLabel(section));
		if (split && target) {
			const rightWidth = width - leftWidth - 3;
			const preview = this.previewLines(target).flatMap((line) => wrapTextWithAnsi(clean(line), rightWidth));
			return [...header, ...Array.from({ length: remaining }, (_, i) => { const left = roster[i] ?? ""; return `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(left)))} │ ${preview[i] ?? ""}`; })];
		}
		const detail = target && detailHeight ? this.compactDetail(target, width).slice(0, detailHeight) : [];
		return [...header, ...Array.from({ length: listHeight }, (_, i) => roster[i] ?? ""), ...detail];
	}
	private rosterLines(row: DashboardTarget, selected: boolean, width: number): string[] {
		const session = row.kind === "session" ? row.session : undefined;
		const description = selected && this.description?.sessionId === sessionIdOf(row) ? this.description : undefined;
		const model = description?.data?.model ?? session?.model;
		const config = model ? `${model.modelId} · ${model.thinkingLevel}` : row.kind === "run" ? "recorded" : description?.data || description?.error ? "model unavailable" : "select for model";
		const title = truncateToWidth(`${selected ? "›" : " "} ${displayPreview(titleOf(row), 300)}`, width);
		const line = title + " ".repeat(Math.max(0, width - visibleWidth(title)));
		return [selected ? this.theme.bg("selectedBg", this.theme.fg("accent", line)) : title, this.theme.fg("muted", truncateToWidth(clean(`  ${stateOf(row)} · ${config}`), width))];
	}
	private compactDetail(target: DashboardTarget, width: number): string[] {
		const current = this.description?.sessionId === sessionIdOf(target) ? this.description.data : undefined;
		return ["─".repeat(width), clean(target.kind === "session" ? configuration(current ?? target.session) : `Recorded ${target.run.state} · not a live query`), clean(label(target))];
	}
	private emptyLabel(section?: DashboardSection): string {
		if (section?.error !== undefined) return "Enter reads the source error";
		return this.loading ? "Read in progress…" : "None found.";
	}
	invalidate(): void { this.input.invalidate(); }
	dispose(): void { this.closed = true; this.generation++; this.descriptionGeneration++; this.input.focused = false; }
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
