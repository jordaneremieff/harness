import { createHash } from "node:crypto";
import { hostMetadata, type CatalogRecord } from "./catalog.ts";

export const DELIVERY_WAKE_RECIPIENT_LIMIT = 256;

export function nativeRecipientAvailability(record: CatalogRecord, packageDir?: string): string {
	return createHash("sha256")
		.update(JSON.stringify(hostMetadata(record, packageDir)))
		.digest("hex");
}
