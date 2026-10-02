/**
 * One peer pane: title and status, a bounded transcript viewport, the native
 * composer, and a compact footer. The pane renders exactly the height the
 * window allocates; ScrollView supplies clamping and follow, and this wrapper
 * slices the visible lines because an overlay is not a constrained layout root.
 */
import { basename } from "node:path";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { AgentConversation } from "./dashboard-conversation.ts";
import type { PeerDescriptor, PeerDocument, PeerKind, PeerPaneState, PeerTranscript, PeerTranscriptFactory } from "./peer-contract.ts";
import { PeerComposer } from "./peer-composer.ts";
import { footerText, modelText, stateText } from "./peer-footer.ts";
import { renderPeerNoticeCard } from "./tool-cards.ts";

/** Default transcript renderer: the shared Durable conversation view with Pi components. */
export const agentConversationTranscripts: PeerTranscriptFactory = {
	create: (input) => new AgentConversation(input.entries, input.cwd, input.tui, input.expanded, input.showThinking, input.renderCustom),
};

/** Holds the current transcript so ScrollView's single child can be swapped. */
class DocumentHolder implements Component {
	transcript: PeerTranscript;
	document?: PeerDocument;
	constructor(transcript: PeerTranscript) {
		this.transcript = transcript;
	}
	render(width: number): string[] {
		this.document = this.transcript.render(width);
		return this.document.lines;
	}
	invalidate(): void {
		this.transcript.invalidate();
	}
}

/** Concatenates the stable committed document with the small live tail. */
export class MergedTranscript implements PeerTranscript {
	private readonly head: PeerTranscript;
	private readonly live: PeerTranscript;
	constructor(head: PeerTranscript, live: PeerTranscript) {
		this.head = head;
		this.live = live;
	}
	render(width: number): PeerDocument {
		const head = this.head.render(width);
		const live = this.live.render(width);
		if (!live.lines.length) return head;
		const lines = head.lines.length ? [...head.lines, ""] : [];
		const offset = lines.length;
		const anchors = [...head.anchors, ...live.anchors.map((anchor) => ({ id: anchor.id, line: anchor.line + offset }))];
		lines.push(...live.lines);
		return { lines, anchors };
	}
	invalidate(): void {
		this.head.invalidate();
		this.live.invalidate();
	}
}

function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	const visible = visibleWidth(line);
	if (visible > width) return truncateToWidth(line, width);
	return line + " ".repeat(width - visible);
}

function emptyTranscript(): PeerTranscript {
	return { render: () => ({ lines: [], anchors: [] }), invalidate: () => {} };
}

export interface PeerPaneContent {
	entries: readonly AgentConversationEntry[];
	revision: string;
	live: readonly AgentConversationEntry[];
	liveRevision: string;
	cwd: string;
	expanded: boolean;
	showThinking: boolean;
}

export interface PeerPaneOptions {
	key: string;
	kind: PeerKind;
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	factory: PeerTranscriptFactory;
	state: PeerPaneState;
	onSubmit(text: string): void;
	onEscape(): void;
}

export class PeerPane {
	readonly key: string;
	readonly kind: PeerKind;
	readonly composer: PeerComposer;
	descriptor?: PeerDescriptor;
	notice?: string;
	/** Earlier-page status, shown on the pane status line. */
	pagination?: string;
	error?: string;
	submitting = false;
	/** True when this pane's peer holds a replaced native editor draft for explicit restore. */
	nativeDraftSaved = false;

	private readonly options: PeerPaneOptions;
	private readonly holder: DocumentHolder;
	private readonly scroll: ScrollView;
	private readonly state: PeerPaneState;
	private head?: PeerTranscript;
	private live?: PeerTranscript;
	private headKey?: string;
	private liveKey?: string;
	private restored = false;
	private focusedFlag = false;

	constructor(options: PeerPaneOptions) {
		this.options = options;
		this.key = options.key;
		this.kind = options.kind;
		this.state = options.state;
		this.composer = new PeerComposer({
			tui: options.tui,
			theme: options.theme,
			keys: options.keys,
			onSubmit: (text) => options.onSubmit(text),
			onChange: (text) => { if (text.trim() !== "" && !text.startsWith("/")) this.state.draft = text; },
			onEscape: () => options.onEscape(),
		});
		this.composer.setText(options.state.draft);
		this.holder = new DocumentHolder(emptyTranscript());
		this.scroll = new ScrollView(this.holder, { follow: "end", scrollbar: "hidden", overscroll: "contain" });
	}

	get focused(): boolean {
		return this.focusedFlag;
	}

	focus(): void {
		this.focusedFlag = true;
		this.composer.focused = true;
	}
	blur(): void {
		this.focusedFlag = false;
		this.composer.focused = false;
	}

	/** Replace the rendered content; a new revision rebuilds only the changed transcript part. */
	setContent(content: PeerPaneContent): void {
		const headKey = `${content.revision}:${content.expanded ? 1 : 0}:${content.showThinking ? 1 : 0}`;
		if (!this.head || headKey !== this.headKey) {
			this.head = this.options.factory.create({ entries: content.entries, cwd: content.cwd, tui: this.options.tui, expanded: content.expanded, showThinking: content.showThinking, renderCustom: (entry) => this.customEntry(entry) });
			this.headKey = headKey;
		}
		if (!this.live || content.liveRevision !== this.liveKey) {
			this.live = content.live.length ? this.options.factory.create({ entries: content.live, cwd: content.cwd, tui: this.options.tui, expanded: content.expanded, showThinking: content.showThinking, renderCustom: (entry) => this.customEntry(entry) }) : emptyTranscript();
			this.liveKey = content.liveRevision;
		}
		this.holder.transcript = new MergedTranscript(this.head, this.live);
	}

