import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord/context";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import {
	arr,
	bool,
	compile,
	int,
	lit,
	nullable,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import type { LiveBridge } from "./live-bridge.ts";
import {
	LIVE_WIRE_BYTES,
	type LiveAction,
	type LiveResult,
	liveDigest,
	liveId,
	readLiveAction,
} from "./live-protocol.ts";
import { type ShowOptions, ShowOutcomes, showStored } from "./live-show.ts";
import { LaunchSchema, PaneSchema, paneInventory } from "./pane-state.ts";
import { responseDigest, SOURCE_BYTES, validUnicode } from "./responses.ts";

const DESCRIPTION =
	"Use list for this conversation's connected panes and pending launches. Each handle names an exact live buffer; view.documentId names its stored document. A dirty or conflicted view reports its base, not saved live text. Conflict means autosave stopped: preserve the draft and read the stored revision separately. Use show with a full stored document ID for current/follow, or add revision to pin. It reuses an agent pane, never an operator pane. Only navigated confirms a switch. Only launch supplies argv for an initial pane; confirm its view with list. Never type navigation into the terminal or repeat an uncertain show. Use read on an exact handle. Only complete has whole source; for page, join all fragments from offset zero with nextOffset and unchanged baseGeneration/baseDigest. Use apply with unique {find,replace} anchors. An explicit base binds the edit; range edits require it. Claim ranges before composing a larger edit; claims never block the person. If busy, edit elsewhere or read after the person leaves the passage. Retry an uncertain edit only with its UUID and identical arguments. Applied confirms private recovery, not a saved revision. Use comments for delivered open or closed comments; continue with nextOffset and the sheet version as expectedVersion. setComment requires the listed item ID, its version as expectedVersion, and the new state. It does not send a message.";
