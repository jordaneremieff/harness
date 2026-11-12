/** Fit one storage status page to its presentation byte limit through smaller scans of the same position. */
import { projectStorageStatus } from "./status-overview.ts";

export interface FittedStoragePage<Page, Projected> {
	/** The scan page behind the projection; its continuation and counts are the ones to return. */
	readonly page: Page;
	readonly projected: Projected;
}

/**
 * Scan with the requested limit, then with half of it (rounded up) down to one row, while the projection
 * overflows its byte limit. Every scan starts at the caller's position: the scan function owns the cursor
 * and receives only a limit. Any other projection result ends the search after the scan that produced it,
 * and a one-row overflow is returned as the projection made it.
 */
export async function fitStoragePage<Page, Projected>(
	limit: number,
	scan: (limit: number) => Promise<Page>,
	project: (page: Page) => Projected,
	overflows: (projected: Projected) => boolean,
): Promise<FittedStoragePage<Page, Projected>> {
	for (;;) {
		const page = await scan(limit);
		const projected = project(page);
		const smaller = Math.ceil(limit / 2);
		if (!(smaller < limit) || !overflows(projected)) return { page, projected };
		limit = smaller;
	}
}

/** The compact storage projection with its typed byte-limit refusal as the only cause of a smaller scan. */
export function fitStorageStatusPage<Page>(
	limit: number,
	scan: (limit: number) => Promise<Page>,
): Promise<FittedStoragePage<Page, ReturnType<typeof projectStorageStatus>>> {
	return fitStoragePage(limit, scan, projectStorageStatus, (projected) => projected.format === "refused" && projected.cause === "byte-limit");
}
