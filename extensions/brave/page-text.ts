import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { Parser } from "htmlparser2";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 128 * 1024;
const MAX_ELEMENTS = 50_000;
const MAX_DEPTH = 256;
export const MAX_EXCERPT_BYTES = 24_000;
const EXCLUDED = new Set([
	"head",
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"iframe",
	"object",
	"embed",
	"nav",
	"header",
	"footer",
	"aside",
	"form",
	"button",
	"select",
	"textarea",
]);
const BLOCKS = new Set([
	"address",
	"article",
	"blockquote",
	"br",
	"dd",
	"div",
	"dl",
	"dt",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tr",
	"ul",
]);

export function cleanPageText(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

function capText(text: string, limit: number): string {
	const capped = text.slice(0, limit);
	const last = capped.charCodeAt(capped.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped;
}

class TextBucket {
	text = "";
	truncated = false;
	append(value: string) {
		value = cleanPageText(value)
			.replace(/[^\S\n]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n+/g, "\n");
		if (!this.text || this.text.endsWith("\n")) value = value.replace(/^[ \n]+/, "");
		else if (this.text.endsWith(" ")) {
			value = value.replace(/^ +/, "");
			if (value.startsWith("\n")) this.text = this.text.slice(0, -1);
		}
		const remaining = MAX_TEXT_CHARS - this.text.length;
		if (value.length > remaining) this.truncated = true;
		this.text += value.slice(0, remaining);
	}
	paragraphs(): string[] {
		return cleanPageText(capText(this.text, MAX_TEXT_CHARS))
			.split(/\n+/)
			.map((line) => line.replace(/\s+/g, " ").trim())
			.filter(Boolean);
	}
}

export interface PageText {
	title: string;
	paragraphs: string[];
	method: "main" | "article" | "body" | "plain-text";
	truncated: boolean;
}

function decodePage(body: Buffer, contentType: string): { text: string; html: boolean } {
	if (body.byteLength > MAX_INPUT_BYTES) throw new Error("Web reader input exceeds the byte limit.");
	const type = contentType.split(";", 1)[0].trim().toLowerCase();
	const html = type === "text/html" || type === "application/xhtml+xml";
	if (!html && type !== "text/plain" && type !== "text/markdown") {
		throw new Error("Web reader supports HTML, plain text, and Markdown only; this content type is unsupported.");
	}
	const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
	let text: string;
	try {
		text = new TextDecoder(charset, { fatal: true }).decode(body);
	} catch {
		throw new Error("Web reader cannot decode this character encoding or malformed text.");
	}
	if (text.includes("\0")) throw new Error("Web reader rejected binary content labeled as text.");
	return { text, html };
}

export async function extractPageText(body: Buffer, contentType: string, signal?: AbortSignal): Promise<PageText> {
	signal?.throwIfAborted();
	const { text, html } = decodePage(body, contentType);
	if (!html) {
		const bucket = new TextBucket();
		bucket.append(text);
		return { title: "", paragraphs: bucket.paragraphs(), method: "plain-text", truncated: bucket.truncated };
	}
	const buckets = { body: new TextBucket(), main: new TextBucket(), article: new TextBucket() };
	const stack: { name: string; excluded: boolean; main: boolean; article: boolean; title: boolean }[] = [];
	let elements = 0;
	let title = "";
	let titleSeen = false;
	const append = (value: string) => {
		const state = stack.at(-1);
		if (state?.excluded) return;
		buckets.body.append(value);
		if (state?.main) buckets.main.append(value);
		if (state?.article) buckets.article.append(value);
	};
	const parser = new Parser(
		{
			onopentag(name, attributes) {
				if (++elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) {
					throw new Error("Web reader HTML exceeds the element or nesting limit.");
				}
				if (BLOCKS.has(name)) append("\n");
				if (name === "td" || name === "th") append(" | ");
				const parent = stack.at(-1);
				const documentTitle = name === "title" && (!parent || parent.name === "head") && !titleSeen;
				if (documentTitle) titleSeen = true;
				stack.push({
					name,
					excluded:
						parent?.excluded === true ||
						EXCLUDED.has(name) ||
						"hidden" in attributes ||
						attributes["aria-hidden"]?.toLowerCase() === "true" ||
						/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.style ?? ""),
					main: parent?.main === true || name === "main" || attributes.role === "main",
					article: parent?.article === true || name === "article",
					title: documentTitle,
				});
			},
			ontext(value) {
				if (stack.at(-1)?.title) title += value.slice(0, Math.max(0, 301 - title.length));
				append(value);
			},
			onclosetag(name) {
				if (BLOCKS.has(name)) append("\n");
				stack.pop();
				if (BLOCKS.has(name)) append("\n");
			},
		},
		{ decodeEntities: true },
	);
	for (let offset = 0; offset < text.length; offset += 8192) {
		signal?.throwIfAborted();
		parser.write(text.slice(offset, offset + 8192));
		await setImmediate(undefined, { signal });
	}
	signal?.throwIfAborted();
	parser.end();
	const main = buckets.main.paragraphs();
	const article = buckets.article.paragraphs();
	const method = main.length ? "main" : article.length ? "article" : "body";
	return {
		title: cleanPageText(capText(title, 300)).replace(/\s+/g, " ").trim(),
		paragraphs: method === "main" ? main : method === "article" ? article : buckets.body.paragraphs(),
		method,
		truncated: buckets[method].truncated,
	};
}

export interface PageExcerpts {
	sourceId: string;
	excerpts: { reference: string; text: string }[];
	outputTruncated: boolean;
}

export function makePageExcerpts(page: PageText, finalUrl: string, maxBytes = 16_000): PageExcerpts {
	if (!Number.isInteger(maxBytes) || maxBytes < 1000 || maxBytes > MAX_EXCERPT_BYTES) {
		throw new Error("Web reader max_bytes must be an integer from 1000 through 24000.");
	}
	const sourceId = createHash("sha256")
		.update(finalUrl)
		.update("\0")
		.update(page.paragraphs.join("\n"))
		.digest("hex")
		.slice(0, 16);
	const excerpts: PageExcerpts["excerpts"] = [];
	let used = 0;
	let outputTruncated = page.truncated;
	outer: for (const paragraph of page.paragraphs) {
		// Code points keep excerpt boundaries outside surrogate pairs.
		const points = Array.from(paragraph);
		for (let offset = 0; offset < points.length; ) {
			let text = "";
			let textBytes = 0;
			while (offset < points.length) {
				const point = points[offset];
				const bytes = Buffer.byteLength(point);
				if (textBytes + bytes > 800) break;
				text += point;
				textBytes += bytes;
				offset++;
			}
			const reference = `${sourceId}:E${excerpts.length + 1}`;
			const bytes = Buffer.byteLength(`[${reference}] ${text}\n\n`);
			if (used + bytes > maxBytes || excerpts.length >= 160) {
				outputTruncated = true;
				break outer;
			}
			excerpts.push({ reference, text });
			used += bytes;
		}
	}
	return { sourceId, excerpts, outputTruncated };
}
