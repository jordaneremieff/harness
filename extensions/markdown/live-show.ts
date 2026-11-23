import { arr, int, lit, obj, opt, str } from "@earendil-works/pi-schema";
import type { LiveBridge } from "./live-bridge.ts";
import { withLiveShow } from "./live-launch.ts";
import type { LiveConfig } from "./live-protocol.ts";
import { paneCommand } from "./pane-command.ts";
import { LaunchSchema, PaneViewSchema, paneInventory } from "./pane-state.ts";
import type { MarkdownStore } from "./store.ts";

export const ShowOutcomes = [
	obj({ status: lit("navigated"), workspace: str(), document: str(), handle: str(), view: PaneViewSchema }),
	obj({ status: lit("pending"), pending: arr(LaunchSchema), message: str() }),
	obj({
		status: lit("launch"),
		documentId: str(),
		revision: opt(int()),
		argv: arr(str()),
		launchId: str(),
		message: str(),
	}),
] as const;

export interface ShowOptions {
	store: MarkdownStore;
	app?: string;
	connection: () => Promise<LiveConfig>;
	checkRoute?: () => void;
}

/** A handle selects a specific live buffer; a stored ID selects content, never a substitute buffer. */
export async function showStored(
	bridge: LiveBridge | undefined,
	input: { document?: string; revision?: number; handle?: string; newPane?: boolean },
	options: ShowOptions | undefined,
	signal?: AbortSignal,
) {
	if (!options)
		return { status: "error", message: "This host has no live show route. The saved document remains available." };
	if (!input.document || !/^md-[a-f0-9]{20}$/u.test(input.document))
		return { status: "error", message: "Use the full stored document ID from markdown_read or markdown_publish." };
	const { store } = options;
	const identity = await store.identity();
	if (!identity) return { status: "error", message: "The Markdown store is absent. No pane was changed." };
	const selected = await store.get(input.document, input.revision);
	const documentId = selected.document.id;
	const pin =
		input.revision === undefined
			? undefined
			: { revision: selected.revision.revision, digest: selected.revision.digest };
	signal?.throwIfAborted();
	options.checkRoute?.();
	const selection = selectPane(paneInventory(bridge), input.handle, input.newPane);
	if (selection.status === "new") return offerLaunch(options, documentId, pin, signal, input.newPane);
	if (selection.status !== "reuse") return selection;
	if (!bridge) return { status: "closed", message: "The exact conversation is no longer available." };
	// Navigation success comes from the rendered page, even if inventory already names this document.
	const result = await bridge.execute(
		selection.handle,
		{ op: "navigate", storeId: identity.storeId, documentId, ...pin },
		signal,
	);
	if (result.status === "uncertain")
		return {
			...result,
			message: `${result.message} List panes to check the displayed view. Do not repeat the command or launch a replacement automatically.`,
		};
	return result;
}

type Inventory = ReturnType<typeof paneInventory>;
type Selection =
	| { status: "new" }
	| { status: "reuse"; handle: string }
	| { status: "pending"; pending: Inventory["pending"]; message: string }
	| { status: "busy" | "closed" | "error"; message: string };
function selectPane(inventory: Inventory, handle?: string, newPane?: boolean): Selection {
	const pending = inventory.pending.filter((launch) => launch.origin === "agent");
	if (handle === undefined && pending.length)
		return {
			status: "pending",
			pending,
			message:
				"An agent launch is outstanding. An offer is not a started pane. Use list to check for a connected handle; do not open another pane.",
		};
	if (newPane === true) return { status: "new" };
	const eligible = inventory.panes.filter((pane) => pane.origin === "agent");
	if (handle === undefined && eligible.length > 1)
		return {
			status: "busy",
			message: "More than one agent pane is connected. List panes and specify its exact handle.",
		};
	const pane = handle === undefined ? eligible[0] : inventory.panes.find((item) => item.handle === handle);
	if (handle !== undefined && !pane)
		return {
			status: "closed",
			message:
				"That exact handle is not connected to this conversation. No other pane was selected. Use list to check its state.",
		};
	if (pane?.origin === "operator")
		return {
			status: "error",
			message: "This is an operator pane. Only an agent pane from this conversation accepts show.",
		};
	return pane ? { status: "reuse", handle: pane.handle } : { status: "new" };
}

async function offerLaunch(
	{ store, app, connection }: ShowOptions,
	documentId: string,
	pin: { revision: number; digest: string } | undefined,
	signal?: AbortSignal,
	newPane?: boolean,
) {
	const command = paneCommand(app, store.root, documentId, pin);
	if ("showUnavailable" in command) return { status: "error", message: command.showUnavailable };
	const target = { documentId, ...(pin && { revision: pin.revision }) };
	const offer: typeof target & { show?: string[]; showUnavailable?: string } = { ...target, show: command.show };
	const launch = await withLiveShow(offer, app, connection, signal, newPane);
	if (!launch.show || !launch.launchId)
		return {
			status: "error",
			message: launch.showUnavailable ?? "No live launch was reserved. Check the pane list before requesting a launch.",
		};
	return {
		status: "launch",
		...target,
		launchId: launch.launchId,
		argv: launch.show,
		message:
			"Run this exact one-use argv as the initial pane program. This offer does not confirm startup or display. Use list to confirm the document and revision; " +
			(newPane === true ? "use the offer only once." : "do not start a second pane."),
	};
}
