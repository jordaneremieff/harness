import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";

const TRUNCATION_MARKER = Buffer.from("\n[output truncated by eval parent]\n", "utf8");

export interface BoundedFileResult {
	path: string;
	bytes: number;
	truncated: boolean;
}

export interface BoundedFileSink {
	accept(chunk: Buffer | string): void;
	close(): BoundedFileResult;
}

export function createBoundedFileSink(path: string, maxBytes: number): BoundedFileSink {
	if (!isAbsolute(path)) throw new Error("bounded output path must be absolute");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < TRUNCATION_MARKER.length) {
		throw new Error(`maxBytes must be a safe integer of at least ${TRUNCATION_MARKER.length}`);
	}
	const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	let written = 0;
	let truncated = false;
	let closed = false;
	let failed: unknown;

	const writeAll = (chunk: Buffer, length: number, position: number): number => {
		let offset = 0;
		while (offset < length) {
			const count = writeSync(descriptor, chunk, offset, length - offset, position + offset);
			if (count === 0) throw new Error(`zero-byte write to ${path}`);
			offset += count;
		}
		return offset;
	};

	return {
		accept(value): void {
			if (closed || failed !== undefined) return;
			const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : value;
			if (truncated || chunk.length === 0) return;
			try {
				const remaining = maxBytes - written;
				if (chunk.length <= remaining) {
					written += writeAll(chunk, chunk.length, written);
					return;
				}
				if (remaining > 0) written += writeAll(chunk, remaining, written);
				const markerOffset = maxBytes - TRUNCATION_MARKER.length;
				ftruncateSync(descriptor, markerOffset);
				writeAll(TRUNCATION_MARKER, TRUNCATION_MARKER.length, markerOffset);
				written = maxBytes;
				truncated = true;
			} catch (error) {
				failed = error;
				throw error;
			}
		},
		close(): BoundedFileResult {
			if (!closed) {
				closed = true;
				closeSync(descriptor);
			}
			if (failed !== undefined) throw failed;
			const verifyDescriptor = openSync(path, constants.O_RDONLY);
			try {
				return { path, bytes: fstatSync(verifyDescriptor).size, truncated };
			} finally {
				closeSync(verifyDescriptor);
			}
		},
	};
}
