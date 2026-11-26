import { parseCatalogView, type CatalogView } from "./catalog-view.ts";
import { activityKey, attachLiveActivity, readLiveActivity, type ChangesView } from "./live-activity.ts";

const LIVE_ACTIVITY_PREFIX = "activity:";
const OWNER_LIMIT = 512;

export function activityFeedToken(sessionId: string): string {
	return LIVE_ACTIVITY_PREFIX + sessionId;
}

export function activityFeedOwner(token: string | undefined): string | undefined {
	if (!token?.startsWith(LIVE_ACTIVITY_PREFIX) || token.length > LIVE_ACTIVITY_PREFIX.length + OWNER_LIMIT)
		return undefined;
	const id = token.slice(LIVE_ACTIVITY_PREFIX.length);
	return activityKey(id, OWNER_LIMIT) ? id : undefined;
}

export function baseChangesView(view: ChangesView): CatalogView {
	if (!Object.hasOwn(view, "liveActivity")) return view;
	const { liveActivity: _, ...base } = view;
	return base;
}

/** Current host publication, bound to the generation from the negotiated hello. */
export interface HostChanges {
	readonly revision: number;
	readonly writerId: string;
	readonly view?: ChangesView;
}
export type NativeOwnerEvidence =
	| {
			readonly kind: "verified";
			readonly storageId: string;
			readonly socketPath: string;
			readonly writerId: string;
			readonly view?: CatalogView;
	  }
	| { readonly kind: "unavailable"; readonly reason: string }
	| { readonly kind: "unknown"; readonly reason: string };

/** Reject retired shapes and publications from a different storage or generation. */
export function parseHostChanges(
	value: unknown,
	writerId: string,
	storageId: string,
	includeActivity = false,
): HostChanges {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Host changes frame is not an object");
	const frame = value as Record<string, unknown>;
	if (
		Object.keys(frame).some((key) => !["revision", "writerId", "view"].includes(key)) ||
		!Number.isSafeInteger(frame.revision) ||
		Number(frame.revision) < 0 ||
		frame.writerId !== writerId
	)
		throw new Error("Host changes frame has an invalid revision or writer identity");
	if (frame.view === undefined) return { revision: Number(frame.revision), writerId };
	const raw = frame.view;
	let view: ChangesView;
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.hasOwn(raw, "liveActivity")) {
		const { liveActivity, ...base } = raw as Record<string, unknown>;
		view = parseCatalogView(base);
		if (includeActivity && view.unavailable === undefined)
			view = attachLiveActivity(view, readLiveActivity(liveActivity));
	} else {
		view = parseCatalogView(raw);
	}
	if (view.storageId !== storageId) throw new Error("Host publication describes a different storage");
	return { revision: Number(frame.revision), writerId, view };
}
