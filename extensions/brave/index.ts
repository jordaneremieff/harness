/** Stateless web search and bounded public-page reading. */

import type { Static } from "@earendil-works/pi-schema";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
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
import { toolDisplay } from "./display.ts";

export default function registerBraveSearch(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const disposeSettings = publishSettings(pi.events, { agentDir });
	pi.on("session_shutdown", disposeSettings);
	const display = toolDisplay();
	const [readDisplay, searchDisplay] = display.tools;
	pi.events.emit(
		"durable:contribution",
		braveDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	pi.registerTool({
		...readDisplay,
		name: "web_read",
		label: "Read public web page",
		description: BRAVE_WEB_READ_DESCRIPTION,
		promptSnippet: BRAVE_WEB_READ_SNIPPET,
		promptGuidelines: [...BRAVE_WEB_READ_GUIDELINES],
		parameters: BRAVE_WEB_READ_PARAMETERS,
		async execute(_toolCallId, params: Static<typeof BRAVE_WEB_READ_PARAMETERS>, signal): Promise<WebReadResult> {
			return readWebPage(params, signal);
		},
	});
	pi.registerTool<typeof BRAVE_WEB_SEARCH_PARAMETERS, BraveWebSearchDetails>({
		...searchDisplay,
		name: "web_search",
		label: "Brave web search",
		description: BRAVE_WEB_SEARCH_DESCRIPTION,
		promptSnippet: BRAVE_WEB_SEARCH_SNIPPET,
		promptGuidelines: [...BRAVE_WEB_SEARCH_GUIDELINES],
		parameters: BRAVE_WEB_SEARCH_PARAMETERS,
		async execute(_toolCallId, params: Static<typeof BRAVE_WEB_SEARCH_PARAMETERS>, signal) {
			return runWebSearch(params, signal, { agentDir });
		},
	});
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", display);
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1) {
			publishDisplay();
		}
	});
	publishDisplay();
}
