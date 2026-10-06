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
	type CodemodeToolDetails,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentToolCards } from "./tool-cards.ts";

/** Capture presentation only. Unexpected factory API access fails closed. */
export function captureCodemodeRenderers(): ToolRenderers {
	const definitions: ToolDefinition[] = [];
	const standIn = new Proxy({
		registerTool: ((definition: ToolDefinition) => { definitions.push(definition); }) as ExtensionAPI["registerTool"],
	} satisfies Pick<ExtensionAPI, "registerTool">, {
		get(target, property) {
			if (property === "registerTool") return target.registerTool;
			throw new Error(`Codemode capture requested unsupported API: ${String(property)}`);
		},
	});
	const returned = createCodemodeExtension()(standIn as ExtensionAPI);
	if (returned && typeof (returned as PromiseLike<void>).then === "function") {
		void Promise.resolve(returned).catch(() => undefined);
		throw new Error("Codemode renderer capture became asynchronous");
	}
	const definition = definitions.length === 1 ? definitions[0] : undefined;
	if (definition?.name !== "codemode" || typeof definition.renderCall !== "function" || typeof definition.renderResult !== "function" ||
		(definition.renderShell !== undefined && definition.renderShell !== "default" && definition.renderShell !== "self")) {
		throw new Error("Codemode renderer capture unavailable");
	}
	return { renderCall: definition.renderCall, renderResult: definition.renderResult, renderShell: definition.renderShell };
}

let captured = false;
let codemode: ToolRenderers | undefined;
function codemodeRenderers(): ToolRenderers | undefined {
	if (!captured) {
		captured = true;
		try { codemode = captureCodemodeRenderers(); } catch { /* Pi's standard card remains available. */ }
	}
	return codemode;
}

async function cannotExecute(): Promise<never> {
	throw new Error("Transcript tools cannot execute");
}

function presentationFields(presentation: ToolRenderers | undefined): ToolRenderers {
	return {
		...(presentation?.renderCall === undefined ? {} : { renderCall: presentation.renderCall }),
		...(presentation?.renderResult === undefined ? {} : { renderResult: presentation.renderResult }),
		...(presentation?.renderShell === undefined ? {} : { renderShell: presentation.renderShell }),
	};
}

/** Native and shared presentation with no execution or loadout hooks. */
export function createDashboardToolDefinitions(cwd: string): (name: string, knownCall?: boolean) => ToolDefinition {
	const native = new Map([
		createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd), createGrepToolDefinition(cwd), createFindToolDefinition(cwd),
		createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd),
	].map((definition) => [definition.name, definition]));
	const agents = createAgentToolCards();
	const renderers = codemodeRenderers();
	return (name, knownCall = true) => {
		const builtin = knownCall ? native.get(name) : undefined;
		const presentation = (builtin ?? (name === "codemode" ? renderers : Object.hasOwn(agents, name) ? agents[name] : undefined)) as ToolRenderers | undefined;
		return {
			name, label: builtin?.label ?? name, description: builtin?.description ?? "Retained tool display",
			parameters: builtin?.parameters ?? Type.Object({}),
			...presentationFields(presentation),
			execute: cannotExecute,
		};
	};
}

type NestedCall = CodemodeToolDetails["calls"][number];
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function preview(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function normalizeCall(value: unknown, id: string): NestedCall | undefined {
	const call = record(value);
	if (typeof call.name !== "string" || typeof call.status !== "string" || !["running", "ok", "error", "cancelled"].includes(call.status)) return undefined;
	const normalized: NestedCall = {
		id: typeof call.id === "string" ? call.id : id,
		name: call.name, args: typeof call.args === "string" ? preview(call.args, 200) : "",
		status: call.status as NestedCall["status"],
	};
	if (finiteNumber(call.durationMs)) normalized.durationMs = call.durationMs;
	if (typeof call.error === "string") normalized.error = preview(call.error, 500);
	if (finiteNumber(call.cost)) normalized.cost = call.cost;
	return normalized;
}

/** Normalize retained and live details without inventing unseen argument or error data. */
export function normalizeCodemodeDetails(details: unknown, toolCallId: string): CodemodeToolDetails {
	const source = record(details);
	const calls = Array.isArray(source.calls) ? source.calls.flatMap((value, index) => {
		const call = normalizeCall(value, `${toolCallId}/${index + 1}`);
		return call === undefined ? [] : [call];
	}) : [];
	return { calls, ...(typeof source.fullOutputPath === "string" ? { fullOutputPath: source.fullOutputPath } : {}) };
}
