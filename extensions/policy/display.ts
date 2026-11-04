/**
 * Presentation-only module for the policy tool cards. It imports presentation code and public Pi types
 * only, so a client can load it to render retained or live policy results without starting the
 * extension. The ordinary tool registration and the tool-display publication use these same records.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderProposeCall, renderProposeResult, renderRulesCall, renderRulesResult } from "./presentation.ts";

export type ToolDisplayPublication = {
	version: 1;
	tools: Array<{
		name: string;
		renderCall?: ToolDefinition["renderCall"];
		renderResult?: ToolDefinition["renderResult"];
		renderShell?: ToolDefinition["renderShell"];
	}>;
};

const TOOLS: ToolDisplayPublication["tools"] = [
	{
		name: "policy_propose",
		renderCall: (args, theme, context) => renderProposeCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderProposeResult(result, options, theme, context),
	},
	{
		name: "policy_rules",
		renderCall: (args, theme, context) => renderRulesCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderRulesResult(result, options, theme, context),
	},
];

/** The renderer records for the policy tools; function identities are stable across calls. */
export function toolDisplay(): ToolDisplayPublication {
	return { version: 1, tools: TOOLS.map((tool) => ({ ...tool })) };
}

/** The display record for one policy tool. */
export function toolDisplayRecord(name: string): ToolDisplayPublication["tools"][number] {
	const record = TOOLS.find((tool) => tool.name === name);
	if (!record) throw new Error(`No display record for ${name}`);
	return record;
}
