import {
	createCodemodeExtension,
	createReadToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { createAgentToolCards, ordinaryWorkCard, type AgentCardLookup } from "./tool-cards.ts";
import type { ToolDisplayLookup } from "./tool-display.ts";

/** Capture presentation only. Unexpected factory API access fails closed. */
export function captureCodemodeRenderers(): ToolRenderers {
	const definitions: ToolDefinition[] = [];
	const standIn = new Proxy(
		{
			registerTool: ((definition: ToolDefinition) => {
				definitions.push(definition);
			}) as ExtensionAPI["registerTool"],
		} satisfies Pick<ExtensionAPI, "registerTool">,
		{
			get(target, property) {
				if (property === "registerTool") return target.registerTool;
				throw new Error(`Codemode capture requested unsupported API: ${String(property)}`);
			},
		},
	);
	const returned = createCodemodeExtension()(standIn as ExtensionAPI);
	if (returned && typeof (returned as PromiseLike<void>).then === "function") {
		void Promise.resolve(returned).catch(() => undefined);
		throw new Error("Codemode renderer capture became asynchronous");
	}
	const definition = definitions.length === 1 ? definitions[0] : undefined;
	if (
		definition?.name !== "codemode" ||
		typeof definition.renderCall !== "function" ||
		typeof definition.renderResult !== "function" ||
		(definition.renderShell !== undefined && definition.renderShell !== "default" && definition.renderShell !== "self")
	) {
		throw new Error("Codemode renderer capture unavailable");
	}
	return {
		renderCall: definition.renderCall,
		renderResult: definition.renderResult,
		renderShell: definition.renderShell,
	};
}

let captured = false;
let codemode: ToolRenderers | undefined;
function codemodeRenderers(): ToolRenderers | undefined {
	if (!captured) {
		captured = true;
		try {
			codemode = captureCodemodeRenderers();
		} catch {
			/* Pi's standard card remains available. */
		}
	}
	return codemode;
}

async function cannotExecute(): Promise<never> {
	throw new Error("Transcript tools cannot execute");
}

/**
 * Native and owner presentation with no execution or loadout hooks. `rows` supplies already-observed
 * roster facts, such as target names and applied configuration. It reads no store.
 */
export function createDashboardToolDefinitions(
	cwd: string,
	toolDisplay?: ToolDisplayLookup,
	rows: AgentCardLookup = () => [],
): (name: string, knownCall?: boolean) => ToolDefinition {
	const native = new Map(
		[
			createReadToolDefinition(cwd),
			createBashToolDefinition(cwd),
			createEditToolDefinition(cwd),
			createWriteToolDefinition(cwd),
			createGrepToolDefinition(cwd),
			createFindToolDefinition(cwd),
			createLsToolDefinition(cwd),
			createPowerShellToolDefinition(cwd),
		].map((definition) => [definition.name, definition as ToolDefinition] as const),
	);
	const agents = new Map(Object.entries(createAgentToolCards(rows)));
	agents.set("agent_yield", ordinaryWorkCard("agent_yield", rows));
	const resolve = (name: string, knownCall: boolean): ToolRenderers | undefined => {
		const builtin = native.get(name);
		if (builtin) return knownCall ? (toolDisplay?.(name) ?? builtin) : undefined;
		if (name === "codemode") return knownCall ? codemodeRenderers() : undefined;
		return agents.get(name) ?? toolDisplay?.(name);
	};
	return (name, knownCall = true) => {
		const builtin = knownCall ? native.get(name) : undefined;
		const presentation = resolve(name, knownCall);
		return {
			name,
			label: builtin?.label ?? name,
			description: builtin?.description ?? "Retained tool display",
			parameters: builtin?.parameters ?? obj({}, { open: true }),
			// Pi's built-in fallback fills the renderers, not the registered tool's shell.
			renderCall: presentation?.renderCall ?? builtin?.renderCall,
			renderResult: presentation?.renderResult ?? builtin?.renderResult,
			renderShell: presentation?.renderShell,
			execute: cannotExecute,
		};
	};
}
