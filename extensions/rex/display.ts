import { keyText, type ExtensionAPI, type Theme, type ThemeColor, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type CardTheme = Pick<Theme, "fg">;
type RenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];
interface Line { text: string; colour: ThemeColor; preview?: boolean }

export function publishRexToolDisplay(events: ExtensionAPI["events"], tools: readonly DisplayRecord[]): () => void {
	const publish = () => events.emit("harness:tool-display:publish", {
		version: 1,
		tools: tools.map(({ name, renderCall, renderResult, renderShell }) => ({ name, renderCall, renderResult, renderShell })),
	});
	const stop = events.on("harness:tool-display:request", (request) => {
		if (object(request).version === 1) publish();
	});
	publish();
	return stop;
}

export function createRexToolDisplay(name: string) {
	return {
		renderShell: "default" as const,
		renderCall(args: unknown, theme: CardTheme, context: { expanded: boolean; isPartial: boolean }): Component {
			const request = object(args);
			const action = [string(request.op), string(request.kind) ?? string(request.view) ?? string(request.condition)].filter(Boolean).join(" ");
			const lines = [line(`${name}${action ? ` · ${action}` : ""}`, "toolTitle")];
			const facts = [string(request.label), string(request.method), string(request.action),
				string(request.phase) ? `phase ${request.phase}` : undefined,
				string(request.recordId) ? `record ${request.recordId}` : undefined,
				string(request.query) ? `query ${JSON.stringify(request.query)}` : undefined].filter(Boolean).join(" · ");
			if (facts) lines.push(line(facts, "muted"));
			if (context.isPartial || context.expanded) {
				const target = targetText(request.target);
				if (target) lines.push(line(target, "muted"));
			}
			if (context.expanded) lines.push(line(""), ...jsonLines(args));
			else {
				if (typeof request.text === "string") lines.push(line(JSON.stringify(request.text), "toolOutput", true));
				if (Array.isArray(request.keys)) lines.push(line(`keys ${request.keys.filter((key) => typeof key === "string").join(" · ")}`, "muted", true));
			}
			return card(lines, theme);
		},
		renderResult(result: RenderResult, options: ToolRenderResultOptions, theme: CardTheme, context: { args: unknown; isError: boolean }): Component {
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const value = canonicalResult(text);
			const lines: Line[] = [];
			if (!value) {
				lines.push(line(options.isPartial ? "partial result" : "tool result", context.isError ? "error" : "toolOutput"));
				lines.push(...text.split("\n").slice(0, options.expanded ? undefined : 2).map((part) => line(part, "toolOutput", !options.expanded)));
			} else {
				const effects = object(value.effects);
				const coverage = object(value.coverage);
				const data = object(value.data);
				const request = object(context.args);
				const state = effects.state;
				const effect = state === "unknown" ? "UNKNOWN EFFECTS" : state === "confirmed" ? "effects confirmed" : "no effects";
				lines.push(line(`${options.isPartial ? "partial · " : ""}${String(value.outcome).replaceAll("_", " ")} · ${effect}`, state === "unknown" ? "warning" : value.ok ? "toolOutput" : "error"));
				const target = targetText(value.target);
				if (target) lines.push(line(target, "muted"));
				if (string(effects.recordId)) lines.push(line(`record ${effects.recordId}`, "muted"));
				if (request.op === "input" || value.outcome === "input_delivered") lines.push(line("Input delivery is not application execution.", "muted"));
				if (name === "rex_wait") lines.push(line(value.outcome === "timeout" ? "Observer deadline; terminal work remains independent." : "Observer end does not stop terminal work.", "muted"));
				if (request.op === "inspect" && request.view === "capture") lines.push(line("Bounded capture, not a complete transcript.", "muted"));
				if (name === "rex_owned" && request.op === "owned") lines.push(line("Stored phase is not live presence or cleanup permission.", "muted"));
				if (name === "rex_status") lines.push(line("Reported status is not permission or task acceptance.", "muted"));
				if (name === "rex_native" && ["api", "lua", "action"].includes(String(request.kind)) && value.ok) lines.push(line("CLI success is not inner application success.", "muted"));
				const omitted: string[] = [];
				if (coverage.dataOmitted) omitted.push("bulk data omitted");
				if (Array.isArray(coverage.truncatedFields) && coverage.truncatedFields.length) omitted.push("diagnostics shortened");
				if (number(coverage.omittedRecordRefs) > 0) omitted.push(`${coverage.omittedRecordRefs} record references omitted`);
				if (number(coverage.omittedRecords) > 0) omitted.push(`${coverage.omittedRecords} records outside this page`);
				if (number(data.omittedMethods) > 0) omitted.push(`${data.omittedMethods} methods outside this page`);
				if (coverage.truncated && omitted.length === 0) omitted.push("source output is incomplete");
				if (omitted.length) lines.push(line(omitted.join(" · "), "muted"));
				if (typeof coverage.returnedRecords === "number" && typeof coverage.totalRecords === "number") lines.push(line(`${coverage.returnedRecords} of ${coverage.totalRecords} records`, "muted"));
				if (typeof data.returnedMethods === "number" && typeof data.matchedMethods === "number") lines.push(line(`${data.returnedMethods} of ${data.matchedMethods} methods · ${data.totalMethods} installed`, "muted"));
				const next = coverage.nextOffset ?? data.nextOffset;
				if (typeof next === "number") lines.push(line(`next offset ${next}`, "muted"));
				if (string(value.error)) lines.push(line(String(value.error), "error", true));
				if (!options.expanded) {
					if (string(effects.note)) lines.push(line(String(effects.note), "muted", true));
					if (string(coverage.note)) lines.push(line(String(coverage.note), "muted", true));
					const capture = string(data.content) ?? string(object(data.snapshot).content);
					if (capture) lines.push(...capture.split("\n").slice(0, 2).map((part) => line(part, "toolOutput", true)));
				} else lines.push(line(""), ...jsonLines(value));
			}
			const key = keyText("app.tools.expand");
			if (key) lines.push(line(`${key} to ${options.expanded ? "collapse" : "expand · complete bounded result"}`, "muted"));
			return card(lines, theme);
		},
	} satisfies Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function number(value: unknown): number { return typeof value === "number" ? value : 0; }
function safe(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]|\p{Cs}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function line(text: string, colour: ThemeColor = "toolOutput", preview = false): Line { return { text: safe(text), colour, preview }; }
function targetText(value: unknown): string {
	const target = object(value);
	const id = string(target.blockId) ?? string(target.block) ?? string(target.windowId) ?? string(target.window) ?? string(target.sessionId) ?? string(target.session) ?? string(target.clientId) ?? string(target.client);
	const server = string(target.server) ?? string(object(target.server).endpoint);
	return [id, server].filter(Boolean).join(" · ");
}
function canonicalResult(text: string): Record<string, unknown> | undefined {
	try {
		const value = object(JSON.parse(text));
		return typeof value.ok === "boolean" && typeof value.outcome === "string" && ["none", "confirmed", "unknown"].includes(String(object(value.effects).state)) && object(value.coverage).bounded === true ? value : undefined;
	} catch { return undefined; }
}
function jsonLines(value: unknown): Line[] {
	return (JSON.stringify(value, null, 2) ?? "null").split("\n").map((text) => line(text));
}
function card(lines: Line[], theme: CardTheme): Component {
	let cachedWidth: number | undefined;
	let cached: string[] = [];
	return {
		invalidate() { cachedWidth = undefined; },
		render(width) {
			if (width <= 0) return [];
			if (cachedWidth === width) return cached;
			cachedWidth = width;
			cached = lines.flatMap((entry) => {
				// Input is plain escaped text. Remove only the utility's SGR reset before applying the row colour.
				const rows = entry.preview ? [truncateToWidth(entry.text, width, "…").replaceAll("\u001b[0m", "")] : wrapTextWithAnsi(entry.text, width);
				return rows.map((row) => theme.fg(entry.colour, row));
			});
			return cached;
		},
	};
}
