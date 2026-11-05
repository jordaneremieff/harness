import { homedir } from "node:os";
import { basename } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth, wrapTextWithAnsi, truncateToWidth, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { RelatedEffort } from "./effort-presence.ts";
import type { DashboardResult } from "./dashboard.ts";
import { type Action, type Control, actionControl, keyInput, keyMatches, keyText, menuControl } from "../../operator-ui/index.ts";
import { AgentComposer } from "./agent-composer.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { LIST_BLOCK_ROWS, dashboardHeading, fitLine, listBlock, readingGeometry } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";
import { memberDeclarationLines, threadPage, type Collaborate } from "./thread-data.ts";
import type { CollaborationPage } from "./collaboration.ts";

const plain = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
/** Clip with one ellipsis character; the generic line fit must never add its own three dots. */
const clip = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…");
/** A session's folder as a short label: the last path component, or `~` for the home folder. */
const folderLabel = (cwd: string) => (cwd === homedir() ? "~" : basename(cwd) || cwd);
/** Activity this close to the start is the registration itself, not later input or tool work. */
const START_SLACK_MS = 5_000;
/** Readable words for presence scan stop reasons; an unknown reason keeps its own word. */
const SCAN_REASONS: Record<string, string> = {
	"visit-limit": "scan limit hit",
	"result-limit": "row limit hit",
	"byte-limit": "size limit hit",
	"status-byte-limit": "size limit hit",
	unreadable: "unreadable records",
	"repository-unknown": "unknown repository",
	"directory-unreadable": "unreadable folder",
	"native-record-unreadable": "unreadable agent records",
	"native-intent-incomplete": "incomplete agent intent",
};
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
/** The four arrow and page actions the footer's `select` and `read` hints stand for. */
const STEP_ACTIONS = new Set(["previous", "next", "read-up", "read-down"]);

