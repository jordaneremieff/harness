import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { GRANTS, STDOUT_LIMITS } from "./gws.ts";
import { checkContinuation, external, ok, renderingId, requireSourceId, SOURCE_ID_PATTERN, TextBudget } from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const PresentationId = str({ minLength: 1, maxLength: 512 });
const SourceId = str({
	minLength: 16,
	maxLength: 16,
	pattern: SOURCE_ID_PATTERN,
	description: "The sourceId of the page that returned offset. Required when offset is above 0.",
});
const SLIDE_LIST_MAX = 200;
const GROUP_DEPTH_MAX = 8;
const PAGE_MAX_BYTES = 24 * 1024;
const RESULT_TEXT_BYTES = 44 * 1024;

type Json = Record<string, unknown>;
/** Offsets are code points into the rendered deck, the unit of `offset` and `nextOffset`. */
type SlideEntry = { objectId: string; slideNumber: number; offset: number; notesOffset?: number };

function object(value: unknown): value is Json {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function records(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(object) : [];
}
function linked(content: string, url: string): string {
	const label = content.trimEnd();
	return `[${label}](${url})${content.slice(label.length)}`;
}

function runText(element: Json): string {
	const run = object(element.textRun) ? element.textRun : object(element.autoText) ? element.autoText : undefined;
	if (!run) return "";
	const piece = text(run.content).replaceAll("\u000b", "\n");
	const style = object(run.style) ? run.style : {};
	const url = object(style.link) ? text(style.link.url) : "";
	return url && piece.trim() ? linked(piece, url) : piece;
}
function bulletPrefix(marker: Json): string {
	if (!object(marker.bullet)) return "";
	const level = typeof marker.bullet.nestingLevel === "number" ? marker.bullet.nestingLevel : 0;
	return `${"  ".repeat(level)}- `;
}

/** The paragraphs of one text body; a paragraph marker starts each paragraph and carries its bullet. */
function textBlock(content: unknown): string {
	const paragraphs: { prefix: string; body: string }[] = [];
	for (const element of records(object(content) ? content.textElements : undefined)) {
		if (object(element.paragraphMarker) || !paragraphs.length)
			paragraphs.push({
				prefix: object(element.paragraphMarker) ? bulletPrefix(element.paragraphMarker) : "",
				body: "",
			});
		paragraphs[paragraphs.length - 1].body += runText(element);
	}
	return paragraphs
		.map((paragraph) => ({ prefix: paragraph.prefix, body: paragraph.body.replace(/\n$/, "") }))
		.filter((paragraph) => paragraph.body.trim())
		.map((paragraph) => paragraph.prefix + paragraph.body)
		.join("\n");
}

function tableBlock(table: Json): string {
	const rows = records(table.tableRows).map((row) =>
		records(row.tableCells).map((cell) => textBlock(cell.text).replaceAll("|", "\\|").replaceAll(/\n+/g, "<br>")),
	);
	if (!rows.length) return "";
	const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
	const line = (cells: string[]) =>
		`| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
	return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}

/** A picture, video or chart has no text; its alternative text stands in when the author gave one. */
function mediaBlock(kind: string, element: Json): string {
	const alt = (text(element.title) || text(element.description)).replaceAll(/\s+/g, " ").trim();
	return alt ? `[${kind}: ${alt}]` : `[${kind}]`;
}

function shapeBlock(shape: Json): string {
	const body = textBlock(shape.text);
	const placeholder = object(shape.placeholder) ? text(shape.placeholder.type) : "";
	const title = placeholder === "TITLE" || placeholder === "CENTERED_TITLE";
	return title && body ? `### ${body.replaceAll("\n", " ")}` : body;
}

function elementBlock(element: Json): string {
	if (object(element.shape)) return shapeBlock(element.shape);
	if (object(element.table)) return tableBlock(element.table);
	if (object(element.wordArt)) return text(element.wordArt.renderedText);
	if (object(element.image)) return mediaBlock("image", element);
	if (object(element.video)) return mediaBlock("video", element);
	return object(element.sheetsChart) ? mediaBlock("chart", element) : "";
}

function elementBlocks(elements: unknown, depth = 0): string[] {
	const blocks: string[] = [];
	for (const element of records(elements)) {
		if (!object(element.elementGroup)) blocks.push(elementBlock(element));
		else if (depth < GROUP_DEPTH_MAX) blocks.push(...elementBlocks(element.elementGroup.children, depth + 1));
	}
	return blocks.filter(Boolean);
}

function speakerNotes(notesPage: unknown): string {
	if (!object(notesPage)) return "";
	const notesId = object(notesPage.notesProperties) ? text(notesPage.notesProperties.speakerNotesObjectId) : "";
	const holder = records(notesPage.pageElements).find((element) => notesId && element.objectId === notesId);
	return holder && object(holder.shape) ? textBlock(holder.shape.text) : "";
}

/** The deck as markdown: one section per slide in order, each with its text and then its speaker notes. */
function renderDeck(slides: Json[]): { text: string; index: SlideEntry[] } {
	let out = "";
	let length = 0;
	const append = (piece: string) => {
		out += piece;
		length += [...piece].length;
	};
	const index = slides.map((slide, position) => {
		if (position > 0) append("\n\n");
		const properties = object(slide.slideProperties) ? slide.slideProperties : {};
		const entry: SlideEntry = { objectId: text(slide.objectId), slideNumber: position + 1, offset: length };
		const header = `## Slide ${entry.slideNumber} (${entry.objectId})${properties.isSkipped === true ? " [skipped]" : ""}`;
		append([header, ...elementBlocks(slide.pageElements)].join("\n\n"));
		const notes = speakerNotes(properties.notesPage);
		if (notes) {
			append("\n\n**Speaker notes**\n\n");
			entry.notesOffset = length;
			append(notes);
		}
		return entry;
	});
	return { text: out, index };
}

export const slidesTools: ToolSpec[] = [
	{
		name: "slides_get",
		label: "Slides read",
		description:
			"Read a Google Slides presentation as a bounded markdown slice of slide text and speaker notes. The first page lists each slide's objectId and text offset. To read on, pass an offset with the sourceId of the page it came from; a changed presentation refuses with DOCUMENT_CHANGED.",
		parameters: obj({
			presentationId: PresentationId,
			offset: opt(int({ minimum: 0, default: 0 })),
			sourceId: opt(SourceId),
			limit: opt(int({ minimum: 1, maximum: 24000, default: 12000 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.slidesRead }, signal, async (operation) => {
				const args = value as { presentationId: string; offset?: number; sourceId?: string; limit?: number };
				requireSourceId(args.offset ?? 0, args.sourceId);
				const response = await operation.call<Json>("slides", ["presentations", "get"], {
					params: { presentationId: args.presentationId, fields: "presentationId,title,revisionId,slides" },
					stdoutLimit: STDOUT_LIMITS.document,
				});
				const deck = renderDeck(records(response.slides));
				const offset = args.offset ?? 0;
				const sourceId = renderingId(deck.text);
				checkContinuation(offset, args.sourceId, sourceId, "presentation");
				const listed = offset === 0 ? deck.index.slice(0, SLIDE_LIST_MAX) : undefined;
				const reserved = listed ? Buffer.byteLength(JSON.stringify(listed)) : 0;
				const budget = new TextBudget(RESULT_TEXT_BYTES - reserved);
				const title = budget.clip(response.title, 2048);
				const page = budget.page(deck.text, offset, args.limit ?? 12000, PAGE_MAX_BYTES);
				return ok({
					presentationId: text(response.presentationId) || args.presentationId,
					...(text(response.revisionId) ? { revisionId: text(response.revisionId) } : {}),
					slideCount: deck.index.length,
					externalData: external("slides", {
						title: title.text,
						...(listed ? { slides: listed, slidesTruncated: deck.index.length > SLIDE_LIST_MAX } : {}),
						content: {
							format: "markdown",
							text: page.text,
							truncated: page.nextOffset !== undefined,
							...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
							totalCodePoints: page.total,
							sourceId,
						},
					}),
				});
			}),
	},
];
