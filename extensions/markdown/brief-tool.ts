import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { toolDisplay } from "./display.ts";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import {
	BRIEF_SCAN_BYTES,
	MAX_REQUEST_CHARS,
	buildBrief,
	formatBrief,
	type BriefMessage,
	type WritingBrief,
} from "./brief.ts";
import { describeRules } from "./check-rules.ts";
import { loadLexicon, loadReader, WritingConfigError, type WritingOptions } from "./writing-config.ts";

export const BRIEF_GUIDANCE = "Call markdown_brief before drafting a document for the operator.";
const description = `${BRIEF_GUIDANCE} It supplies the reader profile, recent requests, technical terms to explain or omit, and the checks that apply at publication.`;
const Parameters = obj({ title: opt(str({ maxLength: 200 })) }, { open: false });
export const WritingBriefSchema = obj({
	title: opt(str()),
	reader: str(),
	requests: opt(
		arr(str(), {
			description:
				"Request excerpts for reference, oldest first. All are earlier requests if latestRequestWithheld is true.",
		}),
	),
	latestRequestWithheld: opt(bool({ description: "The brief omitted the newest user message." })),
	skipped: opt(int()),
	opening: str(),
	terms: opt(arr(str())),
	checks: arr(str()),
	limited: opt(bool()),
});
const VISITS = 2000;

type Source = Pick<ExtensionContext["sessionManager"], "getEntry" | "getLeafId">;
type NativeHost = { durable: typeof Durable; harness?: Pick<Durable.Harness, "conversation"> };

export function transcriptMessage(message: { role: string; content?: unknown }): BriefMessage | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	const parts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap((part: unknown) => {
						if (
							typeof part !== "object" ||
							part === null ||
							!("type" in part) ||
							part.type !== "text" ||
							!("text" in part) ||
							typeof part.text !== "string"
						)
							return [];
						return [part.text];
					})
				: [];
	return parts.length || message.role === "user" ? { role: message.role, text: parts.join("\n\n") } : undefined;
}
export function* ordinaryBriefMessages(source: Source): Iterable<BriefMessage> {
	let id = source.getLeafId();
	for (let i = 0; id && i < VISITS; i++) {
		const entry = source.getEntry(id);
		if (!entry) return;
		id = entry.parentId;
		if (entry.type !== "message") continue;
		const message = transcriptMessage(entry.message);
		if (message) yield message;
	}
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the paged cursor, cutoff and byte budget in the same traversal.
async function nativeMessages(
	host: NativeHost,
	id: Durable.ConversationId,
	context: Context,
): Promise<BriefMessage[] | undefined> {
	const conversation = await host.harness?.conversation(id, context);
	if (!conversation) return undefined;
	const messages: BriefMessage[] = [];
	let cursor: Durable.Cursor | undefined, cutoff: Durable.EntryId | undefined;
	let visited = 0,
		bytes = 0;
	do {
		context.abortSignal?.throwIfAborted();
		const page = await conversation.entries(
			{ order: "descending", ...(cutoff === undefined ? {} : { maxEntryId: cutoff }) },
			Math.min(50, VISITS - visited),
			cursor,
			context,
		);
		cutoff ??= page.items[0]?.id;
		visited += page.items.length;
		for (const entry of page.items) {
			const { UserEntry, AssistantEntry } = host.durable;
			if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) continue;
			for (const value of [...(entry.model ?? [])].reverse()) {
				if (value.role !== "user" && bytes > BRIEF_SCAN_BYTES) continue;
				const message = transcriptMessage(value);
				if (!message) continue;
				if (message.role === "user") {
					const request = message.text.trim();
					// A prefix of an oversized request must not pass as a complete request.
					messages.push({ ...message, text: request.length > MAX_REQUEST_CHARS * 2 ? "" : request });
				} else {
					const bytesLeft = BRIEF_SCAN_BYTES - bytes;
					const text = message.text.slice(-Math.max(1, bytesLeft + 1));
					messages.push({ ...message, text });
					bytes += Buffer.byteLength(text);
				}
			}
		}
		cursor = page.next;
		if (!page.items.length) break;
	} while (cursor && visited < VISITS);
	return messages;
}

export function makeBrief(
	options: WritingOptions,
	messages?: () => Iterable<BriefMessage> | undefined | Promise<Iterable<BriefMessage> | undefined>,
) {
	return async (title?: string, lexicon?: ReadonlySet<string>, forRefusal = false): Promise<WritingBrief> => {
		const reader = await loadReader(options).catch((error: unknown) => {
			if (!(forRefusal && error instanceof WritingConfigError)) throw error;
			return undefined;
		});
		const terms = lexicon ?? (forRefusal ? undefined : await loadLexicon(options));
		return buildBrief({
			title,
			reader,
			messages: await messages?.(),
			lexicon: terms,
			checks: describeRules(options.mode, options.overrides),
		});
	};
}
export type BriefBuilder = ReturnType<typeof makeBrief>;

export function createBriefTool(options: WritingOptions): ToolDefinition<typeof Parameters, WritingBrief> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_brief");
	return {
		...presentation,
		name: "markdown_brief",
		label: "Markdown Brief",
		description,
		parameters: Parameters,
		outputSchema: WritingBriefSchema,
		async execute(_id, { title }, _signal, _update, ctx) {
			const brief = await makeBrief(options, () => ordinaryBriefMessages(ctx.sessionManager))(title);
			return { content: [{ type: "text", text: formatBrief(brief) }], details: brief, structuredContent: brief };
		},
	};
}
export function nativeBrief(host: NativeHost, options: WritingOptions, id: Durable.ConversationId, context: Context) {
	return makeBrief(options, () => nativeMessages(host, id, context));
}
export function createNativeBriefTool(host: NativeHost, options: WritingOptions) {
	return host.durable.defineTool({
		name: "markdown_brief",
		description,
		parameters: Parameters,
		structuredOutputSchema: WritingBriefSchema,
		replay: "safe",
		async execute({ title }, api, context) {
			const brief = await nativeBrief(host, options, api.conversationId, context)(title);
			return { output: [{ type: "text", text: formatBrief(brief) }], structuredOutput: brief, details: brief };
		},
	});
}
