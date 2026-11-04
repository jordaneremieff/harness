/**
 * The stash browser for the attached Agent terminal. The client imports this module locally and
 * gives it a request route to the `stash` contribution command of the selected agent; the view is
 * the one ordinary Pi shows. Evaluating this module registers nothing and opens no store.
 */

import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import type { JsonValue, OperatorPanelModule, PanelHost } from "../../operator-ui/index.ts";
import { createStashViewState, type StashOperations, type StashViewState, stashView } from "./operator-view.ts";
import { readPanelAnswer, type StashPanelRequest } from "./panel-protocol.ts";

/** Owner operations over the host route; effects answer the host's receipt text. */
function routedOperations(host: PanelHost): StashOperations {
	const ask = async (request: StashPanelRequest, signal?: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	const viewOf = async (request: Extract<StashPanelRequest, { op: "recent" | "archive" }>, signal: AbortSignal) => {
		const answer = await ask(request, signal);
		if (answer.op !== "recent" && answer.op !== "archive") throw new Error("The host answered a different stash request");
		return answer.view;
	};
	const receipt = async (request: Exclude<StashPanelRequest, { op: "recent" | "archive" | "preview" }>) => {
		const answer = await ask(request);
		if (!("text" in answer)) throw new Error("The host answered a different stash request");
		return answer.text;
	};
	return {
		recent: (signal) => viewOf({ op: "recent" }, signal),
		archive: async (query, cursor, prior, signal) => {
			try {
				return await viewOf({ op: "archive", query, ...(cursor === undefined ? {} : { cursor }) }, signal);
			} catch (error) {
				if (prior?.scope !== "archive" || signal.aborted) throw error;
				return { ...prior, stale: true, coverage: error instanceof Error ? error.message : String(error) };
			}
		},
		preview: async (entry, signal) => {
			const answer = await ask({ op: "preview", id: entry.meta.id }, signal);
			if (answer.op !== "preview") throw new Error("The host answered a different stash request");
			return answer.entry;
		},
		// The handover goes to the selected agent's conversation, so the browser stays open with the receipt.
		pickup: (id, note) => receipt({ op: "pickup", id, ...(note === undefined ? {} : { note }) }),
		close: (id, outcome) => receipt({ op: "close", id, outcome }),
		release: (id) => receipt({ op: "release", id }),
		reopen: (id) => receipt({ op: "reopen", id }),
		rotate: (id) => receipt({ op: "rotate", id }),
		copy: (text) => copyToClipboard(text),
	};
}

/** Browsing position per attached target, kept while this terminal runs. */
const states = new Map<string, StashViewState>();

function stateFor(target: string): StashViewState {
	let state = states.get(target);
	if (!state) {
		state = createStashViewState();
		states.set(target, state);
	}
	return state;
}

export function operatorPanel(): OperatorPanelModule {
	return { version: 2, title: "Stashes", open: (host) => stashView(host, routedOperations(host), stateFor(host.target.id)) };
}
