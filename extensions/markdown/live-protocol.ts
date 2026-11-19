import { SOURCE_BYTES, responseDigest, validUnicode } from "./responses.ts";

export const LIVE_WIRE_BYTES = 32 * 1024 * 1024;
export const LIVE_PROMPT_BYTES = 128 * 1024;
/** Runtime ownership never enters the native JSON configuration. */
export const LIVE_LIFETIME = Symbol("markdown-live-lifetime");
export interface LiveConfig { version: 1; endpoint: string; token: string; [LIVE_LIFETIME]?: AbortSignal }
export interface LiveBinding { workspace: string; document: string }
export type LivePromptReceipt = { status: "requested" | "admitted"; submissionId?: string }
	| { status: "rejected"; message: string }
	| { status: "uncertain"; message: string; retryable: boolean };
export interface LiveRange { start: number; end: number }
export interface LiveEdit extends LiveRange { expected: string; replacement: string }
export type LiveAction = { op: "read" }
	| { op: "apply"; operationId: string; baseGeneration: number; baseDigest: string; edits: LiveEdit[] }
	| { op: "claim"; baseGeneration: number; baseDigest: string; ranges: LiveRange[]; label?: string }
	| { op: "release"; claimId: string };
export type LiveCommand = LiveBinding & LiveAction & { requestId: string };
export type LiveResult = { status: "ok"; source: string; generation: number; digest: string; assets: { reference: string; digest: string }[] }
	| { status: "applied"; operationId: string; generation: number; digest: string; retained: true }
	| { status: "claimed"; claimId: string; expiresAt: number }
	| { status: "released"; claimId: string }
	| { status: "stale" | "busy" | "closed" | "error" | "uncertain"; message: string };
export interface LiveState { sequence: number; status: "idle" | "queued" | "working" | "answer" | "error"; text: string; truncated: boolean; operationId?: string }
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const liveId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
export const liveDigest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function readLiveConfig(value: unknown): LiveConfig {
	if (!isRecord(value) || value.version !== 1 || typeof value.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(value.endpoint) || Number(new URL(value.endpoint).port) > 65535 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token)) throw new Error("Invalid live Markdown connection.");
	return { version: 1, endpoint: value.endpoint, token: value.token };
}
export function readLiveBinding(value: unknown): LiveBinding {
	if (!isRecord(value) || !liveId(value.workspace) || !liveId(value.document)) throw new Error("Invalid live Markdown workspace or document.");
	return { workspace: value.workspace, document: value.document };
}
export const liveHandle = ({ workspace, document }: LiveBinding): string => `${workspace}:${document}`;
function readLiveClaim(value: Record<string, unknown>): Extract<LiveAction, { op: "claim" }> {
	if (!generation(value.baseGeneration) || !liveDigest(value.baseDigest) || !Array.isArray(value.ranges) || value.ranges.length < 1 || value.ranges.length > 16) throw new Error("Invalid live Markdown claim base or ranges.");
	if (value.label !== undefined && (typeof value.label !== "string" || [...value.label].length > 80 || !validUnicode(value.label) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.label))) throw new Error("A claim label requires at most 80 characters on one line.");
	let end = -1;
	const ranges = value.ranges.map((range): LiveRange => {
		if (!isRecord(range) || !generation(range.start) || !generation(range.end) || range.end < range.start || range.start < end) throw new Error("Claims require ordered, nonoverlapping UTF-16 ranges.");
		end = range.end;
		return { start: range.start, end: range.end };
	});
	return { op: "claim", baseGeneration: value.baseGeneration, baseDigest: value.baseDigest, ranges, ...(value.label === undefined ? {} : { label: value.label as string }) };
}
export function readLiveAction(value: unknown): LiveAction {
	if (!isRecord(value)) throw new Error("Invalid live Markdown action.");
	if (value.op === "read") return { op: "read" };
	if (value.op === "release") {
		if (!liveId(value.claimId)) throw new Error("Invalid live Markdown claim identity.");
		return { op: "release", claimId: value.claimId };
	}
	if (value.op === "claim") return readLiveClaim(value);
	if (value.op !== "apply" || !liveId(value.operationId) || !generation(value.baseGeneration) || !liveDigest(value.baseDigest) || !Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 64) throw new Error("Invalid live Markdown edit identity or base.");
	let bytes = 0;
	let end = -1;
	const edits = value.edits.map((edit): LiveEdit => {
		if (!isRecord(edit) || !generation(edit.start) || !generation(edit.end) || edit.end < edit.start || edit.start < end || typeof edit.expected !== "string" || typeof edit.replacement !== "string" || !validUnicode(edit.expected) || !validUnicode(edit.replacement) || edit.end - edit.start !== edit.expected.length) throw new Error("Edits require ordered, nonoverlapping UTF-16 ranges and exact expected text.");
		end = edit.end;
		bytes += Buffer.byteLength(edit.expected) + Buffer.byteLength(edit.replacement);
		if (bytes > 2 * SOURCE_BYTES) throw new Error("The live edit exceeds the source limit.");
		return { start: edit.start, end: edit.end, expected: edit.expected, replacement: edit.replacement };
	});
	return { op: "apply", operationId: value.operationId, baseGeneration: value.baseGeneration, baseDigest: value.baseDigest, edits };
}
export function readLiveResult(value: unknown, action: LiveAction): LiveResult {
	if (!isRecord(value)) throw new Error("Invalid native live result.");
	if (["stale", "busy", "closed", "error", "uncertain"].includes(String(value.status)) && typeof value.message === "string" && value.message.length <= 1000) return { status: value.status as "error", message: value.message };
	if (action.op === "claim" && value.status === "claimed" && liveId(value.claimId) && generation(value.expiresAt) && value.expiresAt > 0) return { status: "claimed", claimId: value.claimId, expiresAt: value.expiresAt };
	if (action.op === "release" && value.status === "released" && value.claimId === action.claimId) return { status: "released", claimId: action.claimId };
	if (action.op === "apply" && value.status === "applied" && value.operationId === action.operationId && generation(value.generation) && liveDigest(value.digest) && value.retained === true) return { status: "applied", operationId: action.operationId, generation: value.generation, digest: value.digest, retained: true };
	if (action.op === "read" && value.status === "ok" && typeof value.source === "string" && validUnicode(value.source) && Buffer.byteLength(value.source) <= SOURCE_BYTES && generation(value.generation) && value.digest === responseDigest(value.source) && Array.isArray(value.assets) && value.assets.length <= 256 && value.assets.every((asset) => isRecord(asset) && typeof asset.reference === "string" && asset.reference.length <= 4096 && liveDigest(asset.digest))) return { status: "ok", source: value.source, generation: value.generation, digest: value.digest, assets: value.assets as { reference: string; digest: string }[] };
	throw new Error("The native live result failed its identity, source or retention check.");
}
