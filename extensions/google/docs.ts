import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { GRANTS, type Operation, STDOUT_LIMITS } from "./gws.ts";
import {
	checkContinuation,
	external,
	GoogleError,
	ok,
	renderingId,
	requireSourceId,
	SOURCE_ID_PATTERN,
	TextBudget,
} from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const DocumentId = str({ minLength: 1, maxLength: 512 });
const TabId = str({ minLength: 1, maxLength: 512 });
const RevisionId = str({ minLength: 1, maxLength: 1024 });
const SourceId = str({
	minLength: 16,
	maxLength: 16,
	pattern: SOURCE_ID_PATTERN,
	description: "The sourceId of the page that returned offset. Required when offset is above 0.",
});
const TAB_LIST_MAX = 100;
const TAB_DEPTH_MAX = 8;
const TABLE_DEPTH_MAX = 4;
const PAGE_MAX_BYTES = 24 * 1024;

type Json = Record<string, unknown>;
type Tab = { tabId: string; title: string; nestingLevel: number; parentTabId?: string; documentTab: Json };
/** Footnote numbers by footnote ID, in the order the body refers to them. */
type Render = { lists: Json; footnotes: Map<string, string> };

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

function textRunText(run: Json): string {
	const content = text(run.content).replaceAll("\u000b", "\n");
	const style = object(run.textStyle) ? run.textStyle : {};
	const url = object(style.link) ? text(style.link.url) : "";
	return url && content.trim() ? linked(content, url) : content;
}
function personText(person: Json): string {
	const properties = object(person.personProperties) ? person.personProperties : {};
	return text(properties.name) || text(properties.email);
}
function richLinkText(richLink: Json): string {
	const properties = object(richLink.richLinkProperties) ? richLink.richLinkProperties : {};
	const uri = text(properties.uri);
	return uri ? linked(text(properties.title) || uri, uri) : text(properties.title);
}
/** The text that Google returns for a smart chip, such as the display text of a date. */
function chipText(chip: Json, group: string, name: string): string {
	const properties = chip[group];
	return object(properties) ? text(properties[name]) : "";
}
function footnoteMark(reference: Json, render: Render): string {
	const number = text(reference.footnoteNumber);
	render.footnotes.set(text(reference.footnoteId), number);
	return `[^${number}]`;
}

/** The text of each kind of paragraph element; a kind that is absent here contributes nothing. */
const INLINE: Record<string, (value: Json, render: Render) => string> = {
	textRun: textRunText,
	person: personText,
	richLink: richLinkText,
	footnoteReference: footnoteMark,
	dateElement: (chip) => chipText(chip, "dateElementProperties", "displayText"),
	dropdown: (chip) => chipText(chip, "dropdownProperties", "displayValue"),
	inlineObjectElement: () => "[image]",
	equation: () => "[equation]",
	horizontalRule: () => "---",
};

function inlineText(elements: unknown, render: Render): string {
	let out = "";
	for (const element of records(elements))
		for (const [kind, renderKind] of Object.entries(INLINE)) {
			const value = element[kind];
			if (object(value)) out += renderKind(value, render);
		}
	return out;
}

function orderedList(render: Render, bullet: Json, level: number): boolean {
	const list = render.lists[text(bullet.listId)];
	const properties = object(list) && object(list.listProperties) ? list.listProperties : {};
	const nesting = Array.isArray(properties.nestingLevels) ? properties.nestingLevels[level] : undefined;
	const glyph = object(nesting) ? text(nesting.glyphType) : "";
	return glyph !== "" && glyph !== "NONE" && glyph !== "GLYPH_TYPE_UNSPECIFIED";
}

function paragraphBlock(paragraph: Json, render: Render): string {
	const body = inlineText(paragraph.elements, render).replace(/\n$/, "");
	if (!body.trim()) return "";
	if (object(paragraph.bullet)) {
		const level = typeof paragraph.bullet.nestingLevel === "number" ? paragraph.bullet.nestingLevel : 0;
		return `${"  ".repeat(level)}${orderedList(render, paragraph.bullet, level) ? "1." : "-"} ${body}`;
	}
	const style = object(paragraph.paragraphStyle) ? text(paragraph.paragraphStyle.namedStyleType) : "";
	const heading = /^HEADING_([1-6])$/.exec(style);
	if (style === "TITLE") return `# ${body}`;
	return heading ? `${"#".repeat(Number(heading[1]))} ${body}` : body;
}

