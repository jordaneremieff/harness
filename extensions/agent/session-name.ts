/** Derive a concise session name from the first genuine interactive input. */
export const SESSION_NAME_CODE_POINTS = 48;
export const SESSION_NAME_WORDS = 8;
const MINIMUM_USEFUL_CHARACTERS = 3;

function firstLine(text: string): string | undefined {
	for (const raw of text.split("\n")) {
		const line = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
		if (line.length > 0) return line;
	}
	return undefined;
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
 * Deterministic name text for one interactive input, or undefined when the input
 * has no usable description. Fenced code, inline code and URLs do not contribute.
 */
export function sessionNameFromInput(input: string): string | undefined {
	let text = input.replace(/\r\n?/gu, "\n");
	text = text.replace(/`{3,}[\s\S]*?(?:`{3,}|$)/gu, " ");
	text = text.replace(/~{3,}[\s\S]*?(?:~{3,}|$)/gu, " ");
	text = text.replace(/`+[^`\n]*`+/gu, " ");
	text = text.replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ");
	const commandless = text.trimStart().startsWith("/") ? text.trimStart().replace(/^\/\S*[ \t]*/u, "") : text;
	const line = firstLine(commandless);
	if (line === undefined) return undefined;
	const name = cappedWords(firstSentence(withoutLeadingMarkers(line)))?.replace(/[\s.,;:!?…·*_~]+$/u, "");
	if (name === undefined || name.length === 0) return undefined;
	if (!hasUsableWord(name)) return undefined;
	const useful = name.replace(/[^\p{L}\p{N}]/gu, "");
	if (Array.from(useful).length < MINIMUM_USEFUL_CHARACTERS) return undefined;
	return name;
}
