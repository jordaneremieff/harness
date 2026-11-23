import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readRegular(path: string, limit: number): Buffer | undefined {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${path}: not a regular file`);
		if (stat.size > limit) throw new Error(`${path}: exceeds ${limit} bytes`);
		const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
		let length = 0;
		while (length < bytes.length) {
			const bytesRead = readSync(fd, bytes, length, bytes.length - length, null);
			if (bytesRead === 0) return bytes.subarray(0, length);
			length += bytesRead;
		}
		throw new Error(`${path}: file grew while being read`);
	} finally {
		closeSync(fd);
	}
}
