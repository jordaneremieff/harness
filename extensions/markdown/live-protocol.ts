import { type CommentAction, type CommentResult, readCommentAction, readCommentResult } from "./comment-protocol.ts";
import { SOURCE_BYTES, responseDigest, validUnicode } from "./responses.ts";

export const LIVE_WIRE_BYTES = 32 * 1024 * 1024;
export const LIVE_PROMPT_BYTES = 128 * 1024;
/** Runtime ownership never enters the native JSON configuration. */
export const LIVE_LIFETIME = Symbol.for("pi.markdown.live.lifetime.v3");
export const PANE_PROTOCOL = 3;
export interface LiveConfig {
	version: 1;
	endpoint: string;
	token: string;
	live?: typeof PANE_PROTOCOL;
	conversation?: string;
	hostPid?: number;
	[LIVE_LIFETIME]?: AbortSignal;
}
export interface LiveBinding {
	workspace: string;
	document: string;
}
export interface LivePaneView {
	kind: "published" | "response" | "file" | "scratchpad" | "copy" | "local-file" | "loading";
	title: string;
	mode: "reading" | "writing";
	dirty: boolean;
	conflict: boolean;
	follows?: boolean;
	storeId?: string;
	documentId?: string;
	revision?: number;
	digest?: string;
}
export interface LivePane extends LiveBinding {
	handle: string;
	live: typeof PANE_PROTOCOL;
	pid: number;
	origin: "agent" | "operator";
	view: LivePaneView;
	reportedAt: number;
}
export type LivePromptReceipt =
	| { status: "requested" | "admitted"; submissionId?: string }
	| { status: "rejected"; message: string }
	| { status: "uncertain"; message: string; retryable: boolean };
export interface LiveRange {
	start: number;
	end: number;
}
export interface LiveEdit extends LiveRange {
	expected: string;
	replacement: string;
}
export type LiveAction =
	| CommentAction
	| { op: "read" }
	| { op: "navigate"; storeId: string; documentId: string; revision?: number; digest?: string }
	| { op: "apply"; operationId: string; baseGeneration: number; baseDigest: string; edits: LiveEdit[] }
	| { op: "claim"; baseGeneration: number; baseDigest: string; ranges: LiveRange[]; label?: string }
	| { op: "release"; claimId: string };
export type LiveCommand = LiveBinding & LiveAction & { requestId: string };
export type LiveResult =
	| CommentResult
	| {
			status: "ok";
			source: string;
			generation: number;
			digest: string;
			assets: { reference: string; digest: string }[];
	  }
	| ({ status: "navigated"; handle: string; view: LivePaneView } & LiveBinding)
	| { status: "applied"; operationId: string; generation: number; digest: string; retained: true }
	| { status: "claimed"; claimId: string; expiresAt: number }
	| { status: "released"; claimId: string }
	| { status: "stale" | "busy" | "closed" | "error" | "uncertain"; message: string };
