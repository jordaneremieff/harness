import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Publication = { version: 1; tools: Array<Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">> };
function plain(value: unknown): string { return typeof value === "string" ? [...value.replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu, " ")].slice(0, 240).join("") : ""; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
const renderCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
	const title = plain(record(args).title);
	return new Text(`${theme.fg("toolTitle", "Markdown publish")} ${title}`, 0, 0);
};
const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, _options, theme) => {
	const details = record(result.details);
	if (details.ok === false) return new Text(theme.fg("error", plain(record(details.error).message) || "Publication failed."), 0, 0);
	const id = plain(details.documentId);
	// An attached agent terminal sends slash text to the conversation, so the card names the view first.
	return new Text(id ? `Saved ${id} · revision ${details.revision} · ${details.bytes} bytes\nNo window opened. Open it from the Markdown view under Published (Owner views in the agent view). In an ordinary Pi session: /markdown ${id}` : "Publication result unavailable.", 0, 0);
};
export function toolDisplay(): Publication { return { version: 1, tools: [{ name: "markdown_publish", renderCall, renderResult }] }; }
