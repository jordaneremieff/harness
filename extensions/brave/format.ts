import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { BraveWebSearchRequest, BraveWebSearchResponse, BraveWebResult } from "./client.ts";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const OUTPUT_NOTICE_BYTES = 1024;

interface FormattedSearchResults {
	text: string;
	outputTruncated: boolean;
	fieldsShortened: boolean;
}

function oneLine(value: string, maxCharacters: number): { text: string; shortened: boolean } {
	const safe = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
	const characters = Array.from(safe);
	if (characters.length <= maxCharacters) return { text: safe, shortened: false };
	return { text: `${characters.slice(0, maxCharacters).join("")}…`, shortened: true };
}

function formatResult(result: BraveWebResult, index: number): { lines: string[]; shortened: boolean } {
	const title = oneLine(result.title, 500);
	const url = oneLine(result.url, 4096);
	const description = result.description ? oneLine(result.description, 2000) : undefined;
	const age = result.age ? oneLine(result.age, 200) : undefined;
	const lines = [`${index}. ${title.text}`, `   URL: ${url.text}`];
	let shortened = title.shortened || url.shortened;
	if (age?.text) {
		lines.push(`   Published: ${age.text}`);
		shortened ||= age.shortened;
	}
	if (description?.text) {
		lines.push(`   Snippet: ${description.text}`);
		shortened ||= description.shortened;
	}
	if (result.extraSnippets.length > 0) {
		lines.push("   Additional excerpts:");
		for (const snippet of result.extraSnippets) {
			const excerpt = oneLine(snippet, 1000);
			if (excerpt.text) lines.push(`   - ${excerpt.text}`);
			shortened ||= excerpt.shortened;
		}
	}
	return { lines, shortened };
}

export function formatSearchResults(
	response: BraveWebSearchResponse,
	request: BraveWebSearchRequest,
): FormattedSearchResults {
	const requested = oneLine(request.query, 400);
	const original = oneLine(response.originalQuery, 400);
	const altered = response.alteredQuery ? oneLine(response.alteredQuery, 400) : undefined;
	let fieldsShortened = requested.shortened || original.shortened || (altered?.shortened ?? false);
	const lines: string[] = [];

	if (altered?.text) {
		lines.push(`Brave Search used corrected query "${altered.text}" (requested "${requested.text}").`);
	} else {
		lines.push(`Brave Search results for "${original.text}":`);
	}

	if (response.results.length === 0) {
		lines.push("", "No web results found.");
	} else {
		for (const [index, result] of response.results.entries()) {
			const formatted = formatResult(result, index + 1);
			lines.push("", ...formatted.lines);
			fieldsShortened ||= formatted.shortened;
		}
	}

	const offset = request.offset ?? 0;
	if (response.moreResultsAvailable && offset < 9) {
		lines.push("", `More results are available. Repeat the search with offset ${offset + 1} and the same count.`);
	}
	if (fieldsShortened) lines.push("", "[Long result fields were shortened for context safety.]");

	const raw = lines.join("\n");
	const truncation = truncateHead(raw, {
		maxLines: DEFAULT_MAX_LINES - 4,
		maxBytes: DEFAULT_MAX_BYTES - OUTPUT_NOTICE_BYTES,
	});
	if (!truncation.truncated) {
		return { text: truncation.content, outputTruncated: fieldsShortened, fieldsShortened };
	}

	const notice =
		`\n\n[Search output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. ` +
		"Re-run with a lower count, disable extra_snippets, or narrow the query.]";
	return {
		text: truncation.content + notice,
		outputTruncated: true,
		fieldsShortened,
	};
}
