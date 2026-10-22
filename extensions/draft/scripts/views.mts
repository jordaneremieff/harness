// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).

/** Three character views of one source text. Each keeps the source length so offsets stay aligned. */
export interface Views {
	/** Prose only: code, URLs, link targets, tags, comments and markers are blank. */
	P: string[];
	/** Prose with inline code content kept. */
	L: string[];
	/** Source with code, comments, link syntax and URLs blank, markup kept. */
	R: string[];
}

export function makeViews(text: string): Views {
	return { P: text.split(""), L: text.split(""), R: text.split("") };
}

export function blank(view: string[], from: number, to: number): void {
	for (let i = from; i < to; i++) if (view[i] !== "\n") view[i] = " ";
}

export function blankAll(v: Views, from: number, to: number): void {
	blank(v.P, from, to);
	blank(v.L, from, to);
	blank(v.R, from, to);
}

export function blankText(v: Views, from: number, to: number): void {
	blank(v.P, from, to);
	blank(v.L, from, to);
}

export function indentOf(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
	}
	return width;
}

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Drop trailing punctuation and unmatched closing brackets from a URL candidate. */
export function trimUrl(url: string): string {
	let value = url;
	for (;;) {
		const last = value[value.length - 1];
		if (last === undefined) return value;
		if (/[.,;:!?'"*_]/.test(last)) {
			value = value.slice(0, -1);
			continue;
		}
		const open = CLOSERS[last];
		if (open === undefined) return value;
		if (value.split(last).length - 1 <= value.split(open).length - 1) return value;
		value = value.slice(0, -1);
	}
}
