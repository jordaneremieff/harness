/** Bounded source capture and complete, terminal-safe named-data review. */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { cloneJson, type NamedData, validateNamedData } from "./data.ts";
import { namedDataRevision } from "./local-rules.ts";

export const MAX_DATA_SOURCE_BYTES = 512 * 1024;
export const MAX_DATA_REVIEW_BYTES = 1024 * 1024;
export const MAX_DATA_APPROVAL_OUTPUT_BYTES = 30 * 1024;
export interface DataArtifact {
	data: NamedData;
	expectedRevision: string | null;
}

export function safeJson(value: unknown, indent?: number): string {
	return JSON.stringify(value, null, indent).replace(
		/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function dataFileApprovalText(path: string, approveRevision: string): string {
	const command = `/policy data set-file ${safeJson({ path, approveRevision })}`;
	const output = `No data changed. Review the complete source file named in the command.\nNormalized artifact revision: ${approveRevision}\nExact approval command:\n${command}`;
	if (Buffer.byteLength(output, "utf8") > MAX_DATA_APPROVAL_OUTPUT_BYTES)
		throw new Error("data approval command exceeds output byte bound");
	return output;
}

export function normalizeDataArtifact(value: unknown, defaults?: { source: string; capturedAt: number }): DataArtifact {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("data source requires an object");
	const request = value as Record<string, unknown>;
	if (
		Object.keys(request).some((key) => key !== "data" && key !== "expectedRevision") ||
		!Object.hasOwn(request, "expectedRevision") ||
		!request.data ||
		typeof request.data !== "object" ||
		Array.isArray(request.data)
	)
		throw new Error("data source requires data and expectedRevision only");
	if (
		request.expectedRevision !== null &&
		(typeof request.expectedRevision !== "string" || !/^[a-f0-9]{12}$/.test(request.expectedRevision))
	)
		throw new Error("expectedRevision must be null for a new binding or its current revision");
	const supplied = cloneJson(request.data) as Record<string, unknown>;
	const raw: Record<string, unknown> = { ...defaults, ...supplied };
	if (!Object.hasOwn(raw, "source") || !Object.hasOwn(raw, "capturedAt"))
		throw new Error("data file requires explicit source and capturedAt");
	const candidate = { ...raw, revision: "000000000000" };
	const error = validateNamedData(candidate);
	if (error) throw new Error(error);
	const revision = namedDataRevision(candidate as NamedData);
	if (raw.revision !== undefined && raw.revision !== revision)
		throw new Error("data revision does not describe its contract");
	return { data: { ...raw, revision } as NamedData, expectedRevision: request.expectedRevision as string | null };
}

/** Capture one regular file without following a final symlink or reading beyond the source bound. */
export async function readDataArtifact(path: string): Promise<DataArtifact> {
	if (!path || path.includes("\0") || /^[a-z][a-z0-9+.-]*:\/\//i.test(path))
		throw new Error("data source requires a local file path");
	const initial = await lstat(path);
	if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("data source must be a regular non-symlink file");
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.ino !== initial.ino || before.dev !== initial.dev)
			throw new Error("data source changed before capture");
		if (before.size > MAX_DATA_SOURCE_BYTES) throw new Error("data source exceeds file byte bound");
		const buffer = Buffer.alloc(MAX_DATA_SOURCE_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > MAX_DATA_SOURCE_BYTES) throw new Error("data source exceeds file byte bound");
		const after = await handle.stat();
		if (
			size !== before.size ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error("data source changed during capture");
		return normalizeDataArtifact(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
		);
	} finally {
		await handle.close();
	}
}

export function dataReview(artifact: DataArtifact, approvalRevision: string): string {
	const { data, expectedRevision } = artifact;
	const { rows, ...metadata } = data;
	const body = `${safeJson({ expectedRevision, approveRevision: approvalRevision, data: metadata }, 2)}\nrows (${rows.length}):\n${rows.map((row) => safeJson(row)).join("\n")}`;
	if (Buffer.byteLength(body, "utf8") > MAX_DATA_REVIEW_BYTES)
		throw new Error("complete data review exceeds byte bound");
	return body;
}
