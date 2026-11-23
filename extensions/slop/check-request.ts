import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipRow, expansionHint } from "./presentation.ts";
import { bodyText } from "./presentation-text.ts";

export const CHECK_REQUEST = "slop-check-request";
const localExpansion = new WeakMap<object, { global: boolean; expanded: boolean }>();

function bodyRows(text: string, expanded: boolean, theme: Theme, width: number): string[] {
	if (!text) return [];
	const rows = wrapTextWithAnsi(text, width);
	return ["", ...(expanded ? rows : rows.slice(0, 3)).map((line) => theme.fg("customMessageText", line))];
}

export const renderCheckRequest: MessageRenderer = (message, options, theme) => {
	const choice = localExpansion.get(message);
	if (choice && choice.global !== options.expanded) localExpansion.delete(message);
	let expanded = localExpansion.get(message)?.expanded ?? options.expanded;
	const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
	const details = typeof message.details === "object" ? message.details : undefined;
	const hint = details && "hint" in details && typeof details.hint === "string" ? bodyText(details.hint).trim() : "";
	const content =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const instructionsEnd = details && "instructionsEnd" in details ? details.instructionsEnd : undefined;
	const full = bodyText(
		typeof instructionsEnd === "number" &&
			Number.isSafeInteger(instructionsEnd) &&
			instructionsEnd > 0 &&
			instructionsEnd <= content.length
			? content.slice(0, instructionsEnd)
			: content,
	);
	const title = `${theme.fg("customMessageLabel", theme.bold("[slop]"))} ${theme.fg("customMessageText", theme.bold("Check requested"))}`;
	box.addChild(
		new MouseRegion(
			{
				render(width) {
					if (width <= 0) return [];
					const lines = [clipRow(title, width), ...bodyRows(expanded ? full : hint, expanded, theme, width)];
					if (!expanded && full) lines.push(...expansionHint(theme, options, width, true));
					return lines;
				},
				invalidate() {},
			},
			(event) => {
				if (!full || event.type !== "click" || event.button !== "left") return undefined;
				expanded = !expanded;
				localExpansion.set(message, { global: options.expanded, expanded });
				box.invalidate();
				return { handled: true };
			},
		),
	);
	return box;
};
