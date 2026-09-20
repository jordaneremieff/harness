import { Resolver } from "node:dns/promises";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export const PAGE_NETWORK_LIMITS = Object.freeze({
	urlCharacters: 4096,
	redirects: 3,
	headerBytes: 16 * 1024,
	bodyBytes: 2 * 1024 * 1024,
	timeoutMs: 20_000,
});

export interface PublicPageResponse {
	requestedUrl: string;
	finalUrl: string;
	retrievedAt: string;
	contentType: string;
	body: Buffer;
	downloadedBytes: number;
	redirectCount: number;
}

export interface PageResolver {
	resolve4(hostname: string): Promise<string[]>;
	resolve6(hostname: string): Promise<string[]>;
	cancel(): void;
}

/** Dependency seams do not change the public-address policy or resource ceilings. */
export interface PageNetworkDependencies {
	createResolver(): PageResolver;
	request(options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest;
}

export interface PageNetworkOptions {
	/** Tests and callers may shorten, but never extend, the total deadline. */
	timeoutMs?: number;
	dependencies?: PageNetworkDependencies;
}

class PageNetworkError extends Error {}

function failure(message = "Public page request failed."): PageNetworkError {
	return new PageNetworkError(message);
}

const excludedAddresses = new BlockList();
for (const [address, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["192.175.48.0", 24],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	excludedAddresses.addSubnet(address, bits, "ipv4");
}
for (const [address, bits] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["2620:4f:8000::", 48],
	["3ffe::", 16],
	["3fff::", 20],
] as const) {
	excludedAddresses.addSubnet(address, bits, "ipv6");
}
const ipv6GlobalUnicast = new BlockList();
ipv6GlobalUnicast.addSubnet("2000::", 3, "ipv6");

/**
 * IPv4 excludes special-use blocks, including public special-purpose services.
 * IPv6 admits only 2000::/3, excluding protocol assignments, documentation,
 * 6to4, AS112, former 6bone space, and ISATAP interface identifiers.
 * All dotted IPv6, zone identifiers, mapped addresses, and translation prefixes
 * are rejected rather than interpreted as alternate routes to IPv4.
 */
export function isPublicPageAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return !excludedAddresses.check(address, "ipv4");
	if (
		family !== 6 ||
		address.includes(".") ||
		address.includes("%") ||
		!ipv6GlobalUnicast.check(address, "ipv6") ||
		excludedAddresses.check(address, "ipv6")
	)
		return false;
	const halves = address.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	return !(Number.parseInt(words[5], 16) === 0x5efe && [0, 0x0200].includes(Number.parseInt(words[4], 16)));
}

export function parsePublicPageUrl(input: string): URL {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.length > PAGE_NETWORK_LIMITS.urlCharacters ||
		!/^https?:\/\//i.test(input) ||
		/^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(input) ||
		/[\u0000-\u0020\u007f-\u009f\\]/u.test(input)
	) {
		throw failure("Public page URL is not allowed.");
	}
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw failure("Public page URL is not allowed.");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.port ||
		!url.hostname ||
		url.href.length > PAGE_NETWORK_LIMITS.urlCharacters
	) {
		throw failure("Public page URL is not allowed.");
	}
	url.hash = "";
	const hostname = unbracket(url.hostname);
	if (isIP(hostname) && !isPublicPageAddress(hostname)) throw failure("Public page address is not allowed.");
	return url;
}

function unbracket(hostname: string): string {
	return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
}

function abortFailure(signal: AbortSignal): PageNetworkError {
	return signal.reason instanceof PageNetworkError ? signal.reason : failure("Public page request cancelled.");
}

