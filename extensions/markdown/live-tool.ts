import { arr, int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import type * as Durable from "@earendil-works/pi-durable";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toolDisplay } from "./display.ts";
import type { LiveBridge } from "./live-bridge.ts";
import { LIVE_WIRE_BYTES, readLiveAction, type LiveResult } from "./live-protocol.ts";

const DESCRIPTION = "Read or edit the exact unsaved buffer in a connected native Markdown pane. List handles when none is known. Read returns exact source pages of at most 64 KiB; offset counts UTF-16 units. Continue with nextOffset as offset and the same baseGeneration/baseDigest; a changed source returns stale. Read before edits; use the returned generation and SHA-256 digest as the apply base. Edits use ordered, nonoverlapping UTF-16 start/end ranges, exact expected text and replacement text. A stable UUID operationId names one exact apply; retry an unconfirmed apply only with that same ID and identical arguments. The pane's Undo and private recovery own changes. Claim the ranges before composing a larger edit; claims never block the person. Claim and release require a handle with live: 2 from list. A busy message that says the person has the passage open for writing means edit elsewhere, or read again after they leave it. Never substitute stored document reads, publication, file writes or a new pane for this live buffer. A stale result requires a fresh read and a revised edit; busy requires a later read. Closed means the exact target is unavailable.";
const LiveParameters = obj({
	op: union([lit("list"), lit("read"), lit("apply"), lit("claim"), lit("release")]),
	handle: opt(str({ maxLength: 73 })),
	offset: opt(int({ minimum: 0 })),
	operationId: opt(str({ maxLength: 36 })),
	claimId: opt(str({ maxLength: 36 })),
	ranges: opt(arr(obj({ start: int({ minimum: 0 }), end: int({ minimum: 0 }) }, { open: false }), { minItems: 1, maxItems: 16 })),
	label: opt(str({ maxLength: 80 })),
	baseGeneration: opt(int({ minimum: 0 })),
	baseDigest: opt(str({ maxLength: 71 })),
	edits: opt(arr(obj({ start: int({ minimum: 0 }), end: int({ minimum: 0 }), expected: str(), replacement: str() }), { minItems: 1, maxItems: 64 })),
}, { open: false });
type Input = { op: "list" | "read" | "apply" | "claim" | "release"; offset?: number; handle?: string; operationId?: string; claimId?: string; baseGeneration?: number; baseDigest?: string; ranges?: { start: number; end: number }[]; label?: string; edits?: { start: number; end: number; expected: string; replacement: string }[] };
type SourcePage = Extract<LiveResult, { status: "ok" }> & { offset: number; nextOffset: number | null; totalChars: number; totalBytes: number };
export function liveSourcePage(result: LiveResult, input: Input): Exclude<LiveResult, { status: "ok" }> | SourcePage {
	if (result.status !== "ok") return result;
	const offset = input.offset ?? 0;
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid live source page boundary.");
	if (offset > 0 && (input.baseGeneration !== result.generation || input.baseDigest !== result.digest)) return { status: "stale", message: "The live source changed between pages. Read again from offset zero." };
	if (offset > result.source.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(result.source[offset] ?? ""))) throw new Error("Invalid live source page boundary.");
	let end = offset;
	let bytes = 0;
	for (const point of result.source.slice(offset)) {
		const size = Buffer.byteLength(point);
		if (bytes + size > 65536) break;
		bytes += size; end += point.length;
	}
	return { ...result, source: result.source.slice(offset, end), offset, nextOffset: end < result.source.length ? end : null, totalChars: result.source.length, totalBytes: Buffer.byteLength(result.source) };
}
async function execute(bridge: LiveBridge | undefined, input: Input, signal?: AbortSignal): Promise<unknown> {
	if (input.op === "list") return { status: "ok", panes: bridge?.list() ?? [] };
	if (!input.handle) throw new Error("Read, apply, claim and release require the exact live pane handle.");
	if (!bridge) return { status: "closed", message: "No live native pane is connected to this exact conversation." };
	const result = await bridge.execute(input.handle, readLiveAction(input), signal);
	return input.op === "read" ? liveSourcePage(result, input) : result;
}
function output(value: unknown): { type: "text"; text: string }[] { return [{ type: "text", text: JSON.stringify(value) }]; }
export function createLiveTool(find: (ctx: ExtensionContext) => Promise<LiveBridge | undefined>): ToolDefinition<typeof LiveParameters> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_live");
	return { ...presentation, name: "markdown_live", label: "Markdown Live", description: DESCRIPTION, parameters: LiveParameters, async execute(_id, input, signal, _update, ctx) {
		const result = await execute(await find(ctx), input as Input, signal);
		return { content: output(result), details: result };
	} };
}
export function createNativeLiveTool(durable: typeof Durable, find: (conversation: string) => Promise<LiveBridge | undefined>): Durable.ToolRegistration<typeof LiveParameters> {
	return durable.defineTool({ name: "markdown_live", description: DESCRIPTION, parameters: LiveParameters, replay: "safe", outputLimits: { maxBytes: LIVE_WIRE_BYTES, maxLines: 2000 }, async execute(input, api, context) {
		const result = await execute(await find(String(api.conversationId)), input as Input, context.abortSignal);
		return { output: output(result), details: result as Durable.JsonObject };
	} });
}
