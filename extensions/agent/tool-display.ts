import type { ExtensionAPI, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";

// Package contract: docs/conventions/tool-display.md. Copy this shape in each slice.
type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};
type ToolDisplayRequest = { version: 1 };

export type ToolDisplayLookup = (name: string) => ToolRenderers | undefined;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Renderer references are trusted extension code, but execution fields never cross this boundary. */
function display(value: unknown): ToolDisplayPublication["tools"][number] | undefined {
	if (!record(value) || typeof value.name !== "string" || value.name.length === 0) return undefined;
	const { name, renderCall, renderResult, renderShell } = value;
	if (renderCall !== undefined && typeof renderCall !== "function") return undefined;
	if (renderResult !== undefined && typeof renderResult !== "function") return undefined;
	if (renderShell !== undefined && renderShell !== "default" && renderShell !== "self") return undefined;
	if (renderCall === undefined && renderResult === undefined && renderShell === undefined) return undefined;
	return {
		name,
		...(renderCall === undefined ? {} : { renderCall: renderCall as ToolDefinition["renderCall"] }),
		...(renderResult === undefined ? {} : { renderResult: renderResult as ToolDefinition["renderResult"] }),
		...(renderShell === undefined ? {} : { renderShell }),
	};
}

/** Pi owns subscription cleanup; the registry belongs to this factory invocation only. */
export function collectToolDisplay(events: ExtensionAPI["events"]): ToolDisplayLookup {
	const renderers = new Map<string, ToolRenderers>();
	events.on("harness:tool-display:publish", (payload) => {
		if (!record(payload) || payload.version !== 1 || !Array.isArray(payload.tools)) return;
		for (const value of payload.tools) {
			const tool = display(value);
			if (!tool) continue;
			const { name, ...presentation } = tool;
			renderers.set(name, Object.freeze(presentation));
		}
	});
	const request: ToolDisplayRequest = { version: 1 };
	events.emit("harness:tool-display:request", request);
	return (name) => renderers.get(name);
}

/** Publish the same agent cards that own ordinary tool registration. */
export function publishToolDisplay(events: ExtensionAPI["events"], tools: ToolDisplayPublication["tools"]): void {
	const publication: ToolDisplayPublication = { version: 1, tools: tools.flatMap((tool) => display(tool) ?? []) };
	const publish = () => events.emit("harness:tool-display:publish", publication);
	events.on("harness:tool-display:request", (request) => {
		if (record(request) && request.version === 1) publish();
	});
	publish();
}
