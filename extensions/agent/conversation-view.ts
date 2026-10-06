import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { AwaitFact } from "./await-facts.ts";
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ScrollView } from "@earendil-works/pi-tui";
import type { AgentConversationEntry, AgentConversationSnapshot } from "./dashboard-types.ts";
import type { AgentReadingState } from "./dashboard-state.ts";
import { AgentConversation, type ConversationDocument, renderableEntries } from "./dashboard-conversation.ts";

const ENTRY_LIMIT = 800;
const BYTE_LIMIT = 4 * 1024 * 1024;
/** Bound display input before component construction. The source retains older history. */
export function boundedEntries(entries: readonly AgentConversationEntry[]): AgentConversationEntry[] {
	const visible = renderableEntries(entries);
	const kept: AgentConversationEntry[] = [];
	let bytes = 0;
	for (let index = visible.length - 1; index >= 0 && kept.length < ENTRY_LIMIT; index--) {
		const entry = displayInput(visible[index]);
		const size = JSON.stringify(entry).length * 2;
		if (kept.length && bytes + size > BYTE_LIMIT) break;
		kept.push(entry);
		bytes += size;
	}
	return kept.reverse();
}
function displayInput(entry: AgentConversationEntry): AgentConversationEntry {
	if (JSON.stringify(entry).length * 2 <= BYTE_LIMIT) return entry;
	const text = (entry.model ?? [])
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		)
		.join("\n")
		.slice(0, 65536);
	return {
		id: entry.id,
		kind: entry.kind,
		model: [{ role: "system", content: `${text}\n[Entry display limited: ${entry.kind}]`, timestamp: 0 }],
	};
}
interface HistoryPage {
	upper?: number;
	before?: number | null;
	entries?: AgentConversationEntry[];
	bytes: number;
}
type Snapshot = AgentConversationSnapshot & { nextBefore?: number | null };
/** Cursor metadata outlives evicted input; only a contiguous loaded range is displayed. */
export class ConversationHistory {
	private pages: HistoryPage[] = [];
	private active = 0;
	private range = { start: 0, end: 0 };
	private entryIndex = new Map<string, number>();
	private makePage(entries: readonly AgentConversationEntry[], upper?: number, before?: number | null): HistoryPage {
		const visible = boundedEntries(entries);
		if (visible.length < renderableEntries(entries).length && visible.length) before = Number(visible[0].id);
		return {
			upper,
			before,
			entries: visible,
			bytes: visible.reduce((bytes, entry) => bytes + JSON.stringify(entry).length * 2, 0),
		};
	}
	private anchorIndex(anchor?: string): number {
		return anchor
			? (this.entryIndex.get(anchor) ?? this.entryIndex.get(anchor.split(":")[0]) ?? this.active)
			: this.active;
	}
	private index(): void {
		this.entryIndex.clear();
		this.pages.forEach((page, index) => {
			page.entries?.forEach((entry) => {
				this.entryIndex.set(entry.id, index);
			});
		});
	}
	private bound(anchor?: string): void {
		this.index();
		this.active = this.anchorIndex(anchor);
		let count = this.pages.reduce((total, page) => total + (page.entries?.length ?? 0), 0);
		let bytes = this.pages.reduce((total, page) => total + page.bytes, 0);
		const farthest = this.pages
			.map((_, index) => index)
			.sort((left, right) => Math.abs(right - this.active) - Math.abs(left - this.active));
		for (const index of farthest) {
			if (count <= ENTRY_LIMIT && bytes <= BYTE_LIMIT) break;
			const page = this.pages[index];
			if (!page.entries || index === this.active) continue;
			count -= page.entries.length;
			bytes -= page.bytes;
			if (page.upper === undefined) {
				page.upper = Number(page.entries.at(-1)?.id) + 1;
				this.pages.push({ before: page.upper, bytes: 0 });
			}
			page.entries = undefined;
			page.bytes = 0;
		}
		this.index();
	}
	tail(snapshot: Snapshot, anchor?: string): void {
		if (!this.pages.length) {
			const bounded = this.makePage(snapshot.entries, undefined, snapshot.nextBefore);
			this.pages = [this.makePage([], undefined, bounded.before)];
			this.active = 0;
		}
		const tail = this.pages.at(-1);
		if (!tail?.entries || tail.upper !== undefined) return;
		const entries = [
			...new Map([...tail.entries, ...boundedEntries(snapshot.entries)].map((entry) => [entry.id, entry])).values(),
		];
		const chunks: HistoryPage[] = [];
		let before = tail.before;
		for (let offset = 0; offset < entries.length; offset += 100) {
			const next = entries[offset + 100];
			const upper = next ? Number(next.id) : undefined;
			chunks.push(this.makePage(entries.slice(offset, offset + 100), upper, before));
			before = upper;
		}
		if (!chunks.length) chunks.push(this.makePage([], undefined, tail.before));
		this.pages.splice(this.pages.length - 1, 1, ...chunks);
		if (!anchor) this.active = this.pages.length - 1;
		this.bound(anchor);
	}
	add(snapshot: Snapshot, upper: number | undefined, anchor?: string): void {
		const existing = this.pages.findIndex((page) => page.upper === upper && !page.entries);
		const page = this.makePage(snapshot.entries, upper, snapshot.nextBefore);
		if (existing >= 0) this.pages.splice(existing, 1, page);
		else {
			const next = this.pages.findIndex((range) => range.before === upper);
			const at = next < 0 ? 0 : next;
			this.pages.splice(at, 0, page);
			if (at <= this.active) this.active++;
		}
		this.bound(anchor);
	}
	entries(anchor?: string): AgentConversationEntry[] {
		this.active = this.anchorIndex(anchor);
		let start = this.active;
		let end = this.active;
		while (start > 0 && this.pages[start - 1].entries && this.pages[start - 1].upper === this.pages[start].before)
			start--;
		while (
			end + 1 < this.pages.length &&
			this.pages[end + 1].entries &&
			this.pages[end].upper === this.pages[end + 1].before
		)
			end++;
		this.range = { start, end };
		return this.pages.slice(start, end + 1).flatMap((page) => page.entries ?? []);
	}
	earlier(): number | null | undefined {
		return this.pages[this.range.start]?.before;
	}
	newer(): { upper?: number } | undefined {
		const next = this.pages[this.range.end + 1];
		return next ? { upper: next.entries ? (next.before ?? undefined) : next.upper } : undefined;
	}
	upper(anchor?: string): number | undefined {
		return this.pages[this.anchorIndex(anchor)]?.upper;
	}
	get loadedEntries(): number {
		return this.pages.reduce((count, page) => count + (page.entries?.length ?? 0), 0);
	}
}
function committedAssistant(entries: readonly AgentConversationEntry[], timestamp: number): AgentConversationEntry | undefined {
	return entries.find((entry) => entry.model?.some((message) => message.role === "assistant" && message.timestamp === timestamp));
}
export class ConversationView {
	private transcript?: AgentConversation;
	private document: ConversationDocument = { lines: [], anchors: [] };
	private readonly scroll: ScrollView;
	private restored = false;
	private contentHeight = 0;
	private estimatedHeight = false;
	private cwd = "";
	private expanded?: boolean;
	private showThinking?: boolean;
	private liveIdentity?: { id: string; timestamp: number };
	toolDisplay?: (name: string) => ToolRenderers | undefined;
	private viewport?: { width: number; height: number; top: number };
	private readonly tui: TUI;
	readonly state: AgentReadingState;
	constructor(tui: TUI, state: AgentReadingState) {
		this.tui = tui;
		this.state = state;
		this.scroll = new ScrollView(
			{ render: () => [], invalidate: () => {} },
			{ follow: "end", scrollbar: "hidden", overscroll: "contain" },
		);
	}
	private transferLiveInstance(entries: readonly AgentConversationEntry[]): void {
		const previous = this.liveIdentity;
		if (!previous) return;
		const target = committedAssistant(entries, previous.timestamp);
		if (!target) return;
		this.transcript?.renameEntry(previous.id, target.id);
		const anchor = this.state.anchor;
		if (anchor && (anchor.id === previous.id || anchor.id.startsWith(`${previous.id}:`))) anchor.id = target.id + anchor.id.slice(previous.id.length);
		this.liveIdentity = undefined;
	}
	private liveEntries(committed: readonly AgentConversationEntry[], live: readonly AgentConversationEntry[], ids: Set<string>): AgentConversationEntry[] {
		const generation = live.find((entry) => entry.id === "live:generation");
		const timestamp = generation?.model?.find((message) => message.role === "assistant")?.timestamp;
		const identity = timestamp === undefined ? undefined : { id: `live:generation:${timestamp}`, timestamp };
		const duplicate = timestamp !== undefined && committedAssistant(committed, timestamp) !== undefined;
		if (identity && !duplicate) this.liveIdentity = identity;
		return live.filter((entry) => !ids.has(entry.id) && !(entry === generation && duplicate))
			.map((entry) => entry === generation && identity ? { ...entry, id: identity.id } : entry);
	}
	setContent(entries: readonly AgentConversationEntry[], live: readonly AgentConversationEntry[], cwd: string, awaiting?: AwaitFact): void {
		this.viewport = undefined;
		const committed = boundedEntries(entries);
		const ids = new Set(committed.map((entry) => entry.id));
		this.transferLiveInstance(entries);
		const merged = [...committed, ...this.liveEntries(committed, live, ids)];
		if (!this.transcript || this.cwd !== cwd) {
			this.transcript = new AgentConversation(merged, cwd, this.tui, this.state.expanded, this.state.showThinking, undefined, this.state, this.toolDisplay);
			this.cwd = cwd;
			this.expanded = this.state.expanded;
			this.showThinking = this.state.showThinking;
		} else this.transcript.update(merged);
		if (this.expanded !== this.state.expanded) this.transcript.setExpanded(this.state.expanded);
		if (this.showThinking !== this.state.showThinking) this.transcript.setShowThinking(this.state.showThinking);
		this.expanded = this.state.expanded;
		this.showThinking = this.state.showThinking;
		this.transcript.setAwaiting(awaiting);
		if (!this.state.follow) this.restored = false;
	}
	render(width: number, height: number): string[] {
		if (!this.transcript) return Array.from({ length: height }, () => "");
		const anchor = !this.state.follow ? this.state.anchor : undefined;
		const window = this.transcript.renderWindow(
			width,
			this.restored ? this.scroll.scrollTop : this.state.scroll,
			height,
			this.state.follow,
			anchor,
		);
		this.viewport = { width, height, top: window.top };
		this.document = { lines: [], anchors: window.anchors };
		if (!this.state.follow) this.state.scroll = window.top;
		this.contentHeight = window.height;
		this.estimatedHeight = window.estimated;
		this.scroll.updateLayout(window.height, height, () => this.tui.requestRender());
		this.restored = true;
		this.scroll.scrollTo(window.top, { disableFollow: !this.state.follow });
		if (this.state.follow) this.scroll.scrollToEnd();
		return window.lines;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const viewport = this.viewport;
		if (!viewport || event.width !== viewport.width || event.height !== viewport.height || event.x < 0 || event.x >= viewport.width || event.y < 0 || event.y >= viewport.height) return;
		const item = this.transcript?.handleMouse({ ...event, y: viewport.top + event.y });
		if (!item) return;
		this.state.follow = false;
		this.scroll.scrollTo(viewport.top, { disableFollow: true });
		this.state.scroll = viewport.top;
		this.state.anchor = { id: item.id, offset: Math.min(viewport.top - item.line, item.targetOffset ?? Infinity) };
		this.restored = false;
		this.viewport = undefined;
		return { handled: true, render: true };
	}
	page(delta: number): void {
		this.scroll.scrollBy(delta);
		if (delta > 0 && this.atBottom()) this.scroll.scrollToEnd();
		this.save();
	}
	position(): { first: number; last: number; total: number; end: boolean; estimated: boolean } {
		return {
			first:
				this.contentHeight && this.scroll.viewportHeight ? Math.min(this.contentHeight, this.scroll.scrollTop + 1) : 0,
			last: this.scroll.viewportHeight
				? Math.min(this.contentHeight, this.scroll.scrollTop + this.scroll.viewportHeight)
				: 0,
			total: this.contentHeight,
			end: this.atBottom(),
			estimated: this.estimatedHeight,
		};
	}
	atTop(): boolean {
		return this.scroll.scrollTop === 0;
	}
	atBottom(): boolean {
		return this.scroll.scrollTop >= this.contentHeight - this.scroll.viewportHeight;
	}
	reanchor(): void {
		this.restored = false;
	}
	save(): void {
		if (!this.restored) return;
		this.state.follow = this.scroll.isFollowingEnd;
		this.state.scroll = this.scroll.scrollTop;
		if (!this.state.follow && this.state.anchor && this.viewport?.top === this.state.scroll) return;
		const anchor = [...this.document.anchors].reverse().find((item) => item.line <= this.state.scroll);
		this.state.anchor =
			!this.state.follow && anchor ? { id: anchor.id, offset: this.state.scroll - anchor.line } : undefined;
	}
	invalidate(): void {
		this.viewport = undefined;
		this.transcript?.invalidate();
		this.restored = false;
	}
}
