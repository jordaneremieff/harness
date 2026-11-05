import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth, wrapTextWithAnsi, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { RelatedEffort } from "./effort-presence.ts";
import type { DashboardResult } from "./dashboard.ts";
import { AgentComposer } from "./agent-composer.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { ActionInventory, type ScreenAction } from "./action-inventory.ts";
import { dashboardHeading, dashboardSelection, fitLine, readingGeometry } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";
import { memberDeclarationLines, threadPage, type Collaborate } from "./thread-data.ts";
import type { CollaborationPage } from "./collaboration.ts";

const plain = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
/** Clip with one ellipsis character; the generic line fit must never add its own three dots. */
const clip = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…");
/** A session identity short enough to read: long identities keep their first eight characters. */
const shortIdentity = (id: string) => (id.length > 12 ? id.slice(0, 8) : id);
interface EffortViewOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	efforts(): Promise<EffortAwareness>;
	messageEffort?(id: string, text: string): Promise<DashboardResult>;
	observeEffort?(id: string): Promise<string>;
	collaborate?: Collaborate;
	openContact(threadId: string): string | undefined;
	openThreads(): string | undefined;
	onBack(): void;
	redraw(): void;
}
/** Presence and thread hints follow pane entry and roster notices, never an age timer. */
export class EffortView {
	private readonly mouse = new DashboardMouse();
	private readonly inventory = new ActionInventory(() => this.actions(), (reason) => { this.notice = reason; });
	/** First visible row of each list. Wheel scrolling moves these; selection and the message recipient stay put. */
	private listStart: { efforts?: number; threads?: number } = {};
	/** Whether the current layout shows the Active threads section; hidden threads are not navigable. */
	private threadsShown = true;
	private readonly composer: AgentComposer;
	private view?: EffortAwareness;
	private selected?: string;
	private selectedThread?: string;
	private composing = false;
	private target?: string;
	private readonly drafts = new Map<string, { text: string; revision: number }>();
	private pending = false;
	private again = false;
	private sending = false;
	private disposed = false;
	private active = false;
	private generation = 0;
	private contactRead = 0;
	private contactPending = false;
	private contactAgain = false;
	private contactPage?: CollaborationPage;
	private contactNotice = "";
	private observation?: string;
	private observing = false;
	private notice = "";
	private offset = 0;
	private observedAt = Date.now();
	private exactTime = false;
	private scanOpen = false;
	/** The complete detail view; false shows the short key and value groups. */
	private detailsOpen = false;
	/** A read failure for the effort list, shown in the list footer. */
	private loadError = "";
	/** Derived detail lines, keyed by width, disclosure state, content revision and the minute. */
	private detailVersion = 0;
	private detailCache?: { key: string; lines: string[] };
	/** One cached row block per effort or thread, keyed by content, width and selection. */
	private readonly rowCache = new Map<string, { key: string; lines: string[] }>();
	private readonly options: EffortViewOptions;
	constructor(options: EffortViewOptions) {
		this.options = options;
		this.composer = new AgentComposer({
			...options,
			onSubmit: (text) => { void this.send(text); },
			onChange: (text) => {
				if (this.target) this.drafts.set(this.target, { text, revision: (this.drafts.get(this.target)?.revision ?? 0) + 1 });
			},
			onEscape: () => this.back(),
		});
	}
	open(): void { this.active = true; this.clearSelectionReads(); void this.refresh(); }
	private clearSelectionReads(): void {
		this.generation++;
		this.contactRead++;
		this.contactAgain = false;
		this.contactPage = undefined;
		this.contactNotice = "";
		this.observation = undefined;
		this.observing = false;
	}
	private select(id: string, thread = false): void {
		if (id === (this.selectedThread ?? this.selected) && thread === Boolean(this.selectedThread)) return;
		this.selectedThread = thread ? id : undefined;
		if (!thread) this.selected = id;
		this.listStart = {};
		this.offset = 0;
		this.detailVersion++;
		this.clearSelectionReads();
		void this.readContact();
	}
	private contactId(): string | undefined {
		const row = this.row();
		return row?.relationship === "machine" ? row.contactThreadClaim : row?.intentClaim?.contactThread;
	}
	private async readContact(): Promise<void> {
		if (!this.active || this.disposed || this.selectedThread || this.composing) return;
		const threadId = this.contactId();
		const generation = this.generation;
		const read = ++this.contactRead;
		this.contactPage = undefined;
		this.contactNotice = !threadId ? "No contact thread claim" : !this.options.collaborate ? "Contact declarations unavailable: no thread reader" : "Read contact declarations…";
		if (!threadId || !this.options.collaborate) return;
		if (this.contactPending) { this.contactAgain = true; return; }
		this.contactPending = true;
		const current = () => this.active && !this.disposed && generation === this.generation && read === this.contactRead && threadId === this.contactId();
		try {
			const result = await this.options.collaborate({ action: "read", threadId, limit: 1 });
			if (!current()) return;
			if (!threadPage(result) || result.thread.id !== threadId) throw new Error("invalid contact thread page");
			this.contactPage = result;
			this.contactNotice = "";
			this.detailVersion++;
		} catch (error) {
			if (current()) this.contactNotice = `Contact declarations unavailable: ${plain(String(error).slice(0, 512))}`;
			this.detailVersion++;
		} finally {
			this.contactPending = false;
			this.contactFinished(current());
		}
	}
	private contactFinished(current: boolean): void {
		if (current) this.options.redraw();
		if (!this.active || this.disposed || !this.contactAgain) return;
		this.contactAgain = false;
		void this.readContact();
	}
	private async observe(): Promise<void> {
		const id = this.selected;
		if (!id || this.selectedThread || this.observing || !this.active || this.disposed) return;
		this.scanOpen = false;
		this.offset = 0;
		if (!this.options.observeEffort) {
			this.observation = "Read-only observation unavailable: no reader";
			return;
		}
		const generation = this.generation;
		const current = () => this.active && !this.disposed && generation === this.generation && id === this.selected && !this.selectedThread;
		this.observing = true;
		this.observation = "Read-only observation…";
		this.detailVersion++;
		this.options.redraw();
		try {
			const result = await this.options.observeEffort(id);
			if (!current()) return;
			let excerpt = result.slice(0, 16000);
			if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
			this.observation = cleanDashboardText(excerpt) + (result.length > excerpt.length ? "\nObservation omitted by display bound; use agent_inspect for a bounded next read." : "");
			if (!this.observation.trim()) this.observation = "No observation text returned; coverage unknown";
			this.detailVersion++;
		} catch (error) {
			if (current()) this.observation = `Read-only observation unavailable: ${plain(String(error).slice(0, 512))}`;
			this.detailVersion++;
		} finally {
			if (current()) { this.observing = false; this.options.redraw(); }
		}
	}
	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.pending) { this.again = true; return; }
		this.pending = true;
		try {
			const view = await this.options.efforts();
			if (this.disposed) return;
			this.view = view;
			this.loadError = "";
			this.detailVersion++;
			this.observedAt = Date.now();
			if (!view.presence.efforts.some((row) => row.id === this.selected)) {
				this.selected = view.presence.efforts[0]?.id;
				this.clearSelectionReads();
			}
			if (this.selectedThread && !view.threads.items.some((row) => row.id === this.selectedThread)) this.selectedThread = undefined;
			this.mouse.reset();
			void this.readContact();
		} catch (error) {
			if (!this.disposed) this.loadError = `Related efforts unavailable: ${String(error)}`;
		} finally {
			this.pending = false;
			if (!this.disposed) {
				this.options.redraw();
				if (this.again) { this.again = false; void this.refresh(); }
			}
		}
	}
	private row(): RelatedEffort | undefined { return this.view?.presence.efforts.find((row) => row.id === (this.composing ? this.target : this.selected)); }
	private threads() { return (this.view?.threads.items ?? []).filter((row) => !row.closed).toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)); }
	private toggleScan(): void { this.scanOpen = !this.scanOpen; this.detailsOpen = false; this.offset = 0; this.detailVersion++; }
	private toggleDetails(): void { this.detailsOpen = !this.detailsOpen; this.scanOpen = false; this.offset = 0; this.detailVersion++; }
	private back(): void {
		if (this.scanOpen) this.toggleScan();
		else if (this.composing) { this.composing = false; this.composer.focused = false; }
		else { this.active = false; this.clearSelectionReads(); this.options.onBack(); }
	}
	private message(): void {
		const row = this.row();
		if (this.selectedThread || row?.liveness !== "live" || !this.options.messageEffort) {
			this.notice = "Direct messages need a live compatible effort";
			return;
		}
		this.target = row.id;
		this.scanOpen = false;
		this.composing = true;
		this.composer.setText(this.drafts.get(row.id)?.text ?? "");
	}
	private contact(): void {
		const row = this.row();
		const contact = this.selectedThread ?? (row?.relationship === "machine" ? row.contactThreadClaim : row?.intentClaim?.contactThread);
		if (contact) {
			const notice = this.options.openContact(contact);
			this.notice = notice ?? "";
			if (!notice) { this.active = false; this.clearSelectionReads(); }
		}
		else this.notice = "No contact thread claim";
	}
	private async send(text: string): Promise<void> {
		const id = this.target;
		if (!id || this.sending || !text.trim()) return;
		if (this.view?.presence.efforts.find((row) => row.id === id)?.liveness !== "live" || !this.options.messageEffort) {
			this.notice = "Delivery not attempted: effort is not live";
			return;
		}
		const revision = this.drafts.get(id)?.revision;
		this.sending = true;
		this.notice = "Sending operator message…";
		this.options.redraw();
		try {
			const result = await this.options.messageEffort(id, text);
			if (this.disposed) return;
			this.notice = plain(result.text);
			if (this.drafts.get(id)?.text === text && this.drafts.get(id)?.revision === revision) {
				this.drafts.delete(id);
				if (this.target === id) this.composer.setText("");
			}
		} catch (error) {
			if (!this.disposed) this.notice = `Delivery not confirmed. Draft retained: ${String(error)}`;
		} finally {
			this.sending = false;
			if (!this.disposed) this.options.redraw();
		}
	}
	private move(delta: number): void {
		const choices = [...(this.view?.presence.efforts ?? []).map((row) => ({ id: row.id, thread: false })), ...(this.threadsShown ? this.threads().map((row) => ({ id: row.id, thread: true })) : [])];
		const index = choices.findIndex((row) => row.id === (this.selectedThread ?? this.selected) && row.thread === Boolean(this.selectedThread));
		const next = choices[Math.max(0, Math.min(choices.length - 1, index + delta))];
		if (!next) return;
		this.select(next.id, next.thread);
	}
	private openThreads(): void {
		const notice = this.options.openThreads();
		this.notice = notice ?? "";
		if (!notice) { this.active = false; this.clearSelectionReads(); }
	}
	/** Every action of this view. Footer, menu, shortcuts and pointer all dispatch these records. */
	private actions(): ScreenAction[] {
		if (this.composing) return [
			{ id: "send", label: "Send", keys: ["enter"], main: true, run: () => this.composer.handleInput("\r") },
			{ id: "newline", label: "Newline", keys: ["ctrl+j"], main: true, run: () => this.composer.handleInput("\n") },
		];
		const row = this.row();
		const messageBlocked = this.selectedThread || row?.liveness !== "live" || !this.options.messageEffort ? "Direct messages need a live compatible effort" : undefined;
		const observeBlocked = this.selectedThread ? "Select an effort, not a thread" : !this.selected ? "No effort is selected" : undefined;
		const contactBlocked = this.selectedThread || this.contactId() ? undefined : "No contact thread claim";
		return [
			{ id: "contact", label: "Open thread", keys: ["enter"], main: true, disabled: contactBlocked, run: () => this.contact() },
			{ id: "message", label: "Message", keys: ["m", "tab"], main: true, disabled: messageBlocked, run: () => this.message() },
			{ id: "observe", label: "Observe", keys: ["o"], main: true, disabled: observeBlocked, run: () => { void this.observe(); } },
			{ id: "details", label: this.detailsOpen ? "Summary" : "Details", keys: ["d"], main: true, run: () => this.toggleDetails() },
			{ id: "threads", label: "Threads", keys: ["t"], main: true, run: () => this.openThreads() },
			{ id: "scan", label: this.scanOpen ? "Hide scan" : "Scan details", keys: ["c"], run: () => this.toggleScan() },
			{ id: "time", label: this.exactTime ? "Relative times" : "Exact times", keys: ["i"], run: () => { this.exactTime = !this.exactTime; } },
			{ id: "previous", label: "Previous", keys: ["up"], run: () => this.move(-1) },
			{ id: "next", label: "Next", keys: ["down"], run: () => this.move(1) },
			{ id: "read-up", label: "Read up", keys: ["pageUp"], run: () => { this.offset = Math.max(0, this.offset - 5); } },
			{ id: "read-down", label: "Read down", keys: ["pageDown"], run: () => { this.offset += 5; } },
		];
	}
	/** The four primary controls of the selected-effort header, in order. */
	private primaryActions(): ScreenAction[] {
		const ids = ["contact", "message", "observe", "details"];
		const actions = this.actions();
		return ids.flatMap((id) => actions.find((action) => action.id === id) ?? []);
	}
	handleInput(data: string): void {
		if (this.inventory.open) this.inventory.handleInput(data);
		else if (matchesKey(data, "escape")) this.back();
		else if (!this.inventory.handleInput(data, this.composing) && this.composing) this.composer.handleInput(data);
		this.options.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.inventory.open ? this.inventory.handleMouse(event) : this.mouse.handle(event); }
	private time(value: string | number): string {
		const at = new Date(value).getTime();
		return Number.isFinite(at) ? dashboardTime(at, this.exactTime, this.observedAt) : "unknown (invalid time)";
	}
	/** The first sentence of a purpose, for titles and headers. */
	private firstSentence(text: string): string {
		const flat = plain(text);
		const end = flat.search(/[.!?]\s/u);
		return end > 0 ? flat.slice(0, end + 1) : flat;
	}
	private declaredPurpose(row: RelatedEffort): string | undefined {
		return row.relationship === "machine" ? row.purposeClaim : row.intentClaim?.purpose ?? row.purposeClaim;
	}
	/** A recognisable title: the purpose's first sentence, then a short identity. */
	private effortTitle(row: RelatedEffort): string {
		const text = this.declaredPurpose(row) ?? row.observedPurpose?.text;
		const title = text ? this.firstSentence(text).replace(/[.!?]$/u, "") : "";
		return title || `Session ${shortIdentity(row.id)}`;
	}
	private relationOf(row: RelatedEffort): string {
		return { cwd: "same folder", repository: "same repository", machine: "this machine" }[row.relationship as string] ?? row.relationship;
	}
	private lastUpdate(row: RelatedEffort): string | number {
		return (row.relationship !== "machine" ? row.intentClaim?.updatedAt : undefined) ?? row.intentUpdatedAt ?? row.lastActivityAt ?? row.startedAt;
	}
	/** Line 2 of an effort row and of the detail header. */
	private effortFacts(row: RelatedEffort): string {
		return `${row.liveness} · ${this.time(this.lastUpdate(row))}`;
	}
	private threadDetails(): string[] {
		const thread = this.threads().find((row) => row.id === this.selectedThread);
		return thread ? [`Active thread: ${plain(thread.title)}`, `Purpose: ${plain(thread.purpose)}`, this.time(thread.updatedAt), "Enter reads its current frame and exchange in Threads."] : [];
	}	private contactSummary(): string {
		const page = this.contactPage;
		if (!page) return plain(this.contactNotice) || "Reading contact…";
		const t = page.thread;
		return `${plain(t.title)} · ${t.closed ? "Closed" : "Open"} · ${t.members.length} member${t.members.length === 1 ? "" : "s"}`;
	}
	/** The short default detail: Purpose, Integration when declared, Contact, Identity. */
	private defaultGroups(row: RelatedEffort, includeIntegration: boolean): Array<[string, string]> {
		const groups: Array<[string, string]> = [];
		const purpose = this.declaredPurpose(row) ?? row.observedPurpose?.text;
		if (purpose) groups.push(["Purpose", plain(purpose)]);
		const claim = row.relationship === "machine" ? undefined : row.intentClaim;
		if (includeIntegration && claim?.integration) groups.push(["Integration", plain(claim.integration)]);
		if (this.contactId()) groups.push(["Contact", this.contactSummary()]);
		groups.push(["Identity", row.id]);
		return groups;
	}
	/** The complete detail, shown only on request. Machine peers keep their purpose-only view. */
	private fullGroups(row: RelatedEffort): Array<[string, string]> {
		const groups: Array<[string, string]> = [];
		if (this.observation !== undefined) groups.push(["Observation", this.observation]);
		const purpose = this.declaredPurpose(row);
		if (purpose) groups.push(["Purpose", plain(purpose)]);
		return [...groups, ...this.intentGroups(row), ...this.hostGroups(row), ...this.contactGroups()];
	}
	/** Carried intent, or the purpose-only view for a machine peer. */
	private intentGroups(row: RelatedEffort): Array<[string, string]> {
		const claim = row.relationship === "machine" ? undefined : row.intentClaim;
		if (!claim) {
			return [
				...(row.contactThreadClaim ? ([["Contact thread", plain(row.contactThreadClaim)]] as Array<[string, string]>) : []),
				["Purpose-only view", row.relationship === "machine" ? "No shared repository or cwd" : "No stated integration plan"],
			];
		}
		return [
			...(claim.integration ? ([["Integration", plain(claim.integration)]] as Array<[string, string]>) : []),
			["Operator direction", JSON.stringify(plain(claim.authority))],
			["Scope", `${claim.scope.paths.map(plain).join(", ") || "no paths"} · ${claim.scope.branches.map(plain).join(", ") || "no branches"} · full machine gates: ${claim.scope.fullGate ? "declared" : "not declared"}`],
			...(claim.contactThread ? ([["Contact thread", plain(claim.contactThread)]] as Array<[string, string]>) : []),
		];
	}
	private hostGroups(row: RelatedEffort): Array<[string, string]> {
		return [
			["Status", `${row.liveness} · ${this.relationOf(row)}`],
			["Shared substrates", row.sharedSubstrates?.map(plain).join(", ") || "none declared"],
			["Directory", plain(row.cwd)],
			["Started", this.time(row.startedAt)],
			...(row.lastActivityAt ? ([["Last recorded activity", this.time(row.lastActivityAt)]] as Array<[string, string]>) : []),
		];
	}
	private contactGroups(): Array<[string, string]> {
		const page = this.contactPage;
		if (!page) return this.contactId() ? [["Contact", plain(this.contactNotice) || "Reading contact…"]] : [];
		const t = page.thread;
		return [
			["Contact", this.contactSummary()],
			["Contact purpose", plain(t.purpose)],
			["Carried authority", plain(t.authority)],
			["Authority source", plain(t.source)],
			["Restrictions", plain(t.restrictions)],
			["Acceptance", plain(t.acceptance)],
			["Integrator", plain(t.integrator)],
			["Member declarations", memberDeclarationLines(t, (id) => id).slice(1).join("\n")],
			["Retained exchange", `${page.coverage.complete ? "page complete" : "bounded page"}${page.nextBefore !== null ? "; earlier events available" : ""}. Enter opens frame, sources and events in Threads.`],
		];
	}
	/** A key and value group: muted key, wrapped value, then one blank row. Callers cap summary values. */
	private groupLines(groups: ReadonlyArray<[string, string]>, width: number, valueLimit: (key: string) => number = () => Number.MAX_SAFE_INTEGER): string[] {
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const lines: string[] = [];
		for (const [key, value] of groups) {
			const text = value.trim();
			if (!text) continue;
			const valueLines: string[] = [];
			for (const source of text.split("\n")) {
				if (!source.trim()) {
					valueLines.push("");
					continue;
				}
				valueLines.push(...wrapTextWithAnsi(source, textWidth).map((part) => `${pad}${part}`));
			}
			const limit = valueLimit(key);
			lines.push(this.options.theme.fg("muted", `${pad}${key}`), ...valueLines.slice(0, limit), "");
			if (valueLines.length > limit) lines.splice(lines.length - 1, 0, `${pad}…`);
		}
		while (lines.at(-1) === "") lines.pop();
		return lines;
	}
	private scanLines(width: number): string[] {
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		return [`${pad}Scan details`, "", ...this.coverageLines().map((line) => `${pad}${clip(line, textWidth)}`)];
	}
	private detailTime(): string | number | undefined {
		if (this.selectedThread && !this.composing) return this.threads().find((row) => row.id === this.selectedThread)?.updatedAt;
		const row = this.row();
		return row ? this.lastUpdate(row) : undefined;
	}
	private coveragePartial(): boolean {
		if (!this.view) return false;
		const p = this.view.presence.coverage;
		const t = this.view.threads.coverage;
		return !p.complete || !t.complete || p.unreadable + t.unreadable > 0;
	}
	/** The one list footer: effort count, then partial coverage. A read failure takes the row. */
	private listFooter(effortCount: number, width: number): string {
		const theme = this.options.theme;
		if (this.loadError) return theme.fg("warning", clip(` ${plain(this.loadError)}`, width));
		const parts = [`${effortCount} effort${effortCount === 1 ? "" : "s"}`];
		if (this.coveragePartial()) parts.push("scan incomplete");
		return theme.fg("muted", clip(` ${parts.join(" · ")}`, width));
	}
	/** The visible window of one list: the wheel offset when set, otherwise the window that shows the selection. */
	private windowStart(kind: "efforts" | "threads", natural: number, total: number, count: number): number {
		return Math.min(Math.max(0, total - count), Math.max(0, this.listStart[kind] ?? natural));
	}
	private scrollWindow(kind: "efforts" | "threads", delta: number, natural: number, total: number, count: number): void {
		this.listStart[kind] = Math.min(Math.max(0, total - count), Math.max(0, this.windowStart(kind, natural, total, count) + delta));
		this.options.redraw();
	}
	private livenessGlyph(row: RelatedEffort): string {
		return row.liveness === "live" ? "●" : row.liveness === "incompatible" ? "!" : "○";
	}
	private glyphColor(row: RelatedEffort): "accent" | "warning" | "muted" {
		return row.liveness === "live" ? "accent" : row.liveness === "incompatible" ? "warning" : "muted";
	}
	/** The list pane: two lines per item, one blank row, one counts footer. */
	private list(width: number, height: number, y: number, effortCount: number, threadCount: number): string[] {
		const theme = this.options.theme;
		const efforts = this.view?.presence.efforts ?? [];
		const threads = threadCount > 0 && !this.composing ? this.threads() : [];
		this.threadsShown = threadCount > 0;
		const bodyRows = Math.max(1, height - 1);
		const showLabels = threadCount > 0;
		const capacity = Math.max(1, Math.floor((bodyRows - (showLabels ? 2 : 1)) / 3));
		const effortShown = efforts.length ? Math.min(Math.max(1, effortCount), capacity, efforts.length) : 0;
		const threadShown = Math.max(0, Math.min(threadCount, capacity - effortShown));
		const lines: string[] = [theme.fg("muted", " Efforts"), ...this.effortRows(efforts, width, y + 1, effortShown)];
		if (showLabels) {
			lines.push(theme.fg("muted", ` Active threads · ${threads.length}`));
			lines.push(...this.threadRows(threads, width, y + 1 + effortShown * 3, threadShown));
		}
		while (lines.length < bodyRows) lines.push("");
		lines.length = bodyRows;
		const footer = this.listFooter(efforts.length, width);
		this.mouse.add({ x: 0, y: y + bodyRows, width, height: 1, click: () => this.toggleScan() });
		return Array.from({ length: height }, (_, row) => (row < bodyRows ? lines[row] ?? "" : footer)).map((line) => fitLine(line, width));
	}
	private rowLines(kind: "effort" | "thread", id: string, key: string, build: () => string[]): string[] {
		const cacheKey = `${kind}:${id}`;
		const cached = this.rowCache.get(cacheKey);
		if (cached?.key === key) return cached.lines;
		const lines = build();
		this.rowCache.set(cacheKey, { key, lines });
		return lines;
	}
	/** Two lines and a gap per effort, with the window that keeps the selection visible. */
	private effortRows(efforts: readonly RelatedEffort[], width: number, baseY: number, shown: number): string[] {
		const theme = this.options.theme;
		const lines: string[] = [];
		const index = Math.max(0, efforts.findIndex((row) => row.id === this.selected));
		const naturalStart = Math.max(0, Math.min(index - shown + 1, efforts.length - shown));
		const start = this.windowStart("efforts", naturalStart, efforts.length, Math.max(1, shown));
		const visible = efforts.slice(start, start + shown);
		this.mouse.add({ x: 0, y: baseY, width, height: Math.max(1, visible.length * 3), wheel: (delta) => this.scrollWindow("efforts", delta, naturalStart, efforts.length, Math.max(1, shown)) });
		for (const row of visible) {
			const chosen = !this.selectedThread && row.id === (this.composing ? this.target : this.selected);
			this.mouse.add({ x: 0, y: baseY + lines.length, width, height: 3, click: () => { if (!this.composing) this.select(row.id); } });
			const title = clip(this.effortTitle(row), width - 4);
			const key = [width, chosen, this.composing, this.exactTime, Math.floor(Date.now() / 60_000), title, row.liveness, String(this.lastUpdate(row))].join("#");
			lines.push(...this.rowLines("effort", row.id, key, () => [
				chosen ? dashboardSelection(`▌ ${this.livenessGlyph(row)} ${title}`, width, true, theme) : `  ${theme.fg(this.glyphColor(row), this.livenessGlyph(row))} ${theme.bold(theme.fg("text", title))}`,
				theme.fg("muted", `    ${this.effortFacts(row)}`),
				"",
			]));
		}
		return lines;
	}
	/** Two lines and a gap per active thread. */
	private threadRows(threads: ReturnType<EffortView["threads"]>, width: number, baseY: number, shown: number): string[] {
		const theme = this.options.theme;
		const lines: string[] = [];
		const threadIndex = Math.max(0, threads.findIndex((row) => row.id === this.selectedThread));
		const naturalThreads = Math.max(0, Math.min(threadIndex - shown + 1, threads.length - shown));
		const threadStart = this.windowStart("threads", naturalThreads, threads.length, Math.max(1, shown));
		const visible = threads.slice(threadStart, threadStart + shown);
		this.mouse.add({ x: 0, y: baseY, width, height: Math.max(1, visible.length * 3 + 1), wheel: (delta) => this.scrollWindow("threads", delta, naturalThreads, threads.length, Math.max(1, shown)) });
		for (const thread of visible) {
			const chosen = thread.id === this.selectedThread;
			this.mouse.add({ x: 0, y: baseY + 1 + lines.length, width, height: 3, click: () => { if (!this.composing) { this.select(thread.id, true); this.contact(); } } });
			const time = this.time(thread.updatedAt);
			const title = clip(plain(thread.title), width - 6 - visibleWidth(time));
			const purpose = clip(plain(thread.purpose), width - 4);
			const key = [width, chosen, this.exactTime, Math.floor(Date.now() / 60_000), title, purpose, thread.updatedAt].join("#");
			lines.push(...this.rowLines("thread", thread.id, key, () => [
				chosen ? dashboardSelection(`▌ ● ${title}`, width, true, theme) : `  ${theme.fg("success", "●")} ${theme.bold(theme.fg("text", title))}  ${theme.fg("muted", time)}`,
				theme.fg("muted", `    ${purpose}`),
				"",
			]));
		}
		return lines;
	}
	private coverageLines(): string[] {
		if (!this.view) return ["Presence coverage: not read", "Thread coverage: not read"];
		const presence = this.view.presence;
		const p = presence.coverage;
		const threads = this.view.threads;
		const t = threads.coverage;
		return [
			`Presence: ${p.visited}/${presence.limits.visits} visits · ${presence.efforts.length}/${presence.limits.results} rows · ${p.complete ? "complete" : "incomplete"}`,
			`${p.omitted} omitted · ${p.unreadable} unreadable · ${p.dead} dead · ${p.unrelated} excluded entries`,
			...(p.reasons.length ? [`Presence reasons: ${p.reasons.map(plain).join(", ")}`] : []),
			`Threads: ${t.visited}/${threads.limits.visits} visits · ${threads.items.length}/${threads.limits.results} rows · ${t.complete ? "complete" : "incomplete"}`,
			`${t.omittedHints} omitted hints · ${t.omittedResults} omitted rows · ${t.unreadable} unreadable`,
			`${t.missingHints} missing hints · unvisited records: ${t.unvisited ? "yes" : "no"}`,
			...(t.reasons.length ? [`Thread reasons: ${t.reasons.map(plain).join(", ")}`] : []),
		];
	}
	/** Right-aligned header controls: the primary actions that fit, then More. */
	private actionControls(room: number, xRight: number, y: number): { text: string; width: number } {
		const theme = this.options.theme;
		const actions = this.primaryActions();
		const more = " More… ";
		const parts: Array<{ action?: ScreenAction; label: string }> = [];
		let used = visibleWidth(more);
		for (const action of actions) {
			const label = ` ${action.label} `;
			if (used + visibleWidth(label) > room) break;
			parts.push({ action, label });
			used += visibleWidth(label) + 1;
		}
		parts.push({ label: more });
		const width = parts.reduce((sum, part) => sum + visibleWidth(part.label), 0) + Math.max(0, parts.length - 1);
		let cursor = Math.max(0, xRight - width);
		let text = "";
		for (const [index, part] of parts.entries()) {
			if (index) {
				text += " ";
				cursor += 1;
			}
			const action = part.action;
			text += action?.disabled ? theme.fg("muted", part.label) : theme.fg("accent", part.label);
			const at = cursor;
			this.mouse.add({ x: at, y, width: visibleWidth(part.label), height: 1, click: () => {
				if (!action) {
					this.inventory.handleInput("x");
					return;
				}
				if (action.disabled) {
					this.notice = action.disabled;
					this.options.redraw();
					return;
				}
				action.run();
			} });
			cursor += visibleWidth(part.label);
		}
		return { text, width };
	}
	/** The right pane: two header lines, one blank row, then the scrolling detail. */
	private detailPane(width: number, height: number, x: number, y: number, includeIntegration: boolean, tightActions = false): string[] {
		const theme = this.options.theme;
		const { margin } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const section = this.detailSections(width, x, y, margin, includeIntegration, tightActions);
		const editor = this.composing ? this.composer.render(width, `Operator message to ${plain(this.target ?? "")} · Enter sends`) : [];
		const noticeLines = this.notice ? [theme.fg(this.notice.includes("unavailable") ? "warning" : "muted", truncateToWidth(`${pad}${plain(this.notice)}`, Math.max(1, width - 1), "…"))] : [];
		const available = Math.max(1, height - section.preamble.length - editor.length - noticeLines.length);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, section.bodySource.length - available)));
		const body = Array.from({ length: available }, (_, index) => section.bodySource[this.offset + index] ?? "");
		if (section.bodySource.length) this.mouse.add({ x, y: y + section.preamble.length, width, height: available, wheel: (delta) => { this.offset = Math.max(0, this.offset + delta); this.options.redraw(); } });
		if (section.timeLine >= 0) this.mouse.add({ x, y: y + section.timeLine, width, height: 1, click: () => { this.exactTime = !this.exactTime; this.options.redraw(); } });
		this.timeHits(body, x, y + section.preamble.length, width);
		if (editor.length) this.mouse.add({ x, y: y + section.preamble.length + available, width, height: editor.length, click: (event) => this.composer.handleMouse(event) });
		return [...section.preamble, ...body, ...editor, ...noticeLines].slice(0, height).map((line) => fitLine(line, width));
	}
	/** The pane's preamble and scrolling body for its current state. */
	private detailSections(width: number, x: number, y: number, margin: number, includeIntegration: boolean, tightActions: boolean): { preamble: string[]; bodySource: string[]; timeLine: number } {
		const row = this.row();
		if (this.scanOpen) return { preamble: this.scanLines(width), bodySource: [], timeLine: -1 };
		if (!row) {
			const message = this.composing ? `Message target ${plain(this.target ?? "")}: not in the current presence page` : this.view ? "No efforts in this page." : "Reading efforts…";
			return { preamble: [" ".repeat(margin) + clip(message, width - margin - 1)], bodySource: [], timeLine: -1 };
		}
		if (this.selectedThread && !this.composing && !this.detailsOpen) return this.threadSection(width, margin);
		return { preamble: this.detailHeaderLines(row, width, x, y, margin, tightActions), bodySource: this.detailBody(row, width, includeIntegration), timeLine: -1 };
	}
	/** A selected active thread, before it is opened in Threads. */
	private threadSection(width: number, margin: number): { preamble: string[]; bodySource: string[]; timeLine: number } {
		const preamble = this.threadDetails().map((line) => `${" ".repeat(margin)}${clip(line, width - margin - 1)}`);
		const detailTime = this.detailTime();
		const timeLine = detailTime !== undefined ? preamble.findIndex((line) => line.trim() === this.time(detailTime)) : -1;
		return { preamble, bodySource: [], timeLine };
	}
	/** Cached key and value lines for the selected effort. */
	private detailBody(row: RelatedEffort, width: number, includeIntegration: boolean): string[] {
		const groups = this.detailsOpen ? this.fullGroups(row) : this.defaultGroups(row, includeIntegration);
		if (!this.detailsOpen && this.observation !== undefined) groups.unshift(["Observation", this.observation]);
		const key = [row.id, width, includeIntegration, this.detailsOpen, this.detailVersion, this.observedAt, Math.floor(Date.now() / 60_000), this.exactTime, this.selectedThread, this.composing, this.target ?? ""].join("#");
		if (this.detailCache?.key !== key) this.detailCache = { key, lines: this.groupLines(groups, width, (name) => (this.detailsOpen || name === "Observation" ? Number.MAX_SAFE_INTEGER : 3)) };
		return this.detailCache.lines;
	}
	/** Two header lines and one blank row; the controls carry their own hit regions. */
	private detailHeaderLines(row: RelatedEffort, width: number, x: number, y: number, margin: number, tightActions: boolean): string[] {
		const theme = this.options.theme;
		const pad = " ".repeat(margin);
		const room = Math.max(1, width - margin - 1);
		// Leave at least 20 columns for the title; the compact layout keeps only the first action and More.
		const budget = tightActions ? visibleWidth(" Open thread ") + visibleWidth(" More… ") + 1 : Math.max(0, room - Math.min(room, 20));
		const controls = this.actionControls(budget, x + width, y);
		const title = truncateToWidth(this.effortTitle(row), Math.max(1, room - controls.width - 1), "…");
		const facts = `${row.liveness} · ${this.relationOf(row)} · updated ${this.time(this.lastUpdate(row))}`;
		this.mouse.add({ x, y: y + 1, width, height: 1, click: () => { this.exactTime = !this.exactTime; this.options.redraw(); } });
		return [`${fitLine(`${pad}${theme.bold(theme.fg("text", title))}`, Math.max(1, width - controls.width))}${controls.text}`, theme.fg("muted", truncateToWidth(`${pad}${facts}`, Math.max(1, width - 1), "…")), ""];
	}
	/** Register the exact-time toggle on any visible time row. */
	private timeHits(body: readonly string[], x: number, y: number, width: number): void {
		const detailTime = this.detailTime();
		for (let index = 0; index < body.length; index++) {
			if (/^\s*(Started:|Last recorded activity:)/.test(body[index]) || (detailTime !== undefined && body[index].trim() === this.time(detailTime))) {
				this.mouse.add({ x, y: y + index, width, height: 1, click: () => { this.exactTime = !this.exactTime; this.options.redraw(); } });
			}
		}
	}
	private renderWide(width: number, height: number, listWidth: number): string[] {
		const theme = this.options.theme;
		// The same split as the Agents tab: the divider sits at column `listWidth` in every tab.
		const x = listWidth + 1;
		const rightWidth = Math.max(1, width - x);
		const bodyRows = Math.max(1, height - 1);
		const effortCount = Math.max(1, Math.floor((bodyRows - 3) / 6));
		const threadCount = Math.max(0, Math.floor((bodyRows - 3 - effortCount * 3) / 3));
		const list = this.list(listWidth - 1, bodyRows, 1, effortCount, threadCount);
		const right = this.detailPane(rightWidth, bodyRows, x, 1, true);
		const panes = Array.from({ length: bodyRows }, (_, index) => fitLine(list[index] ?? "", listWidth) + theme.fg("borderMuted", "│") + fitLine(right[index] ?? "", rightWidth));
		return [dashboardHeading("Agents > Related efforts", "", width, theme), ...panes].map((line) => fitLine(line, width));
	}
	private renderTight(width: number, height: number): string[] {
		const theme = this.options.theme;
		const bodyRows = Math.max(1, height - 1);
		const withThreads = width >= 80 && height >= 24 && !this.composing;
		const stripRows = withThreads ? 9 : 5;
		const list = this.list(width, stripRows, 1, 1, withThreads ? 1 : 0);
		const detailHeight = Math.max(1, bodyRows - stripRows);
		const detail = this.detailPane(width, detailHeight, 0, 1 + stripRows, withThreads, true);
		const body = Array.from({ length: bodyRows }, (_, index) => (index < stripRows ? list[index] ?? "" : detail[index - stripRows] ?? ""));
		return [dashboardHeading("Agents > Related efforts", "", width, theme), ...body].slice(0, height).map((line) => fitLine(line, width));
	}
	private fallbackListWidth(width: number): number {
		return Math.max(30, Math.min(36, Math.floor(width * 0.22)));
	}
	render(width: number, height: number, listWidth?: number): string[] {
		this.mouse.reset(width, height);
		this.composer.focused = this.composing;
		if (width >= 60 && height >= 20 && this.inventory.open) return this.inventory.render(width, height, "Agents > Related efforts", "efforts", this.options.theme);
		if (width < 60 || height < 20) return Array.from({ length: height }, (_, index) => fitLine(index ? "" : "Resize to use Related efforts. Esc back.", width));
		if (width >= 100) return this.renderWide(width, height, listWidth ?? this.fallbackListWidth(width));
		return this.renderTight(width, height);
	}
	invalidate(): void { this.mouse.reset(); this.inventory.invalidate(); this.composer.invalidate(); this.detailCache = undefined; this.rowCache.clear(); }
	dispose(): void { this.disposed = true; this.active = false; this.clearSelectionReads(); this.mouse.reset(); this.detailCache = undefined; this.rowCache.clear(); }
}
