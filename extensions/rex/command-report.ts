import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Text for one Pi notice: no terminal sequences or control characters, and one line. */
export function noticeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}
