import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { decodePublication } from "./contract.mts";

export type Publication = ReturnType<typeof decodePublication>;
export interface CatalogRecord {
	storageId: string;
	cwd: string;
	agentDir: string;
	packageDir: string;
	storagePath: string;
	model: { provider: string; modelId: string };
	thinkingLevel: string;
	createdAt: string;
	name?: string;
	trust?: boolean;
	ownerId?: string;
	independent?: { inputDigest: string; projectTrusted: boolean };
	recoveryDue?: boolean;
	view?: Publication;
	publicationError?: string;
}
export interface WriterClaim {
	sessionId: string;
	cwd: string;
	host: string;
	createdAt: string;
	pid: number;
}
export interface ClaimObservation {
	state: "absent" | "dead" | "live" | "unknown";
	claim?: WriterClaim;
	error?: string;
}
export interface ClaimOptions {
	hostname?: string;
	pidProbe?: (pid: number) => void;
}
export const RECORD_BYTES = 32768;
export const CACHE_BYTES = 8 * 1024 * 1024;
export const CACHE_ROWS = 2048;
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unsupported metadata field");
}
function text(value: unknown, limit: number, empty = false): string {
	if (
		typeof value !== "string" ||
		value.length > limit ||
		(!empty && !value.length) ||
		/[\u0000-\u001f\u007f-\u009f]/u.test(value)
	)
		throw new Error("Invalid metadata text");
	return value;
}
function path(value: unknown): string {
	const result = text(value, 4096);
	if (!isAbsolute(result)) throw new Error("Expected an absolute path");
	return result;
}
export function storageName(value: unknown): string {
	const name = text(value, 512);
	if (name === "." || name === ".." || /[\\/]/u.test(name)) throw new Error("Invalid storage identity");
	return name;
}
export function iso(value: unknown): string {
	const stamp = text(value, 256);
	const date = new Date(stamp);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== stamp) throw new Error("Invalid ISO timestamp");
	return stamp;
}
function independentMetadata(value: unknown): NonNullable<CatalogRecord["independent"]> {
	const independent = object(value);
	fields(independent, ["inputDigest", "projectTrusted"]);
	if (
		typeof independent.inputDigest !== "string" ||
		!/^[a-f0-9]{64}$/u.test(independent.inputDigest) ||
		typeof independent.projectTrusted !== "boolean"
	)
		throw new Error("Invalid independent metadata");
	return { inputDigest: independent.inputDigest, projectTrusted: independent.projectTrusted };
}
export function decodeRecord(value: unknown, storageId: string, root: string): CatalogRecord {
	const v = object(value);
	fields(v, [
		"storageId",
		"cwd",
		"agentDir",
		"packageDir",
		"storagePath",
		"model",
		"thinkingLevel",
		"createdAt",
		"name",
		"trust",
		"ownerId",
		"independent",
		"view",
		"threads",
		"recoveryDue",
	]);
	if (storageName(v.storageId) !== storageId || v.storagePath !== join(root, `${storageId}.sqlite`))
		throw new Error("Catalog identity or database path mismatch");
	const model = object(v.model);
	fields(model, ["provider", "modelId"]);
	const level = text(v.thinkingLevel, 256);
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
		throw new Error("Unknown thinking level");
	const record: CatalogRecord = {
		storageId,
		cwd: path(v.cwd),
		agentDir: path(v.agentDir),
		packageDir: path(v.packageDir),
		storagePath: path(v.storagePath),
		model: { provider: text(model.provider, 512), modelId: text(model.modelId, 512) },
		thinkingLevel: level,
		createdAt: text(v.createdAt, 256),
	};
	if (v.name !== undefined) record.name = text(v.name, 256, true);
	if (v.ownerId !== undefined) record.ownerId = text(v.ownerId, 512);
	for (const key of ["trust", "recoveryDue"] as const) {
		if (v[key] !== undefined) {
			if (typeof v[key] !== "boolean") throw new Error("Invalid metadata flag");
			record[key] = v[key];
		}
	}
	if (v.independent !== undefined) record.independent = independentMetadata(v.independent);
	// Thread hints are not control metadata and are not exposed by this consumer.
	if (v.view !== undefined) {
		try {
			record.view = decodePublication(v.view, storageId);
		} catch {
			record.publicationError = "Stored publication is unavailable or malformed";
		}
	}
	return record;
}
export async function readJson(path: string, maxBytes: number): Promise<{ value: unknown; bytes: number }> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Record is not a bounded regular file");
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const result = await file.read(buffer, length, buffer.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		if (length > maxBytes) throw new Error("Record exceeds its byte bound");
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		return { value: JSON.parse(decoded), bytes: length };
	} finally {
		await file.close();
	}
}
export async function readRecord(root: string, name: string): Promise<{ record: CatalogRecord; bytes: number }> {
	const storageId = storageName(name);
	const data = await readJson(join(root, `${storageId}.json`), RECORD_BYTES);
	return { record: decodeRecord(data.value, storageId, root), bytes: data.bytes };
}
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
export function deriveEndpoint(record: Pick<CatalogRecord, "storageId" | "cwd" | "agentDir">): {
	serverId: string;
	socketPath: string;
	claimPath: string;
} {
	const cwd = resolve(path(record.cwd)),
		storageId = storageName(record.storageId),
		agentDir = path(record.agentDir);
	const hash = sha(`pi.agent.host\0${storageId}\0${cwd}`);
	const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 3) | 8).toString(16);
	const serverId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	const socketPath = [join(agentDir, "durable-hosts"), join(tmpdir(), "pi-hosts"), "/tmp/pi-hosts"]
		.map((dir) => join(dir, `${serverId}.sock`))
		.find((candidate) => Buffer.byteLength(candidate) <= 100);
	if (!socketPath) throw new Error("No bounded socket path");
	const claimPath = join(
		agentDir,
		"durable-hosts",
		sha(`${storageId}\0${cwd}`),
		".claims",
		`${sha(JSON.stringify([cwd, storageId]))}.lock`,
	);
	return { serverId, socketPath, claimPath };
}
function decodeClaim(value: unknown, record: CatalogRecord): WriterClaim {
	const v = object(value);
	if (v.sessionId !== record.storageId || v.cwd !== resolve(record.cwd))
		throw new Error("Writer claim identity mismatch");
	const claim: WriterClaim = {
		sessionId: text(v.sessionId, 512),
		cwd: path(v.cwd),
		host: text(v.host, 512),
		createdAt: iso(v.createdAt),
		pid: Number(v.pid),
	};
	if (typeof v.pid !== "number" || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || claim.pid > 2147483647)
		throw new Error("Invalid writer PID");
	return claim;
}
export async function readClaim(record: CatalogRecord, options: ClaimOptions = {}): Promise<ClaimObservation> {
	let value: unknown;
	try {
		value = (await readJson(deriveEndpoint(record).claimPath, 16384)).value;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "absent" }
			: { state: "unknown", error: "Writer claim is unreadable" };
	}
	try {
		const claim = decodeClaim(value, record);
		if (claim.host !== (options.hostname ?? hostname()))
			return { state: "unknown", claim, error: "Writer claim belongs to another host" };
		try {
			(options.pidProbe ?? ((pid) => process.kill(pid, 0)))(claim.pid);
			return { state: "live", claim };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") return { state: "dead", claim };
			if (code === "EPERM") return { state: "live", claim };
			return { state: "unknown", claim, error: "Writer PID probe failed" };
		}
	} catch {
		return { state: "unknown", error: "Writer claim is invalid" };
	}
}
