import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fitLine } from "./frame.ts";

/** One laid-out string: the content it came from, the effective body width, and its lines. */
interface TextLayout {
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
function layoutText(
	cached: TextLayout | undefined,
	text: string,
	width: number,
): { layout: TextLayout | undefined; lines: readonly string[] } {
	if (cached && cached.text === text && cached.width === width) return { layout: cached, lines: cached.lines };
	const lines = text
		.replaceAll("\t", "  ")
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
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
	private source: string = "";
	private key?: string;
	private offset = 0;
	private height = 1;
	private total = 0;
	private layout?: TextLayout;

	/** Replace the content. A different `key` starts at the top; the same key keeps the position. */
	setContent(content: string, key?: string): void {
		if (key === undefined || key !== this.key) this.offset = 0;
		this.key = key;
		this.source = content;
	}

	scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset + delta));
	}

	private lines(width: number): readonly string[] {
		const laid = layoutText(this.layout, this.source, width);
		this.layout = laid.layout;
		return laid.lines;
	}

	render(width: number, height: number, theme: Theme): string[] {
		this.height = Math.max(1, height);
		const scrollbar = width > 8;
		const body = this.lines(scrollbar ? width - 1 : width);
		this.total = body.length;
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset));
		const visible = body.slice(this.offset, this.offset + this.height);
		const overflow = this.total > this.height;
		const thumb = overflow ? Math.max(1, Math.round((this.height * this.height) / this.total)) : 0;
		const thumbTop = overflow
			? Math.round(((this.height - thumb) * this.offset) / Math.max(1, this.total - this.height))
			: 0;
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
