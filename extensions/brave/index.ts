/** Stateless web search and bounded public-page reading. */

import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishSettings } from "./settings.ts";
import {
	BRAVE_WEB_READ_DESCRIPTION,
	BRAVE_WEB_READ_GUIDELINES,
	BRAVE_WEB_READ_PARAMETERS,
	BRAVE_WEB_READ_SNIPPET,
	BRAVE_WEB_SEARCH_DESCRIPTION,
	BRAVE_WEB_SEARCH_GUIDELINES,
	BRAVE_WEB_SEARCH_PARAMETERS,
	BRAVE_WEB_SEARCH_SNIPPET,
	type BraveWebSearchDetails,
	runWebSearch,
} from "./capability.ts";
import { braveDurableContribution } from "./durable.ts";
import { readWebPage, type WebReadResult } from "./page-reader.ts";
import { renderReadCall, renderReadResult, renderSearchCall, renderSearchResult } from "./presentation.ts";

export default function registerBraveSearch(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const disposeSettings = publishSettings(pi.events, { agentDir });
	pi.on("session_shutdown", disposeSettings);
	const displayTools: Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">[] = [];
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		pi.registerTool(tool);
		const { name, renderCall, renderResult, renderShell } = tool;
		if (renderCall || renderResult || renderShell) {
			displayTools.push({ name, renderCall, renderResult, renderShell } as (typeof displayTools)[number]);
		}
	};
	pi.events.emit(
		"durable:contribution",
		braveDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	registerTool({
		name: "web_read",
		label: "Read public web page",
		description: BRAVE_WEB_READ_DESCRIPTION,
		promptSnippet: BRAVE_WEB_READ_SNIPPET,
		promptGuidelines: [...BRAVE_WEB_READ_GUIDELINES],
		parameters: BRAVE_WEB_READ_PARAMETERS,
		renderCall: (args, theme, context) => renderReadCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderReadResult(result, options, theme, context),
		async execute(_toolCallId, params, signal): Promise<WebReadResult> {
			return readWebPage(params, signal);
		},
	});
	registerTool<typeof BRAVE_WEB_SEARCH_PARAMETERS, BraveWebSearchDetails>({
		name: "web_search",
		label: "Brave web search",
		description: BRAVE_WEB_SEARCH_DESCRIPTION,
		promptSnippet: BRAVE_WEB_SEARCH_SNIPPET,
		promptGuidelines: [...BRAVE_WEB_SEARCH_GUIDELINES],
		parameters: BRAVE_WEB_SEARCH_PARAMETERS,
		renderCall: (args, theme, context) => renderSearchCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderSearchResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return runWebSearch(params, signal, { agentDir });
		},
	});
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", { version: 1, tools: displayTools });
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1) {
			publishDisplay();
		}
	});
	publishDisplay();
}