/** Presence and thread hints follow pane entry and roster notices, never an age timer. */
export class EffortView {
	private readonly mouse = new DashboardMouse();
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
	/** The effort a notice describes; another selection does not show it. */
	private noticeFor?: string;
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
		this.contactStart(threadId);
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
			if (current()) {
				this.contactPage = undefined;
				this.contactNotice = `Contact declarations unavailable: ${plain(String(error).slice(0, 512))}`;
				this.detailVersion++;
			}
		} finally {
			this.contactPending = false;
			this.contactFinished(current());
		}
	}
	/** Start a contact read: a routine refresh keeps the declaration already read. */
	private contactStart(threadId: string | undefined): void {
		const retained = threadId && this.contactPage?.thread.id === threadId ? this.contactPage : undefined;
		this.contactPage = retained;
		if (!threadId) this.contactNotice = "No contact thread claim";
		else if (!this.options.collaborate) this.contactNotice = "Contact declarations unavailable: no thread reader";
		else this.contactNotice = retained ? "" : "Read contact declarations…";
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
			this.setNotice("Direct messages need a live compatible effort", this.selected);
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
			this.setNotice(notice ?? "", this.selectedThread ?? this.selected);
			if (!notice) { this.active = false; this.clearSelectionReads(); }
		}
		else this.setNotice("No contact thread claim", this.selected);
	}
	/** Publish a notice against the effort it describes, so another selection never shows it. */
	private setNotice(text: string, id?: string): void {
		this.notice = text;
		this.noticeFor = id;
	}
	private async send(text: string): Promise<void> {
		const id = this.target;
		if (!id || this.sending || !text.trim()) return;
		if (this.view?.presence.efforts.find((row) => row.id === id)?.liveness !== "live" || !this.options.messageEffort) {
			this.setNotice("Delivery not attempted: effort is not live", id);
			return;
		}
		const revision = this.drafts.get(id)?.revision;
		this.sending = true;
		this.setNotice("Sending operator message…", id);
		this.options.redraw();
		try {
			const result = await this.options.messageEffort(id, text);
			if (this.disposed) return;
			this.setNotice(plain(result.text), id);
			if (this.drafts.get(id)?.text === text && this.drafts.get(id)?.revision === revision) {
				this.drafts.delete(id);
				if (this.target === id) this.composer.setText("");
			}
		} catch (error) {
			if (!this.disposed) this.setNotice(`Delivery not confirmed. Draft retained: ${String(error)}`, id);
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
		this.setNotice(notice ?? "", this.selectedThread ?? this.selected);
		if (!notice) { this.active = false; this.clearSelectionReads(); }
	}
	/** Every action of this view, re-read at each render and each invocation. Footer, keys and pointer all run these. */
	private actions(): Action[] {
		if (this.composing) return [
			{ id: "send", label: "Send", key: "enter", primary: true, run: () => this.composer.handleInput("\r") },
		];
		const row = this.row();
		const messageBlocked = this.selectedThread || row?.liveness !== "live" || !this.options.messageEffort ? "Direct messages need a live compatible effort" : undefined;
		const observeBlocked = this.selectedThread ? "Select an effort, not a thread" : !this.selected ? "No effort is selected" : undefined;
		const contactBlocked = this.selectedThread || this.contactId() ? undefined : "No contact thread claim";
		return [
			{ id: "contact", label: "Open thread", key: "enter", primary: true, disabled: contactBlocked, run: () => this.contact() },
			{ id: "message", label: "Message", key: "m", primary: true, disabled: messageBlocked, run: () => this.message() },
			{ id: "observe", label: "Observe", key: "o", primary: true, disabled: observeBlocked, run: () => { void this.observe(); } },
			{ id: "details", label: this.detailsOpen ? "Summary" : "Details", key: "d", primary: true, run: () => this.toggleDetails() },
			{ id: "threads", label: "Threads", key: "t", primary: true, run: () => this.openThreads() },
			{ id: "scan", label: this.scanOpen ? "Hide scan" : "Scan details", short: this.scanOpen ? "hide scan" : "scan", key: "c", run: () => this.toggleScan() },
			{ id: "refresh", label: "Refresh", key: "r", run: () => { void this.refresh(); } },
			{ id: "time", label: this.exactTime ? "Relative times" : "Exact times", short: "times", key: "i", run: () => { this.exactTime = !this.exactTime; } },
			{ id: "previous", label: "Previous", key: "up", run: () => this.move(-1) },
			{ id: "next", label: "Next", key: "down", run: () => this.move(1) },
			{ id: "read-up", label: "Read up", key: "pageUp", run: () => { this.offset = Math.max(0, this.offset - 5); } },
			{ id: "read-down", label: "Read down", key: "pageDown", run: () => { this.offset += 5; } },
		];
	}

	private invoke(id: string): void {
		const action = this.actions().find((item) => item.id === id);
		if (!action) return;
		if (action.disabled) {
			this.setNotice(action.disabled, this.selectedThread ?? this.selected);
			return;
		}
		action.run();
	}

	/** True while the message field has focus: printable keys are its text. */
	editing(): boolean {
		return this.composing;
	}

	/**
	 * The footer for the current focus: navigation first, then the actions on the selection, then the
	 * way out. Actions that do not fit or lack a place on the row are listed under More with their keys.
	 */
	footer(): { controls: Control[]; menu: Control[] } {
		const actions = this.actions();
		const byId = new Map(actions.map((action) => [action.id, action]));
		const control = (id: string, priority: number): Control | undefined => {
			const action = byId.get(id);
			return action ? actionControl(action, (chosen) => this.invoke(chosen), priority) : undefined;
		};
		const hint = (id: string, keys: string[], label: string, priority: number): Control =>
			({ id, keys, label, priority, run: (key) => this.sendHint(key) });
		const back = hint("back", ["escape"], "back", 0);
		if (this.composing) {
			const send = control("send", 1);
			return {
				controls: [
					...(send ? [send] : []),
					{ id: "newline", keys: this.newlineKeys(), label: "newline", priority: 2, run: (key) => this.sendHint(key) },
					back,
				],
				menu: [],
			};
		}
		const controls: Control[] = [hint("select", ["up", "down"], "select", 0), hint("read", ["pageUp", "pageDown"], "read", 2)];
		for (const id of ["contact", "message", "observe", "details", "threads"]) {
			const item = control(id, 1);
			if (item) controls.push(item);
		}
		controls.push(back);
		const menu = actions
			.filter((action) => !action.primary && !STEP_ACTIONS.has(action.id))
			.map((action) => menuControl(action, (chosen) => this.invoke(chosen)));
		return { controls, menu };
	}

	/** Send one footer key; a key with no terminal form says so and sends nothing. */
	private sendHint(key: string): void {
		const input = keyInput(key);
		if (input === undefined) {
			this.setNotice(`The ${keyText(key)} key has no clickable form here.`);
			return;
		}
		this.handleInput(input);
	}

	/** The keys the resolved newline binding accepts, as the composer footer shows them. */
	private newlineKeys(): string[] {
		const keys = this.options.keys.getKeys("tui.input.newLine");
		return keys.length ? [...keys] : ["shift+enter", "ctrl+j"];
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, "escape")) this.back();
		else if (this.composing) this.composer.handleInput(data);
		else {
			const action = this.actions().find((item) => item.key !== undefined && keyMatches(data, item.key));
			if (action) this.invoke(action.id);
		}
		this.options.redraw();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse.handle(event); }
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
	/**
	 * The best human title: the session's own name, then the declared purpose's first sentence, then the
	 * observed first input in quotes, then the folder of an untitled session. Nothing is invented.
	 */
	private effortTitle(row: RelatedEffort): string {
		if (row.name?.trim()) return plain(row.name);
		const purpose = this.declaredPurpose(row);
		if (purpose) return this.firstSentence(purpose);
		if (row.observedPurpose?.text.trim()) return `“${plain(row.observedPurpose.text)}”`;
		return `Untitled session in ${folderLabel(row.cwd)}`;
	}
	private relationOf(row: RelatedEffort): string {
		return { cwd: "same folder", repository: "same repository", machine: "this machine" }[row.relationship as string] ?? row.relationship;
	}
	private lastUpdate(row: RelatedEffort): string | number {
		return (row.relationship !== "machine" ? row.intentClaim?.updatedAt : undefined) ?? row.intentUpdatedAt ?? row.lastActivityAt ?? row.startedAt;
	}
	/** Whether the Pi session runs: `live` means its process is running here, not that it is working. */
	private presenceOf(row: RelatedEffort): string {
		return row.liveness === "live" ? "Pi open" : row.liveness === "incompatible" ? "Pi open, other version" : "presence unknown";
	}
	/** The last recorded input, tool end or settled turn; the registration time alone is not activity. */
	private activityOf(row: RelatedEffort): string {
		const started = new Date(row.startedAt).getTime();
		const last = row.lastActivityAt ? new Date(row.lastActivityAt).getTime() : Number.NaN;
		if (!Number.isFinite(last)) return `started ${this.time(row.startedAt)}`;
		if (Number.isFinite(started) && Math.abs(last - started) < START_SLACK_MS) return `started ${this.time(row.startedAt)}, no activity recorded`;
		return `last activity ${this.time(row.lastActivityAt ?? row.startedAt)}`;
	}
	/** Line 2 of an effort row: presence, then recorded activity. */
	private effortFacts(row: RelatedEffort): string {
		return `${this.presenceOf(row)} · ${this.activityOf(row)}`;
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
	/**
	 * The default detail, complete and in reading order: the rest of the declared purpose (its first
	 * sentence is the title), the integration plan with its age, then the contact thread. Identity and
	 * provenance stay in Details.
	 */
	private defaultGroups(row: RelatedEffort, includeIntegration: boolean, titleCut = false): Array<[string, string]> {
		const groups: Array<[string, string]> = [];
		const purpose = this.declaredPurpose(row);
		if (purpose) {
			const rest = titleCut ? plain(purpose) : this.purposeRest(row, purpose);
			if (rest) groups.push([rest === plain(purpose) ? "Purpose" : "", rest]);
		} else if (row.observedPurpose?.text.trim()) groups.push(["First input (observed, not a declared purpose)", plain(row.observedPurpose.text)]);
		else groups.push(["", "This session declares no purpose or integration plan."]);
		const claim = row.relationship === "machine" ? undefined : row.intentClaim;
		if (includeIntegration && claim?.integration) groups.push([`Integration · next shared acts, declared ${this.time(claim.updatedAt)}`, plain(claim.integration)]);
		if (this.contactId()) groups.push(["Contact thread", this.contactSummary()]);
		return groups;
	}
	/**
	 * The purpose text the body still has to show. When the title is the purpose's complete first
	 * sentence, only the following sentences remain; a named session shows the whole purpose.
	 */
	private purposeRest(row: RelatedEffort, purpose: string): string {
		const flat = plain(purpose);
		if (row.name?.trim()) return flat;
		const first = this.firstSentence(purpose);
		return flat.startsWith(first) ? flat.slice(first.length).trim() : flat;
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
			["Status", `${this.presenceOf(row)} · ${this.activityOf(row)} · ${this.relationOf(row)}`],
			["Identity", row.id],
			...(row.name?.trim() ? ([["Session name", plain(row.name)]] as Array<[string, string]>) : []),
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
	/** A key and value group: muted key (none for a lead paragraph), the complete wrapped value, then one blank row. */
	private groupLines(groups: ReadonlyArray<[string, string]>, width: number): string[] {
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const lines: string[] = [];
		for (const [key, value] of groups) {
			const text = value.trim();
			if (!text) continue;
			if (key) lines.push(this.options.theme.fg("muted", `${pad}${key}`));
			for (const source of text.split("\n")) {
				if (!source.trim()) {
					lines.push("");
					continue;
				}
				lines.push(...wrapTextWithAnsi(source, textWidth).map((part) => `${pad}${part}`));
			}
			lines.push("");
		}
		while (lines.at(-1) === "") lines.pop();
		return lines;
	}
	/** The scanned coverage text; the pane scrolls it, so every sentence stays reachable. */
	private scanBody(width: number): string[] {
		const { margin, textWidth } = readingGeometry(width);
		const pad = " ".repeat(margin);
		return this.coverageLines().flatMap((line) => (line ? wrapTextWithAnsi(line, textWidth).map((part) => `${pad}${part}`) : [""]));
	}
	/** How long ago this view read presence, against the clock; record ages stay fixed to the read itself. */
	private readAge(): string {
		return dashboardTime(this.observedAt, this.exactTime);
	}
	/** Scan stop reasons in plain words; the presence scan's by default. */
	private scanReasons(reasons: readonly string[] = this.view?.presence.coverage.reasons ?? []): string {
		return [...new Set(reasons.map((reason) => SCAN_REASONS[reason] ?? plain(reason)))].join(", ");
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
	/**
	 * The one list footer: the effort count, when presence was read, and why the scan is incomplete. The
	 * row opens Scan details, which lists every count and bound. A read failure takes the row.
	 */
	private listFooter(effortCount: number, width: number): string {
		const theme = this.options.theme;
		if (this.loadError) return theme.fg("warning", clip(` ${plain(this.loadError)}`, width));
		const partial = this.coveragePartial();
		let more = this.scanOpen ? " · Hide" : " · Details";
		const parts = [`${effortCount} effort${effortCount === 1 ? "" : "s"}`, `read ${this.readAge()}`, ...(partial ? [this.scanReasons() || "scan incomplete"] : [])];
		// A narrow list drops the read age, then the control word (the whole row still opens Scan details), before it shortens the reason.
		const fits = () => visibleWidth(` ${parts.join(" · ")}${partial ? more : ""}`) <= width;
		if (!fits()) parts.splice(1, 1);
		if (!fits()) more = "";
		const text = ` ${parts.join(" · ")}`;
		if (!partial || !more) return theme.fg("muted", clip(text, width));
		return `${theme.fg("muted", clip(text, Math.max(1, width - visibleWidth(more))))}${theme.fg("accent", more)}`;
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
		const capacity = Math.max(1, Math.floor((bodyRows - (showLabels ? 2 : 1)) / LIST_BLOCK_ROWS));
		const effortShown = efforts.length ? Math.min(Math.max(1, effortCount), capacity, efforts.length) : 0;
		const threadShown = Math.max(0, Math.min(threadCount, capacity - effortShown));
		const lines: string[] = [theme.fg("muted", " Efforts"), ...this.effortRows(efforts, width, y + 1, effortShown)];
		if (showLabels) {
			lines.push(theme.fg("muted", ` Active threads · ${threads.length}`));
			lines.push(...this.threadRows(threads, width, y + 1 + effortShown * LIST_BLOCK_ROWS, threadShown));
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
		this.mouse.add({ x: 0, y: baseY, width, height: Math.max(1, visible.length * LIST_BLOCK_ROWS), wheel: (delta) => this.scrollWindow("efforts", delta, naturalStart, efforts.length, Math.max(1, shown)) });
		for (const row of visible) {
			const chosen = !this.selectedThread && row.id === (this.composing ? this.target : this.selected);
			this.mouse.add({ x: 0, y: baseY + lines.length, width, height: LIST_BLOCK_ROWS, click: () => { if (!this.composing) this.select(row.id); } });
			const title = this.effortTitle(row);
			const facts = this.effortFacts(row);
			const key = [width, chosen, this.composing, Math.floor(Date.now() / 60_000), title, facts].join("#");
			lines.push(...this.rowLines("effort", row.id, key, () => listBlock({ title, glyph: this.livenessGlyph(row), glyphColor: this.glyphColor(row), detail: facts, selected: chosen }, width, theme).lines));
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
		this.mouse.add({ x: 0, y: baseY, width, height: Math.max(1, visible.length * LIST_BLOCK_ROWS + 1), wheel: (delta) => this.scrollWindow("threads", delta, naturalThreads, threads.length, Math.max(1, shown)) });
		for (const thread of visible) {
			const chosen = thread.id === this.selectedThread;
			this.mouse.add({ x: 0, y: baseY + 1 + lines.length, width, height: LIST_BLOCK_ROWS, click: () => { if (!this.composing) { this.select(thread.id, true); this.contact(); } } });
			const time = this.time(thread.updatedAt);
			const title = plain(thread.title);
			const purpose = plain(thread.purpose);
			const key = [width, chosen, this.exactTime, Math.floor(Date.now() / 60_000), title, purpose, thread.updatedAt].join("#");
			lines.push(...this.rowLines("thread", thread.id, key, () => listBlock({ title, glyph: "●", glyphColor: "success", detail: purpose, time, timeOnDetail: this.exactTime, selected: chosen }, width, theme).lines));
		}
		return lines;
	}
	/** Every count and bound of the last presence and thread read, in sentences, with what the operator can do. */
	private coverageLines(): string[] {
		if (!this.view) return ["Presence and threads are not read yet."];
		const presence = this.view.presence;
		const p = presence.coverage;
		const threads = this.view.threads;
		const t = threads.coverage;
		const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
		return [
			`Presence, read ${this.readAge()}: ${p.complete ? "complete" : `incomplete (${this.scanReasons() || "reason not reported"})`}.`,
			`The scan visited ${p.visited} of at most ${presence.limits.visits} session entries and lists ${presence.efforts.length} of at most ${presence.limits.results} efforts. It skipped ${plural(p.dead, "ended session", "ended sessions")} and ${plural(p.unrelated, "unrelated entry", "unrelated entries")}; ${p.unreadable} unreadable, ${p.omitted} omitted by the row or size limit.`,
			...(p.complete ? [] : ["Efforts the scan did not reach are not listed. Refresh (r) reads presence again; the bounds stay the same."]),
			"",
			`Threads: ${t.complete ? "complete" : `incomplete (${this.scanReasons(t.reasons) || "reason not reported"})`}.`,
			`The read visited ${t.visited} of at most ${threads.limits.visits} records and lists ${threads.items.length} of at most ${threads.limits.results} active threads; ${t.omittedResults} rows and ${t.omittedHints} hints omitted, ${t.unreadable} unreadable, ${plural(t.missingHints, "record", "records")} without hints${t.unvisited ? ", and some records not visited" : ""}. The Threads tab reads every thread.`,
		];
	}
	/** The right pane: two header lines, one blank row, then the scrolling detail. */
	private detailPane(width: number, height: number, x: number, y: number, includeIntegration: boolean): string[] {
		const theme = this.options.theme;
		const { margin } = readingGeometry(width);
		const pad = " ".repeat(margin);
		const section = this.detailSections(width, x, y, margin, includeIntegration);
		const editor = this.composing ? this.composer.render(width, this.composerCaption()) : [];
		const notice = this.notice && (!this.noticeFor || this.noticeFor === this.selected) ? this.notice : "";
		const noticeLines = notice ? [theme.fg(notice.includes("unavailable") ? "warning" : "muted", truncateToWidth(`${pad}${plain(notice)}`, Math.max(1, width - 1), "…"))] : [];
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
	private detailSections(width: number, x: number, y: number, margin: number, includeIntegration: boolean): { preamble: string[]; bodySource: string[]; timeLine: number } {
		const row = this.row();
		if (this.scanOpen) return { preamble: [this.options.theme.fg("muted", `${" ".repeat(margin)}Scan details`)], bodySource: this.scanBody(width), timeLine: -1 };
		if (!row) {
			const message = this.composing ? `Message target ${plain(this.target ?? "")}: not in the current presence page` : this.view ? "No efforts in this page." : "Reading efforts…";
			return { preamble: [" ".repeat(margin) + clip(message, width - margin - 1)], bodySource: [], timeLine: -1 };
		}
		if (this.selectedThread && !this.composing && !this.detailsOpen) return this.threadSection(width, margin);
		const header = this.detailHeaderLines(row, width, x, y);
		return { preamble: header.lines, bodySource: this.detailBody(row, width, includeIntegration, header.titleCut), timeLine: -1 };
	}
	/** A selected active thread, before it is opened in Threads. */
	private threadSection(width: number, margin: number): { preamble: string[]; bodySource: string[]; timeLine: number } {
		const preamble = this.threadDetails().map((line) => `${" ".repeat(margin)}${clip(line, width - margin - 1)}`);
		const detailTime = this.detailTime();
		const timeLine = detailTime !== undefined ? preamble.findIndex((line) => line.trim() === this.time(detailTime)) : -1;
		return { preamble, bodySource: [], timeLine };
	}
	/** Cached key and value lines for the selected effort; every value is complete and the body scrolls. */
	private detailBody(row: RelatedEffort, width: number, includeIntegration: boolean, titleCut: boolean): string[] {
		const groups = this.detailsOpen ? this.fullGroups(row) : this.defaultGroups(row, includeIntegration, titleCut);
		if (!this.detailsOpen && this.observation !== undefined) groups.unshift(["Observation", this.observation]);
		const key = [row.id, width, includeIntegration, titleCut, this.detailsOpen, this.detailVersion, this.observedAt, Math.floor(Date.now() / 60_000), this.exactTime, this.selectedThread, this.composing, this.target ?? ""].join("#");
		if (this.detailCache?.key !== key) this.detailCache = { key, lines: this.groupLines(groups, width) };
		return this.detailCache.lines;
	}
	/**
	 * The header: the complete title, then presence and recorded activity, then one blank row. A title
	 * longer than three rows ends with an ellipsis and the body then shows the whole purpose.
	 */
	private detailHeaderLines(row: RelatedEffort, width: number, x: number, y: number): { lines: string[]; titleCut: boolean } {
		const theme = this.options.theme;
		const room = Math.max(1, width - 2);
		const title = this.effortTitle(row);
		const facts = this.effortFacts(row);
		let rows = wrapTextWithAnsi(title, room);
		const titleCut = rows.length > 3;
		if (titleCut) rows = [...rows.slice(0, 2), truncateToWidth(`${rows[2] ?? ""} ${rows.slice(3).join(" ")}`, room, "…")];
		const lines = rows.map((part) => ` ${theme.bold(theme.fg("text", part))}`);
		const factsRow = lines.length;
		lines.push(theme.fg("muted", ` ${facts}`));
		this.mouse.add({ x, y: y + factsRow, width, height: 1, click: () => { this.exactTime = !this.exactTime; this.options.redraw(); } });
		lines.push("");
		return { lines, titleCut };
	}
	/** The message field names its recipient by title and short identity; Details keeps the full identity. */
	private composerCaption(): string {
		const target = this.view?.presence.efforts.find((row) => row.id === this.target);
		const id = plain(this.target ?? "");
		const name = target ? `${clip(this.effortTitle(target), 48)} · ${id.slice(0, 8)}` : id;
		return `Operator message to ${name}`;
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
		const detail = this.detailPane(width, detailHeight, 0, 1 + stripRows, withThreads);
		const body = Array.from({ length: bodyRows }, (_, index) => (index < stripRows ? list[index] ?? "" : detail[index - stripRows] ?? ""));
		return [dashboardHeading("Agents > Related efforts", "", width, theme), ...body].slice(0, height).map((line) => fitLine(line, width));
	}
	private fallbackListWidth(width: number): number {
		return Math.max(30, Math.min(36, Math.floor(width * 0.22)));
	}
	render(width: number, height: number, listWidth?: number): string[] {
		this.mouse.reset(width, height);
		this.composer.focused = this.composing;
		// The host gives the view every row above the footer, so 19 rows here is a 20-row terminal.
		if (width < 60 || height < 19) return Array.from({ length: height }, (_, index) => fitLine(index ? "" : "Resize to use Related efforts. Esc back.", width));
		if (width >= 100) return this.renderWide(width, height, listWidth ?? this.fallbackListWidth(width));
		return this.renderTight(width, height);
	}
	invalidate(): void { this.mouse.reset(); this.composer.invalidate(); this.detailCache = undefined; this.rowCache.clear(); }
	dispose(): void { this.disposed = true; this.active = false; this.clearSelectionReads(); this.mouse.reset(); this.detailCache = undefined; this.rowCache.clear(); }
}
