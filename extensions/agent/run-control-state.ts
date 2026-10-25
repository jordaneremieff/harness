import type * as Native from "@earendil-works/pi-durable";
import type { ResultReference } from "./result-reference.ts";

export type RunControlState = {
	recorded: boolean;
	inputs: number[];
	complete: boolean;
	dispatch?: "pending" | "confirmed";
	result?: ResultReference | null;
};

/** Native input and task links remain available after a generation settles. */
export function agentRunControlDoc(durable: typeof Native) {
	return durable.defineDocFamily<RunControlState, null>({ kind: "agent.run-control", family: true, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ recorded: false, inputs: [], complete: true }), checkpointWhen: () => false });
}
