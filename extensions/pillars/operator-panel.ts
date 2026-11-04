/**
 * The read-only Pillars browser for the attached Agent terminal. The client imports this module
 * locally and gives it a request route to the `pillars` contribution command of the selected
 * agent; the view is the one ordinary Pi shows. Evaluating this module registers nothing and
 * reads no corpus.
 */

import type { JsonValue, OperatorPanelModule, PanelHost } from "../../operator-ui/index.ts";
import { createPillarsViewState, type PillarsOperations, type PillarsViewState, pillarsView } from "./operator-view.ts";
import { readPanelAnswer, type PillarsPanelRequest } from "./panel-protocol.ts";

function routedOperations(host: PanelHost): PillarsOperations {
	const ask = async (request: PillarsPanelRequest, signal: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	return {
		inventory: async (signal) => {
			const answer = await ask({ op: "inventory" }, signal);
			if (answer.op !== "inventory") throw new Error("The host answered a different Pillars request");
			return answer.entries;
		},
		read: async (request, signal) => {
			const answer = await ask(
				{
					op: "read",
					resource: request.resource ?? "inventory",
					...(request.offset === undefined ? {} : { offset: request.offset }),
					...(request.referenceBodyDigest === undefined ? {} : { referenceBodyDigest: request.referenceBodyDigest }),
				},
				signal,
			);
			if (answer.op !== "read") throw new Error("The host answered a different Pillars request");
			return answer.page;
		},
	};
}

/** Browsing position per attached target, kept while this terminal runs. */
const states = new Map<string, PillarsViewState>();

function stateFor(target: string): PillarsViewState {
	let state = states.get(target);
	if (!state) {
		state = createPillarsViewState();
		states.set(target, state);
	}
	return state;
}

export function operatorPanel(): OperatorPanelModule {
	return { version: 2, title: "Pillars", open: (host) => pillarsView(host, routedOperations(host), stateFor(host.target.id)) };
}
