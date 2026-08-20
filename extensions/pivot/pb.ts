/**
 * pb — macOS clipboard write with async cancellation and timeout.
 *
 * Content goes to pbcopy's stdin: no shell, no quoting, no staging file.
 * A blocked pasteboard (remote session, hung process, TCC prompt) can block
 * the child; the timeout kills the child and rejects, and an AbortSignal
 * aborts it promptly. execFile is used instead of execFileSync so the Node
 * event loop stays alive during the wait.
 */

import { execFile } from "node:child_process";

const PB_TIMEOUT_MS = 30_000;

export async function pbCopy(
	content: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	const { signal, timeoutMs = PB_TIMEOUT_MS } = options;
	return new Promise<void>((resolve, reject) => {
		const child = execFile("pbcopy", [], { encoding: "utf8", timeout: timeoutMs, signal }, (error) => {
			if (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error("pbcopy is not available — the pivot extension requires macOS"));
				} else {
					reject(error);
				}
				return;
			}
			resolve();
		});
		child.stdin?.end(content, "utf8");
	});
}
