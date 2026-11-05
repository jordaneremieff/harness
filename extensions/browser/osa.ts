/** Runs one JXA request through osascript with a deadline, cancellation, and bounded output. */

import { execFile } from "node:child_process";
import { JXA_PROGRAM } from "./jxa.ts";

export type OsaRequest = { op: string } & Record<string, unknown>;

export interface OsaFailure {
	code: string | null;
	number: number | null;
	message: string;
	extra: unknown;
}

export type OsaReply = { ok: true; value: unknown } | { ok: false; error: OsaFailure };

/**
 * Transport failure: the request did not produce a reply. `delivery` states whether the
 * browser received the request: `none` when osascript never started, `unknown` once it ran.
 */
export class TransportError extends Error {
	readonly kind: "timeout" | "cancelled" | "spawn" | "exit" | "malformed";
	readonly delivery: "none" | "unknown";
	constructor(kind: TransportError["kind"], delivery: TransportError["delivery"], message: string) {
		super(message);
		this.name = "TransportError";
		this.kind = kind;
		this.delivery = delivery;
	}
}

export type OsaRunner = (
	request: OsaRequest,
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<OsaReply>;

const OUTPUT_LIMIT = 8 * 1024 * 1024;

function parseReply(stdout: string): OsaReply {
	let value: unknown;
	try {
		value = JSON.parse(stdout.trim());
	} catch {
		throw new TransportError("malformed", "unknown", "osascript returned output that is not a JSON reply.");
	}
	if (value && typeof value === "object" && "ok" in value) {
		const reply = value as { ok: unknown; value?: unknown; error?: Partial<OsaFailure> };
		if (reply.ok === true) return { ok: true, value: reply.value };
		const error = reply.error ?? {};
		return {
			ok: false,
			error: {
				code: typeof error.code === "string" ? error.code : null,
				number: typeof error.number === "number" ? error.number : null,
				message: typeof error.message === "string" ? error.message : "Unknown Apple Events error.",
				extra: error.extra ?? null,
			},
		};
	}
	throw new TransportError("malformed", "unknown", "osascript returned an unexpected reply shape.");
}

/** The production runner: `/usr/bin/osascript -l JavaScript -e <program>` with the request on standard input. */
export const runOsascript: OsaRunner = (request, { signal, timeoutMs }) =>
	new Promise<OsaReply>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new TransportError("cancelled", "none", "Cancelled before the request was sent."));
			return;
		}
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const child = execFile(
			"/usr/bin/osascript",
			["-l", "JavaScript", "-e", JXA_PROGRAM],
			{ encoding: "utf8", maxBuffer: OUTPUT_LIMIT, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					const spawnFailed = (error as NodeJS.ErrnoException).code === "ENOENT";
					const detail = String(stderr || "no error output")
						.trim()
						.slice(-500);
					finish(() =>
						reject(
							spawnFailed
								? new TransportError("spawn", "none", "osascript is not available on this system.")
								: new TransportError("exit", "unknown", `osascript failed: ${detail}`),
						),
					);
					return;
				}
				finish(() => {
					try {
						resolve(parseReply(stdout));
					} catch (parseError) {
						reject(parseError);
					}
				});
			},
		);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new TransportError("timeout", "unknown", `No reply within ${timeoutMs} ms.`)));
		}, timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(() => reject(new TransportError("cancelled", "unknown", "Cancelled while waiting for the browser.")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(request), "utf8");
	});