	/** Agent peer notices render through the same card as the native chat. */
	private customEntry(entry: AgentConversationEntry): Component | undefined {
		const data = entry.data as { customType?: unknown; content?: unknown; details?: unknown } | undefined;
		if (data?.customType !== "agent.peer") return undefined;
		return renderPeerNoticeCard({ content: data.content, details: data.details, timestamp: 0 }, this.options.theme, this.state.view.expanded);
	}

	setDescriptor(descriptor: PeerDescriptor | undefined): void {
		this.descriptor = descriptor;
	}

	scrollLines(delta: number): void {
		this.scroll.scrollBy(delta);
		this.captureView();
	}

	followTail(): void {
		this.scroll.scrollToEnd();
		this.captureView();
	}

	/** True when the reading position is at the first loaded line, before any earlier page. */
	atTop(): boolean {
		return this.scroll.viewportHeight > 0 && this.scroll.scrollTop <= 0;
	}

	/** Re-apply the saved anchor after a prepend, so the reading position stays. */
	reanchor(): void {
		if (!this.state.view.follow) this.restored = false;
	}

	/** Persist the composer draft text into the shared state. */
	saveDraft(): void {
		if (!this.submitting) this.state.draft = this.composer.getText();
	}

	/** Persist follow state and the anchor block under the current reading position. */
	captureView(): void {
		const view = this.state.view;
		view.follow = this.scroll.isFollowingEnd;
		view.scroll = this.scroll.scrollTop;
		if (view.follow || !this.holder.document) {
			view.anchor = undefined;
			return;
		}
		const anchors = this.holder.document.anchors;
		view.anchor = undefined;
		for (let index = anchors.length - 1; index >= 0; index--) {
			const anchor = anchors[index];
			if (anchor.line <= this.scroll.scrollTop) {
				view.anchor = { id: anchor.id, offset: this.scroll.scrollTop - anchor.line };
				return;
			}
		}
	}

	private restoreView(): void {
		if (this.restored) return;
		this.restored = true;
		const view = this.state.view;
		const anchorState = view.anchor;
		if (view.follow) this.scroll.scrollToEnd();
		else if (anchorState && this.holder.document) {
			const anchor = this.holder.document.anchors.find((item) => item.id === anchorState.id);
			if (anchor) this.scroll.scrollTo(anchor.line + anchorState.offset, { disableFollow: true });
			else this.scroll.scrollTo(view.scroll, { disableFollow: true });
		} else this.scroll.scrollTo(view.scroll, { disableFollow: true });
	}

	private header(width: number): string[] {
		const theme = this.options.theme;
		const descriptor = this.descriptor;
		const name = descriptor ? (descriptor.kind === "primary" ? `Primary · ${descriptor.name}` : `Agent · ${descriptor.name}`) : this.kind === "primary" ? "Primary" : "Agent";
		const marker = this.focusedFlag ? theme.fg("accent", "▌") : theme.fg("dim", "▌");
		const suffix = descriptor?.kind === "primary" && descriptor.detail ? `  ${descriptor.detail}` : "";
		const titleText = `${marker} ${theme.bold(truncateToWidth(`${name}${suffix}`, Math.max(0, width - 2)))}`;
		const status = descriptor
			? [basename(descriptor.cwd) || descriptor.cwd, modelText(descriptor), stateText(descriptor.state), this.pagination, this.notice ?? (this.submitting ? "sending…" : undefined)].filter(Boolean).join(" · ")
			: this.error ?? "loading…";
		return [fitLine(titleText, width), fitLine(theme.fg(this.error ? "warning" : "muted", truncateToWidth(status, width)), width)];
	}

	render(width: number, height: number = this.options.tui.terminal.rows): string[] {
		width = Math.max(1, Math.floor(width));
		height = Math.max(0, Math.floor(height));
		if (height === 0) return [];
		const theme = this.options.theme;
		const header = this.header(width);
		const footer = fitLine(theme.fg("dim", truncateToWidth(this.descriptor ? footerText(this.descriptor, { mode: this.state.mode, notice: this.notice, nativeDraft: this.nativeDraftSaved }) : this.error ?? "", width)), width);
		const available = Math.max(0, height - header.length - 1);
		const composerLines = this.composer.render(width);
		const composerKeep = Math.min(composerLines.length, Math.max(0, available - 1));
		const transcriptHeight = Math.max(0, available - composerKeep);
		const lines = this.scroll.render(width);
		this.scroll.updateLayout(lines.length, transcriptHeight, () => this.options.tui.requestRender());
		this.restoreView();
		const top = transcriptHeight > 0 ? this.scroll.scrollTop : 0;
		const visible = lines.slice(top, top + transcriptHeight);
		// The transcript viewport owns every row between the header and the composer; short
		// content stays at its top and the remaining rows stay blank above the composer.
		const viewport = Array.from({ length: transcriptHeight }, (_, index) => visible[index] ?? "");
		const out = [...header, ...viewport, ...composerLines.slice(0, composerKeep), footer];
		if (out.length > height) out.length = height;
		while (out.length < height) out.push(" ".repeat(width));
		return out.map((line) => fitLine(line, width));
	}

	invalidate(): void {
		this.head?.invalidate();
		this.live?.invalidate();
		this.composer.invalidate();
	}
}