async function resolvePublicAddress(
	hostname: string,
	signal: AbortSignal,
	dependencies: PageNetworkDependencies,
): Promise<string> {
	if (signal.aborted) throw abortFailure(signal);
	if (isIP(hostname)) {
		if (!isPublicPageAddress(hostname)) throw failure("Public page address is not allowed.");
		return hostname;
	}
	const resolver = dependencies.createResolver();
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => {
			resolver.cancel();
			reject(abortFailure(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	const emptyWhenAbsent = (error: unknown): string[] => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENODATA") return [];
		throw failure("Public page DNS lookup failed.");
	};
	try {
		const answers = await Promise.race([
			Promise.all([
				resolver.resolve4(hostname).catch(emptyWhenAbsent),
				resolver.resolve6(hostname).catch(emptyWhenAbsent),
			]),
			cancelled,
		]);
		if (signal.aborted) throw abortFailure(signal);
		const addresses = answers.flat();
		if (addresses.length === 0 || !addresses.every(isPublicPageAddress)) {
			throw failure("Public page address is not allowed.");
		}
		return addresses[0];
	} finally {
		signal.removeEventListener("abort", onAbort);
		resolver.cancel();
	}
}

/** The numeric destination prevents a second DNS lookup after address validation. */
export function pinnedPageRequestOptions(url: URL, address: string): RequestOptions {
	const hostname = unbracket(url.hostname);
	return {
		protocol: url.protocol,
		hostname: address,
		family: isIP(address),
		port: url.protocol === "https:" ? 443 : 80,
		path: url.pathname + url.search,
		method: "GET",
		agent: false,
		maxHeaderSize: PAGE_NETWORK_LIMITS.headerBytes,
		insecureHTTPParser: false,
		setHost: false,
		headers: {
			Host: url.host,
			Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
			"Accept-Encoding": "identity",
			Connection: "close",
			"User-Agent": "Pi-Public-Page/1.0",
		},
		...(url.protocol === "https:"
			? {
					servername: isIP(hostname) ? "" : hostname,
					rejectUnauthorized: true,
					checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
				}
			: {}),
	};
}

interface PageHop {
	location?: string;
	body?: Buffer;
	contentType?: string;
}

type ResponseDecision =
	| { kind: "redirect"; location: string }
	| { kind: "error"; error: PageNetworkError }
	| { kind: "body"; contentType: string; declaredLength: string | undefined };

/** Validate status, encoding, and declared length before any body buffer is allocated. */
function classifyResponse(response: IncomingMessage): ResponseDecision {
	const status = response.statusCode ?? 0;
	if ([301, 302, 303, 307, 308].includes(status)) {
		const location = response.headers.location;
		if (!location) return { kind: "error", error: failure("Public page redirect is not allowed.") };
		return { kind: "redirect", location };
	}
	if (status !== 200) return { kind: "error", error: failure("Public page returned an unsuccessful HTTP status.") };
	const encoding = response.headers["content-encoding"];
	if (encoding && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity"))
		return { kind: "error", error: failure("Public page compressed responses are not supported.") };
	const declaredLength = response.headers["content-length"];
	if (
		declaredLength !== undefined &&
		(!/^\d+$/.test(declaredLength) || Number(declaredLength) > PAGE_NETWORK_LIMITS.bodyBytes)
	)
		return { kind: "error", error: failure("Public page body exceeds the size limit.") };
	return { kind: "body", contentType: response.headers["content-type"] ?? "", declaredLength };
}

function requestPage(
	url: URL,
	address: string,
	signal: AbortSignal,
	dependencies: PageNetworkDependencies,
): Promise<PageHop> {
	return new Promise((resolve, reject) => {
		let request: ClientRequest | undefined;
		let response: IncomingMessage | undefined;
		let settled = false;
		let bytes = 0;
		let body: Buffer | undefined;
		const finish = (error?: Error, result?: PageHop) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			response?.removeListener("data", onData);
			response?.destroy();
			request?.destroy();
			body = undefined;
			if (error) reject(error);
			else resolve(result ?? {});
		};
		const onError = () => finish(failure());
		const onAbort = () => finish(abortFailure(signal));
		const onData = (chunk: Buffer) => {
			if (settled || !body) return;
			bytes += chunk.length;
			if (bytes > PAGE_NETWORK_LIMITS.bodyBytes) {
				finish(failure("Public page body exceeds the size limit."));
				return;
			}
			chunk.copy(body, bytes - chunk.length);
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			request = dependencies.request(pinnedPageRequestOptions(url, address), (incoming) => {
				response = incoming;
				response.on("error", onError);
				response.once("aborted", onError);
				response.once("close", () => {
					if (!settled) onError();
				});
				if (settled) {
					response.destroy();
					return;
				}
				const decision = classifyResponse(response);
				if (decision.kind === "error") {
					finish(decision.error);
					return;
				}
				if (decision.kind === "redirect") {
					finish(undefined, { location: decision.location });
					return;
				}
				const { contentType, declaredLength } = decision;
				// A fixed buffer also bounds allocation overhead from tiny transfer chunks.
				body = Buffer.allocUnsafe(PAGE_NETWORK_LIMITS.bodyBytes);
				response.on("data", onData);
				response.once("end", () => {
					if (settled) return;
					if (!body || !response?.complete || (declaredLength !== undefined && Number(declaredLength) !== bytes)) {
						onError();
						return;
					}
					finish(undefined, { body: Buffer.from(body.subarray(0, bytes)), contentType });
				});
			});
			request.on("error", onError);
			request.once("close", () => {
				if (!response && !settled) onError();
			});
			if (settled) request.destroy();
			else request.end();
		} catch {
			onError();
		}
	});
}

const nativeDependencies: PageNetworkDependencies = {
	createResolver: () => new Resolver(),
	request: (options, callback) =>
		options.protocol === "https:" ? httpsRequest(options, callback) : httpRequest(options, callback),
};

function resolveTimeout(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? PAGE_NETWORK_LIMITS.timeoutMs;
	if (!Number.isFinite(value) || value <= 0 || value > PAGE_NETWORK_LIMITS.timeoutMs)
		throw failure("Public page deadline is not allowed.");
	return value;
}

/** A redirect target must stay bounded and must not smuggle credentials, controls, or backslashes. */
function redirectAllowed(location: string): boolean {
	if (location.length > PAGE_NETWORK_LIMITS.urlCharacters) return false;
	if (/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#]*@/i.test(location)) return false;
	return !/[\u0000-\u0020\u007f-\u009f\\]/u.test(location);
}

interface FetchedPage {
	requestedUrl: string;
	finalUrl: string;
	body: Buffer;
	contentType: string;
	redirectCount: number;
}

/** Follow bounded, validated redirects until a non-redirect response arrives. */
async function followRedirects(
	input: string,
	controller: AbortController,
	dependencies: PageNetworkDependencies,
): Promise<FetchedPage> {
	let url = parsePublicPageUrl(input);
	const requestedUrl = url.href;
	for (let redirectCount = 0; ; redirectCount++) {
		const address = await resolvePublicAddress(unbracket(url.hostname), controller.signal, dependencies);
		if (controller.signal.aborted) throw abortFailure(controller.signal);
		const result = await requestPage(url, address, controller.signal, dependencies);
		if (controller.signal.aborted) throw abortFailure(controller.signal);
		if (result.location !== undefined) {
			if (redirectCount >= PAGE_NETWORK_LIMITS.redirects) throw failure("Public page redirect limit exceeded.");
			if (!redirectAllowed(result.location)) throw failure("Public page redirect is not allowed.");
			url = parsePublicPageUrl(new URL(result.location, url).href);
			continue;
		}
		const body = result.body ?? Buffer.alloc(0);
		return { requestedUrl, finalUrl: url.href, body, contentType: result.contentType ?? "", redirectCount };
	}
}

export async function fetchPublicPage(
	input: string,
	signal?: AbortSignal,
	options: PageNetworkOptions = {},
): Promise<PublicPageResponse> {
	if (signal?.aborted) throw failure("Public page request cancelled.");
	const timeoutMs = resolveTimeout(options.timeoutMs);
	const controller = new AbortController();
	const onAbort = () => controller.abort(failure("Public page request cancelled."));
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(failure("Public page request timed out.")), timeoutMs);
	const dependencies = options.dependencies ?? nativeDependencies;
	try {
		const fetched = await followRedirects(input, controller, dependencies);
		return {
			requestedUrl: fetched.requestedUrl,
			finalUrl: fetched.finalUrl,
			retrievedAt: new Date().toISOString(),
			contentType: fetched.contentType,
			body: fetched.body,
			downloadedBytes: fetched.body.length,
			redirectCount: fetched.redirectCount,
		};
	} catch (error) {
		if (controller.signal.aborted) throw abortFailure(controller.signal);
		throw error instanceof PageNetworkError ? error : failure();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
