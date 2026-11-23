import {
	type CardCall,
	type CardResult,
	count,
	type Data,
	field,
	list,
	object,
	pick,
	type Presenter,
	type ResultContext,
	text,
} from "./display-data.ts";

type ResourceKey = "documentId" | "presentationId";

function nonnegativeInteger(value: unknown): number | undefined {
	const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function identifier(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readCall(args: Data, resourceKey: ResourceKey): CardCall {
	const tab = field(args.tabId);
	const limit = nonnegativeInteger(args.limit);
	const offset = nonnegativeInteger(args.offset);
	const facts = [
		...(resourceKey === "documentId" ? [tab ? `tab ${tab}` : "first tab"] : []),
		...(offset === undefined ? [] : [`offset ${offset}`]),
		...(limit === undefined ? [] : [`limit ${limit}`]),
	];
	const source = field(args.sourceId);
	return {
		subject: field(args[resourceKey]),
		...(facts.length ? { facts } : {}),
		...(source ? { args: { sourceId: source } } : {}),
	};
}

function docTabs(external: Data): string[] {
	const lines = list(external.tabs).flatMap((value) => {
		const tab = object(value);
		const id = field(tab.tabId);
		const title = field(tab.title);
		const parent = field(tab.parentTabId);
		return id ? [`Tab ${id}${title ? `: ${title}` : ""}${parent ? ` (parent ${parent})` : ""}`] : [];
	});
	if (external.tabsTruncated === true) lines.push("Google returned only part of the tab list.");
	return lines;
}

function slideIndex(external: Data): string[] {
	const lines = list(external.slides).flatMap((value) => {
		const slide = object(value);
		const id = field(slide.objectId);
		const number = nonnegativeInteger(slide.slideNumber);
		const offset = nonnegativeInteger(slide.offset);
		const notes = nonnegativeInteger(slide.notesOffset);
		if (!id || number === undefined) return [];
		return [
			`Slide ${number} (${id})${offset === undefined ? "" : `: offset ${offset}`}${notes === undefined ? "" : `; speaker notes at offset ${notes}`}`,
		];
	});
	if (external.slidesTruncated === true) lines.push("Google returned only part of the slide index.");
	return lines;
}

function readPage(resourceKey: ResourceKey, args: Data, data: Data, content: Data) {
	const isDoc = resourceKey === "documentId";
	const target = isDoc ? "tab" : "presentation";
	const resourceId = identifier(args[resourceKey]) ?? identifier(data[resourceKey]);
	const tabId = identifier(data.tabId) ?? identifier(args.tabId);
	const offset = nonnegativeInteger(args.offset) ?? 0;
	const nextOffset = nonnegativeInteger(content.nextOffset);
	const sourceId = identifier(content.sourceId);
	const next =
		resourceId && (!isDoc || tabId) && sourceId && nextOffset !== undefined && nextOffset > offset
			? {
					args: {
						[resourceKey]: resourceId,
						...(isDoc ? { tabId } : {}),
						...pick(args, "limit"),
						offset: nextOffset,
						sourceId,
					},
				}
			: undefined;

	return { isDoc, target, tabId, offset, nextOffset, sourceId, next };
}

function pageOutcome(
	target: string,
	offset: number,
	next: boolean,
	nextOffset: number | undefined,
	truncated: boolean,
	body: string,
): string {
	let outcome: string;
	if (next) outcome = `Read the ${target} from offset ${offset}; more text is available.`;
	else if (truncated || nextOffset !== undefined)
		outcome = `Read part of the ${target}; no usable continuation was returned.`;
	else if (offset > 0 && !body) outcome = `No ${target} text remains from offset ${offset}.`;
	else if (offset > 0) outcome = `Read the rest of the ${target} from offset ${offset}.`;
	else if (!body) outcome = `The ${target} has no rendered text.`;
	else outcome = `Read the full ${target} text.`;

	return outcome;
}

function readDetails(
	page: ReturnType<typeof readPage>,
	{ data, args }: ResultContext,
	external: Data,
	content: Data,
): string[] {
	const { isDoc, tabId, sourceId } = page;
	const total = nonnegativeInteger(content.totalCodePoints);
	const title = field(external.title);
	const tab = field(tabId);
	const revision = field(data.revisionId);
	const source = field(sourceId);
	const slides = nonnegativeInteger(data.slideCount);
	const details: string[] = [];
	if (title) details.push(`Title: ${title}`);
	if (isDoc && tab && tabId !== args.tabId) details.push(`Selected tab: ${tab}`);
	if (revision) details.push(`Revision: ${revision}`);
	if (!isDoc && slides !== undefined) details.push(`Slides: ${slides}`);
	if (total !== undefined) details.push(`Source length: ${count(total, "code point")}`);
	if (source) details.push(`Source ID: ${source}`);
	details.push(...(isDoc ? docTabs(external) : slideIndex(external)));
	return details;
}

function readResult(context: ResultContext, resourceKey: ResourceKey): CardResult | undefined {
	const { args, data, status, isError } = context;
	if (isError || status === "error") return undefined;
	const external = object(data.externalData);
	const content = object(external.content);
	if (typeof content.text !== "string") return undefined;

	const page = readPage(resourceKey, args, data, content);
	const outcome = pageOutcome(
		page.target,
		page.offset,
		Boolean(page.next),
		page.nextOffset,
		content.truncated === true,
		content.text,
	);
	const details = readDetails(page, context, external, content);
	const body = text(content.text);
	return {
		outcome,
		...(body ? { body: body.split("\n") } : {}),
		...(details.length ? { details } : {}),
		...(page.next ? { next: page.next } : {}),
	};
}

function writeCall(args: Data, replace: boolean): CardCall {
	const tab = field(args.tabId);
	const revision = field(args.expectedRevisionId);
	const summary: Data = revision ? { expectedRevisionId: revision } : {};
	for (const key of replace ? ["find", "replacement"] : ["text"]) {
		const value = args[key];
		if (typeof value === "string") summary[key] = count([...value].length, "character");
	}
	const facts = [tab ? `tab ${tab}` : replace ? "all tabs" : "first tab"];
	if (replace) facts.push(args.matchCase === false ? "case-insensitive" : "case-sensitive");
	return { subject: field(args.documentId), facts, ...(Object.keys(summary).length ? { args: summary } : {}) };
}

function writeResult(context: ResultContext, replace: boolean): CardResult | undefined {
	const { data, status, isError } = context;
	if (isError || status === "error") return undefined;
	const changed = nonnegativeInteger(data.occurrencesChanged);
	if (status !== "ok" || !field(data.documentId) || (replace && changed === undefined)) {
		return { outcome: `The result does not confirm the ${replace ? "replacement" : "append"}.` };
	}
	const revision = field(data.revisionId);
	const outcome =
		replace && changed !== undefined
			? changed === 0
				? "Replaced no occurrences."
				: `Replaced ${count(changed, "occurrence")}.`
			: "Appended text to the tab.";
	return { outcome, ...(revision ? { body: [`Revision: ${revision}`] } : {}) };
}

export const documentsPresenters: Record<string, Presenter> = {
	docs_get: {
		call: (args) => readCall(args, "documentId"),
		result: (context) => readResult(context, "documentId"),
	},
	docs_append: {
		call: (args) => writeCall(args, false),
		result: (context) => writeResult(context, false),
	},
	docs_replace_text: {
		call: (args) => writeCall(args, true),
		result: (context) => writeResult(context, true),
	},
	slides_get: {
		call: (args) => readCall(args, "presentationId"),
		result: (context) => readResult(context, "presentationId"),
	},
};
