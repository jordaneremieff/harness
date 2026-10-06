import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

// Shape owned by docs/conventions/tool-display.md; keep this slice independent.
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
type ToolDisplay = ToolDisplayPublication["tools"][number];

export function toolDisplayPublisher(pi: Pick<ExtensionAPI, "events" | "registerTool">) {
	const tools: ToolDisplay[] = [];
	const version: ToolDisplayRequest["version"] = 1;
	const publish = () => pi.events.emit("harness:tool-display:publish", { version, tools: [...tools] } satisfies ToolDisplayPublication);
	pi.events.on("harness:tool-display:request", (request: unknown) => {
		if (request && typeof request === "object" && "version" in request && request.version === version) publish();
	});
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		pi.registerTool(definition);
		if (definition.renderCall === undefined && definition.renderResult === undefined && definition.renderShell === undefined) return;
		tools.push({
			name: definition.name,
			...(definition.renderCall === undefined ? {} : { renderCall: definition.renderCall }),
			...(definition.renderResult === undefined ? {} : { renderResult: definition.renderResult }),
			...(definition.renderShell === undefined ? {} : { renderShell: definition.renderShell }),
		} as ToolDisplay);
	};
	return { registerTool, publish };
}
