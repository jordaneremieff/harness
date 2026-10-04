import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { RelatedEffort, PrimaryIntentClaim } from "./effort-presence.ts";
import type { DashboardResult } from "./dashboard.ts";
import { AgentComposer } from "./agent-composer.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
import { dashboardHeading, dashboardSelection, fitLine } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";

const plain = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
interface EffortViewOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	efforts(): Promise<EffortAwareness>;
	messageEffort?(id: string, text: string): Promise<DashboardResult>;
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
	private notice = "";
	private offset = 0;
	private observedAt = Date.now();
	private exactTime = false;
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
	open(): void { void this.refresh(); }
	async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.pending) { this.again = true; return; }
		this.pending = true;
		try {
			const view = await this.options.efforts();
			if (this.disposed) return;
			this.view = view;
			this.observedAt = Date.now();
			if (!view.presence.efforts.some((row) => row.id === this.selected)) this.selected = view.presence.efforts[0]?.id;
			if (this.selectedThread && !view.threads.items.some((row) => row.id === this.selectedThread)) this.selectedThread = undefined;
			this.mouse.reset();
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
	private back(): void {
		if (this.composing) { this.composing = false; this.composer.focused = false; }
		else this.options.onBack();
	}
	private message(): void {
		const row = this.row();
		if (this.selectedThread || row?.liveness !== "live" || !this.options.messageEffort) {
			this.notice = "Direct messages need a live compatible effort";
			return;
		}
		this.target = row.id;
		this.composing = true;
		this.composer.setText(this.drafts.get(row.id)?.text ?? "");
	}
	private contact(): void {
		const row = this.row();
		const contact = this.selectedThread ?? (row?.relationship === "machine" ? row.contactThreadClaim : row?.intentClaim?.contactThread);
		if (contact) this.notice = this.options.openContact(contact) ?? "";
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
		this.selectedThread = next.thread ? next.id : undefined;
		if (!next.thread) this.selected = next.id;
		this.offset = 0;
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.back();
		else if (this.composing) this.composer.handleInput(data);
		else if (matchesKey(data, "up") || matchesKey(data, "down")) this.move(matchesKey(data, "up") ? -1 : 1);
		else if (matchesKey(data, "enter")) this.contact();
		else if (data === "t") this.notice = this.options.openThreads() ?? "";
		else if (data === "i") this.exactTime = !this.exactTime;
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
			`Purpose claim: ${plain(claim.purpose)}`,
			`Integration intent claim: ${plain(claim.integration)}`,
			`Quoted scoped authority claim: ${JSON.stringify(plain(claim.authority))}`,
			`Scope claim: ${claim.scope.paths.map(plain).join(", ") || "no paths"} · ${claim.scope.branches.map(plain).join(", ") || "no branches"} · full machine gates: ${claim.scope.fullGate ? "declared" : "not declared"}`,
			...(claim.contactThread ? [`Contact thread claim: ${plain(claim.contactThread)}`] : []),
			this.time(claim.updatedAt),
		];
	}
	private limitedClaimLines(row: RelatedEffort): string[] {
		return [
			...(row.purposeClaim ? [`Purpose claim: ${plain(row.purposeClaim)}`] : ["No purpose claim"]),
			...(row.contactThreadClaim ? [`Contact thread claim: ${plain(row.contactThreadClaim)}`] : []),
			...(row.intentUpdatedAt ? [this.time(row.intentUpdatedAt)] : []),
			row.relationship === "machine" ? "Purpose-only view: no shared repository or cwd" : "No integration intent claim",
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
			`${plain(row.id)} · Liveness: ${row.liveness} · Related by ${row.relationship}`,
			`Shared substrates: ${row.sharedSubstrates?.map(plain).join(", ") || "none declared"}`,
			`Directory: ${plain(row.cwd)}`,
			...(row.observedPurpose ? [`Observed purpose (${row.observedPurpose.source}): ${plain(row.observedPurpose.text)}`] : []),
		];
	}
	private purposePreview(row: RelatedEffort): string {
		return (row.relationship === "machine" ? row.purposeClaim : row.intentClaim?.purpose) || row.observedPurpose?.text || "No purpose claim";
	}
	private details(wide = false): string[] {
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
		if (!wide) return [...facts, ...intent, ...times];
		const theme = this.options.theme;
		return [
			theme.bold(plain(row.name || row.id)), "",
			...intent.map((line) => /^(Purpose claim|Integration intent claim):/.test(line) ? theme.bold(line) : line), "",
			...facts.map((line) => theme.fg("muted", line)),
			...times.map((line) => theme.fg("muted", line)),
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
			this.mouse.add({ x: 0, y: y + lines.length, width, height: 1, click: () => { if (!this.composing) { this.selected = row.id; this.selectedThread = undefined; this.offset = 0; } } });
			const chosen = !this.selectedThread && row.id === this.selected;
			lines.push(dashboardSelection(`${chosen ? "›" : " "} ${plain(row.name || row.id)} · ${row.liveness}`, width, chosen, this.options.theme));
		}
		const threads = this.threads();
		lines.push(this.options.theme.fg("muted", `Active threads · ${this.composing ? 0 : Math.min(2, threads.length)}/${threads.length} loaded · newest covered first`));
		if (!this.composing) {
			const threadIndex = Math.max(0, threads.findIndex((row) => row.id === this.selectedThread));
			for (const thread of threads.slice(Math.max(0, threadIndex - 1), Math.max(0, threadIndex - 1) + 2)) {
				this.mouse.add({ x: 0, y: y + lines.length, width, height: 1, click: () => { this.selectedThread = thread.id; this.contact(); } });
				lines.push(dashboardSelection(`${thread.id === this.selectedThread ? "›" : " "} ${plain(thread.title)} · ${this.time(thread.updatedAt)}`, width, thread.id === this.selectedThread, this.options.theme));
			}
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
				if (!this.composing) { this.selected = row.id; this.selectedThread = undefined; this.offset = 0; }
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
				if (!this.composing) { this.selectedThread = thread.id; this.contact(); }
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
		const coverage = this.coverageLines();
		const footer = (this.composing ? coverage.filter((line) => /^(Presence:|Threads:)/.test(line)) : coverage).map((line) => theme.fg("muted", line));
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
		const right = [...body, ...editor, ...footer];
		const panes = Array.from({ length: paneHeight }, (_, index) => fitLine(list[index] ?? "", listWidth) + theme.fg("borderMuted", " │ ") + fitLine(right[index] ?? "", rightWidth));
		const hints = this.composing ? ["Enter send", "Ctrl+J newline"] : ["↑↓ select", "Enter thread", "m message", "t threads", "i time", "PgUp/PgDn read"];
		return [dashboardHeading("Agents > Related efforts", "", width, theme), theme.fg("muted", this.selfLine()), ...panes, plain(this.notice), mouseHints(this.mouse, height - 1, hints, "Esc back", width, (data) => this.handleInput(data), theme)].map((line) => fitLine(line, width));
	}
	render(width: number, height: number): string[] {
		this.mouse.reset(width, height);
		this.composer.focused = this.composing;
		if (width < 60 || height < 20) return Array.from({ length: height }, (_, index) => fitLine(index ? "" : "Resize to use Related efforts. Esc back.", width));
		if (width >= 100) return this.renderWide(width, height);
		const rows = this.rows(width, 2);
		const editor = this.composing ? this.composer.render(width, `Operator message to ${plain(this.target ?? "")} · Enter sends`) : [];
		const coverage = this.coverageLines();
		const footer = (this.composing ? coverage.filter((line) => /^(Presence:|Threads:)/.test(line)) : coverage).map((line) => fitLine(this.options.theme.fg("muted", line), width));
		const bodyHeight = Math.max(0, height - rows.length - editor.length - footer.length - 4);
		const detail = this.details().flatMap((line) => wrapTextWithAnsi(line, width));
		this.offset = Math.max(0, Math.min(this.offset, detail.length - bodyHeight));
		const body = Array.from({ length: bodyHeight }, (_, index) => detail[this.offset + index] ?? "");
		this.mouse.add({ x: 0, y: rows.length + 2, width, height: bodyHeight, wheel: (delta) => { this.offset = Math.max(0, this.offset + delta); this.options.redraw(); } });
		const editorY = 2 + rows.length + bodyHeight;
		if (this.composing) this.mouse.add({ x: 0, y: editorY, width, height: editor.length, click: (event) => this.composer.handleMouse(event) });
		const hints = this.composing ? ["Enter send", "Ctrl+J newline"] : ["↑↓ select", "Enter thread", "m message", "t threads", "i time", "PgUp/PgDn read"];
		return [dashboardHeading("Agents > Related efforts", "", width, this.options.theme), this.selfLine(), ...rows, ...body, ...editor, ...footer, plain(this.notice), mouseHints(this.mouse, height - 1, hints, "Esc back", width, (data) => this.handleInput(data), this.options.theme)].slice(0, height).map((line) => fitLine(line, width));
	}
	invalidate(): void { this.mouse.reset(); this.composer.invalidate(); }
	dispose(): void { this.disposed = true; this.mouse.reset(); }
}
