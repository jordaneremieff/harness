import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import type { CollaborationList, CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { AgentComposer } from "./agent-composer.ts";
import { fitHints, fitLine } from "./dashboard-layout.ts";

export type Collaborate = (input: Record<string, unknown>) => Promise<unknown>;
type Discovery = CollaborationList & { sources?: Array<{ sessionId: string; omitted: number; unavailable: boolean }> };
export interface CollaborationViewState {
	selected?: string;
	exactTime: boolean;
	drafts: Map<
		string,
		{ text: string; revision: number; notify: string[]; pending: boolean; request?: { id: string; content: string } }
	>;
}
export function createCollaborationViewState(): CollaborationViewState {
	return { drafts: new Map(), exactTime: false };
}
const listeners = new WeakMap<CollaborationViewState, Set<() => void>>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");
const number = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function summary(value: unknown): value is CollaborationSummary {
	return (
		object(value) &&
		["id", "title", "purpose"].every((key) => typeof value[key] === "string") &&
		number(value.updatedAt) &&
		typeof value.closed === "boolean" &&
		number(value.members)
	);
}
function discovery(value: unknown): value is Discovery {
	return (
		object(value) &&
		Array.isArray(value.items) &&
		value.items.every(summary) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		object(value.coverage) &&
		typeof value.coverage.complete === "boolean" &&
		number(value.coverage.visited) &&
		number(value.coverage.omitted) &&
		(value.coverage.unavailable === undefined || number(value.coverage.unavailable)) &&
		(value.sources === undefined ||
			(Array.isArray(value.sources) &&
				value.sources.every(
					(item) =>
						object(item) &&
						typeof item.sessionId === "string" &&
						number(item.omitted) &&
						typeof item.unavailable === "boolean",
				)))
	);
}
function receiptSequence(value: unknown, threadId: string): number {
	if (!object(value) || value.threadId !== threadId || !number(value.sequence) || typeof value.deduped !== "boolean")
		throw new Error("The host returned an invalid post receipt. Read the thread before retry.");
	return value.sequence;
}
function threadPage(value: unknown): value is CollaborationPage {
	if (!object(value) || !object(value.thread) || !Array.isArray(value.events) || !object(value.coverage)) return false;
	const thread = value.thread;
	return (
		["id", "title", "purpose", "authority", "source", "restrictions", "acceptance", "integrator", "creator"].every(
			(key) => typeof thread[key] === "string",
		) &&
		["revision", "sequence", "createdAt", "updatedAt"].every((key) => number(thread[key])) &&
		typeof thread.closed === "boolean" &&
		Array.isArray(thread.members) &&
		thread.members.every(
			(item) =>
				object(item) &&
				typeof item.identity === "string" &&
				typeof item.contribution === "string" &&
				number(item.joinedAt),
		) &&
		value.events.every(
			(event) =>
				object(event) &&
				["threadId", "sender", "kind", "message", "source"].every((key) => typeof event[key] === "string") &&
				(event.origin === "operator" || event.origin === "model") &&
				["sequence", "at", "revision"].every((key) => number(event[key])) &&
				(event.replyTo === null || number(event.replyTo)) &&
				strings(event.notify),
		) &&
		(value.nextBefore === null || number(value.nextBefore)) &&
		number(value.pending) &&
		typeof value.coverage.complete === "boolean" &&
		number(value.coverage.bytes)
	);
}
/** Treat thread text as text, not terminal control sequences. */
function plain(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : " "));
}

