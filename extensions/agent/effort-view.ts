import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { matchesKey, wrapTextWithAnsi, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { RelatedEffort, PrimaryIntentClaim } from "./effort-presence.ts";
import type { DashboardResult } from "./dashboard.ts";
import { AgentComposer } from "./agent-composer.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
import { dashboardHeading, dashboardSelection, fitLine } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";
import { memberDeclarationLines, threadPage, type Collaborate } from "./collaboration-view.ts";
import type { CollaborationPage } from "./collaboration.ts";

const plain = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
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
		this.offset = 0;
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
		} catch (error) {
			if (current()) this.contactNotice = `Contact declarations unavailable: ${plain(String(error).slice(0, 512))}`;
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
		this.options.redraw();
		try {
			const result = await this.options.observeEffort(id);
			if (!current()) return;
			let excerpt = result.slice(0, 16000);
			if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
			this.observation = cleanDashboardText(excerpt) + (result.length > excerpt.length ? "\nObservation omitted by display bound; use agent_inspect for a bounded next read." : "");
			if (!this.observation.trim()) this.observation = "No observation text returned; coverage unknown";
		} catch (error) {
			if (current()) this.observation = `Read-only observation unavailable: ${plain(String(error).slice(0, 512))}`;
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
			this.observedAt = Date.now();
			if (!view.presence.efforts.some((row) => row.id === this.selected)) {
				this.selected = view.presence.efforts[0]?.id;
				this.clearSelectionReads();
			}
			if (this.selectedThread && !view.threads.items.some((row) => row.id === this.selectedThread)) this.selectedThread = undefined;
			this.mouse.reset();
			void this.readContact();
		} catch (error) {
			if (!this.disposed) this.notice = `Related efforts unavailable: ${String(error)}`;
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
	private toggleScan(): void { this.scanOpen = !this.scanOpen; this.offset = 0; }
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
		const choices = [...(this.view?.presence.efforts ?? []).map((row) => ({ id: row.id, thread: false })), ...this.threads().map((row) => ({ id: row.id, thread: true }))];
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
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.back();
		else if (this.composing) this.composer.handleInput(data);
		else if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
		else if (matchesKey(data, "enter")) this.contact();
		else if (data === "t") this.openThreads();
		else if (data === "o") void this.observe();
		else if (data === "i") this.exactTime = !this.exactTime;
		else if (data === "c") this.toggleScan();
		else if (data === "m" || matchesKey(data, "tab")) this.message();
		else if (matchesKey(data, "pageDown")) this.offset += 5;
		else if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - 5);
		this.options.redraw();
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse.handle(event); }
	private time(value: string | number): string {
		const at = new Date(value).getTime();
		return Number.isFinite(at) ? dashboardTime(at, this.exactTime, this.observedAt) : "unknown (invalid time)";
	}
	private claimLines(claim: PrimaryIntentClaim): string[] {
		return [
			this.options.theme.fg("muted", "Stated by this effort"),
			`Purpose: ${plain(claim.purpose)}`,
			`Integration: ${plain(claim.integration)}`,
			`Operator direction (quoted): ${JSON.stringify(plain(claim.authority))}`,
			`Scope: ${claim.scope.paths.map(plain).join(", ") || "no paths"} · ${claim.scope.branches.map(plain).join(", ") || "no branches"} · full machine gates: ${claim.scope.fullGate ? "declared" : "not declared"}`,
			...(claim.contactThread ? [`Contact thread: ${plain(claim.contactThread)}`] : []),
			this.time(claim.updatedAt),
		];
	}
	private limitedClaimLines(row: RelatedEffort): string[] {
		const purpose = this.declaredPurpose(row);
		return [
			this.options.theme.fg("muted", "Stated by this effort"),
			...(purpose ? [`Purpose: ${plain(purpose)}`] : ["No stated purpose"]),
			...(row.contactThreadClaim ? [`Contact thread: ${plain(row.contactThreadClaim)}`] : []),
			...(row.intentUpdatedAt ? [this.time(row.intentUpdatedAt)] : []),
			row.relationship === "machine" ? "Purpose-only view: no shared repository or cwd" : "No stated integration plan",
		];
	}
	private threadDetails(): string[] {
		const thread = this.threads().find((row) => row.id === this.selectedThread);
		return thread ? [`Active thread: ${plain(thread.title)}`, `Purpose: ${plain(thread.purpose)}`, this.time(thread.updatedAt), "Enter reads its current frame and exchange in Threads."] : [];
	}
	private detailTime(): string | number | undefined {
		if (this.selectedThread && !this.composing) return this.threads().find((row) => row.id === this.selectedThread)?.updatedAt;
		const row = this.row();
		return (row?.relationship !== "machine" ? row?.intentClaim?.updatedAt : undefined) ?? row?.intentUpdatedAt;
	}
	private hostFacts(row: RelatedEffort): string[] {
		return [
			`Status: ${row.liveness} · Related by ${row.relationship}`,
			`Shared substrates: ${row.sharedSubstrates?.map(plain).join(", ") || "none declared"}`,
			`Directory: ${plain(row.cwd)}`,
			...(!this.declaredPurpose(row) && row.observedPurpose ? [`Observed purpose (${row.observedPurpose.source}): ${plain(row.observedPurpose.text)}`] : []),
		];
	}
	private declaredPurpose(row: RelatedEffort): string | undefined {
		return row.relationship === "machine" ? row.purposeClaim : row.intentClaim?.purpose ?? row.purposeClaim;
	}
	private purposePreview(row: RelatedEffort): string {
		return this.declaredPurpose(row) || (row.observedPurpose ? `Observed purpose (${row.observedPurpose.source}): ${row.observedPurpose.text}` : "No purpose claim");
	}
	private contactLines(): string[] {
		const page = this.contactPage;
		if (!page) return [this.contactNotice];
		const t = page.thread;
		return [
			`Contact frame ${t.revision} (${t.closed ? "closed" : "open"}): ${plain(t.title)}`,
			`Purpose: ${plain(t.purpose)}`,
			`Carried authority (claim): ${plain(t.authority)}`,
			`Authority source: ${plain(t.source)}`,
			`Restrictions: ${plain(t.restrictions)}`,
			`Acceptance: ${plain(t.acceptance)}`,
			`Integrator: ${plain(t.integrator)}`,
			...memberDeclarationLines(t, (id) => id),
			`Retained exchange: ${page.coverage.complete ? "page complete" : "bounded page"}${page.nextBefore !== null ? "; earlier events available" : ""}. Enter opens frame, sources and events in Threads.`,
		];
	}
	private observationLines(): string[] {
		return this.observation === undefined ? [] : ["Read-only observation", ...this.observation.split("\n"), ""];
	}
	private details(wide = false): string[] {
		if (this.scanOpen) return ["Scan details", "", ...this.coverageLines()];
		if (this.selectedThread && !this.composing) return this.threadDetails();
		const row = this.row();
		if (!row) return [this.composing ? `Message target ${plain(this.target ?? "")}: not in the current presence page` : this.view ? "No efforts in this page. See coverage below." : "Reading efforts…"];
		const claim = row.relationship === "machine" ? undefined : row.intentClaim;
		const facts = this.hostFacts(row);
		const intent = claim ? this.claimLines(claim) : this.limitedClaimLines(row);
		const times = [
			`Started: ${this.time(row.startedAt)}`,
			...(row.lastActivityAt ? [`Last recorded activity: ${this.time(row.lastActivityAt)}`] : []),
		];
		if (!wide) return [...this.observationLines(), ...intent, ...facts, ...times, "", ...this.contactLines()];
		const theme = this.options.theme;
		return [
			theme.bold(plain(row.name || row.id)), "",
			...this.observationLines(),
			...intent.map((line) => /^(Purpose|Integration):/.test(line) ? theme.bold(line) : line), "",
			...facts.map((line) => theme.fg("muted", line)),
			...times.map((line) => theme.fg("muted", line)), "",
			...this.contactLines(),
		];
	}
	private selfLine(): string {
		const self = this.view?.self;
		if (!self) return "Your effort: reading current purpose…";
		if (self.omitted) return "Your effort: purpose omitted by source bound";
		if (self.intentClaim) return `Your purpose claim: ${plain(self.intentClaim.purpose)}`;
		return self.observedPurpose ? `Your observed purpose (${self.observedPurpose.source}): ${plain(self.observedPurpose.text)}` : "Your effort: no observed purpose or purpose claim";
	}
	private rows(width: number, y: number): string[] {
		const efforts = this.view?.presence.efforts ?? [];
		const count = this.composing ? 1 : 2;
		const index = Math.max(0, efforts.findIndex((row) => row.id === this.selected));
		const lines = [this.options.theme.fg("muted", `Efforts · ${Math.min(count, efforts.length)}/${efforts.length} loaded rows visible`)];
		for (const row of efforts.slice(Math.max(0, index - count + 1), Math.max(0, index - count + 1) + count)) {
			this.mouse.add({ x: 0, y: y + lines.length, width, height: 1, click: () => { if (!this.composing) { this.select(row.id); } } });
			const chosen = !this.selectedThread && row.id === this.selected;
			lines.push(dashboardSelection(`${chosen ? "›" : " "} ${plain(row.name || row.id)} · ${row.liveness}`, width, chosen, this.options.theme));
		}
		const threads = this.threads();
		lines.push(this.options.theme.fg("muted", `Active threads · ${this.composing ? 0 : Math.min(2, threads.length)}/${threads.length} loaded · newest covered first`));
		if (!this.composing) {
			const threadIndex = Math.max(0, threads.findIndex((row) => row.id === this.selectedThread));
			for (const thread of threads.slice(Math.max(0, threadIndex - 1), Math.max(0, threadIndex - 1) + 2)) {
				this.mouse.add({ x: 0, y: y + lines.length, width, height: 1, click: () => { this.select(thread.id, true); this.contact(); } });
				lines.push(dashboardSelection(`${thread.id === this.selectedThread ? "›" : " "} ${plain(thread.title)} · ${this.time(thread.updatedAt)}`, width, thread.id === this.selectedThread, this.options.theme));
			}
		}
		return lines;
	}
	private coverageSummary(): string[] {
		if (!this.view || this.scanOpen) return [];
		const p = this.view.presence.coverage;
		const t = this.view.threads.coverage;
		if (p.complete && t.complete) return [];
		const unreadable = p.unreadable + t.unreadable;
		const reasons: string[] = [];
		if (unreadable) reasons.push(`${unreadable} unreadable record${unreadable === 1 ? "" : "s"}`);
		else if (!p.complete) reasons.push("efforts partly scanned");
		if (!t.complete) reasons.push(t.unvisited ? "threads partly unvisited" : "thread hints partial");
		return [`Scan incomplete: ${reasons.join("; ")}`];
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
	private list(width: number, height: number, y: number): string[] {
		const theme = this.options.theme;
		const efforts = this.view?.presence.efforts ?? [];
		const threads = this.threads();
		const count = Math.max(1, Math.floor((height - 3) / 6));
		const index = Math.max(0, efforts.findIndex((row) => row.id === this.selected));
		const start = Math.max(0, Math.min(index - count + 1, efforts.length - count));
		const visible = efforts.slice(start, start + count);
		const lines = [theme.fg("muted", `Efforts · ${visible.length}/${efforts.length} loaded`)];
		for (const row of visible) {
			const chosen = !this.selectedThread && row.id === (this.composing ? this.target : this.selected);
			this.mouse.add({ x: 0, y: y + lines.length, width, height: 3, click: () => {
				if (!this.composing) { this.select(row.id); }
			} });
			const purpose = this.purposePreview(row);
			lines.push(
				dashboardSelection(`${chosen ? "›" : " "} ${plain(row.name || row.id)}`, width, chosen, theme),
				theme.fg(row.liveness === "live" ? "accent" : "muted", `  ${row.liveness} · ${row.relationship}`),
				`  ${plain(purpose)}`,
			);
		}
		lines.push("");
		const threadCount = Math.max(0, Math.floor((height - lines.length - 1) / 2));
		const threadIndex = Math.max(0, threads.findIndex((row) => row.id === this.selectedThread));
		const threadStart = Math.max(0, Math.min(threadIndex - threadCount + 1, threads.length - threadCount));
		const visibleThreads = threads.slice(threadStart, threadStart + threadCount);
		lines.push(theme.fg("muted", `Active threads · ${visibleThreads.length}/${threads.length} loaded`));
		for (const thread of visibleThreads) {
			this.mouse.add({ x: 0, y: y + lines.length, width, height: 2, click: () => {
				if (!this.composing) { this.select(thread.id, true); this.contact(); }
			} });
			lines.push(
				dashboardSelection(`${thread.id === this.selectedThread ? "›" : " "} ${plain(thread.title)}`, width, thread.id === this.selectedThread, theme),
				theme.fg("muted", `  ${this.time(thread.updatedAt)}`),
			);
		}
		return lines;
	}
	private renderWide(width: number, height: number): string[] {
		const theme = this.options.theme;
		const listWidth = Math.max(30, Math.min(36, Math.floor(width * 0.22)));
		const x = listWidth + 3;
		const rightWidth = width - x;
		const paneHeight = height - 4;
		const list = this.list(listWidth, paneHeight, 2);
		const editor = this.composing ? this.composer.render(rightWidth, `Operator message to ${plain(this.target ?? "")} · Enter sends`) : [];
		const footer = this.coverageSummary().map((line) => theme.fg("muted", line));
		const bodyHeight = Math.max(0, paneHeight - editor.length - footer.length);
		const detail = this.details(true).flatMap((line) => wrapTextWithAnsi(line, Math.min(88, rightWidth)));
		this.offset = Math.max(0, Math.min(this.offset, detail.length - bodyHeight));
		const body = Array.from({ length: bodyHeight }, (_, index) => detail[this.offset + index] ?? "");
		this.mouse.add({ x, y: 2, width: rightWidth, height: bodyHeight, wheel: (delta) => {
			this.offset = Math.max(0, this.offset + delta); this.options.redraw();
		} });
		const detailTime = this.detailTime();
		for (let index = 0; index < body.length; index++) {
			if (/(Started:|Last recorded activity:)/.test(body[index]) || (detailTime !== undefined && body[index] === this.time(detailTime))) {
				this.mouse.add({ x, y: 2 + index, width: rightWidth, height: 1, click: () => {
					this.exactTime = !this.exactTime; this.options.redraw();
				} });
			}
		}
		if (this.composing) this.mouse.add({ x, y: 2 + bodyHeight, width: rightWidth, height: editor.length, click: (event) => this.composer.handleMouse(event) });
		if (footer.length && !this.composing) this.mouse.add({ x, y: 2 + bodyHeight + editor.length, width: rightWidth, height: 1, click: () => this.toggleScan() });
		const right = [...body, ...editor, ...footer];
		const panes = Array.from({ length: paneHeight }, (_, index) => fitLine(list[index] ?? "", listWidth) + theme.fg("borderMuted", " │ ") + fitLine(right[index] ?? "", rightWidth));
		const hints = this.composing ? ["Enter send", "Ctrl+J newline"] : ["↑↓ select", "Enter thread", "o observe", "m message", "c scan", "i time", "t threads", "PgUp/PgDn read"];
		return [dashboardHeading("Agents > Related efforts", "", width, theme), theme.fg("muted", this.selfLine()), ...panes, plain(this.notice), mouseHints(this.mouse, height - 1, hints, "Esc back", width, (data) => this.handleInput(data), theme)].map((line) => fitLine(line, width));
	}
	render(width: number, height: number): string[] {
		this.mouse.reset(width, height);
		this.composer.focused = this.composing;
		if (width < 60 || height < 20) return Array.from({ length: height }, (_, index) => fitLine(index ? "" : "Resize to use Related efforts. Esc back.", width));
		if (width >= 100) return this.renderWide(width, height);
		const rows = this.rows(width, 2);
		const editor = this.composing ? this.composer.render(width, `Operator message to ${plain(this.target ?? "")} · Enter sends`) : [];
		const footer = this.coverageSummary().map((line) => fitLine(this.options.theme.fg("muted", line), width));
		const bodyHeight = Math.max(0, height - rows.length - editor.length - footer.length - 4);
		const detail = this.details().flatMap((line) => wrapTextWithAnsi(line, width));
		this.offset = Math.max(0, Math.min(this.offset, detail.length - bodyHeight));
		const body = Array.from({ length: bodyHeight }, (_, index) => detail[this.offset + index] ?? "");
		this.mouse.add({ x: 0, y: rows.length + 2, width, height: bodyHeight, wheel: (delta) => { this.offset = Math.max(0, this.offset + delta); this.options.redraw(); } });
		const editorY = 2 + rows.length + bodyHeight;
		if (this.composing) this.mouse.add({ x: 0, y: editorY, width, height: editor.length, click: (event) => this.composer.handleMouse(event) });
		if (footer.length && !this.composing) this.mouse.add({ x: 0, y: editorY + editor.length, width, height: 1, click: () => this.toggleScan() });
		const hints = this.composing ? ["Enter send", "Ctrl+J newline"] : ["↑↓ select", "Enter thread", "o observe", "m message", "c scan", "i time", "t threads", "PgUp/PgDn read"];
		return [dashboardHeading("Agents > Related efforts", "", width, this.options.theme), this.selfLine(), ...rows, ...body, ...editor, ...footer, plain(this.notice), mouseHints(this.mouse, height - 1, hints, "Esc back", width, (data) => this.handleInput(data), this.options.theme)].slice(0, height).map((line) => fitLine(line, width));
	}
	invalidate(): void { this.mouse.reset(); this.composer.invalidate(); }
	dispose(): void { this.disposed = true; this.active = false; this.clearSelectionReads(); this.mouse.reset(); }
}
