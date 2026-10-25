import type * as Durable from "@earendil-works/pi-durable";
import type { ExecutionSelection } from "./agent-preferences.ts";
import type { ResultReference } from "./result-reference.ts";

export type AgentChild = {
	readonly selection?: ExecutionSelection;
	readonly name: string;
	readonly conversationId?: Durable.ConversationId;
	readonly anchorTaskId?: Durable.TaskId;
	readonly foreignSessionId?: string;
	readonly result?: ResultReference;
	readonly thinking?: { requested: string; effective: string };
	readonly createdBy: Durable.TaskId;
	reported: Durable.EntryId[];
};
export type AgentChildrenState = { children: AgentChild[]; reporters: Record<string, number> };

/** Native creation and reporter records remain the authority for delegated-work lineage. */
export function agentChildrenDoc(durable: typeof Durable) {
	return durable.defineDoc<AgentChildrenState>({ kind: "agent.children", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ children: [], reporters: {} }), checkpointWhen: () => false });
}
