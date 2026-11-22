/**
 * Why a memory_edit anchor does not occur in a note body, stated so that the next attempt can copy the right text.
 * A refusal that only says "does not match" invites a retry with the same mistake; this one says whether the text
 * sits in the frontmatter, matches only with different whitespace or quote and dash forms, or where it stops
 * matching, with the body's own text at that point.
 */

const EXCERPT_CHARS = 80;
const QUOTE_CHARS = 600;
/** A shorter matching prefix or suffix locates nothing useful. */
const MIN_LOCATING_CHARS = 12;

const FOLDED: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201A": "'",
	"\u201B": "'",
	"\u2032": "'",
	"\u201C": '"',
	"\u201D": '"',
	"\u201E": '"',
	"\u201F": '"',
	"\u2033": '"',
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2013": "-",
	"\u2014": "-",
	"\u2212": "-",
};

/** Folded text and, for each folded character, the index of the original character it came from. */
interface Folded {
	readonly text: string;
	readonly origin: readonly number[];
}

/** Collapse each whitespace run to one space and map typographic quotes and dashes to their ASCII forms. */
function fold(text: string): Folded {
	let folded = "";
	const origin: number[] = [];
	let space = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (/\s/u.test(character)) {
			if (!space) {
				folded += " ";
				origin.push(index);
			}
			space = true;
			continue;
		}
		space = false;
		folded += FOLDED[character] ?? character;
		origin.push(index);
	}
	return { text: folded, origin };
}

function occurrences(text: string, part: string): number[] {
	const found: number[] = [];
	for (let at = text.indexOf(part); at >= 0 && found.length < 2; at = text.indexOf(part, at + 1)) found.push(at);
	return found;
}

/** The longest length `n` for which `matches(n)` holds, given that it holds for every shorter length. */
function longest(limit: number, matches: (length: number) => boolean): number {
	let low = 0;
	let high = limit;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (matches(middle)) low = middle;
		else high = middle - 1;
	}
	return low;
}

const quoted = (text: string) => JSON.stringify(text);

/**
 * The refusal for `edits[index].oldText` that occurs nowhere in `body`. `source` is the whole note; the body starts
 * at `bodyStart`, and line numbers count from the first line of the note as memory_read returns it.
 */
export function anchorMismatch(source: string, bodyStart: number, oldText: string, index: number): string {
	const label = `edits[${index}].oldText`;
	const body = source.slice(bodyStart);
	const line = (bodyOffset: number) => source.slice(0, bodyStart + bodyOffset).split("\n").length;
	if (source.slice(0, bodyStart).includes(oldText))
		return `${label} is in the frontmatter, which memory_edit does not change; its generated fields update themselves. Anchor the edit on text in the body.`;
	if (source.includes(oldText))
		return `${label} starts in the frontmatter and ends in the body; memory_edit changes only the body. Anchor the edit on body text alone.`;

	const foldedBody = fold(body);
	const foldedOld = fold(oldText).text.trim();
	if (foldedOld.length > 0) {
		const places = occurrences(foldedBody.text, foldedOld);
		if (places.length > 1)
			return `${label} does not match the body exactly, and it matches more than one place once whitespace and quote or dash forms are ignored. Copy the intended text exactly from the body, with enough context to make it unique.`;
		if (places.length === 1) {
			const start = foldedBody.origin[places[0]];
			const end = foldedBody.origin[places[0] + foldedOld.length - 1] + 1;
			const exact = body.slice(start, end);
			const where = `line ${line(start)}`;
			return exact.length <= QUOTE_CHARS
				? `${label} matches the body only when whitespace and quote or dash forms are ignored. The body has this text at ${where}; copy it exactly: ${quoted(exact)}`
				: `${label} matches the body only when whitespace and quote or dash forms are ignored, from ${where} to line ${line(end)}. Copy that passage exactly from the note's current body.`;
		}
	}

	const prefix = longest(oldText.length, (length) => body.includes(oldText.slice(0, length)));
	const suffix = longest(oldText.length, (length) => body.includes(oldText.slice(oldText.length - length)));
	if (Math.max(prefix, suffix) < MIN_LOCATING_CHARS)
		return `${label} does not match the body, and neither its start nor its end occurs there. Read the note again and copy the anchor exactly from its body.`;
	if (prefix >= suffix) {
		const at = body.indexOf(oldText.slice(0, prefix)) + prefix;
		return `${label} matches the body for its first ${prefix} characters, up to line ${line(at)}, and then differs. There the body continues ${quoted(body.slice(at, at + EXCERPT_CHARS))}, while oldText continues ${quoted(oldText.slice(prefix, prefix + EXCERPT_CHARS))}. Copy the anchor exactly from the body.`;
	}
	const tail = oldText.slice(oldText.length - suffix);
	const at = body.indexOf(tail);
	const missing = oldText.length - suffix;
	return `${label} matches the body for its last ${suffix} characters, from line ${line(at)}, but not before them. There the body has ${quoted(body.slice(Math.max(0, at - EXCERPT_CHARS), at))}, while oldText has ${quoted(oldText.slice(Math.max(0, missing - EXCERPT_CHARS), missing))}. Copy the anchor exactly from the body.`;
}
