import { closeSync, constants, fstatSync, lstatSync, openSync, type Stats } from "node:fs";

const DARWIN_O_EXLOCK = 0x20;

export interface NativeWriterLease {
	readonly dev: number;
	readonly ino: number;
	readonly descriptor: number;
	/** Detect replacement; this is not fencing against an uncooperative writer. */
	assertNamed(): void;
	release(): void;
}
export type NativeLeaseAttempt = { kind: "held"; lease: NativeWriterLease } | { kind: "busy" };

function checkFile(stat: Stats): void {
	if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
		throw new Error("Native writer lease requires one private regular file owned by this user");
	}
}

/** One nonblocking attempt on a private local Darwin filesystem; release never removes its inode. */
export function tryNativeWriterLease(path: string, signal?: AbortSignal): NativeLeaseAttempt {
	return openLease(path, true, signal);
}

/**
 * Block this thread until no other process holds the lease at `path`, then hold it. Only a dedicated runner process,
 * which has no other work on its thread, may wait this way.
 */
export function waitNativeWriterLease(path: string): NativeWriterLease {
	const attempt = openLease(path, false);
	if (attempt.kind === "busy") throw new Error("A blocking native lease wait reported busy");
	return attempt.lease;
}

function openLease(path: string, nonblocking: boolean, signal?: AbortSignal): NativeLeaseAttempt {
	if (process.platform !== "darwin") throw new Error("Native writer leases require a private local Darwin filesystem");
	signal?.throwIfAborted();
	let descriptor: number;
	try {
		descriptor = openSync(
			path,
			constants.O_RDWR |
				constants.O_CREAT |
				DARWIN_O_EXLOCK |
				(nonblocking ? constants.O_NONBLOCK : 0) |
				constants.O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EAGAIN") return { kind: "busy" };
		throw error;
	}
	try {
		signal?.throwIfAborted();
		const opened = fstatSync(descriptor);
		checkFile(opened);
		let closed = false;
		const lease: NativeWriterLease = {
			dev: opened.dev,
			ino: opened.ino,
			descriptor,
			assertNamed() {
				if (closed) throw new Error("Native writer lease is closed");
				const held = fstatSync(descriptor);
				const named = lstatSync(path);
				checkFile(held);
				checkFile(named);
				if (
					held.dev !== opened.dev ||
					held.ino !== opened.ino ||
					named.dev !== opened.dev ||
					named.ino !== opened.ino
				) {
					throw new Error("Native writer lease pathname changed; ownership is unavailable");
				}
			},
			release() {
				if (closed) return;
				closed = true;
				closeSync(descriptor);
			},
		};
		lease.assertNamed();
		return { kind: "held", lease };
	} catch (error) {
		closeSync(descriptor);
		throw error;
	}
}

/**
 * Take the lease at each path in order, without blocking. A busy path releases the leases already taken. The held
 * lease asserts and releases every path; its descriptor and identity are the first path's.
 */
export function tryNativeWriterLeases(paths: readonly string[], signal?: AbortSignal): NativeLeaseAttempt {
	const held: NativeWriterLease[] = [];
	const releaseHeld = () => {
		for (const lease of held.splice(0)) lease.release();
	};
	try {
		for (const path of paths) {
			const attempt = tryNativeWriterLease(path, signal);
			if (attempt.kind === "busy") {
				releaseHeld();
				return { kind: "busy" };
			}
			held.push(attempt.lease);
		}
	} catch (error) {
		releaseHeld();
		throw error;
	}
	const [first] = held;
	if (first === undefined) throw new Error("Native writer leases require at least one path");
	return {
		kind: "held",
		lease: {
			dev: first.dev,
			ino: first.ino,
			descriptor: first.descriptor,
			assertNamed() {
				for (const lease of held) lease.assertNamed();
			},
			release() {
				for (const lease of held) lease.release();
			},
		},
	};
}
