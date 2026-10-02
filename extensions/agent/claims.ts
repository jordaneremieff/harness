/** Writer-claim files under `<native>/.claims` and their owner-process classification. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/** Largest claim file a bounded read accepts. */
export const CLAIM_BYTES = 16 * 1024;
const CLAIM_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_PID = 2147483647;

export interface ClaimIdentity {
	sessionId: string;
	cwd: string;
}

/** A claim file's parsed content and the file identity it was read from. */
export interface ClaimFile {
	claim: unknown;
	dev: number;
	ino: number;
}

/**
 * `live` is a same-host process that exists (or refuses a signal probe);
 * `dead` is a same-host process that no longer exists; `unknown` is a claim
 * whose owner cannot be established: another host, an invalid record, or an
 * unexpected probe failure.
 */
export type ClaimObservation =
	| { kind: "absent" }
	| { kind: "live"; label: string }
	| { kind: "dead"; label: string }
	| { kind: "unknown"; label?: string; error: string };

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function claimPath(nativeRoot: string, identity: ClaimIdentity): string {
	const key = createHash("sha256")
		.update(JSON.stringify([resolve(identity.cwd), identity.sessionId]))
		.digest("hex");
	return join(nativeRoot, ".claims", `${key}.lock`);
}

/** Bounded read of one claim file; follows no symlink and throws on any bound or parse failure. */
export function readClaimFile(path: string): ClaimFile {
	const fd = openSync(path, CLAIM_FLAGS);
	try {
		const stat = fstatSync(fd);
		checkClaimFile(stat);
		const buffer = Buffer.alloc(CLAIM_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
			if (!count) break;
			bytes += count;
		}
		return parseClaimFile(buffer, bytes, stat);
	} finally {
		closeSync(fd);
	}
}

function checkClaimFile(stat: Stats): void {
	if (!stat.isFile() || stat.size > CLAIM_BYTES)
		throw new Error("Writer claim exceeds its read bound or is not a regular file");
}
function parseClaimFile(buffer: Buffer, bytes: number, stat: Stats): ClaimFile {
	if (bytes > CLAIM_BYTES) throw new Error("Writer claim exceeds its read bound");
	return { claim: JSON.parse(buffer.toString("utf8", 0, bytes)), dev: stat.dev, ino: stat.ino };
}
async function readClaimFileAsync(path: string): Promise<ClaimFile> {
	const file = await open(path, CLAIM_FLAGS);
	try {
		const stat = await file.stat();
		checkClaimFile(stat);
		const buffer = Buffer.alloc(CLAIM_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
			if (!bytesRead) break;
			bytes += bytesRead;
		}
		return parseClaimFile(buffer, bytes, stat);
	} finally {
		await file.close();
	}
}
function unreadableClaim(error: unknown): ClaimObservation {
	return (error as NodeJS.ErrnoException).code === "ENOENT"
		? { kind: "absent" }
		: { kind: "unknown", error: `Writer claim is unreadable: ${reason(error)}` };
}
/** The async reader uses the same claim bounds and classification as control paths. */
export async function observeClaimAsync(path: string, identity: ClaimIdentity): Promise<ClaimObservation> {
	try {
		return classifyClaim((await readClaimFileAsync(path)).claim, identity);
	} catch (error) {
		return unreadableClaim(error);
	}
}
export function classifyClaim(claim: unknown, identity: ClaimIdentity): ClaimObservation {
	if (
		!record(claim) ||
		claim.sessionId !== identity.sessionId ||
		claim.cwd !== resolve(identity.cwd) ||
		typeof claim.host !== "string" ||
		!claim.host ||
		!timestamp(claim.createdAt) ||
		!Number.isSafeInteger(claim.pid) ||
		Number(claim.pid) <= 0 ||
		Number(claim.pid) > MAX_PID
	)
		return { kind: "unknown", error: "Writer claim is invalid" };
	if (claim.host !== hostname())
		return { kind: "unknown", label: claim.host, error: "Writer claim belongs to another host" };
	const pid = Number(claim.pid);
	const label = `PID ${pid}`;
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { kind: "dead", label };
		if (code !== "EPERM")
			return { kind: "unknown", label, error: `Writer process check failed (${code ?? "unknown"})` };
	}
	return { kind: "live", label };
}

/** Read and classify one claim path; a missing file is `absent`, any read failure is `unknown`. */
export function observeClaim(path: string, identity: ClaimIdentity): ClaimObservation {
	try {
		return classifyClaim(readClaimFile(path).claim, identity);
	} catch (error) {
		return unreadableClaim(error);
	}
}
