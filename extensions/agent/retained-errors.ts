/** Closed failures for the independent retained reader and its source capture. */
export type RetainedErrorCode = "invalid_request" | "incompatible" | "not_found" | "source_changed" | "source_unreadable" | "limit_exceeded" | "timeout" | "cancelled" | "internal";

const messages: Record<RetainedErrorCode, string> = {
	invalid_request: "The retained read request is invalid.",
	incompatible: "The retained read contract is incompatible.",
	not_found: "The retained storage or conversation does not exist.",
	source_changed: "Retained storage changed during capture. Retry the read.",
	source_unreadable: "The retained source is unreadable.",
	limit_exceeded: "The retained read exceeds its byte bound.",
	timeout: "The retained read deadline expired.",
	cancelled: "The retained read was cancelled.",
	internal: "The retained reader failed.",
};

export class RetainedReadError extends Error {
	readonly code: RetainedErrorCode;
	readonly retryable: boolean;
	constructor(code: RetainedErrorCode) {
		super(messages[code]);
		this.code = code;
		this.retryable = code === "source_changed" || code === "timeout";
	}
}

export function checkRetainedRead(signal?: AbortSignal, deadline?: number): void {
	if (signal?.aborted) throw signal.reason instanceof RetainedReadError ? signal.reason : new RetainedReadError("cancelled");
	if (deadline !== undefined && Date.now() >= deadline) throw new RetainedReadError("timeout");
}
