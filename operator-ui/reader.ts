import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { HitMap } from "./hits.ts";
import { fitLine, wrap } from "./text.ts";
import type { Action, KeyHint, OperatorView, ViewHost } from "./view.ts";

/** Text, display lines, or lines laid out for a given width, for example rendered Markdown. */
export type ReaderContent = string | readonly string[] | ((width: number) => readonly string[]);

/** One laid-out string: the content it came from, the effective body width, and its lines. */
export interface TextLayout {
	readonly text: string;
	readonly width: number;
	readonly lines: readonly string[];
}

/** The one retained layout holds at most this input and this many display lines. */
const MAX_LAYOUT_INPUT = 1_048_576;
const MAX_LAYOUT_LINES = 32_768;

/**
 * Lay out one immutable string at the effective body width, reusing `cached` when both match.
 * Equal content at an equal width keeps its layout even when it arrives as a new string. An
 * input or a result beyond the retained bounds is returned but not kept.
 */
export function layoutText(
	cached: TextLayout | undefined,
	text: string,
	width: number,
): { layout: TextLayout | undefined; lines: readonly string[] } {
	if (cached && cached.text === text && cached.width === width) return { layout: cached, lines: cached.lines };
	const lines = wrap(text, width);
	return text.length <= MAX_LAYOUT_INPUT && lines.length <= MAX_LAYOUT_LINES
		? { layout: { text, width, lines }, lines }
		: { layout: undefined, lines };
}

/**
 * Read-only scrolling text. Content is wrapped to the width it is given; the reading position
 * stays while the content key stays the same, so a refresh of the same record does not jump.
 * One string layout is retained between renders; a changed text or width replaces it.
 */
export class Reader {
	focused = false;
	private source: ReaderContent = "";
	private key?: string;
	private offset = 0;
	private height = 1;
	private total = 0;
	private layout?: TextLayout;

	/** Replace the content. A different `key` starts at the top; the same key keeps the position. */
	setContent(content: ReaderContent, key?: string): void {
		if (key === undefined || key !== this.key) this.offset = 0;
		this.key = key;
		this.source = content;
		if (typeof content !== "string") this.layout = undefined;
	}

	get position(): { first: number; last: number; total: number } {
		return { first: this.offset + 1, last: Math.min(this.total, this.offset + this.height), total: this.total };
	}

	scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset + delta));
	}

	private lines(width: number): readonly string[] {
		if (typeof this.source === "string") {
			const laid = layoutText(this.layout, this.source, width);
			this.layout = laid.layout;
			return laid.lines;
		}
		this.layout = undefined;
		const lines = typeof this.source === "function" ? this.source(width) : this.source;
		return lines.flatMap((line) => wrap(line, width));
	}

	render(width: number, height: number, theme: Theme, hits: HitMap, x0: number, y0: number): string[] {
		this.height = Math.max(1, height);
		const scrollbar = width > 8;
		const body = this.lines(scrollbar ? width - 1 : width);
		this.total = body.length;
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset));
		const visible = body.slice(this.offset, this.offset + this.height);
		const overflow = this.total > this.height;
		const thumb = overflow ? Math.max(1, Math.round((this.height * this.height) / this.total)) : 0;
		const thumbTop = overflow ? Math.round(((this.height - thumb) * this.offset) / Math.max(1, this.total - this.height)) : 0;
		hits.add({ x: x0, y: y0, width, height: this.height, wheel: (delta) => this.scroll(delta) });
		return Array.from({ length: this.height }, (_, row) => {
			const text = visible[row] ?? "";
			if (!scrollbar) return fitLine(text, width);
			const bar = !overflow
				? " "
				: row >= thumbTop && row < thumbTop + thumb
					? theme.fg("scrollbarThumb", "┃")
					: theme.fg("scrollbarTrack", "│");
			return fitLine(text, width - 1) + bar;
		});
	}

	/** True once the last line has been on screen at the current content and width. */
	get atEnd(): boolean {
		return this.offset + this.height >= this.total;
	}

	handleInput(data: string): boolean {
		const page = Math.max(1, this.height - 1);
		const steps: Array<[string, number]> = [
			["up", -1],
			["down", 1],
			["pageUp", -page],
			["pageDown", page],
		];
		for (const [key, delta] of steps) {
			if (matchesKey(data, key as "up")) {
				this.scroll(delta);
				return true;
			}
		}
		if (matchesKey(data, "home")) {
			this.offset = 0;
			return true;
		}
		if (matchesKey(data, "end")) {
			this.offset = Number.MAX_SAFE_INTEGER;
			return true;
		}
		return false;
	}
}

/** A read-only text view with its own actions, for details, profiles and inspections. */
export class ReaderView implements OperatorView {
	readonly title: string;
	focused = false;
	private readonly reader = new Reader();
	private readonly hits = new HitMap();
	private readonly host: ViewHost;
	private readonly content: () => ReaderContent;
	private readonly extra: () => readonly Action[];

	constructor(title: string, host: ViewHost, content: () => ReaderContent, actions: () => readonly Action[] = () => []) {
		this.title = title;
		this.host = host;
		this.content = content;
		this.extra = actions;
	}
	render(width: number, height: number): string[] {
		this.hits.begin(width, height);
		this.reader.focused = this.focused;
		this.reader.setContent(this.content(), this.title);
		return this.reader.render(width, height, this.host.theme, this.hits, 0, 0);
	}
	handleInput(data: string): boolean {
		return this.reader.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.hits.handle(event);
	}
	actions(): readonly Action[] {
		return this.extra();
	}
	keys(): readonly KeyHint[] {
		return [
			{ keys: ["up", "down"], label: "scroll" },
			{ keys: ["pageUp", "pageDown"], label: "page" },
		];
	}
}
