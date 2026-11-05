/**
 * Derive a concise session name from operator input text.
 *
 * The agent extension names an unnamed session from genuine interactive input.
 * The evo extension names one from the direction of a registered `/evo`
 * invocation. Both use Pi's public session name API.
 */
export const SESSION_NAME_CODE_POINTS = 48;
export const SESSION_NAME_WORDS = 8;
const MINIMUM_USEFUL_CHARACTERS = 3;

function normalizedLine(raw: string): string {
	return raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/** A Markdown ATX heading labels a section instead of describing the work. */
function isHeading(line: string): boolean {
	return /^#{1,6}(?:[ \t]|$)/u.test(line);
}

/**
 * The first nonempty line that is not a heading. When every nonempty line is a
 * heading, the first heading supplies the name.
 */
function nameLine(text: string): string | undefined {
	let heading: string | undefined;
	for (const raw of text.split("\n")) {
		const line = normalizedLine(raw);
		if (line.length === 0) continue;
		if (isHeading(line)) {
			heading ??= line;
			continue;
		}
		return line;
	}
	return heading;
}

/** The first sentence of a line: text before a sentence mark that is followed by whitespace. */
function firstSentence(line: string): string {
	return line.split(/(?<=[.!?…])\s+/u)[0] ?? line;
}

/** Remove leading block markers such as headings, quotes, list items and emphasis runs. */
function withoutLeadingMarkers(line: string): string {
	return line.replace(/^(?:(?:#{1,6}|[-*+>]|\d+[.)])[ \t]+|[*_~]+)+/u, "");
}

function cappedWords(line: string): string | undefined {
	const words = line.split(" ").filter((word) => word.length > 0);
	const first = words[0];
	if (first === undefined || Array.from(first).length > SESSION_NAME_CODE_POINTS) return undefined;
	const kept: string[] = [];
	let size = 0;
	for (const word of words) {
		const length = Array.from(word).length;
		const next = kept.length === 0 ? length : size + 1 + length;
		if (kept.length >= SESSION_NAME_WORDS || next > SESSION_NAME_CODE_POINTS) break;
		kept.push(word);
		size = next;
	}
	return kept.join(" ");
}

/** A word that starts with a dash is command syntax, not usable name text. */
function hasUsableWord(name: string): boolean {
	return name.split(" ").some((word) => !word.startsWith("-"));
}

/**
 * Deterministic name text for one operator input, or undefined when the input
 * has no usable description. Fenced code, inline code and URLs do not contribute.
 */
export function sessionNameFromInput(input: string): string | undefined {
	let text = input.replace(/\r\n?/gu, "\n");
	text = text.replace(/`{3,}[\s\S]*?(?:`{3,}|$)/gu, " ");
	text = text.replace(/~{3,}[\s\S]*?(?:~{3,}|$)/gu, " ");
	text = text.replace(/`+[^`\n]*`+/gu, " ");
	text = text.replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ");
	const commandless = text.trimStart().startsWith("/") ? text.trimStart().replace(/^\/\S*[ \t]*/u, "") : text;
	const line = nameLine(commandless);
	if (line === undefined) return undefined;
	const name = cappedWords(firstSentence(withoutLeadingMarkers(line)))?.replace(/[\s.,;:!?…·*_~]+$/u, "");
	if (name === undefined || name.length === 0) return undefined;
	if (!hasUsableWord(name)) return undefined;
	const useful = name.replace(/[^\p{L}\p{N}]/gu, "");
	if (Array.from(useful).length < MINIMUM_USEFUL_CHARACTERS) return undefined;
	return name;
}