export interface LiveState {
	sequence: number;
	status: "idle" | "queued" | "working" | "answer" | "error";
	text: string;
	truncated: boolean;
	operationId?: string;
	document?: string;
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
export const liveId = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
export const liveDigest = (value: unknown): value is string =>
	typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const livePid = (value: unknown): value is number => generation(value) && value > 0 && value <= 0x7fffffff;
const storeId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const documentId = (value: unknown): value is string => typeof value === "string" && /^md-[a-f0-9]{20}$/u.test(value);
const oneLine = (value: unknown, max: number): value is string =>
	typeof value === "string" &&
	!!value.trim() &&
	value.length <= max &&
	validUnicode(value) &&
	!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
function invalidField(field: string, requirement?: string): never {
	throw new Error(`Invalid native field ${field}${requirement ? `: ${requirement}` : ""}.`);
}
function requireStoredParents(value: Record<string, unknown>): void {
	if (value.documentId !== undefined && value.storeId === undefined)
		invalidField("view.storeId", "required with view.documentId");
	if (value.revision !== undefined && value.documentId === undefined)
		invalidField("view.documentId", "required with view.revision");
	if (value.digest !== undefined && value.revision === undefined)
		invalidField("view.revision", "required with view.digest");
}
function readStoredView(
	value: Record<string, unknown>,
): Pick<LivePaneView, "storeId" | "documentId" | "revision" | "digest"> {
	requireStoredParents(value);
	if (value.storeId !== undefined && !storeId(value.storeId)) invalidField("view.storeId");
	if (value.documentId !== undefined && !documentId(value.documentId)) invalidField("view.documentId");
	if (value.revision !== undefined && (!generation(value.revision) || value.revision < 1))
		invalidField("view.revision");
	if (value.digest !== undefined && !liveDigest(value.digest)) invalidField("view.digest");
	return {
		...(value.storeId !== undefined && { storeId: value.storeId as string }),
		...(value.documentId !== undefined && { documentId: value.documentId as string }),
		...(value.revision !== undefined && { revision: value.revision as number }),
		...(value.digest !== undefined && { digest: value.digest as string }),
	};
}
export function readLiveView(value: unknown): LivePaneView {
	if (!isRecord(value)) invalidField("view");
	if (
		typeof value.kind !== "string" ||
		!["published", "response", "file", "scratchpad", "copy", "local-file", "loading"].includes(value.kind)
	)
		invalidField("view.kind");
	if (!oneLine(value.title, 1024)) invalidField("view.title");
	if (value.mode !== "reading" && value.mode !== "writing") invalidField("view.mode");
	if (typeof value.dirty !== "boolean") invalidField("view.dirty");
	if (typeof value.conflict !== "boolean") invalidField("view.conflict");
	if (value.follows !== undefined && typeof value.follows !== "boolean") invalidField("view.follows");
	return {
		kind: value.kind as LivePaneView["kind"],
		title: value.title,
		mode: value.mode,
		dirty: value.dirty,
		conflict: value.conflict,
		...(typeof value.follows === "boolean" && { follows: value.follows }),
		...readStoredView(value),
	};
}
export function readLiveConfig(value: unknown): LiveConfig {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.endpoint !== "string" ||
		!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(value.endpoint) ||
		Number(new URL(value.endpoint).port) > 65535 ||
		typeof value.token !== "string" ||
		!/^[a-f0-9]{64}$/u.test(value.token)
	)
		throw new Error("Invalid live Markdown connection.");
	const base = { version: 1 as const, endpoint: value.endpoint, token: value.token };
	if (value.live === undefined) return base;
	if (value.live !== PANE_PROTOCOL || !oneLine(value.conversation, 512) || !livePid(value.hostPid))
		throw new Error("The live Markdown host and reader protocol do not match. Reload Pi and update the reader.");
	return { ...base, live: PANE_PROTOCOL, conversation: value.conversation, hostPid: value.hostPid };
}
export function readLiveBinding(value: unknown): LiveBinding {
	if (!isRecord(value)) throw new Error("Invalid native pane binding.");
	if (!liveId(value.workspace)) throw new Error("Invalid workspace in the native pane binding.");
	if (!liveId(value.document)) throw new Error("Invalid document in the native pane binding.");
	return { workspace: value.workspace, document: value.document };
}
export const liveHandle = ({ workspace, document }: LiveBinding): string => `${workspace}:${document}`;
function readLiveClaim(value: Record<string, unknown>): Extract<LiveAction, { op: "claim" }> {
	if (
		!generation(value.baseGeneration) ||
		!liveDigest(value.baseDigest) ||
		!Array.isArray(value.ranges) ||
		value.ranges.length < 1 ||
		value.ranges.length > 16
	)
		throw new Error("Invalid live Markdown claim base or ranges.");
	if (
		value.label !== undefined &&
		(typeof value.label !== "string" ||
			[...value.label].length > 80 ||
			!validUnicode(value.label) ||
			/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.label))
	)
		throw new Error("A claim label requires at most 80 characters on one line.");
	let end = -1;
	const ranges = value.ranges.map((range): LiveRange => {
		if (
			!isRecord(range) ||
			!generation(range.start) ||
			!generation(range.end) ||
			range.end < range.start ||
			range.start < end
		)
			throw new Error("Claims require ordered, nonoverlapping UTF-16 ranges.");
		end = range.end;
		return { start: range.start, end: range.end };
	});
	return {
		op: "claim",
		baseGeneration: value.baseGeneration,
		baseDigest: value.baseDigest,
		ranges,
		...(value.label === undefined ? {} : { label: value.label as string }),
	};
}
function readNavigation(value: Record<string, unknown>): Extract<LiveAction, { op: "navigate" }> {
	if (
		!storeId(value.storeId) ||
		!documentId(value.documentId) ||
		((value.revision !== undefined || value.digest !== undefined) &&
			(!generation(value.revision) || value.revision < 1 || !liveDigest(value.digest)))
	)
		throw new Error("Navigation requires an exact store and document. A pinned revision also needs its digest.");
	return {
		op: "navigate",
		storeId: value.storeId,
		documentId: value.documentId,
		...(value.revision !== undefined && { revision: value.revision as number, digest: value.digest as string }),
	};
}
export function readLiveAction(value: unknown): LiveAction {
	if (!isRecord(value)) throw new Error("Invalid live Markdown action.");
	if (value.op === "comments" || value.op === "setComment") return readCommentAction(value);
	if (value.op === "read") return { op: "read" };
	if (value.op === "navigate") return readNavigation(value);
	if (value.op === "release") {
		if (!liveId(value.claimId)) throw new Error("Invalid live Markdown claim identity.");
		return { op: "release", claimId: value.claimId };
	}
	if (value.op === "claim") return readLiveClaim(value);
	if (
		value.op !== "apply" ||
		!liveId(value.operationId) ||
		!generation(value.baseGeneration) ||
		!liveDigest(value.baseDigest) ||
		!Array.isArray(value.edits) ||
		value.edits.length < 1 ||
		value.edits.length > 64
	)
		throw new Error("Invalid live Markdown edit identity or base.");
	let bytes = 0;
	let end = -1;
	const edits = value.edits.map((edit): LiveEdit => {
		if (
			!isRecord(edit) ||
			!generation(edit.start) ||
			!generation(edit.end) ||
			edit.end < edit.start ||
			edit.start < end ||
			typeof edit.expected !== "string" ||
			typeof edit.replacement !== "string" ||
			!validUnicode(edit.expected) ||
			!validUnicode(edit.replacement) ||
			edit.end - edit.start !== edit.expected.length
		)
			throw new Error("Edits require ordered, nonoverlapping UTF-16 ranges and exact expected text.");
		end = edit.end;
		bytes += Buffer.byteLength(edit.expected) + Buffer.byteLength(edit.replacement);
		if (bytes > 2 * SOURCE_BYTES) throw new Error("The live edit exceeds the source limit.");
		return { start: edit.start, end: edit.end, expected: edit.expected, replacement: edit.replacement };
	});
	return {
		op: "apply",
		operationId: value.operationId,
		baseGeneration: value.baseGeneration,
		baseDigest: value.baseDigest,
		edits,
	};
}
function readNavigationResult(
	value: Record<string, unknown>,
	action: Extract<LiveAction, { op: "navigate" }>,
): LiveResult {
	const binding = readLiveBinding(value);
	const view = readLiveView(value.view);
	if (value.handle !== liveHandle(binding)) invalidField("handle");
	if (!["published", "response", "file"].includes(view.kind)) invalidField("view.kind", "expected a stored document");
	if (view.mode !== "reading") invalidField("view.mode", "expected reading");
	if (view.dirty) invalidField("view.dirty", "expected a clean buffer");
	if (view.conflict) invalidField("view.conflict", "expected no conflict");
	if (view.storeId !== action.storeId) invalidField("view.storeId");
	if (view.documentId !== action.documentId) invalidField("view.documentId");
	if (!view.revision || (action.revision !== undefined && action.revision !== view.revision))
		invalidField("view.revision");
	if (!view.digest || (action.revision !== undefined && action.digest !== view.digest)) invalidField("view.digest");
	return { status: "navigated", ...binding, handle: value.handle, view };
}
function readClaimResult(value: Record<string, unknown>): LiveResult {
	if (!liveId(value.claimId)) invalidField("claimId");
	if (!generation(value.expiresAt) || value.expiresAt <= 0)
		invalidField("expiresAt", "expected a positive whole number of Unix milliseconds");
	return { status: "claimed", claimId: value.claimId, expiresAt: value.expiresAt };
}
function readReleaseResult(value: Record<string, unknown>, action: Extract<LiveAction, { op: "release" }>): LiveResult {
	if (value.claimId !== action.claimId) invalidField("claimId");
	return { status: "released", claimId: action.claimId };
}
function readAppliedResult(value: Record<string, unknown>, action: Extract<LiveAction, { op: "apply" }>): LiveResult {
	if (value.operationId !== action.operationId) invalidField("operationId");
	if (!generation(value.generation)) invalidField("generation");
	if (!liveDigest(value.digest)) invalidField("digest");
	if (value.retained !== true) invalidField("retained");
	return {
		status: "applied",
		operationId: action.operationId,
		generation: value.generation,
		digest: value.digest,
		retained: true,
	};
}
function readAssets(value: unknown): { reference: string; digest: string }[] {
	if (!Array.isArray(value) || value.length > 256) invalidField("assets");
	for (const [index, asset] of value.entries()) {
		if (!isRecord(asset)) invalidField(`assets[${index}]`);
		if (typeof asset.reference !== "string" || asset.reference.length > 4096)
			invalidField(`assets[${index}].reference`);
		if (!liveDigest(asset.digest)) invalidField(`assets[${index}].digest`);
	}
	return value as { reference: string; digest: string }[];
}
function readSourceResult(value: Record<string, unknown>): LiveResult {
	if (typeof value.source !== "string" || !validUnicode(value.source) || Buffer.byteLength(value.source) > SOURCE_BYTES)
		invalidField("source");
	if (!generation(value.generation)) invalidField("generation");
	if (value.digest !== responseDigest(value.source)) invalidField("digest");
	return {
		status: "ok",
		source: value.source,
		generation: value.generation,
		digest: value.digest,
		assets: readAssets(value.assets),
	};
}
export function readLiveResult(value: unknown, action: LiveAction): LiveResult {
	if (!isRecord(value)) invalidField("result", "expected an object");
	if (typeof value.status !== "string") invalidField("status");
	if (["stale", "busy", "closed", "error", "uncertain"].includes(value.status)) {
		if (typeof value.message !== "string" || value.message.length > 1000) invalidField("message");
		return { status: value.status as "error", message: value.message };
	}
	return readCommandResult(value, action);
}
function readCommandResult(value: Record<string, unknown>, action: LiveAction): LiveResult {
	switch (action.op) {
		case "comments":
		case "setComment":
			return readCommentResult(value, action);
		case "navigate":
			if (value.status === "navigated") return readNavigationResult(value, action);
			break;
		case "claim":
			if (value.status === "claimed") return readClaimResult(value);
			break;
		case "release":
			if (value.status === "released") return readReleaseResult(value, action);
			break;
		case "apply":
			if (value.status === "applied") return readAppliedResult(value, action);
			break;
		case "read":
			if (value.status === "ok") return readSourceResult(value);
			break;
	}
	return invalidField("status", "not a result for this command");
}
