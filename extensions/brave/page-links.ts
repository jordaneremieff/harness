import { createHash } from "node:crypto";
import { PAGE_NETWORK_LIMITS, parsePublicPageUrl } from "./page-network.ts";
import { cleanPageText, type PageExcerptOptions, type PageText, validateExcerptOptions } from "./page-text.ts";

export const PAGE_LINK_LIMITS = Object.freeze({ records: 2048, bytes: 256 * 1024, labelCharacters: 512, perPage: 160 });

type Region = Exclude<PageText["method"], "plain-text">;
type LabelSource = "text" | "aria-label" | "title" | "none";

export interface PageLink {
	label: string;
	labelSource: LabelSource;
	labelTruncated: boolean;
	url: string;
}

interface RawLink extends Omit<PageLink, "url"> {
	href: string;
	order: number;
}

interface LinkBucket {
	records: RawLink[];
	bytes: number;
	seen: number;
	skippedUrl: number;
	skippedLimit: number;
}

interface PendingLink {
	href: string;
	order: number;
	regions: Region[];
	text: string;
	textTruncated: boolean;
	fallback: string;
	fallbackSource: LabelSource;
	fallbackTruncated: boolean;
}

export interface PageLinks {
	records: PageLink[];
	baseIdentity: string;
	baseStatus: "document" | "element" | "fallback" | "over-limit";
	method: Region;
	anchorsSeen: number;
	skippedUrl: number;
	skippedLimit: number;
	truncatedLabels: number;
	retainedBytes: number;
	truncated: boolean;
}

function normalizedLabel(value: string): string {
	return cleanPageText(value)
		.replace(/\p{Bidi_Control}/gu, " ")
		.replace(/\s+/gu, " ");
}

function capLabel(value: string): string {
	const cap = value.slice(0, PAGE_LINK_LIMITS.labelCharacters);
	return /[\ud800-\udbff]$/.test(cap) ? cap.slice(0, -1) : cap;
}

function boundedLabel(value: string) {
	const normalized = normalizedLabel(value)
		.replace(/[\ud800-\udfff]/gu, " ")
		.trim();
	return { label: capLabel(normalized), truncated: normalized.length > PAGE_LINK_LIMITS.labelCharacters };
}

interface LinkRegion {
	excluded: boolean;
	main: boolean;
	article: boolean;
}

function startLink(attributes: Record<string, string>, region: LinkRegion, order: number): PendingLink {
	const aria = boundedLabel(attributes["aria-label"] ?? "");
	const title = boundedLabel(attributes.title ?? "");
	const fallback = aria.label ? aria : title;
	return {
		href: attributes.href,
		order,
		regions: ["body", ...(region.main ? ["main" as const] : []), ...(region.article ? ["article" as const] : [])],
		text: "",
		textTruncated: false,
		fallback: fallback.label,
		fallbackSource: aria.label ? "aria-label" : title.label ? "title" : "none",
		fallbackTruncated: fallback.truncated,
	};
}

/** Capture anchors during the existing text traversal, without a second parser or any I/O. */
export class PageLinkCollector {
	private readonly buckets: Record<Region, LinkBucket> = {
		body: { records: [], bytes: 0, seen: 0, skippedUrl: 0, skippedLimit: 0 },
		main: { records: [], bytes: 0, seen: 0, skippedUrl: 0, skippedLimit: 0 },
		article: { records: [], bytes: 0, seen: 0, skippedUrl: 0, skippedLimit: 0 },
	};
	private readonly stack: { inert: boolean; active?: PendingLink; own?: PendingLink }[] = [];
	private order = 0;
	private baseSeen = false;
	private base: string | undefined;
	private baseStatus: PageLinks["baseStatus"] = "document";
	private baseIdentity: string;
	private readonly finalUrl: string;

	constructor(finalUrl: string) {
		this.finalUrl = finalUrl;
		this.base = finalUrl;
		this.baseIdentity = finalUrl;
	}

