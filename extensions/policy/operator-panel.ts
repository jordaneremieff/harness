/**
 * The policy view for the attached Agent terminal. The client imports this module locally and
 * gives it a request route to the `policy` contribution command of the selected agent; the view,
 * the complete artifact review and the effect-labelled final action are the ones ordinary Pi
 * shows. Every read and change runs in the host against the bound conversation's scope with a
 * panel audit. Evaluating this module registers nothing and opens no store.
 */

import type { JsonValue, OperatorPanelModule, PanelHost } from "../../operator-ui/index.ts";
import { createPolicyViewState, type PolicyOperations, type PolicyResult, type PolicyViewState, policyView } from "./operator-view.ts";
import { deserializeFireSummary, deserializeSnapshot, type PolicyPanelAnswer, type PolicyPanelRequest, readPanelAnswer } from "./panel-protocol.ts";

const unexpected = () => new Error("The host answered a different policy request");

function routedOperations(host: PanelHost): PolicyOperations {
	const ask = async (request: PolicyPanelRequest, signal?: AbortSignal): Promise<PolicyPanelAnswer> => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	const settled = async (request: PolicyPanelRequest): Promise<PolicyResult> => {
		const answer = await ask(request);
		if (!("outcome" in answer)) throw unexpected();
		return { outcome: answer.outcome, snapshot: deserializeSnapshot(answer.snapshot) };
	};
	return {
		load: async (signal) => {
			const answer = await ask({ op: "load" }, signal);
			if (answer.op !== "load") throw unexpected();
			return { snapshot: deserializeSnapshot(answer.snapshot), fireSummary: deserializeFireSummary(answer.fireSummary), activity: answer.activity, scope: answer.scope };
		},
		refresh: async () => {
			const answer = await ask({ op: "refresh" });
			if (answer.op !== "refresh") throw unexpected();
			return deserializeSnapshot(answer.snapshot);
		},
		inspect: async (view, id) => {
			const answer = await ask({ op: "inspect", view, ...(id === undefined ? {} : { id }) });
			if (answer.op !== "inspect") throw unexpected();
			return { text: answer.text, snapshot: deserializeSnapshot(answer.snapshot) };
		},
		approve: (proposalId, effect, revision) => settled({ op: "approve", proposalId, ...(effect === undefined ? {} : { effect }), revision }),
		reject: (proposalId, revision) => settled({ op: "reject", proposalId, revision }),
		lifecycle: (verb, id, reason, expectedIdentity) => settled({ op: "lifecycle", verb, id, reason, ...(expectedIdentity === undefined ? {} : { expectedIdentity }) }),
		effect: (id, effect, reason, expectedIdentity) => settled({ op: "effect", id, effect, reason, ...(expectedIdentity === undefined ? {} : { expectedIdentity }) }),
		resetRevision: async (id) => {
			const answer = await ask({ op: "reset-revision", id });
			if (answer.op !== "reset-revision") throw unexpected();
			return answer.revision;
		},
		reset: (id, reason, revision) => settled({ op: "reset", id, reason, revision }),
		data: async (args) => {
			const answer = await ask({ op: "data", args });
			if (answer.op !== "data") throw unexpected();
			if ("review" in answer) return { review: answer.review, snapshot: deserializeSnapshot(answer.snapshot) };
			return { outcome: answer.outcome, snapshot: deserializeSnapshot(answer.snapshot) };
		},
	};
}

/** Browsing position per attached target, kept while this terminal runs. */
const states = new Map<string, PolicyViewState>();

function stateFor(target: string): PolicyViewState {
	let state = states.get(target);
	if (!state) {
		state = createPolicyViewState();
		states.set(target, state);
	}
	return state;
}

export function operatorPanel(): OperatorPanelModule {
	return { version: 2, title: "Policy", open: (host) => policyView(host, routedOperations(host), stateFor(host.target.id)) };
}
