import { arr, bool, int, lit, obj, oneOf, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { PANE_PROTOCOL } from "./live-protocol.ts";

/** A saved document is a show target, not evidence of a launch or an invitation to type into a terminal. */
export const ShowRequestSchema = obj({ op: lit("show"), document: str(), revision: opt(int()) });
export type ShowRequest = Static<typeof ShowRequestSchema>;
export const PaneViewSchema = obj({
	kind: union([
		lit("published"),
		lit("response"),
		lit("file"),
		lit("scratchpad"),
		lit("copy"),
		lit("local-file"),
		lit("loading"),
	]),
	title: str(),
	mode: union([lit("reading"), lit("writing")]),
	follows: opt(bool()),
	dirty: bool(),
	conflict: bool(),
	storeId: opt(str()),
	documentId: opt(str()),
	revision: opt(int()),
	digest: opt(str()),
});
const origin = union([lit("agent"), lit("operator")]);
export const PaneSchema = obj({
	workspace: str(),
	document: str(),
	handle: str(),
	live: lit(PANE_PROTOCOL),
	launchId: str(),
	pid: int(),
	origin,
	view: PaneViewSchema,
	reportedAt: int(),
});
export const LaunchSchema = obj({
	launchId: str(),
	origin,
	status: union([lit("offered"), lit("launching")]),
	expiresAt: int(),
	documentId: opt(str()),
	revision: opt(int()),
	pid: opt(int()),
});
export const LaunchFailureSchema = obj({
	launchId: str(),
	origin,
	status: lit("failed"),
	documentId: opt(str()),
	revision: opt(int()),
	pid: opt(int()),
	reason: oneOf(["offer-expired", "startup-expired", "process-ended", "boot-failed", "reload-revoked"]),
	message: str(),
	finishedAt: int(),
});
export const PaneDepartureSchema = obj({
	workspace: str(),
	launchId: str(),
	reason: oneOf(["reader-closed", "document-closed", "process-ended", "contact-lost"]),
	departedAt: int(),
	lastPane: opt(PaneSchema),
});
export const PaneInventoryFields = {
	panes: arr(PaneSchema),
	pending: arr(LaunchSchema),
	failed: opt(arr(LaunchFailureSchema)),
	departed: opt(arr(PaneDepartureSchema)),
};
export const PaneInventorySchema = obj(PaneInventoryFields);
export type PaneInventory = Static<typeof PaneInventorySchema>;

export function paneInventory(bridge?: {
	list(): PaneInventory["panes"];
	pendingLaunches(): PaneInventory["pending"];
	failedLaunches?(): NonNullable<PaneInventory["failed"]>;
	paneDepartures?(): NonNullable<PaneInventory["departed"]>;
}): PaneInventory {
	const panes = bridge?.list() ?? [];
	const pending = bridge?.pendingLaunches() ?? [];
	const failed = bridge?.failedLaunches?.();
	const departed = bridge?.paneDepartures?.();
	return { panes, pending, ...(failed?.length && { failed }), ...(departed?.length && { departed }) };
}