interface CollaborationViewOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	state: CollaborationViewState;
	collaborate: Collaborate;
	nameFor(id: string): string;
	selectedAgent(): string | undefined;
	redraw(): void;
	onBack(): void;
}
/** Reads are bounded pages; roster notifications supply refresh, never a private timer. */
export class CollaborationView {
	private list?: Discovery;
	private page?: CollaborationPage;
	private screen: "list" | "thread" | "compose" | "notify" = "list";
	private index = 0;
	private memberIndex = 0;
	private offset = 0;
	private follow = false;
	private before?: number;
	private scope?: string;
	private generation = 0;
	private pending = false;
	private again = false;
	private disposed = false;
	private notice = "";
	private readonly composer: AgentComposer;
	private readonly options: CollaborationViewOptions;
	constructor(options: CollaborationViewOptions) {
		this.options = options;
		let current = listeners.get(options.state);
		if (!current) {
			current = new Set();
			listeners.set(options.state, current);
		}
		current.add(options.redraw);
		this.composer = new AgentComposer({
			...options,
			onSubmit: (text) => {
				void this.post(text);
			},
			onEscape: () => this.back(),
			onChange: (text) => {
				const draft = this.draft();
				if (draft && draft.text !== text) {
					draft.text = text;
					draft.revision++;
				}
			},
		});
	}
	private nameFor(id: string): string {
		return plain(this.options.nameFor(id));
	}
	private draft() {
		const id = this.options.state.selected;
		if (!id) return undefined;
		let draft = this.options.state.drafts.get(id);
		if (!draft) {
			draft = { text: "", revision: 0, notify: [], pending: false };
			this.options.state.drafts.set(id, draft);
		}
		return draft;
	}
	open(): void {
		this.screen = "list";
		void this.refresh();
	}
	private async call(input: Record<string, unknown>): Promise<unknown> {
		return this.options.collaborate(input);
	}
	private current(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}
	private async readList(generation: number, cursor?: string): Promise<void> {
		const result = await this.call({
			action: "list",
			...(this.scope ? { sessionId: this.scope } : {}),
			...(cursor ? { cursor } : {}),
		});
		if (!this.current(generation)) return;
		if (!discovery(result)) throw new Error("The host returned an invalid thread list. Restart the Pi window or host.");
		this.list = cursor && this.list ? this.mergeList(this.list, result) : result;
		this.index = Math.min(this.index, Math.max(0, this.choices().length - 1));
	}
	private mergeList(previous: Discovery, result: Discovery): Discovery {
		return {
			...result,
			items: [...new Map([...previous.items, ...result.items].map((item) => [item.id, item])).values()],
			sources: [
				...new Map(
					[...(previous.sources ?? []), ...(result.sources ?? [])].map((item) => [item.sessionId, item]),
				).values(),
			],
		};
	}
	private async readPage(generation: number): Promise<void> {
		const id = this.options.state.selected;
		if (!id) return;
		const result = await this.call({ action: "read", threadId: id, ...(this.before ? { before: this.before } : {}) });
		if (!this.current(generation)) return;
		if (!threadPage(result) || result.thread.id !== id)
			throw new Error("The host returned an invalid thread page. Restart the Pi window or host.");
		this.page = result;
	}
	async refresh(cursor?: string): Promise<void> {
		if (this.disposed) return;
		if (this.pending) {
			this.again = true;
			return;
		}
		this.pending = true;
		const generation = this.generation;
		try {
			if (this.screen === "list") await this.readList(generation, cursor);
			else await this.readPage(generation);
		} catch (error) {
			if (this.current(generation)) this.notice = `Threads unavailable: ${String(error)}`;
		} finally {
			this.pending = false;
			this.refreshFinished();
		}
	}
	private refreshFinished(): void {
		if (this.disposed) return;
		this.options.redraw();
		if (this.again) {
			this.again = false;
			void this.refresh();
		}
	}
	private choices(): Array<{ label: string; thread?: string; scope?: string; cursor?: string }> {
		return [
			...(this.list?.items ?? []).map((item) => ({
				label: `${item.closed ? "Closed" : "Open"} · ${plain(item.title)} · ${item.members} peers\n${plain(item.purpose)}`,
				thread: item.id,
			})),
			...(this.list?.sources ?? []).map((item) => ({
				label: `Read storage of ${this.nameFor(item.sessionId)} · ${item.unavailable ? "catalog unavailable" : `${item.omitted} threads omitted`}`,
				scope: item.sessionId,
			})),
			...(this.list?.nextCursor ? [{ label: "Load more thread discovery", cursor: this.list.nextCursor }] : []),
		];
	}
	private choose(): void {
		const choice = this.choices()[this.index];
		if (choice?.cursor) {
			void this.refresh(choice.cursor);
			return;
		}
		if (choice?.scope) {
			this.setScope(choice.scope);
			return;
		}
		if (!choice?.thread) return;
		this.options.state.selected = choice.thread;
		this.screen = "thread";
		this.page = undefined;
		this.before = undefined;
		this.offset = 0;
		this.follow = false;
		this.generation++;
		void this.refresh();
	}
	private setScope(scope?: string): void {
		this.scope = scope;
		this.list = undefined;
		this.index = 0;
		this.generation++;
		void this.refresh();
	}
	private compose(): void {
		if (!this.page || this.page.thread.closed) return;
		this.composer.setText(this.draft()?.text ?? "");
		this.screen = "compose";
	}
	private async post(message: string): Promise<void> {
		const draft = this.draft();
		const threadId = this.options.state.selected;
		if (!draft || !threadId || draft.pending) return;
		const revision = draft.revision;
		const content = JSON.stringify([revision, message, draft.notify]);
		if (draft.request?.content !== content) draft.request = { id: randomUUID(), content };
		draft.pending = true;
		this.notice = "Retain post…";
		this.options.redraw();
		try {
			const result = await this.call({
				action: "post",
				threadId,
				message,
				notify: [...draft.notify],
				origin: "operator",
				requestId: draft.request.id,
			});
			const sequence = receiptSequence(result, threadId);
			draft.request = undefined;
			if (draft.revision === revision) {
				draft.text = "";
				draft.notify = [];
				draft.revision++;
			}
			if (!this.disposed && threadId === this.options.state.selected) {
				this.composer.setText(draft.text);
				if (draft.revision === revision + 1 && draft.text === "") this.screen = "thread";
				this.before = undefined;
				this.offset = Number.MAX_SAFE_INTEGER;
				this.follow = true;
				this.notice = `Post ${sequence} retained. Notification does not prove a response.`;
				void this.refresh();
			}
		} catch (error) {
			if (!this.disposed) this.notice = `Post failed: ${String(error)}. Your draft stays.`;
		} finally {
			draft.pending = false;
			for (const listener of listeners.get(this.options.state) ?? []) listener();
		}
	}
	private back(): void {
		if (this.screen === "notify") this.screen = "compose";
		else if (this.screen === "compose") this.screen = "thread";
		else if (this.screen === "thread") {
			this.screen = "list";
			this.generation++;
			void this.refresh();
		} else if (this.scope) this.setScope();
		else this.options.onBack();
	}
	private composeInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.screen = "notify";
			this.memberIndex = 0;
		} else this.composer.handleInput(data);
	}
	private toggleMember(): void {
		const id = this.page?.thread.members[this.memberIndex]?.identity;
		const draft = this.draft();
		if (!id || !draft) return;
		if (draft.notify.includes(id)) draft.notify = draft.notify.filter((item) => item !== id);
		else if (draft.notify.length < 16) draft.notify.push(id);
		else return;
		draft.revision++;
	}
	private notifyInput(data: string): void {
		const members = this.page?.thread.members ?? [];
		if (matchesKey(data, "up") || matchesKey(data, "down"))
			this.memberIndex = Math.max(
				0,
				Math.min(members.length - 1, this.memberIndex + (matchesKey(data, "up") ? -1 : 1)),
			);
		if (data === " " || matchesKey(data, "enter")) this.toggleMember();
		if (matchesKey(data, "tab")) this.screen = "compose";
	}
	private listInput(data: string): void {
		if (matchesKey(data, "up") || matchesKey(data, "down"))
			this.index = Math.max(0, Math.min(this.choices().length - 1, this.index + (matchesKey(data, "up") ? -1 : 1)));
		if (matchesKey(data, "enter")) this.choose();
		if (data === "s" && this.options.selectedAgent()) this.setScope(this.options.selectedAgent());
		if (data === "r") void this.refresh();
	}
	private beginPost(notify: boolean): void {
		if (!this.page || this.page.thread.closed) return;
		if (!notify) {
			const draft = this.draft();
			if (draft?.notify.length) {
				draft.notify = [];
				draft.revision++;
			}
		}
		this.compose();
		if (notify) this.screen = "notify";
	}
	private latest(): void {
		this.before = undefined;
		this.offset = Number.MAX_SAFE_INTEGER;
		this.follow = true;
		this.generation++;
		void this.refresh();
	}
	private earlier(): void {
		if (!this.page?.nextBefore) return;
		this.before = this.page.nextBefore;
		this.offset = 0;
		this.follow = false;
		this.generation++;
		void this.refresh();
	}
	private threadInput(data: string): void {
		const actions: Record<string, () => void> = {
			p: () => this.beginPost(false),
			n: () => this.beginPost(true),
			r: () => this.latest(),
			b: () => this.earlier(),
			i: () => {
				this.options.state.exactTime = !this.options.state.exactTime;
			},
			f: () => {
				this.offset = 0;
				this.follow = false;
			},
			e: () => {
				this.offset = Number.MAX_SAFE_INTEGER;
				this.follow = true;
			},
		};
		if (actions[data]) {
			actions[data]();
			return;
		}
		const changes = {
			up: -1,
			down: 1,
			pageUp: -Math.max(1, this.options.tui.terminal.rows - 8),
			pageDown: Math.max(1, this.options.tui.terminal.rows - 8),
		};
		for (const [key, delta] of Object.entries(changes))
			if (matchesKey(data, key as "up")) {
				this.offset += delta;
				this.follow = false;
			}
		if (matchesKey(data, "home")) {
			this.offset = 0;
			this.follow = false;
		}
		if (matchesKey(data, "end")) {
			this.offset = Number.MAX_SAFE_INTEGER;
			this.follow = true;
		}
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		const routes = {
			compose: () => this.composeInput(data),
			notify: () => this.notifyInput(data),
			list: () => this.listInput(data),
			thread: () => this.threadInput(data),
		};
		routes[this.screen]();
	}
	private eventTime(at: number): string {
		const date = new Date(at);
		return this.options.state.exactTime
			? date.toISOString()
			: `${date.toLocaleString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit",
					hour12: true,
				})} (local)`;
	}
	private threadLines(): string[] {
		const page = this.page;
		if (!page) return ["Read thread…"];
		const t = page.thread;
		return [
			plain(t.title),
			`${t.closed ? "Closed" : "Open"} · Frame revision ${t.revision}`,
			`Purpose: ${plain(t.purpose)}`,
			`Carried authority (claim): ${plain(t.authority)}`,
			`Authority source: ${plain(t.source)}`,
			`Restrictions: ${plain(t.restrictions)}`,
			`Acceptance: ${plain(t.acceptance)}`,
			`Integrator: ${this.nameFor(t.integrator)}`,
			"",
			"Peers",
			...t.members.map(
				(member) =>
					`${this.nameFor(member.identity)} [${member.identity}] · ${plain(member.contribution) || "No current contribution"}`,
			),
			"",
			"Exchange (chronological)",
			...(this.before ? ["Earlier page. r reads latest."] : []),
			...page.events.flatMap((event) => [
				`#${event.sequence} · ${this.nameFor(event.sender)} [${event.sender}] · ${event.origin} · ${plain(event.kind)} · frame ${event.revision}`,
				`Time: ${this.eventTime(event.at)}${event.replyTo ? ` · Reply to #${event.replyTo}` : ""}`,
				...(event.source ? [`Source: ${plain(event.source)}`] : []),
				plain(event.message),
				...(event.notify.length ? [`Notify: ${event.notify.map((id) => this.nameFor(id)).join(", ")}`] : []),
				"",
			]),
			`Notification intents pending: ${page.pending} · ${page.coverage.complete ? "Page complete" : "Page bounded"}${page.nextBefore ? " · b reads earlier" : ""}`,
		];
	}
	private listLines(width: number, height: number): string[] {
		const choices = this.choices();
		if (!choices.length)
			return [
				this.pending ? "Read thread discovery…" : "No threads in this page. Coverage below does not prove absence.",
			];
		const blocks = choices.map((choice, index) =>
			wrapTextWithAnsi(`${index === this.index ? "›" : " "} ${choice.label}`, width),
		);
		const selectedLine = blocks.slice(0, this.index).reduce((total, block) => total + block.length, 0);
		return blocks.flat().slice(Math.max(0, selectedLine - Math.floor(height / 3)));
	}
	private notifyLines(height: number): string[] {
		const members = this.page?.thread.members ?? [];
		const lines = members.map(
			(member, index) =>
				`${index === this.memberIndex ? "›" : " "} [${this.draft()?.notify.includes(member.identity) ? "x" : " "}] ${this.nameFor(member.identity)} [${member.identity}]`,
		);
		const start = Math.max(0, this.memberIndex - height + 3);
		return ["Select peers to notify. Each selected peer receives a steer. No automatic reply.", ...lines.slice(start)];
	}
	private bodyLines(width: number, height: number): string[] {
		if (this.screen === "list") return this.listLines(width, height);
		if (this.screen === "notify") return this.notifyLines(height);
		const lines = this.threadLines().flatMap((line) => wrapTextWithAnsi(line, width));
		this.offset = this.follow
			? Math.max(0, lines.length - height)
			: Math.max(0, Math.min(this.offset, Math.max(0, lines.length - height)));
		return lines.slice(this.offset);
	}
	private status(): string {
		if (this.screen !== "list")
			return `${this.draft()?.pending ? "Post pending" : "Post wakes nobody by default"} · Notify: ${
				this.draft()
					?.notify.map((id) => this.nameFor(id))
					.join(", ") || "nobody"
			}`;
		const coverage = this.list?.coverage;
		const scope = this.scope ? `Storage: ${this.nameFor(this.scope)}` : "Catalog discovery";
		if (!coverage) return `${scope} · Coverage unknown`;
		return `${scope} · ${coverage.complete ? "Complete" : "Partial"} · ${coverage.omitted} omitted · ${coverage.unavailable ?? 0} unavailable`;
	}
	private hints(): string[] {
		const hints = {
			list: ["↑↓ select", "Enter read", "s selected storage", "r refresh"],
			notify: ["↑↓ select", "Space/Enter toggle", "Tab write"],
			compose: ["Enter post", "Tab notify", "Ctrl+J newline"],
			thread: [
				"p post",
				"n notify",
				this.options.state.exactTime ? "i local time" : "i exact UTC",
				"PgUp/PgDn read",
				"f frame",
				"e exchange",
				"b earlier",
				"r latest",
			],
		};
		return hints[this.screen];
	}
	render(width: number, height: number): string[] {
		if (this.screen === "compose" && this.composer.getText() !== this.draft()?.text)
			this.composer.setText(this.draft()?.text ?? "");
		this.composer.focused = this.screen === "compose";
		const editor = this.screen === "compose" ? this.composer.render(width) : [];
		const bodyHeight = Math.max(1, height - 5 - editor.length);
		const lines = this.bodyLines(width, bodyHeight);
		return [
			"Agents > Threads",
			this.status(),
			...Array.from({ length: bodyHeight }, (_, i) => lines[i] ?? ""),
			...editor,
			this.notice,
			fitHints(this.hints(), "Esc back", width),
			"",
		].map((line) => fitLine(line, width));
	}
	invalidate(): void {
		this.composer.invalidate();
	}
	dispose(): void {
		this.disposed = true;
		listeners.get(this.options.state)?.delete(this.options.redraw);
		this.generation++;
	}
}
