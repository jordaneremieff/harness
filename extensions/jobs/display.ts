import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderBashCall, renderBashResult, renderJobsCall, renderJobsResult } from "./presentation.ts";

type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

/** Pure presentation records for ordinary publication and the standalone descriptor. */
export function toolDisplay(): ToolDisplayPublication {
	return {
		version: 1,
		tools: [
			{ name: "jobs", renderCall: renderJobsCall, renderResult: renderJobsResult },
			{ name: "bash", renderCall: renderBashCall, renderResult: renderBashResult },
		],
	};
}
