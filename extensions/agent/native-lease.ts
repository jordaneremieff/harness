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
	if (process.platform !== "darwin") throw new Error("Native writer leases require a private local Darwin filesystem");
	signal?.throwIfAborted();
	let descriptor: number;
	try { descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | DARWIN_O_EXLOCK | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EAGAIN") return { kind: "busy" };
		throw error;
	}
	try {
		signal?.throwIfAborted();
		const opened = fstatSync(descriptor);
		checkFile(opened);
		let closed = false;
		const lease: NativeWriterLease = {
			dev: opened.dev, ino: opened.ino, descriptor,
			assertNamed() {
				if (closed) throw new Error("Native writer lease is closed");
				const held = fstatSync(descriptor);
				const named = lstatSync(path);
				checkFile(held);
				checkFile(named);
				if (held.dev !== opened.dev || held.ino !== opened.ino || named.dev !== opened.dev || named.ino !== opened.ino) {
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
