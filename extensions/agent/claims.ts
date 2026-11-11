/** Bounded native diagnostic records and separate process-lock observations. */
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
 * Native `dead` ends only the recorded generation; `unknown` establishes no
 * current holder. The separate process-lock classifier also returns `live`
 * for a present same-host process. None of these observations owns a lease.
 */
export type ClaimObservation =
	| { kind: "absent" }
	| { kind: "live"; label: string }
	| { kind: "dead"; label: string; writerId?: string; endedAt?: string }
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
export function validClaim(claim: unknown, identity: ClaimIdentity): claim is Record<string, unknown> & { host: string; pid: number } {
	return record(claim) && claim.sessionId === identity.sessionId && claim.cwd === resolve(identity.cwd)
		&& typeof claim.host === "string" && claim.host.length > 0 && timestamp(claim.createdAt)
		&& Number.isSafeInteger(claim.pid) && Number(claim.pid) > 0 && Number(claim.pid) <= MAX_PID;
}

/** Native identities qualify generation-end evidence, never lease possession. */
export function validNativeWriterId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f-\u009f\ud800-\udfff]/u.test(value);
}

/** Diagnostic metadata can end its recorded generation, never establish a current lease holder. */
export function classifyClaim(claim: unknown, identity: ClaimIdentity): ClaimObservation {
	if (!validClaim(claim, identity) || !validNativeWriterId(claim.token)) return { kind: "unknown", error: "Writer claim is invalid" };
	if (claim.host !== hostname()) return { kind: "unknown", label: claim.host, error: "Writer claim belongs to another host" };
	const label = `PID ${claim.pid}`;
	if (claim.endedAt !== undefined) {
		if (!timestamp(claim.endedAt) || claim.endedAt < String(claim.createdAt)) return { kind: "unknown", label, error: "Writer claim has an invalid end marker" };
		return { kind: "dead", label, writerId: claim.token, endedAt: claim.endedAt };
	}
	try { process.kill(claim.pid, 0); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return { kind: "dead", label, writerId: claim.token };
		if (code !== "EPERM") return { kind: "unknown", label, error: `Writer process check failed (${code ?? "unknown"})` };
	}
	return { kind: "unknown", label, error: "Native claim metadata does not establish a live writer" };
}

/** Process presence remains the distinct contract of non-native process locks. */
export function classifyProcessClaim(claim: unknown, identity: ClaimIdentity): ClaimObservation {
	if (!validClaim(claim, identity)) return { kind: "unknown", error: "Writer claim is invalid" };
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
