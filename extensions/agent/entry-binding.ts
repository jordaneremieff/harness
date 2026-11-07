import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const AGENT_ENTRY_CHANNEL = "durable:agent-entry";

export interface AgentEntryRequest {
	readonly version: 1;
	readonly source: string;
	result?:
		| { readonly kind: "native"; readonly register: ExtensionFactory }
		| { readonly kind: "rejected"; readonly reason: string };
}
