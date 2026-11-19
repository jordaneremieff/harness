import { randomUUID } from "node:crypto";
import { arr, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type * as Durable from "@earendil-works/pi-durable";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";
import type { LiveBridge } from "./live-bridge.ts";
import {
	LIVE_WIRE_BYTES,
	liveDigest,
	liveId,
	readLiveAction,
	type LiveAction,
	type LiveResult,
} from "./live-protocol.ts";
import { SOURCE_BYTES, responseDigest, validUnicode } from "./responses.ts";

const DESCRIPTION =
	"Use apply with unique {find, replace} edits in the unsaved pane. Base and operationId are optional for anchors. Retry unconfirmed edits only with the returned UUID and unchanged arguments. The pane owns Undo and private recovery. List handles; read pages with nextOffset and the same baseGeneration/baseDigest. Claim ranges before composing a larger edit; claims never block the person. Claim and release need live: 2. Range edits need the read base. If the person has the passage open, edit elsewhere or read after they leave it. If stale, read again; if closed, reopen the exact pane. Never substitute stored documents, file writes or a new pane.";
const Anchor = obj({ find: str({ minLength: 1 }), replace: str() }, { open: false });
const Range = obj(
	{ start: int({ minimum: 0 }), end: int({ minimum: 0 }), expected: str(), replacement: str() },
	{ open: false },
);
const LiveParameters = obj(
	{
		op: union([lit("list"), lit("read"), lit("apply"), lit("claim"), lit("release")]),
		handle: opt(str({ maxLength: 73 })),
		offset: opt(int({ minimum: 0 })),
		operationId: opt(str({ maxLength: 36 })),
		claimId: opt(str({ maxLength: 36 })),
		ranges: opt(
			arr(obj({ start: int({ minimum: 0 }), end: int({ minimum: 0 }) }, { open: false }), {
				minItems: 1,
				maxItems: 16,
			}),
		),
		label: opt(str({ maxLength: 80 })),
		baseGeneration: opt(int({ minimum: 0 })),
		baseDigest: opt(str({ maxLength: 71 })),
		edits: opt(union([arr(Anchor, { minItems: 1, maxItems: 64 }), arr(Range, { minItems: 1, maxItems: 64 })])),
	},
	{ open: false },
);
type AnchorEdit = { find: string; replace: string };
type Apply = Omit<Extract<LiveAction, { op: "apply" }>, "edits"> & {
	edits: { start: number; end: number; expected: string; replacement: string }[];
};
type Snapshot = Extract<LiveResult, { status: "ok" }>;
type Version = Pick<Snapshot, "generation" | "digest">;
type Input = {
	op: "list" | "read" | "apply" | "claim" | "release";
	offset?: number;
	handle?: string;
	operationId?: string;
	claimId?: string;
	baseGeneration?: number;
	baseDigest?: string;
	ranges?: { start: number; end: number }[];
	label?: string;
	edits?: AnchorEdit[] | Apply["edits"];
};
type SourcePage = Snapshot & { offset: number; nextOffset: number | null; totalChars: number; totalBytes: number };
const versionOf = ({ generation, digest }: Version): Version => ({ generation, digest });
const matchesBase = (input: Input, snapshot: Version): boolean =>
	input.baseGeneration === snapshot.generation && input.baseDigest === snapshot.digest;

export function liveSourcePage(
	result: LiveResult,
	input: Input,
): Exclude<LiveResult, Snapshot> | SourcePage | ({ status: "stale"; message: string } & Version) {
	if (result.status !== "ok") return result;
	const offset = input.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid live source page boundary.");
	if (offset > 0 && !matchesBase(input, result))
		return {
			status: "stale",
			message: "The live source changed between pages. Read again from offset zero.",
			...versionOf(result),
		};
	if (offset > result.source.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(result.source[offset] ?? "")))
		throw new Error("Invalid live source page boundary.");
	let end = offset;
	let bytes = 0;
	for (const point of result.source.slice(offset)) {
		const size = Buffer.byteLength(point);
		if (bytes + size > 65536) break;
		bytes += size;
		end += point.length;
	}
	return {
		...result,
		source: result.source.slice(offset, end),
		offset,
		nextOffset: end < result.source.length ? end : null,
		totalChars: result.source.length,
		totalBytes: Buffer.byteLength(result.source),
	};
}

