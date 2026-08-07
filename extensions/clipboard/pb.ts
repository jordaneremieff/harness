/**
 * pb — macOS clipboard I/O with async cancellation and short timeout.
 *
 * Content goes to pbcopy's stdin: no shell, no quoting, no staging file.
 * Both utilities are normally millisecond-scale, but a blocked pasteboard
 * (e.g. a remote session, a hung process, or a TCC prompt awaiting user
 * input) can block the child process. An AbortSignal (from the Pi tool
 * call or a 30s deadline) kills the child and rejects promptly.
 *
 * execFile is used instead of execFileSync so the Node event loop stays
 * alive during the wait. The call still awaits the result before returning
 * control to the caller, so Pi's tool loop blocks on the result but not on
 * the host process.
 */

import { execFile } from "node:child_process";

const PB_TIMEOUT_MS = 30_000;

export async function pbCopy(content: string, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = execFile("pbcopy", [], { encoding: "utf8", timeout: PB_TIMEOUT_MS, signal }, (error) => {
			if (error) return reject(error);
			resolve();
		});
		child.stdin?.end(content, "utf8");
	});
}

export async function pbPaste(signal?: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile("pbpaste", [], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: PB_TIMEOUT_MS,
			signal,
		}, (error, captured) => {
			if (error) return reject(error);
			resolve(captured);
		});
	});
}
