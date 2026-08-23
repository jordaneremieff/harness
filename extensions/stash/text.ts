/** Text safety and output bounds owned by the stash extension. */

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;

/** Compact token counts matching the Pi footer convention: 850, 9.5k, 42k, 1.2M. */
export function formatTokenCount(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

const BIDI_CONTROL = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

interface SanitizedText {
	text: string;
	changed: boolean;
}

/** Make untrusted text inert in a terminal while preserving ordinary Unicode and LF line breaks. */
export function sanitizeTerminalText(input: string): SanitizedText {
	let text = "";
	let changed = false;
	for (const char of input) {
		const code = char.codePointAt(0)!;
		if (char === "\n") {
			text += char;
			continue;
		}
		if (char === "\t") {
			text += "\\t";
			changed = true;
			continue;
		}
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			text += code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
			changed = true;
			continue;
		}
		if (BIDI_CONTROL.test(char)) {
			text += `\\u${code.toString(16).padStart(4, "0")}`;
			changed = true;
			continue;
		}
		text += char;
	}
	return { text, changed };
}

interface BoundedOutput {
	text: string;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
	outputBytes: number;
	outputLines: number;
	outputChars: number;
}

function lineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let end = Math.max(0, maxBytes);
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}

function truncateHead(text: string, maxBytes: number, maxLines: number): string {
	let result = text;
	if (lineCount(result) > maxLines) result = result.split("\n").slice(0, maxLines).join("\n");
	return utf8Prefix(result, maxBytes);
}

/**
 * Bound a tool result to Pi's 50 KB / 2000-line tool-output truncation limits
 * (dist/core/tools/truncate.js); the
 * extension applies its own 50 KiB cap. A reserved tail
 * keeps the truncation notice inside those limits instead of appending beyond them.
 */
export function boundedOutput(input: string, hint?: string): BoundedOutput {
	const totalBytes = Buffer.byteLength(input, "utf8");
	const totalLines = lineCount(input);
	const initial = truncateHead(input, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES);
	const truncated = initial !== input;
	if (!truncated) {
		return {
			text: input,
			truncated: false,
			totalBytes,
			totalLines,
			outputBytes: totalBytes,
			outputLines: totalLines,
			outputChars: input.length,
		};
	}

	const safeHint = hint
		? truncateHead(sanitizeTerminalText(hint).text, 400, 1)
		: "Request a narrower result to continue.";
	const body = truncateHead(input, MAX_OUTPUT_BYTES - 1024, MAX_OUTPUT_LINES - 2);
	const bodyBytes = Buffer.byteLength(body, "utf8");
	const bodyLines = lineCount(body);
	const notice = `[Output truncated: showing ${bodyLines} of ${totalLines} lines and ${bodyBytes} of ${totalBytes} bytes. ${safeHint}]`;
	const text = `${body}\n\n${notice}`;
	return {
		text,
		truncated: true,
		totalBytes,
		totalLines,
		outputBytes: Buffer.byteLength(text, "utf8"),
		outputLines: lineCount(text),
		outputChars: body.length,
	};
}
