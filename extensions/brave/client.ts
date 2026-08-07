export const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface BraveWebSearchRequest {
	query: string;
	count?: number;
	offset?: number;
	country?: string;
	search_lang?: string;
	freshness?: string;
	safesearch?: "off" | "moderate" | "strict";
	extra_snippets?: boolean;
	spellcheck?: boolean;
}

export interface BraveWebResult {
	title: string;
	url: string;
	description?: string;
	age?: string;
	extraSnippets: string[];
}

export interface BraveWebSearchResponse {
	originalQuery: string;
	alteredQuery?: string;
	moreResultsAvailable: boolean;
	results: BraveWebResult[];
}

interface ResponseBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
	releaseLock(): void;
}

interface FetchResponse {
	ok: boolean;
	status: number;
	headers?: { get(name: string): string | null };
	body?: { getReader(): ResponseBodyReader; cancel(reason?: unknown): Promise<void> } | null;
	text(): Promise<string>;
}

export type FetchLike = (
	url: URL,
	init: { headers: Record<string, string>; redirect: "error"; signal: AbortSignal },
) => Promise<FetchResponse>;

interface BraveClientOptions {
	apiKey?: string;
	env?: Record<string, string | undefined>;
	fetch?: FetchLike;
	timeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cleanKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim();
	return key.length > 0 ? key : undefined;
}

function cleanErrorText(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 400);
}

export async function resolveApiKey(options: BraveClientOptions = {}, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("Brave web search cancelled.");
	const explicit = cleanKey(options.apiKey);
	if (explicit) return explicit;

	const fromEnvironment = cleanKey((options.env ?? process.env).PI_BRAVE_API_KEY);
	if (fromEnvironment) return fromEnvironment;

	throw new Error("Brave Search is not configured. Set PI_BRAVE_API_KEY.");
}

function httpUrl(value: unknown): string | undefined {
	const raw = asString(value);
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function decodeResponse(payload: unknown, fallbackQuery: string): BraveWebSearchResponse {
	const root = asRecord(payload);
	const query = asRecord(root?.query);
	const web = asRecord(root?.web);
	const rawResults = Array.isArray(web?.results) ? web.results.slice(0, 20) : [];
	const results: BraveWebResult[] = [];

	for (const value of rawResults) {
		const result = asRecord(value);
		const url = httpUrl(result?.url);
		if (!result || !url) continue;
		const snippets = Array.isArray(result.extra_snippets)
			? result.extra_snippets.filter((item): item is string => typeof item === "string").slice(0, 5)
			: [];
		results.push({
			title: asString(result.title) ?? "Untitled result",
			url,
			description: asString(result.description),
			age: asString(result.page_age) ?? asString(result.age),
			extraSnippets: snippets,
		});
	}

	return {
		originalQuery: asString(query?.original) ?? fallbackQuery,
		alteredQuery: asString(query?.altered),
		moreResultsAvailable: query?.more_results_available === true,
		results,
	};
}

function apiErrorDetail(body: string): string | undefined {
	try {
		const root = asRecord(JSON.parse(body));
		const error = asRecord(root?.error);
		const detail = asString(error?.detail);
		const code = asString(error?.code);
		if (detail && code) return cleanErrorText(`${code}: ${detail}`);
		return detail || code ? cleanErrorText(detail ?? code ?? "") : undefined;
	} catch {
		return cleanErrorText(body) || undefined;
	}
}

function requestUrl(params: BraveWebSearchRequest): URL {
	const query = params.query.trim();
	if (!query) throw new Error("Brave web search query cannot be empty.");
	const url = new URL(BRAVE_WEB_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(params.count ?? 10));
	url.searchParams.set("offset", String(params.offset ?? 0));
	url.searchParams.set("safesearch", params.safesearch ?? "moderate");
	url.searchParams.set("spellcheck", String(params.spellcheck ?? true));
	url.searchParams.set("extra_snippets", String(params.extra_snippets ?? false));
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("result_filter", "web");
	if (params.country) url.searchParams.set("country", params.country.toUpperCase());
	if (params.search_lang) url.searchParams.set("search_lang", params.search_lang.toLowerCase());
	if (params.freshness) url.searchParams.set("freshness", params.freshness);
	return url;
}

function transportError(prefix: string, error: unknown): Error {
	const detail = error instanceof Error ? cleanErrorText(error.message) : cleanErrorText(String(error));
	return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

class ResponseLimitError extends Error {}

async function readBoundedBody(response: FetchResponse): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) {
		const body = await response.text();
		if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
			throw new ResponseLimitError(`Brave Search response exceeded the ${MAX_RESPONSE_BYTES}-byte safety limit.`);
		}
		return body;
	}

	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				try {
					await reader.cancel(new Error("response size limit"));
				} catch {}
				throw new ResponseLimitError(`Brave Search response exceeded the ${MAX_RESPONSE_BYTES}-byte safety limit.`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function searchBraveWeb(
	params: BraveWebSearchRequest,
	signal?: AbortSignal,
	options: BraveClientOptions = {},
): Promise<BraveWebSearchResponse> {
	if (signal?.aborted) throw new Error("Brave web search cancelled.");
	const url = requestUrl(params);
	const apiKey = await resolveApiKey(options, signal);
	if (signal?.aborted) throw new Error("Brave web search cancelled.");

	const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
	if (!fetchImpl) throw new Error("Brave web search requires a runtime with fetch support.");
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Brave web search timeout must be positive.");

	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("request timeout"));
	}, timeoutMs);
	timer.unref?.();

	let response: FetchResponse;
	let body: string;
	try {
		try {
			response = await fetchImpl(url, {
				headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
				redirect: "error",
				signal: controller.signal,
			});
		} catch (error) {
			if (signal?.aborted) throw new Error("Brave web search cancelled.");
			if (timedOut) throw new Error(`Brave web search timed out after ${timeoutMs}ms.`);
			throw transportError("Brave Search network request failed", error);
		}

		const declaredLength = Number(response.headers?.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
			try {
				await response.body?.cancel(new Error("response size limit"));
			} catch {}
			controller.abort(new Error("response size limit"));
			throw new ResponseLimitError(`Brave Search response exceeded the ${MAX_RESPONSE_BYTES}-byte safety limit.`);
		}
		try {
			body = await readBoundedBody(response);
		} catch (error) {
			if (error instanceof ResponseLimitError) throw error;
			if (signal?.aborted) throw new Error("Brave web search cancelled.");
			if (timedOut) throw new Error(`Brave web search timed out after ${timeoutMs}ms.`);
			throw transportError("Could not read the Brave Search response", error);
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}

	if (signal?.aborted) throw new Error("Brave web search cancelled.");
	if (timedOut) throw new Error(`Brave web search timed out after ${timeoutMs}ms.`);
	if (!response.ok) {
		const detail = apiErrorDetail(body);
		throw new Error(`Brave Search request failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error("Brave Search returned an invalid JSON response.");
	}
	return decodeResponse(payload, params.query);
}
