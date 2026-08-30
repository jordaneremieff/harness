import type { SubjectAdapter } from "./types.mts";
import { piSdkAdapter } from "./subjects/pi-sdk.mts";

const adapters = new Map<string, SubjectAdapter>([[piSdkAdapter.id, piSdkAdapter]]);

export function getSubjectAdapter(id: string): SubjectAdapter {
	const adapter = adapters.get(id);
	if (!adapter) throw new Error(`No subject adapter is registered for ${id}`);
	return adapter;
}
