import { parseCatalogView, type CatalogView } from "./catalog-view.ts";

/** Current host publication, bound to the generation from the negotiated hello. */
export interface HostChanges {
	readonly revision: number;
	readonly writerId: string;
	readonly view?: CatalogView;
}
export type NativeOwnerEvidence =
	| { readonly kind: "verified"; readonly storageId: string; readonly socketPath: string; readonly writerId: string; readonly view?: CatalogView }
	| { readonly kind: "unavailable"; readonly reason: string }
	| { readonly kind: "unknown"; readonly reason: string };

/** Reject retired shapes and publications from a different storage or generation. */
export function parseHostChanges(value: unknown, writerId: string, storageId: string): HostChanges {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Host changes frame is not an object");
	const frame = value as Record<string, unknown>;
	if (Object.keys(frame).some((key) => !["revision", "writerId", "view"].includes(key)) || !Number.isSafeInteger(frame.revision) || Number(frame.revision) < 0 || frame.writerId !== writerId)
		throw new Error("Host changes frame has an invalid revision or writer identity");
	const view = frame.view === undefined ? undefined : parseCatalogView(frame.view);
	if (view !== undefined && view.storageId !== storageId) throw new Error("Host publication describes a different storage");
	return { revision: Number(frame.revision), writerId, ...(view === undefined ? {} : { view }) };
}