const normalizeLF = (text: string): string => text.replace(/\r\n?/gu, "\n");
const lineAt = (source: string, offset: number): number =>
	(source.slice(0, offset).match(/\r\n|[\r\n]/gu)?.length ?? 0) + 1;
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

function closestPassage(source: string, find: string): { line: number; text: string; truncated: boolean } | undefined {
	if (!source) return;
	const wanted = new Set(words(find));
	let best = { line: 1, text: "" },
		score = -1,
		line = 0;
	for (const match of source.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)) {
		line++;
		const text = match[0].replace(/(?:\r\n|[\r\n])$/u, "");
		const shared = new Set(words(text).filter((word) => wanted.has(word))).size;
		if (shared > score || (shared === score && !best.text.trim() && text.trim())) {
			best = { line, text };
			score = shared;
		}
	}
	const excerpt = best.text.slice(0, 1000).replace(/[\uD800-\uDBFF]$/u, "");
	return { line: best.line, text: excerpt, truncated: excerpt.length < best.text.length };
}

type AnchorError = {
	status: "error";
	message: string;
	edit: number;
	suggestion?: { line: number; text: string; truncated: boolean };
	suggestedFind?: string;
	lines?: number[];
	count?: number;
};
function missingAnchor(source: string, find: string, edit: number): AnchorError {
	const error = { status: "error" as const, edit };
	const suggestedFind = find.replace(/\\[nt]/gu, (sequence) => (sequence === "\\n" ? "\n" : "\t"));
	const suggestedStart = suggestedFind !== find ? source.indexOf(suggestedFind) : -1;
	if (suggestedStart !== -1 && source.indexOf(suggestedFind, suggestedStart + 1) === -1) {
		return {
			...error,
			message:
				"The anchor contains literal \\n or \\t. Use suggestedFind exactly; it contains real line breaks or tabs.",
			suggestedFind,
		};
	}
	const suggestion = closestPassage(source, find);
	return {
		...error,
		message: suggestion
			? "Anchor not found. Use the closest passage shown, or read the buffer and copy exact text."
			: "Anchor not found. The live buffer is empty.",
		suggestion,
	};
}

function repeatedAnchor(source: string, find: string, start: number, edit: number): AnchorError | undefined {
	let count = 1;
	const offsets = [start];
	for (let next = source.indexOf(find, start + 1); next !== -1; next = source.indexOf(find, next + 1)) {
		count++;
		if (offsets.length < 20) offsets.push(next);
	}
	if (count > 1) {
		const lines = offsets.map((offset) => lineAt(source, offset));
		return {
			status: "error",
			edit,
			message: `Anchor occurs ${count} times. Include more surrounding text to select one occurrence.${count > lines.length ? " Only the first 20 match locations are listed." : ""}`,
			lines,
			count,
		};
	}
}

function resolveAnchors(source: string, anchors: AnchorEdit[]): Apply["edits"] | AnchorError {
	const format = source.includes("\r") ? (text: string) => text : normalizeLF;
	const edits: (Apply["edits"][number] & { edit: number })[] = [];
	for (const [index, anchor] of anchors.entries()) {
		const edit = index + 1;
		const find = format(anchor.find);
		const start = source.indexOf(find);
		if (start === -1) return missingAnchor(source, find, edit);
		const repeated = repeatedAnchor(source, find, start, edit);
		if (repeated) return repeated;
		edits.push({ edit, start, end: start + find.length, expected: find, replacement: format(anchor.replace) });
	}
	edits.sort((a, b) => a.start - b.start);
	for (const [index, current] of edits.entries()) {
		const previous = edits[index - 1];
		if (previous && current.start < previous.end)
			return {
				status: "error",
				edit: current.edit,
				message: `Anchors ${previous.edit} and ${current.edit} overlap. Combine them or choose disjoint passages.`,
			};
	}
	return edits.map(({ start, end, expected, replacement }) => ({ start, end, expected, replacement }));
}