const Anchor = obj({ find: str({ minLength: 1 }), replace: str() }, { open: false });
const Range = obj(
	{ start: int({ minimum: 0 }), end: int({ minimum: 0 }), expected: str(), replacement: str() },
	{ open: false },
);
const CommentState = oneOf(["open", "closed"]);
const CommentId = str({ maxLength: 39 });
const LiveParameters = obj(
	{
		op: union([
			lit("list"),
			lit("show"),
			lit("read"),
			lit("apply"),
			lit("claim"),
			lit("release"),
			lit("comments"),
			lit("setComment"),
		]),
		handle: opt(str({ minLength: 1, maxLength: 73 })),
		document: opt(str({ pattern: "^md-[a-f0-9]{20}$" })),
		revision: opt(int({ minimum: 1 })),
		offset: opt(int({ minimum: 0 })),
		operationId: opt(str({ maxLength: 36 })),
		claimId: opt(str({ maxLength: 36 })),
		commentId: opt(CommentId),
		commentState: opt(CommentState),
		expectedVersion: opt(int({ minimum: 0 })),
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
const VersionFields = { generation: int({ minimum: 0 }), digest: str() };
const ReadFields = {
	...VersionFields,
	pane: opt(PaneSchema),
	assets: arr(obj({ reference: str(), digest: str() })),
	totalChars: int({ minimum: 0 }),
	totalBytes: int({ minimum: 0 }),
};
const Complete = obj({ status: lit("complete"), ...ReadFields, offset: lit(0), nextOffset: lit(null), source: str() });
const Page = obj({
	status: lit("page"),
	...ReadFields,
	offset: int({ minimum: 0 }),
	nextOffset: nullable(int({ minimum: 1 })),
	fragment: str(),
});
const FailureFields = { status: oneOf(["stale", "busy", "closed", "error", "uncertain"]), message: str() };
const LiveOutcomeSchema = union([
	Complete,
	Page,
	...ShowOutcomes,
	obj({ status: lit("ok"), panes: arr(PaneSchema), pending: arr(LaunchSchema) }),
	obj({ status: lit("applied"), ...VersionFields, operationId: str(), retained: lit(true), pane: opt(PaneSchema) }),
	obj({ status: lit("claimed"), claimId: str(), expiresAt: int() }),
	obj({ status: lit("released"), claimId: str() }),
	obj({
		status: lit("comments"),
		commentState: CommentState,
		version: int({ minimum: 0 }),
		comments: arr(
			obj({
				commentId: CommentId,
				threadId: str(),
				kind: oneOf(["question", "annotation", "overall"]),
				ordinal: int({ minimum: 0, maximum: 50 }),
				text: str(),
				quote: opt(str()),
				madeOnRevision: opt(int({ minimum: 1 })),
				commentState: CommentState,
				version: int({ minimum: 1 }),
			}),
			{ maxItems: 20 },
		),
		offset: int({ minimum: 0 }),
		total: int({ minimum: 0 }),
		nextOffset: opt(int({ minimum: 1 })),
	}),
	obj({ status: lit("commentSet"), commentId: CommentId, commentState: CommentState, version: int({ minimum: 1 }) }),
	obj({
		...FailureFields,
		pane: opt(PaneSchema),
		generation: opt(VersionFields.generation),
		digest: opt(VersionFields.digest),
		refreshFailure: opt(obj(FailureFields)),
		operationId: opt(str()),
		edit: opt(int()),
		count: opt(int()),
		lines: opt(arr(int())),
		suggestedFind: opt(str()),
		suggestion: opt(obj({ line: int(), text: str(), truncated: bool() })),
	}),
]);
type LiveOutcome = Static<typeof LiveOutcomeSchema>;
const checkOutcome = compile(LiveOutcomeSchema).check;
function checkedOutcome(value: unknown): LiveOutcome {
	if (!checkOutcome(value)) throw new Error("The live Markdown result does not match its output contract.");
	return value;
}
type AnchorEdit = { find: string; replace: string };
type Apply = Omit<Extract<LiveAction, { op: "apply" }>, "edits"> & {
	edits: { start: number; end: number; expected: string; replacement: string }[];
};
type Snapshot = Extract<LiveResult, { status: "ok" }>;
type Version = Pick<Snapshot, "generation" | "digest">;
type Input = Static<typeof LiveParameters>;
const checkInput = compile(LiveParameters).check;
type SourceRead = Static<typeof Complete> | Static<typeof Page>;
const versionOf = ({ generation, digest }: Version): Version => ({ generation, digest });
const matchesBase = (input: Input, snapshot: Version): boolean =>
	input.baseGeneration === snapshot.generation && input.baseDigest === snapshot.digest;

function pageEnd(source: string, offset: number): number {
	let end = offset;
	let bytes = 0;
	for (const point of source.slice(offset)) {
		const size = Buffer.byteLength(point);
		if (bytes + size > 65536) break;
		bytes += size;
		end += point.length;
	}
	return end;
}

export function liveSourcePage(
	result: LiveResult,
	input: Input,
): Exclude<LiveResult, Snapshot> | SourceRead | ({ status: "stale"; message: string } & Version) {
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
	const end = pageEnd(result.source, offset);
	const metadata = {
		...versionOf(result),
		assets: result.assets,
		totalChars: result.source.length,
		totalBytes: Buffer.byteLength(result.source),
	};
	if (offset === 0 && end === result.source.length)
		return { status: "complete", source: result.source, offset: 0, nextOffset: null, ...metadata };
	return {
		status: "page",
		fragment: result.source.slice(offset, end),
		offset,
		nextOffset: end < result.source.length ? end : null,
		...metadata,
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
		...(suggestion ? { suggestion } : {}),
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
			message: `${result.message} List panes to check the exact handle. Do not edit another buffer or open a substitute pane.`,
		};
	if (result.status === "busy" && !/read again|release an active claim/iu.test(result.message))
		return { ...result, message: `${result.message} Read again after the pane is ready.` };
	return result;
}

function staleResult(snapshot: LiveResult) {
	return {
		status: "stale" as const,
		message: "The buffer changed. Read the exact pane and revise the edit.",
		...(snapshot.status === "ok" ? versionOf(snapshot) : { refreshFailure: resultWithNextStep(snapshot) }),
	};
}

async function staleVersion(bridge: LiveBridge, handle: string, signal?: AbortSignal) {
	try {
		return staleResult(await bridge.execute(handle, { op: "read" }, signal));
	} catch (error) {
		return staleResult({ status: "error", message: error instanceof Error ? error.message : String(error) });
	}
}

function editId(seed: string): string {
	const hex = responseDigest(seed).slice(7);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Plan = { action: Apply };
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

async function applyAnchors(
	bridge: LiveBridge,
	handle: string,
	input: Input,
	anchors: AnchorEdit[],
	operationId: string,
	signal?: AbortSignal,
	seal?: Seal,
) {
	const key = anchorKey(input, anchors);
	let plan = (await seal?.(operationId)) ?? bridge.resolvedEdit(handle, operationId, key);
	if (!plan) {
		const snapshot = await bridge.execute(handle, { op: "read" }, signal);
		if (snapshot.status !== "ok") return resultWithNextStep(snapshot);
		if (input.baseGeneration !== undefined && !matchesBase(input, snapshot)) return staleResult(snapshot);
		const edits = resolveAnchors(snapshot.source, anchors);
		if (!Array.isArray(edits)) return edits;
		plan = {
			action: requestApply({
				op: "apply",
				operationId,
				baseGeneration: snapshot.generation,
				baseDigest: snapshot.digest,
				edits,
			}),
		};
	}
	// A retry must send the same resolved command. A unique match on a newer base can name a different passage.
	plan = (await seal?.(operationId, plan)) ?? plan;
	const result = await bridge.execute(handle, plan.action, signal, { key });
	if (result.status === "stale") return staleVersion(bridge, handle, signal);
	return { ...resultWithNextStep(result), operationId };
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
	if (result.status === "stale") return staleVersion(bridge, handle, signal);
	return { ...resultWithNextStep(result), operationId };
}

function observeBuffer(bridge: LiveBridge, handle: string | undefined, result: LiveOutcome): LiveOutcome {
	// A later state report is independent of the command receipt. A failed observation must not undo the receipt.
	try {
		const pane = bridge.list().find((row) => row.handle === handle);
		return pane ? checkedOutcome({ ...result, pane }) : result;
	} catch {
		return result;
	}
}

async function execute(
	find: () => Promise<LiveBridge | undefined>,
	input: Input,
	signal?: AbortSignal,
	taskId?: string,
	seal?: Seal,
	show?: ShowOptions,
): Promise<LiveOutcome> {
	try {
		if (input.op !== "show" && (input.document !== undefined || input.revision !== undefined))
			return {
				status: "error",
				message: "Only show accepts a stored document or revision. Other operations require the exact live handle.",
			};
		if (
			input.op === "show" &&
			Object.keys(input).some((key) => !["op", "handle", "document", "revision"].includes(key))
		)
			return { status: "error", message: "Show takes only document, optional revision and optional exact handle." };
		const bridge = await find();
		if (input.op === "show") return checkedOutcome(await showStored(bridge, input, show, signal));
		const result = checkedOutcome(await executeOnBridge(bridge, input, signal, taskId, seal));
		return bridge && (input.op === "read" || input.op === "apply")
			? observeBuffer(bridge, input.handle, result)
			: result;
	} catch (error) {
		if (!["read", "list", "show"].includes(input.op) || signal?.aborted) throw error;
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

async function reviewComments(bridge: LiveBridge | undefined, handle: string, input: Input, signal?: AbortSignal) {
	const action = readLiveAction(input);
	if (!bridge)
		return {
			status: "closed",
			message: "This conversation has no connected pane. List panes to check the exact handle.",
		};
	const result = await bridge.execute(handle, action, signal);
	switch (result.status) {
		case "closed":
			return {
				...result,
				message: `${result.message} List panes to check the exact handle. Do not select a different pane.`,
			};
		case "stale":
			return {
				...result,
				message: `${result.message} List comments on the exact handle from offset zero for the current versions.`,
			};
		case "uncertain":
			return {
				...result,
				message: `${result.message} List open and closed comments on the exact handle before another change.`,
			};
		default:
			return result;
	}
}

async function executeOnBridge(
	bridge: LiveBridge | undefined,
	input: Input,
	signal?: AbortSignal,
	taskId?: string,
	seal?: Seal,
) {
	if (input.op === "list") return { status: "ok", ...paneInventory(bridge) };
	if (!input.handle) throw new Error(`${input.op} requires the exact live pane handle.`);
	if (input.op === "comments" || input.op === "setComment") return reviewComments(bridge, input.handle, input, signal);
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
	show?: Omit<ShowOptions, "connection"> & {
		lifecycle?: () => AbortSignal;
		connection: (ctx: ExtensionContext) => ReturnType<ShowOptions["connection"]>;
	},
): ToolDefinition<typeof LiveParameters> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_live");
	return {
		...presentation,
		name: "markdown_live",
		label: "Markdown Live",
		description: DESCRIPTION,
		parameters: LiveParameters,
		outputSchema: LiveOutcomeSchema,
		async execute(_id, input, signal, _update, ctx) {
			if (!checkInput(input)) throw new Error("Invalid live Markdown arguments.");
			const id = input.op === "show" && show ? ctx.sessionManager.getSessionId() : undefined;
			const checkRoute = () => {
				if (ctx.sessionManager.getSessionId() !== id) throw new Error("The invoking Markdown conversation changed.");
			};
			const local =
				show && input.op === "show"
					? {
							...show,
							checkRoute,
							connection: () => {
								checkRoute();
								return show.connection(ctx);
							},
						}
					: undefined;
			const lifetime = local?.lifecycle?.();
			const active = lifetime && signal ? AbortSignal.any([lifetime, signal]) : (lifetime ?? signal);
			const result = await execute(() => find(ctx), input, active, undefined, undefined, local);
			return { content: output(result), details: result, structuredContent: result };
		},
	};
}
/** Neither a one-use launch nor a navigation/transition with an unconfirmed receipt is a replayable command. */
async function oncePerTask(
	op: "show" | "setComment",
	run: () => Promise<LiveOutcome>,
	api: Durable.ToolExecutionApi,
	context: Context,
): Promise<LiveOutcome> {
	const attempt = randomUUID();
	if ((await api.memo("markdown.live.attempt", attempt, context)) !== attempt) {
		const receipt = await api.memo<LiveOutcome>("markdown.live.receipt", context);
		if (receipt) return receipt;
		return {
			status: "uncertain",
			message:
				op === "show"
					? "This show was attempted before recovery. List panes and pending launches. No command was repeated and no launch argv was reissued."
					: "The earlier comment change has no confirmed receipt. List open and closed comments on the same handle before another change.",
		};
	}
	const result = await run();
	return result.status === "launch" ? result : await api.memo("markdown.live.receipt", result, context);
}

export function createNativeLiveTool(
	durable: typeof Durable,
	find: (conversation: string) => Promise<LiveBridge | undefined>,
	show?: Omit<ShowOptions, "connection"> & {
		connection: (id: Durable.ConversationId, context: Context) => ReturnType<ShowOptions["connection"]>;
	},
): Durable.ToolRegistration<typeof LiveParameters> {
	return durable.defineTool({
		name: "markdown_live",
		description: DESCRIPTION,
		parameters: LiveParameters,
		structuredOutputSchema: LiveOutcomeSchema,
		replay: "safe",
		outputLimits: { maxBytes: LIVE_WIRE_BYTES, maxLines: 2000 },
		async execute(input, api, context) {
			const seal: Seal = (id, plan) =>
				plan ? api.memo(`live-edit:${id}`, plan, context) : api.memo<Plan>(`live-edit:${id}`, context);
			const run = () =>
				execute(
					() => find(String(api.conversationId)),
					input,
					context.abortSignal,
					String(api.taskId),
					seal,
					show && { ...show, connection: () => show.connection(api.conversationId, context) },
				);
			const result =
				input.op === "show" || input.op === "setComment" ? await oncePerTask(input.op, run, api, context) : await run();
			return { output: output(result), details: result, structuredOutput: result };
		},
	});
}
