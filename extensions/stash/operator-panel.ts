/**
 * The stash browser for the attached Agent terminal. The client imports this module locally and
 * gives it a request route to the `stash` contribution command; the loop, the panel and the
 * effect confirmations are the ones the ordinary `/stash` overlay uses. Evaluating this module
 * registers nothing and opens no store.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { browseStashes, type BrowserOwner, type BrowserRound } from "./browser-flow.ts";
import { StashPanel, type StashPanelResult } from "./panel.ts";
import { readPanelAnswer, type StashPanelRequest } from "./panel-protocol.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The facilities the attached terminal passes to an owner panel (docs/conventions/operator-panels.md). */
export interface OperatorPanelHost {
	readonly target: { readonly id: string; readonly name?: string };
	readonly theme: Theme;
	readonly tui: { requestRender(): void };
	rows(): number;
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	readonly dialogs: {
		select(title: string, choices: readonly { value: string; label: string; description?: string }[]): Promise<string | undefined>;
		confirm(title: string, description: string, action: string): Promise<boolean>;
		input(title: string, options?: { initial?: string; placeholder?: string }): Promise<string | undefined>;
		notify(text: string, type?: "info" | "warning" | "error"): void;
	};
	close(): void;
}

export interface OperatorPanelInstance {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

/** Owner operations over the host route; effects return the host's receipt text. */
function routedOwner(host: OperatorPanelHost): BrowserOwner {
	const ask = async (request: StashPanelRequest, signal?: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	const viewOf = async (request: Extract<StashPanelRequest, { op: "recent" | "archive" }>, signal?: AbortSignal) => {
		const answer = await ask(request, signal);
		if (answer.op !== "recent" && answer.op !== "archive") throw new Error("unexpected answer");
		return answer.view;
	};
	const receipt = async (request: Exclude<StashPanelRequest, { op: "recent" | "archive" | "preview" }>) => {
		const answer = await ask(request);
		if (!("text" in answer)) throw new Error("unexpected answer");
		return answer.text;
	};
	return {
		recent: (signal) => viewOf({ op: "recent" }, signal),
		archive: async (query, cursor, prior, signal) => {
			try { return await viewOf({ op: "archive", query, ...(cursor === undefined ? {} : { cursor }) }, signal); }
			catch (error) {
				if (prior?.scope !== "archive") throw error;
				return { ...prior, stale: true, coverage: error instanceof Error ? error.message : String(error) };
			}
		},
		preview: async (entry, signal) => {
			const answer = await ask({ op: "preview", id: entry.meta.id }, signal);
			if (answer.op !== "preview") throw new Error("unexpected answer");
			return answer.entry;
		},
		pickup: (id, note) => receipt({ op: "pickup", id, ...(note === undefined ? {} : { note }) }),
		close: (id, outcome) => receipt({ op: "close", id, outcome }),
		release: (id) => receipt({ op: "release", id }),
		reopen: (id) => receipt({ op: "reopen", id }),
		rotate: (id) => receipt({ op: "rotate", id }),
		copy: (text) => copyToClipboard(text),
	};
}

function open(host: OperatorPanelHost): OperatorPanelInstance {
	let panel: StashPanel | undefined;
	let waiting = "Read stashes\u2026";
	let disposed = false;
	let pending: ((result: StashPanelResult | undefined) => void) | undefined;
	const show = (round: BrowserRound) => new Promise<StashPanelResult | undefined>((resolve) => {
		if (disposed) { resolve(undefined); return; }
		pending = resolve;
		panel = new StashPanel({
			entries: round.view.entries, title: "Stashes", theme: host.theme, tui: host.tui, getMaxRows: () => host.rows(),
			hasMore: round.view.hasMore, scope: round.view.scope, query: round.view.query, coverage: round.view.coverage, stale: round.view.stale, nextCursor: round.view.nextCursor,
			initialFilter: round.memory.filter, initialSelectedId: round.memory.selectedId, initialSelectedIndex: round.memory.selectedIndex, initialPreviewScroll: round.memory.previewScroll, initialDetail: round.memory.detail,
			loadPreview: round.loadPreview, copyResume: round.copyResume,
			done: (result) => { panel = undefined; pending = undefined; waiting = "Working\u2026"; host.tui.requestRender(); resolve(result); },
		});
		host.tui.requestRender();
	});
	const dialogs = {
		input: (title: string) => host.dialogs.input(title),
		select: async (title: string, choices: readonly string[]) => host.dialogs.select(title, choices.map((value) => ({ value, label: value }))),
		confirm: (title: string, description: string) => host.dialogs.confirm(title, description, "Confirm"),
		notify: (text: string, type?: "info" | "warning" | "error") => host.dialogs.notify(text, type),
	};
	void browseStashes(routedOwner(host), dialogs, show).finally(() => { if (!disposed) host.close(); });
	return {
		render: (width) => panel ? panel.render(width) : [truncateToWidth("Stashes", width), truncateToWidth(waiting, width)],
		handleInput: (data) => { if (panel) panel.handleInput(data); else if (data === "\x1b") host.close(); },
		handleMouse: (event) => panel?.handleMouse(event),
		invalidate: () => panel?.invalidate(),
		dispose() { disposed = true; panel?.dispose(); panel = undefined; pending?.(undefined); pending = undefined; },
	};
}

export function operatorPanel(): { readonly version: 1; readonly title: string; open(host: OperatorPanelHost): OperatorPanelInstance } {
	return { version: 1, title: "Stashes", open };
}
