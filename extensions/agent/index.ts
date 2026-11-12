import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_ENTRY_CHANNEL, type AgentEntryRequest } from "./entry-binding.ts";
import { declareContinuityTools } from "./continuity-tools.ts";

const ownerKey = Symbol.for("pi.extension.agent.owners");
const processState = globalThis as typeof globalThis & {
	[ownerKey]?: { managers: Map<string, unknown> };
};
processState[ownerKey] ??= { managers: new Map() };

const source = fileURLToPath(import.meta.url);
let ordinaryEntryPromise: Promise<typeof import("./ordinary-entry.ts")> | undefined;

function loadOrdinaryEntry(): Promise<typeof import("./ordinary-entry.ts")> {
	ordinaryEntryPromise ??= import("./ordinary-entry.ts");
	return ordinaryEntryPromise;
}

export default async function registerAgentExtension(pi: ExtensionAPI): Promise<void> {
	const request: AgentEntryRequest = { version: 1, source };
	pi.events.emit(AGENT_ENTRY_CHANNEL, request);
	if (request.result?.kind === "native") {
		await request.result.register(pi);
		declareContinuityTools(pi, "native");
		return;
	}
	if (request.result?.kind === "rejected") {
		throw new Error(request.result.reason);
	}
	const { registerOrdinaryAgentExtension } = await loadOrdinaryEntry();
	registerOrdinaryAgentExtension(pi, source);
	declareContinuityTools(pi, "ordinary");
}