function tableBlock(table: Json, render: Render, depth: number): string {
	const rows = records(table.tableRows).map((row) =>
		records(row.tableCells).map((cell) =>
			depth >= TABLE_DEPTH_MAX
				? ""
				: joinBlocks(contentBlocks(cell.content, render, depth + 1))
						.replaceAll("|", "\\|")
						.replaceAll(/\n+/g, "<br>"),
		),
	);
	if (!rows.length) return "";
	const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
	const line = (cells: string[]) =>
		`| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
	return [line(rows[0]), line(Array.from({ length: width }, () => "---")), ...rows.slice(1).map(line)].join("\n");
}

function contentBlocks(content: unknown, render: Render, depth = 0): string[] {
	const blocks: string[] = [];
	for (const element of records(content)) {
		if (object(element.paragraph)) blocks.push(paragraphBlock(element.paragraph, render));
		else if (object(element.table)) blocks.push(tableBlock(element.table, render, depth));
		else if (object(element.tableOfContents))
			blocks.push(...contentBlocks(element.tableOfContents.content, render, depth));
	}
	return blocks;
}

/** Blank lines separate blocks; consecutive list items stay on adjacent lines. */
function joinBlocks(blocks: string[]): string {
	let out = "";
	let previousList = false;
	for (const block of blocks) {
		if (!block) continue;
		const list = /^\s*(?:-|1\.) /.test(block);
		if (out) out += list && previousList ? "\n" : "\n\n";
		out += block;
		previousList = list;
	}
	return out;
}

/** One tab as markdown: headings, lists, tables and links, then the footnotes the body refers to. */
function renderTab(documentTab: Json): string {
	const render: Render = { lists: object(documentTab.lists) ? documentTab.lists : {}, footnotes: new Map() };
	const body = object(documentTab.body) ? documentTab.body : {};
	const blocks = contentBlocks(body.content, render);
	const footnotes = object(documentTab.footnotes) ? documentTab.footnotes : {};
	for (const [footnoteId, number] of [...render.footnotes]) {
		const footnote = footnotes[footnoteId];
		const note = object(footnote) ? joinBlocks(contentBlocks(footnote.content, render)).replaceAll(/\n+/g, " ") : "";
		if (note) blocks.push(`[^${number}]: ${note}`);
	}
	return joinBlocks(blocks);
}

function flattenTabs(tabs: unknown, depth = 0, out: Tab[] = []): Tab[] {
	for (const tab of records(tabs)) {
		const properties = object(tab.tabProperties) ? tab.tabProperties : {};
		out.push({
			tabId: text(properties.tabId),
			title: text(properties.title),
			nestingLevel: depth,
			...(text(properties.parentTabId) ? { parentTabId: text(properties.parentTabId) } : {}),
			documentTab: object(tab.documentTab) ? tab.documentTab : {},
		});
		if (depth < TAB_DEPTH_MAX) flattenTabs(tab.childTabs, depth + 1, out);
	}
	return out;
}

/** A refused write is reported as a changed document when the latest revision differs from the expected one. */
async function refusal(
	operation: Operation,
	args: { documentId: string; expectedRevisionId: string },
	error: unknown,
): Promise<unknown> {
	if (!(error instanceof GoogleError) || error.code !== "API_ERROR") return error;
	const latest = await operation
		.call<Json>("docs", ["documents", "get"], { params: { documentId: args.documentId, fields: "revisionId" } })
		.then((document) => text(document.revisionId))
		.catch(() => "");
	if (!latest || latest === args.expectedRevisionId) return error;
	return new GoogleError(
		"DOCUMENT_CHANGED",
		"The document revision differs from expectedRevisionId. Read the document again before another write.",
	);
}

/**
 * Google applies the request only when `expectedRevisionId` is still the latest revision, so a
 * repeated call cannot apply the same change twice.
 */
async function batchUpdate(
	operation: Operation,
	args: { documentId: string; expectedRevisionId: string },
	request: Json,
): Promise<{ replies: Json[]; result: { documentId: string; revisionId?: string } }> {
	const response = await operation
		.call<Json>("docs", ["documents", "batchUpdate"], {
			params: { documentId: args.documentId },
			body: { requests: [request], writeControl: { requiredRevisionId: args.expectedRevisionId } },
		})
		.catch(async (error: unknown) => {
			throw await refusal(operation, args, error);
		});
	const control = object(response.writeControl) ? response.writeControl : {};
	return {
		replies: records(response.replies),
		result: {
			documentId: text(response.documentId) || args.documentId,
			...(text(control.requiredRevisionId) ? { revisionId: text(control.requiredRevisionId) } : {}),
		},
	};
}

export const docsTools: ToolSpec[] = [
	{
		name: "docs_get",
		label: "Docs read",
		description:
			"Read one Google Docs tab as a bounded markdown slice, with the tab list and, for an editable document, its revisionId. Pending suggestions are left out. To read on, pass nextOffset as offset with the page's sourceId; a changed tab refuses with DOCUMENT_CHANGED.",
		parameters: obj({
			documentId: DocumentId,
			tabId: opt(TabId),
			offset: opt(int({ minimum: 0, default: 0 })),
			sourceId: opt(SourceId),
			limit: opt(int({ minimum: 1, maximum: 24000, default: 12000 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.docsRead }, signal, async (operation) => {
				const args = value as { documentId: string; tabId?: string; offset?: number; sourceId?: string; limit?: number };
				const offset = args.offset ?? 0;
				requireSourceId(offset, args.sourceId);
				const response = await operation.call<Json>("docs", ["documents", "get"], {
					params: {
						documentId: args.documentId,
						includeTabsContent: true,
						suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS",
						fields: "documentId,title,revisionId,tabs",
					},
					stdoutLimit: STDOUT_LIMITS.document,
				});
				const tabs = flattenTabs(response.tabs);
				const tab = args.tabId ? tabs.find((item) => item.tabId === args.tabId) : tabs[0];
				if (!tab && args.tabId)
					throw new GoogleError("INVALID_ARGUMENT", `Tab ${args.tabId} is absent from the document.`);
				if (!tab) throw new GoogleError("BACKEND_SCHEMA_ERROR", "The Docs response has no tabs.");
				const budget = new TextBudget(40 * 1024);
				const title = budget.clip(response.title, 2048);
				const listed = tabs.slice(0, TAB_LIST_MAX).map((item) => ({
					tabId: item.tabId,
					nestingLevel: item.nestingLevel,
					...(item.parentTabId ? { parentTabId: item.parentTabId } : {}),
					title: budget.clip(item.title, 512).text,
				}));
				const rendering = renderTab(tab.documentTab);
				// The ID also names the tab, so a continuation that resolves another tab is refused.
				const sourceId = renderingId(`${tab.tabId}\u0000${rendering}`);
				checkContinuation(offset, args.sourceId, sourceId, "selected tab or its rendering");
				const page = budget.page(rendering, offset, args.limit ?? 12000, PAGE_MAX_BYTES);
				return ok({
					documentId: text(response.documentId) || args.documentId,
					...(text(response.revisionId) ? { revisionId: text(response.revisionId) } : {}),
					tabId: tab.tabId,
					externalData: external("docs", {
						title: title.text,
						tabs: listed,
						tabsTruncated: tabs.length > TAB_LIST_MAX,
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
	{
		name: "docs_append",
		label: "Docs append",
		description:
			"Insert plain text at the end of a Google Docs tab body at an expected document revision. Start the text with a newline to begin a new paragraph.",
		parameters: obj({
			documentId: DocumentId,
			expectedRevisionId: RevisionId,
			text: str({ minLength: 1, maxLength: 65536 }),
			tabId: opt(TabId),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.docsWrite }, signal, async (operation) => {
				const args = value as { documentId: string; expectedRevisionId: string; text: string; tabId?: string };
				const { result } = await batchUpdate(operation, args, {
					insertText: {
						text: args.text,
						endOfSegmentLocation: { segmentId: "", ...(args.tabId ? { tabId: args.tabId } : {}) },
					},
				});
				return ok(result);
			}),
	},
	{
		name: "docs_replace_text",
		label: "Docs replace text",
		description: "Replace every occurrence of a text in a Google Doc, or in one tab, at an expected document revision.",
		parameters: obj({
			documentId: DocumentId,
			expectedRevisionId: RevisionId,
			find: str({ minLength: 1, maxLength: 4096 }),
			replacement: str({ maxLength: 65536 }),
			matchCase: opt(bool({ default: true })),
			tabId: opt(TabId),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: GRANTS.docsWrite }, signal, async (operation) => {
				const args = value as {
					documentId: string;
					expectedRevisionId: string;
					find: string;
					replacement: string;
					matchCase?: boolean;
					tabId?: string;
				};
				const { replies, result } = await batchUpdate(operation, args, {
					replaceAllText: {
						containsText: { text: args.find, matchCase: args.matchCase ?? true },
						replaceText: args.replacement,
						...(args.tabId ? { tabsCriteria: { tabIds: [args.tabId] } } : {}),
					},
				});
				const reply = replies[0] && object(replies[0].replaceAllText) ? replies[0].replaceAllText : {};
				return ok({
					...result,
					occurrencesChanged: typeof reply.occurrencesChanged === "number" ? reply.occurrencesChanged : 0,
				});
			}),
	},
];
