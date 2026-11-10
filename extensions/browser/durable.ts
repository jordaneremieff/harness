/**
 * Native Pi Durable form of the browser tools.
 *
 * The ordinary entrypoint emits this contribution from its factory. The Durable
 * session host installs the returned extension; an ordinary session has no
 * listener on the channel, so the emission has no effect there.
 */

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
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
import {
	type ActParams,
	type BrowserDeps,
	type BrowserResult,
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
import { publishSettings, type SettingsBus } from "./settings.ts";

/** Everything the host installs, complete before the first `create()` call. */
export interface DurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	/** Resolved paths of configured extensions that emitted no contribution. */
	readonly ordinaryOnly: readonly string[];
}

export interface DurableContributionHost {
	/** The host's pi-durable module; every pi-durable runtime value comes from here. */
	readonly durable: typeof Durable;
	/** Pi's cwd-bound services, for read-only use. */
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	/** The agent storage: one root conversation plus its forks and child agents. */
	readonly storageId: string;
	/** Aborted when the host shuts down. */
	readonly signal: AbortSignal;
	/** Register cleanup at host shutdown. */
	onClose(dispose: () => void | Promise<void>): void;
	readonly inventory: DurableInventory;
}

export interface DurableContribution {
	/** Durable extension name; unique across contributions. */
	readonly name: string;
	/** Absolute path of the emitting extension entrypoint. */
	readonly source: string;
	/** Build the native extension for one session host; called once per host. */
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

/** Strict JSON for durable tool results; absent optional values are dropped rather than stored as undefined. */
function jsonDetails(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => jsonDetails(item));
	if (typeof value === "object") {
		const result: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (item !== undefined) {
				// A plain assignment for an own `__proto__` key would set the prototype instead of a data property.
				Object.defineProperty(result, key, {
					value: jsonDetails(item),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
		}
		return result;
	}
	throw new Error(`Browser tool details are not strict JSON (${typeof value}).`);
}

function native(result: BrowserResult) {
	return { output: result.content, details: jsonDetails(result.details), isError: result.isError };
}

/** Model-facing tool guidance for the browser tools offered in one request. */
function guidanceSection(names: readonly ToolName[]): string {
	return [
		...names.map((name) => `${name}: ${TOOL_TEXT[name].snippet}`),
		"Guidelines:",
		...GUIDELINES.map((guideline) => `- ${guideline}`),
	].join("\n");
}

/**
 * The browser contribution. `create()` reads no ordinary session API and keeps no
 * durable conversation state. Listing, inspection, and capture repeat no external
 * effect when rerun; an action or evaluation may have changed the page, so an
 * interrupted call is reported, never rerun.
 */
export function browserDurableContribution(
	source: string,
	bus: SettingsBus,
	disposeFactorySettings: () => void,
	createDeps: (agentDir: string) => BrowserDeps = productionDeps,
): DurableContribution {
	return {
		name: "browser",
		source,
		create(host) {
			disposeFactorySettings();
			const disposeSettings = publishSettings(bus, { agentDir: host.agentDir });
			host.onClose(disposeSettings);
			const deps = createDeps(host.agentDir);
			const offered = offeredTools(deps.readAccess());
			const { defineExtension, defineTool, section } = host.durable;
			const tools = [
				defineTool({
					name: "browser_tabs",
					description: TOOL_TEXT.browser_tabs.description,
					parameters: TABS_PARAMETERS,
					deferred: true,
					// A rerun repeats a read of window and tab state. A permission request is answered once and then remembered by macOS.
					replay: "safe",
					execute: async (args, _api, context: Context) =>
						native(await browserTabs(args as TabsParams, context.abortSignal, deps)),
				}),
				defineTool({
					name: "browser_inspect",
					description: TOOL_TEXT.browser_inspect.description,
					parameters: INSPECT_PARAMETERS,
					deferred: true,
					// A rerun repeats a bounded read-only extraction from the same tab.
					replay: "safe",
					execute: async (args, _api, context: Context) =>
						native(await browserInspect(args as InspectParams, context.abortSignal, deps)),
				}),
				defineTool({
					name: "browser_act",
					description: TOOL_TEXT.browser_act.description,
					parameters: ACT_PARAMETERS,
					deferred: true,
					executionMode: "sequential",
					// An interrupted action may already have changed the page or an external service.
					replay: "unsafe",
					execute: async (args, _api, context: Context) =>
						native(await browserAct(args as ActParams, context.abortSignal, deps)),
				}),
				defineTool({
					name: "browser_evaluate",
					description: TOOL_TEXT.browser_evaluate.description,
					parameters: EVALUATE_PARAMETERS,
					deferred: true,
					executionMode: "sequential",
					// Arbitrary page code may have run with external effects.
					replay: "unsafe",
					execute: async (args, _api, context: Context) =>
						native(await browserEvaluate(args as EvaluateParams, context.abortSignal, deps)),
				}),
				defineTool({
					name: "browser_capture",
					description: TOOL_TEXT.browser_capture.description,
					parameters: CAPTURE_PARAMETERS,
					deferred: true,
					// A rerun captures the window again. A requested savePath refuses to overwrite an earlier file.
					replay: "safe",
					execute: async (args, _api, context: Context) =>
						native(await browserCapture(args as CaptureParams, context.abortSignal, deps)),
				}),
			].filter((tool) => offered.has(tool.name as ToolName));
			return defineExtension({
				name: "browser",
				tools,
				sections: tools.length === 0 ? [] : [section("browser-guidance", (input) => {
					const offered = new Set(input.agent.tools.map((tool) => tool.name));
					const names = (Object.keys(TOOL_TEXT) as ToolName[]).filter((name) => offered.has(name));
					return names.length === 0 ? undefined : guidanceSection(names);
				})],
			});
		},
	};
}
