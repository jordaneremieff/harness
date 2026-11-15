import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Publication = { version: 1; tools: Array<Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">> };
function plain(value: unknown): string { return typeof value === "string" ? [...value.replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu, " ")].slice(0, 240).join("") : ""; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : 0; }
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
const renderReadCall: NonNullable<ToolDefinition["renderCall"]> = (args, theme) => {
	const input = record(args);
	const subject = input.document === undefined ? `find ${plain(input.kind) || "published"}${input.query === undefined ? "" : ` ${JSON.stringify(plain(input.query))}`}` : `${plain(input.document)}${input.revision === undefined ? "" : ` revision ${count(input.revision)}`}`;
	return new Text(`${theme.fg("toolTitle", "Markdown read")} ${subject}`, 0, 0);
};
const renderReadResult: NonNullable<ToolDefinition["renderResult"]> = (result, _options, theme) => {
	const details = record(result.details);
	if (details.ok === false) return new Text(theme.fg("error", plain(record(details.error).message) || "Read failed."), 0, 0);
	if (details.op === "find") return new Text(`${count(details.matched)} matching of ${count(details.scanned)} scanned${details.bounded === true ? " · scan stopped early" : ""}${count(details.unreadable) ? ` · ${count(details.unreadable)} unreadable` : ""}`, 0, 0);
	if (details.op !== "read") return new Text("Read result unavailable.", 0, 0);
	const start = count(details.offset); const end = start + (typeof details.text === "string" ? details.text.length : 0);
	return new Text(`Read ${plain(details.documentId)} · revision ${count(details.revision)} of ${count(details.currentRevision)} · characters ${start}\u2013${end} of ${count(details.chars)}`, 0, 0);
};
export function toolDisplay(): Publication {
	return { version: 1, tools: [{ name: "markdown_publish", renderCall, renderResult }, { name: "markdown_read", renderCall: renderReadCall, renderResult: renderReadResult }] };
}
