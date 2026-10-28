/** Writer-owned parked-recipient discovery, separate from the storage catalogue. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostMetadata, storageIdOf, type CatalogRecord } from "./catalog.ts";
import { publishCatalogChange } from "./catalog-events.ts";

const FORMAT = "agent.delivery-wake/1";
export const DELIVERY_WAKE_RECIPIENT_LIMIT = 256;
const MAX_BYTES = 32 * 1024;

export interface DeliveryWake {
	readonly format: typeof FORMAT;
	readonly recipients: readonly string[];
	readonly failedAvailability: Readonly<Record<string, string | null>>;
	readonly omitted: number;
}

export function nativeRecipientAvailability(record: CatalogRecord, packageDir?: string): string {
	return createHash("sha256").update(JSON.stringify(hostMetadata(record, packageDir))).digest("hex");
}

export function deliveryWakePath(sessionsRoot: string, storageId: string): string {
	if (storageIdOf(storageId) !== storageId) throw new Error("Delivery wake source requires an exact storage identity");
	return join(sessionsRoot, ".delivery-wake", `${storageId}.json`);
}

function readWakeText(path: string): string | undefined {
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Delivery wake metadata is not a bounded regular file");
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (count === 0) break;
			length += count;
		}
		if (length > MAX_BYTES) throw new Error("Delivery wake metadata exceeds its read bound");
		return bytes.toString("utf8", 0, length);
	} finally { closeSync(fd); }
}

/** One bounded exact-path read; no directory scan and no native storage access. */
export function readDeliveryWake(sessionsRoot: string, storageId: string): DeliveryWake | undefined {
	const text = readWakeText(deliveryWakePath(sessionsRoot, storageId));
	if (text === undefined) return undefined;
	const value = JSON.parse(text) as Partial<DeliveryWake> | null;
	if (!value || value.format !== FORMAT || !Array.isArray(value.recipients) || value.recipients.length > DELIVERY_WAKE_RECIPIENT_LIMIT || !Number.isSafeInteger(value.omitted) || (value.omitted ?? -1) < 0) throw new Error("Delivery wake metadata is invalid");
	const failed = value.failedAvailability;
	if (!failed || typeof failed !== "object" || Array.isArray(failed) || Object.keys(failed).length !== value.recipients.length) throw new Error("Delivery wake availability is invalid");
	for (const identity of value.recipients) {
		if (typeof identity !== "string") throw new Error("Delivery wake recipient is invalid");
		storageIdOf(identity);
		const fingerprint = failed[identity];
		if (!Object.hasOwn(failed, identity) || (fingerprint !== null && (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)))) throw new Error("Delivery wake fingerprint is invalid");
	}
	if (new Set(value.recipients).size !== value.recipients.length) throw new Error("Delivery wake recipients are duplicated");
	return value as DeliveryWake;
}

function boundedWake(identities: readonly string[], lastFailed: (identity: string) => string | null): DeliveryWake {
	const unique = [...new Set(identities)].sort();
	const recipients: string[] = [], failedAvailability: Record<string, string | null> = {};
	for (const identity of unique.slice(0, DELIVERY_WAKE_RECIPIENT_LIMIT)) {
		storageIdOf(identity);
		const next = [...recipients, identity], failed = { ...failedAvailability, [identity]: lastFailed(identity) };
		if (Buffer.byteLength(JSON.stringify({ format: FORMAT, recipients: next, failedAvailability: failed, omitted: unique.length - next.length })) + 1 > MAX_BYTES) continue;
		recipients.push(identity);
		failedAvailability[identity] = failed[identity];
	}
	return { format: FORMAT, recipients, failedAvailability, omitted: unique.length - recipients.length };
}

/** Only the source storage's exclusive writer publishes or removes this projection. */
export function writeDeliveryWake(sessionsRoot: string, storageId: string, identities: readonly string[], lastFailed: (identity: string) => string | null = () => null): { changed: boolean; omitted: number } {
	const path = deliveryWakePath(sessionsRoot, storageId);
	if (identities.length === 0) {
		try { unlinkSync(path); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { changed: false, omitted: 0 }; throw error; }
		publishCatalogChange(join(sessionsRoot, "durable"));
		return { changed: true, omitted: 0 };
	}
	const value = boundedWake(identities, lastFailed);
	const text = `${JSON.stringify(value)}\n`;
	if (readWakeText(path) === text) return { changed: false, omitted: value.omitted };
	mkdirSync(join(sessionsRoot, ".delivery-wake"), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try { unlinkSync(temporary); }
		catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw new AggregateError([error, cleanup], "Delivery wake publication and cleanup failed"); }
		throw error;
	}
	publishCatalogChange(join(sessionsRoot, "durable"));
	return { changed: true, omitted: value.omitted };
}