function requestApply(value: unknown): Apply {
	const action = readLiveAction(value);
	if (action.op !== "apply") throw new Error("Expected a live apply action.");
	return action;
}

function resultWithNextStep(result: LiveResult): LiveResult {
	if (result.status === "closed")
		return {
			...result,
			message: `${result.message} Reopen the same live document and list handles before you try again.`,
		};
	if (result.status === "busy" && !/read again|release an active claim/iu.test(result.message))
		return { ...result, message: `${result.message} Read again after the pane is ready.` };
	return result;
}

function staleResult(snapshot: LiveResult, problem?: AnchorError) {
	return {
		...problem,
		status: "stale" as const,
		message: problem
			? `The buffer changed. ${problem.message}`
			: "The buffer changed. Read the exact pane and revise the edit.",
		...(snapshot.status === "ok" ? versionOf(snapshot) : { refreshFailure: resultWithNextStep(snapshot) }),
	};
}

function editId(seed: string): string {
	const hex = responseDigest(seed).slice(7);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Plan = { action: Apply; refreshed: boolean };
type Seal = (operationId: string, plan?: Plan) => Promise<Plan | undefined>;

function anchorKey(input: Input, anchors: AnchorEdit[]): string {
	if (
		(input.baseGeneration !== undefined || input.baseDigest !== undefined) &&
		(!Number.isSafeInteger(input.baseGeneration) || (input.baseGeneration ?? -1) < 0 || !liveDigest(input.baseDigest))
	)
		throw new Error("Supply both baseGeneration and baseDigest, or omit both for anchored edits.");
	let bytes = 0;
	for (const { find, replace } of anchors) {
		if (!find || !validUnicode(find) || !validUnicode(replace))
			throw new Error("Use nonempty find text and valid Unicode in each anchored edit.");
		bytes += Buffer.byteLength(find) + Buffer.byteLength(replace);
		if (bytes > 2 * SOURCE_BYTES) throw new Error("The live edit exceeds the source limit.");
	}
	return responseDigest(
		JSON.stringify([input.baseGeneration, input.baseDigest, anchors.map(({ find, replace }) => [find, replace])]),
	);
}

type AnchorRequest = {
	bridge: LiveBridge;
	handle: string;
	input: Input;
	anchors: AnchorEdit[];
	key: string;
	signal?: AbortSignal;
	seal?: Seal;
};

async function anchoredAttempt(request: AnchorRequest, operationId: string, refreshed: boolean) {
	const { bridge, handle, input, anchors, key, signal, seal } = request;
	let plan = (await seal?.(operationId)) ?? bridge.resolvedEdit(handle, operationId, key);
	if (!plan) {
		const snapshot = await bridge.execute(handle, { op: "read" }, signal);
		if (snapshot.status !== "ok") return { result: refreshed ? staleResult(snapshot) : resultWithNextStep(snapshot) };
		refreshed ||= input.baseGeneration !== undefined && !matchesBase(input, snapshot);
		const edits = resolveAnchors(snapshot.source, anchors);
		if (!Array.isArray(edits)) return { result: refreshed ? staleResult(snapshot, edits) : edits };
		plan = {
			refreshed,
			action: requestApply({
				op: "apply",
				operationId,
				baseGeneration: snapshot.generation,
				baseDigest: snapshot.digest,
				edits,
			}),
		};
	}
	// Replay must use the exact command, not resolve the same intent against a changed pane.
	plan = (await seal?.(operationId, plan)) ?? plan;
	const result = await bridge.execute(handle, plan.action, signal, { key, refreshed: plan.refreshed });
	return { result, plan };
}

async function applyAnchors(
	bridge: LiveBridge,
	handle: string,
	input: Input,
	anchors: AnchorEdit[],
	operationId: string,
	signal?: AbortSignal,
	seal?: Seal,
) {
	const request = { bridge, handle, input, anchors, key: anchorKey(input, anchors), signal, seal };
	let attempt = await anchoredAttempt(request, operationId, false);
	if (attempt.plan && !attempt.plan.refreshed && attempt.result.status === "stale") {
		operationId = editId(`markdown-live refresh:${operationId}`);
		attempt = await anchoredAttempt(request, operationId, true);
	}
	if (!attempt.plan) return attempt.result;
	if (attempt.result.status === "stale")
		return { ...staleResult(await bridge.execute(handle, { op: "read" }, signal)), retried: true };
	return { ...resultWithNextStep(attempt.result), operationId, ...(attempt.plan.refreshed ? { retried: true } : {}) };
}

async function apply(
	bridge: LiveBridge,
	handle: string,
	input: Input,
	signal?: AbortSignal,
	taskId?: string,
	seal?: Seal,
) {
	const operationId = input.operationId ?? (taskId ? editId(`markdown-live task:${taskId}`) : randomUUID());
	if (!liveId(operationId)) throw new Error("Use a UUID as operationId, or omit it.");
	if (input.edits?.some((edit) => "find" in edit)) {
		const anchors: (AnchorEdit | Apply["edits"][number])[] = input.edits;
		if (
			anchors.length > 64 ||
			!anchors.every(
				(edit): edit is AnchorEdit =>
					"find" in edit && typeof edit.find === "string" && typeof edit.replace === "string",
			)
		)
			throw new Error("Use 1 to 64 anchored edits or exact range edits in one call; do not mix the forms.");
		return applyAnchors(bridge, handle, input, anchors, operationId, signal, seal);
	}
	const result = await bridge.execute(handle, requestApply({ ...input, operationId }), signal);
	if (result.status === "stale") return staleResult(await bridge.execute(handle, { op: "read" }, signal));
	return { ...resultWithNextStep(result), operationId };
}

async function execute(
	bridge: LiveBridge | undefined,
	input: Input,
	signal?: AbortSignal,
	taskId?: string,
	seal?: Seal,
): Promise<unknown> {
	if (input.op === "list") return { status: "ok", panes: bridge?.list() ?? [] };
	if (!input.handle) throw new Error("Read, apply, claim and release require the exact live pane handle.");
	if (!bridge)
		return resultWithNextStep({
			status: "closed",
			message: "No live native pane is connected to this exact conversation.",
		});
	if (input.op === "apply") return apply(bridge, input.handle, input, signal, taskId, seal);
	const result = await bridge.execute(input.handle, readLiveAction(input), signal);
	if (result.status === "stale" && input.op === "claim")
		return staleResult(await bridge.execute(input.handle, { op: "read" }, signal));
	return input.op === "read" ? liveSourcePage(resultWithNextStep(result), input) : resultWithNextStep(result);
}

function output(value: unknown): { type: "text"; text: string }[] {
	return [{ type: "text", text: JSON.stringify(value) }];
}
export function createLiveTool(
	find: (ctx: ExtensionContext) => Promise<LiveBridge | undefined>,
): ToolDefinition<typeof LiveParameters> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_live");
	return {
		...presentation,
		name: "markdown_live",
		label: "Markdown Live",
		description: DESCRIPTION,
		parameters: LiveParameters,
		async execute(_id, input, signal, _update, ctx) {
			const result = await execute(await find(ctx), input as Input, signal);
			return { content: output(result), details: result };
		},
	};
}
export function createNativeLiveTool(
	durable: typeof Durable,
	find: (conversation: string) => Promise<LiveBridge | undefined>,
): Durable.ToolRegistration<typeof LiveParameters> {
	return durable.defineTool({
		name: "markdown_live",
		description: DESCRIPTION,
		parameters: LiveParameters,
		replay: "safe",
		outputLimits: { maxBytes: LIVE_WIRE_BYTES, maxLines: 2000 },
		async execute(input, api, context) {
			const seal: Seal = (id, plan) =>
				plan ? api.memo(`live-edit:${id}`, plan, context) : api.memo<Plan>(`live-edit:${id}`, context);
			const result = await execute(
				await find(String(api.conversationId)),
				input as Input,
				context.abortSignal,
				String(api.taskId),
				seal,
			);
			return { output: output(result), details: result as Durable.JsonObject };
		},
	});
}