	open(name: string, attributes: Record<string, string>, region: LinkRegion) {
		const parent = this.stack.at(-1);
		const inert = parent?.inert === true || ["template", "svg", "math"].includes(name);
		if (name === "base" && "href" in attributes && !inert && !this.baseSeen) this.setBase(attributes.href);
		const frame: (typeof this.stack)[number] = { inert, active: parent?.active };
		this.stack.push(frame);
		if (inert || region.excluded) return;
		if (name === "a" && "href" in attributes) frame.own = frame.active = startLink(attributes, region, this.order++);
		if (name === "img" && attributes.alt) this.text(attributes.alt);
	}

	text(value: string) {
		const active = this.stack.at(-1)?.active;
		if (!active || this.stack.at(-1)?.inert) return;
		value = normalizedLabel(value);
		if (!active.text || active.text.endsWith(" ")) value = value.replace(/^ +/, "");
		const combined = active.text + value;
		if (combined.slice(PAGE_LINK_LIMITS.labelCharacters).trim()) active.textTruncated = true;
		active.text = combined.slice(0, PAGE_LINK_LIMITS.labelCharacters + 1);
	}

	close() {
		const anchor = this.stack.pop()?.own;
		if (!anchor) return;
		const label = boundedLabel(anchor.text).label;
		const record: RawLink = {
			href: anchor.href,
			order: anchor.order,
			label: label || anchor.fallback,
			labelSource: label ? "text" : anchor.fallbackSource,
			labelTruncated: label ? anchor.textTruncated : anchor.fallbackTruncated,
		};
		const bytes = Buffer.byteLength(JSON.stringify(record));
		for (const region of anchor.regions) {
			const bucket = this.buckets[region];
			bucket.seen++;
			if (record.href.length > PAGE_NETWORK_LIMITS.urlCharacters) bucket.skippedUrl++;
			else if (
				bucket.skippedLimit ||
				bucket.records.length >= PAGE_LINK_LIMITS.records ||
				bucket.bytes + bytes > PAGE_LINK_LIMITS.bytes
			)
				bucket.skippedLimit++;
			else {
				bucket.records.push(record);
				bucket.bytes += bytes;
			}
		}
	}

	private setBase(href: string) {
		this.baseSeen = true;
		if (href.length > PAGE_NETWORK_LIMITS.urlCharacters) {
			this.base = undefined;
			this.baseIdentity = createHash("sha256").update(href).digest("hex");
			this.baseStatus = "over-limit";
			return;
		}
		try {
			const base = new URL(href, this.finalUrl);
			if (base.protocol === "data:" || base.protocol === "javascript:") throw new Error();
			this.base = base.href;
			this.baseStatus = "element";
		} catch {
			this.base = this.finalUrl;
			this.baseStatus = "fallback";
		}
		this.baseIdentity = this.base;
	}

	finish(method: Region): PageLinks {
		const bucket = this.buckets[method];
		const records: PageLink[] = [];
		let skippedUrl = bucket.skippedUrl;
		let skippedLimit = bucket.skippedLimit;
		let retainedBytes = 0;
		let capped = false;
		for (const raw of bucket.records.sort((a, b) => a.order - b.order)) {
			const url = resolveLink(raw.href, this.base);
			if (url === undefined) {
				skippedUrl++;
				continue;
			}
			const record: PageLink = {
				label: raw.label,
				labelSource: raw.labelSource,
				labelTruncated: raw.labelTruncated,
				url,
			};
			const bytes = Buffer.byteLength(JSON.stringify(record));
			if (capped || retainedBytes + bytes > PAGE_LINK_LIMITS.bytes) {
				capped = true;
				skippedLimit++;
				continue;
			}
			records.push(record);
			retainedBytes += bytes;
		}
		const truncatedLabels = records.filter((record) => record.labelTruncated).length;
		return {
			records,
			baseIdentity: this.baseIdentity,
			baseStatus: this.baseStatus,
			method,
			anchorsSeen: bucket.seen,
			skippedUrl,
			skippedLimit,
			truncatedLabels,
			retainedBytes,
			truncated: skippedLimit > 0 || truncatedLabels > 0 || this.baseStatus === "over-limit",
		};
	}
}

