/** Inspection of and interaction with already-open Chromium-family browser sessions on macOS. */

import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ACT_PARAMETERS,
	CAPTURE_PARAMETERS,
	EVALUATE_PARAMETERS,
	GUIDELINES,
	INSPECT_PARAMETERS,
	offeredTools,
	productionDeps,
	TABS_PARAMETERS,
	TOOL_TEXT,
	type ToolName,
} from "./capability.ts";
import { browserDurableContribution } from "./durable.ts";
import {
	type ActParams,
	browserAct,
	browserCapture,
	browserEvaluate,
	browserInspect,
	browserTabs,
	type CaptureParams,
	type EvaluateParams,
	type InspectParams,
	type TabsParams,
} from "./operations.ts";
import { publishSettings } from "./settings.ts";

export default function registerBrowser(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const disposeSettings = publishSettings(pi.events, { agentDir });
	pi.on("session_shutdown", disposeSettings);
	pi.events.emit(
		"durable:contribution",
		browserDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);
	const deps = productionDeps(agentDir);
	const offered = offeredTools(deps.readAccess());
	const text = (name: ToolName) => ({
		name,
		label: TOOL_TEXT[name].label,
		description: TOOL_TEXT[name].description,
		promptSnippet: TOOL_TEXT[name].snippet,
	});

	if (offered.has("browser_tabs")) {
		pi.registerTool({
			...text("browser_tabs"),
			promptGuidelines: [...GUIDELINES],
			parameters: TABS_PARAMETERS,
			async execute(_id, params, signal) {
				return browserTabs(params as TabsParams, signal, deps);
			},
		});
	}
	if (offered.has("browser_inspect")) {
		pi.registerTool({
			...text("browser_inspect"),
			parameters: INSPECT_PARAMETERS,
			async execute(_id, params, signal) {
				return browserInspect(params as InspectParams, signal, deps);
			},
		});
	}
	if (offered.has("browser_act")) {
		pi.registerTool({
			...text("browser_act"),
			parameters: ACT_PARAMETERS,
			executionMode: "sequential",
			async execute(_id, params, signal) {
				return browserAct(params as ActParams, signal, deps);
			},
		});
	}
	if (offered.has("browser_evaluate")) {
		pi.registerTool({
			...text("browser_evaluate"),
			parameters: EVALUATE_PARAMETERS,
			executionMode: "sequential",
			async execute(_id, params, signal) {
				return browserEvaluate(params as EvaluateParams, signal, deps);
			},
		});
	}
	if (offered.has("browser_capture")) {
		pi.registerTool({
			...text("browser_capture"),
			parameters: CAPTURE_PARAMETERS,
			async execute(_id, params, signal) {
				return browserCapture(params as CaptureParams, signal, deps);
			},
		});
	}
}
