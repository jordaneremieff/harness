/**
 * The browse-and-act loop behind `/stash`: show a view, route a navigation or a labelled
 * action, repeat until the browser closes or a pickup is delivered. The ordinary overlay and the
 * attached-terminal panel both run this loop; each supplies its own dialogs, panel host, and owner
 * operations, so the effects and their confirmations stay identical on both routes.
 */

import type { BrowserView } from "./browser-views.ts";
import { resumeCommand } from "./format.ts";
import type { StashPanelResult } from "./panel.ts";
import type { StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

const safeLine = (value: string) => sanitizeTerminalText(value).text.replace(/\n/g, "\u21b5");

/** Reads and effects the loop needs; every effect returns its receipt text. */
export interface BrowserOwner {
	recent(signal?: AbortSignal): Promise<BrowserView>;
	archive(query: string, cursor: string | undefined, prior: BrowserView | undefined, signal?: AbortSignal): Promise<BrowserView>;
	preview(entry: StashEntry, signal: AbortSignal): Promise<StashEntry>;
	/** Activates the record and delivers its handover; the only action that starts conversation work. A returned receipt is shown; an empty one means the owner already reported. */
	pickup(id: string, note?: string): Promise<string>;
	close(id: string, outcome: string): Promise<string>;
	release(id: string): Promise<string>;
	reopen(id: string): Promise<string>;
	rotate(id: string): Promise<string>;
	/** A client clipboard action, separate from every store effect. */
	copy(text: string): Promise<void>;
}

/** Modal prompts; each resolves undefined (or false) when the operator cancels. */
export interface BrowserDialogs {
	input(title: string): Promise<string | undefined>;
	select(title: string, choices: readonly string[]): Promise<string | undefined>;
	confirm(title: string, description: string): Promise<boolean>;
	notify(text: string, type?: "info" | "warning" | "error"): void;
}

export interface BrowserMemory {
	filter?: string;
	selectedId?: string;
	selectedIndex?: number;
	previewScroll?: number;
	detail?: boolean;
}

/** Panel inputs the loop owns; the host adds theme, tui, rows and title. */
export interface BrowserRound {
	readonly view: BrowserView;
	readonly memory: BrowserMemory;
	loadPreview(entry: StashEntry, signal: AbortSignal): Promise<StashEntry>;
	copyResume(entry: StashEntry): Promise<void>;
}

/** Shows one round of the panel and resolves with its result; undefined means the host closed it. */
export type ShowPanel = (round: BrowserRound) => Promise<StashPanelResult | undefined>;

type BrowserAction = { kind: "stop" | "continue" } | { kind: "pickup"; id: string; note?: string };

function rememberPanel(result: StashPanelResult | undefined): BrowserMemory {
	return { filter: result?.filter ?? "", selectedId: result?.selectedId, selectedIndex: result?.selectedIndex, previewScroll: result?.previewScroll, detail: result?.detail };
}

const message = (error: unknown) => safeLine(error instanceof Error ? error.message : String(error));

/** Resolve a scope or page request into the next view; cancelling the query dialog keeps the current one. */
async function navigate(owner: BrowserOwner, dialogs: BrowserDialogs, navigation: NonNullable<StashPanelResult["navigation"]>, view: BrowserView): Promise<BrowserView> {
	try {
		if ((navigation === "recent" || view.scope !== "archive") && navigation !== "search") return await owner.recent();
		if (navigation === "search") {
			const query = (await dialogs.input("Search archive (full bodies, literal match):"))?.trim();
			return query ? await owner.archive(query, undefined, undefined) : view;
		}
		if (navigation === "refresh") return await owner.archive(view.query, undefined, undefined);
		return view.nextCursor ? await owner.archive(view.query, view.nextCursor, view) : view;
	} catch (error) {
		dialogs.notify(`Stash search could not run: ${message(error)}`, "warning");
		return view;
	}
}

async function closeFromBrowser(owner: BrowserOwner, dialogs: BrowserDialogs, id: string): Promise<void> {
	const outcome = await dialogs.input("Concrete outcome for this stashed effort:");
	if (outcome?.trim()) dialogs.notify(await owner.close(id, outcome), "info");
}

/**
 * The note path: collect the amendment first, then pick up with it. A cancelled dialog returns to
 * the browser without activation or delivery; a submitted empty answer is a deliberate plain pickup.
 */
async function notedPickup(dialogs: BrowserDialogs, id: string): Promise<BrowserAction> {
	const answer = await dialogs.input("Operator note for this pickup (empty for none):");
	if (answer === undefined) return { kind: "continue" };
	return { kind: "pickup", id, note: answer.trim() || undefined };
}

async function applyManaged(owner: BrowserOwner, dialogs: BrowserDialogs, id: string, action: string): Promise<BrowserAction> {
	if (action === "Pick up") return { kind: "pickup", id };
	if (action === "Close with outcome") await closeFromBrowser(owner, dialogs, id);
	else if (action === "Release (return to open)") dialogs.notify(await owner.release(id), "info");
	else if (action === "Reopen") {
		if (await dialogs.confirm("Reopen stashed effort?", `Clear the closure outcome on ${id} and return it to open state?`)) dialogs.notify(await owner.reopen(id), "info");
	} else if (action === "Rotate (archive)") {
		if (await dialogs.confirm("Rotate stashed effort?", `Move ${id} into the stash store's .trash directory? It will disappear from listings and pickup; the file remains recoverable.`)) dialogs.notify(await owner.rotate(id), "info");
	}
	return { kind: "continue" };
}

async function manageEntry(owner: BrowserOwner, dialogs: BrowserDialogs, managed: StashEntry): Promise<BrowserAction> {
	if (managed.meta.invalidState !== undefined || managed.previewError !== undefined) {
		const reason = managed.meta.invalidState !== undefined ? `state "${safeLine(managed.meta.invalidState)}" is not a recognized lifecycle state` : "its header could not be read, so its state is unknown";
		dialogs.notify(`Stash ${managed.meta.id} cannot be acted on: ${reason}.`, "warning");
		return { kind: "continue" };
	}
	const state = managed.meta.state;
	const choices = state === "active" ? ["Close with outcome", "Release (return to open)", "Back"] : state === "closed" ? ["Reopen", "Rotate (archive)", "Back"] : ["Pick up", "Rotate (archive)", "Back"];
	const action = await dialogs.select(`Stash ${managed.meta.id}`, choices);
	if (!action || action === "Back") return { kind: "continue" };
	return applyManaged(owner, dialogs, managed.meta.id, action);
}

async function browserAction(owner: BrowserOwner, dialogs: BrowserDialogs, result: StashPanelResult | undefined): Promise<BrowserAction> {
	if (result?.selected) return { kind: "pickup", id: result.selected.meta.id };
	if (result?.note) return notedPickup(dialogs, result.note.meta.id);
	if (result?.complete) { await closeFromBrowser(owner, dialogs, result.complete.meta.id); return { kind: "continue" }; }
	if (!result?.manage) return { kind: "stop" };
	return manageEntry(owner, dialogs, result.manage);
}

/** One round: show the view, then either take the next view or run the chosen action. */
async function browseRound(owner: BrowserOwner, dialogs: BrowserDialogs, show: ShowPanel, current: BrowserView, state: { memory: BrowserMemory }): Promise<{ next?: BrowserView; done: boolean }> {
	const result = await show({ view: current, memory: state.memory, loadPreview: (entry, signal) => owner.preview(entry, signal), copyResume: (entry) => owner.copy(resumeCommand(entry.meta.id)) });
	state.memory = rememberPanel(result);
	if (result?.navigation) {
		const next = await navigate(owner, dialogs, result.navigation, current);
		if (next !== current) state.memory = {};
		return { next, done: false };
	}
	let action: BrowserAction;
	try { action = await browserAction(owner, dialogs, result); }
	catch (error) { dialogs.notify(message(error), "error"); return { done: true }; }
	if (action.kind === "continue") return { done: false };
	if (action.kind === "pickup") {
		try { const receipt = await owner.pickup(action.id, action.note); if (receipt) dialogs.notify(receipt, "info"); }
		catch (error) { dialogs.notify(message(error), "error"); }
	}
	return { done: true };
}

/**
 * Browse until the operator closes the panel or picks up a record. A navigation result is shown as
 * loaded; after an action the current view is read again so the list reflects the change. A pickup
 * ends the loop with the owner's receipt; a failed effect is reported and ends the loop.
 */
export async function browseStashes(owner: BrowserOwner, dialogs: BrowserDialogs, show: ShowPanel): Promise<void> {
	let view: BrowserView | undefined;
	let loaded = false;
	const state = { memory: {} as BrowserMemory };
	for (;;) {
		try {
			if (view === undefined || !loaded) view = view?.scope === "archive" ? await owner.archive(view.query, view.cursor, view) : await owner.recent();
		} catch (error) {
			dialogs.notify(`Could not open stash store: ${message(error)}`, "error");
			return;
		}
		loaded = false;
		const round = await browseRound(owner, dialogs, show, view, state);
		if (round.done) return;
		if (round.next) { view = round.next; loaded = true; }
	}
}
