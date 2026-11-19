export const LIVE_WIRE_BYTES = 1024 * 1024;
export const LIVE_PROMPT_BYTES = 128 * 1024;
export const LIVE_LIFETIME = Symbol("explorer-live-lifetime");
export interface LiveConfig {
	version: 1;
	endpoint: string;
	token: string;
	[LIVE_LIFETIME]?: AbortSignal;
}
export interface LiveBinding {
	workspace: string;
	document: string;
}
export type LivePromptReceipt =
	| { status: "requested" | "admitted"; submissionId?: string }
	| { status: "rejected"; message: string }
	| { status: "uncertain"; message: string; retryable: boolean };
export type LiveResult = { status: "ok" } | { status: "closed" | "error" | "uncertain"; message: string };
export interface LiveState {
	sequence: number;
	status: "idle" | "queued" | "working" | "answer" | "error";
	text: string;
	truncated: boolean;
	requestId?: string;
	threadId?: string;
}
export const isRecord = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x);
export const liveId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value);
export function readLiveBinding(value: unknown): LiveBinding {
	if (!isRecord(value) || !liveId(value.workspace) || !liveId(value.document))
		throw new Error("Invalid Explorer pane identity.");
	return { workspace: value.workspace, document: value.document };
}
export const liveHandle = ({ workspace, document }: LiveBinding) => `${workspace}:${document}`;
export function readLiveConfig(value: unknown): LiveConfig {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.endpoint !== "string" ||
		!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(value.endpoint) ||
		Number(value.endpoint.slice(17)) > 65535 ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.token)
	)
		throw new Error("Invalid live Explorer connection.");
	return { version: 1, endpoint: value.endpoint, token: value.token };
}
