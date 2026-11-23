import { arr, bool, int, lit, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";

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
	live: lit(3),
	pid: int(),
	origin,
	view: PaneViewSchema,
	reportedAt: int(),
});
export const LaunchSchema = obj({
	launchId: str(),
	origin,
	status: union([lit("offered"), lit("launching")]),
	documentId: opt(str()),
	revision: opt(int()),
	pid: opt(int()),
});
export const PaneInventorySchema = obj({ panes: arr(PaneSchema), pending: arr(LaunchSchema) });
export type PaneInventory = Static<typeof PaneInventorySchema>;

export function paneInventory(bridge?: {
	list(): PaneInventory["panes"];
	pendingLaunches(): PaneInventory["pending"];
}): PaneInventory {
	return { panes: bridge?.list() ?? [], pending: bridge?.pendingLaunches() ?? [] };
}
