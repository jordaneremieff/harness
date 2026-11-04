import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Terminal escape sequences, C0/C1 controls and format characters never reach a label. */
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\p{Cc}\p{Cf}]/gu;

/** One line of untrusted text: controls removed and whitespace collapsed. */
export function plainLine(text: string): string {
	return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** Untrusted multiline text: controls other than newlines and tabs removed, line endings normalised. */
export function plainText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cf}]/gu, " ");
}

/** Exactly `width` columns: truncated with an ellipsis, then padded. ANSI-aware. */
export function fitLine(text: string, width: number): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const value = truncateToWidth(text, columns);
	return value + " ".repeat(Math.max(0, columns - visibleWidth(value)));
}

/** At most `width` columns, unpadded. */
export function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, Math.floor(width)));
}

/** Wrapped display lines of styled or plain text; empty input yields one empty line. */
export function wrap(text: string, width: number): string[] {
	const columns = Math.max(1, Math.floor(width));
	return text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, columns)));
}

/** Left and right segments on one line; the left side yields first when space is short. */
export function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (!right) return fitLine(left, width);
	if (rightWidth + 1 >= width) return fitLine(right, width);
	return `${fitLine(left, width - rightWidth - 1)} ${right}`;
}

export { visibleWidth };

/** Coarse relative age for a past instant: "now", "15m", "3h", "2d". */
export function age(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