function resolveLink(href: string, base: string | undefined): string | undefined {
	const value = href.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	if (/[\u0000-\u001f\u007f-\u009f\\\ud800-\udfff]|\p{Bidi_Control}/u.test(value)) return undefined;
	try {
		const url = new URL(value, base);
		parsePublicPageUrl(url.href);
		return url.href;
	} catch {
		return undefined;
	}
}

export interface PageLinkOptions extends Pick<PageExcerptOptions, "find" | "max_bytes" | "expected_source_id"> {
	link_offset?: number;
}

export function validateLinkOptions(options: PageLinkOptions): void {
	validateExcerptOptions({
		find: options.find,
		max_bytes: options.max_bytes,
		expected_source_id: options.expected_source_id,
	});
	const offset = options.link_offset ?? 0;
	if (!Number.isInteger(offset) || offset < 0 || offset > PAGE_LINK_LIMITS.records || options.link_offset === null) {
		throw new Error(`Web reader link_offset must be an integer from 0 through ${PAGE_LINK_LIMITS.records}.`);
	}
	if (offset > 0 && options.expected_source_id === undefined) {
		throw new Error(
			"Web reader links continuation requires expected_source_id from the previous links response. Start at link_offset 0 if no source ID is available.",
		);
	}
}

export function formatPageLink(record: PageLink, reference: string): string {
	return `[${reference}] ${JSON.stringify(record)}\n`;
}

function validateLinkSource(page: PageLinks, finalUrl: string, options: PageLinkOptions) {
	validateLinkOptions(options);
	const sourceId = createHash("sha256")
		.update(JSON.stringify({ view: "links", finalUrl, limits: PAGE_LINK_LIMITS, ...page }))
		.digest("hex")
		.slice(0, 16);
	if (options.expected_source_id !== undefined && options.expected_source_id !== sourceId) {
		throw new Error(
			"Web reader link source changed: the final URL, base, extraction coverage, or retained links differ from expected_source_id. No links returned. Start a new links read without continuation fields; do not combine snapshots or text/link source IDs.",
		);
	}
	const linkOffset = options.link_offset ?? 0;
	if (linkOffset > page.records.length)
		throw new Error(
			`Web reader link_offset exceeds the retained link count (${page.records.length}). Use a returned nextOffset, or restart at link_offset 0.`,
		);
	return { sourceId, linkOffset };
}

export function makeLinkPage(page: PageLinks, finalUrl: string, options: PageLinkOptions = {}) {
	const { sourceId, linkOffset } = validateLinkSource(page, finalUrl, options);
	const records: { reference: string; text: string }[] = [];
	let used = 0;
	let nextOffset: number | null = null;
	let requiredMaxBytes: number | null = null;
	let firstMatchOffset: number | null = null;
	for (let index = linkOffset; index < page.records.length; index++) {
		const record = page.records[index];
		if (options.find !== undefined && !record.label.includes(options.find)) continue;
		const reference = `${sourceId}:L${index + 1}`;
		const text = formatPageLink(record, reference);
		const bytes = Buffer.byteLength(text);
		if (used + bytes > (options.max_bytes ?? 16_000) || records.length >= PAGE_LINK_LIMITS.perPage) {
			nextOffset = index;
			if (records.length === 0) requiredMaxBytes = bytes;
			break;
		}
		firstMatchOffset ??= index;
		records.push({ reference, text });
		used += bytes;
	}
	return {
		sourceId,
		records,
		linkOffset,
		nextOffset,
		requiredMaxBytes,
		outputTruncated: nextOffset !== null || page.truncated,
		...(options.find === undefined ? {} : { find: { query: options.find, firstMatchOffset } }),
	};
}
