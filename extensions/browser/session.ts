/**
 * Target resolution and Apple Events calls for one explicitly selected browser
 * process. Nothing here launches, activates, or quits a browser.
 */

import {
	type AccessLevel,
	type AccessMap,
	accessCovers,
	BROWSERS,
	type BrowserKey,
	type BrowserSpec,
} from "./browsers.ts";
import { type OsaFailure, type OsaReply, type OsaRequest, type OsaRunner, TransportError } from "./osa.ts";

export interface SessionDeps {
	run: OsaRunner;
	readAccess: () => AccessMap;
	platform: string;
	processArgs: (pid: number, signal?: AbortSignal) => Promise<string | null>;
}

/** An expected refusal: the operation did not reach the page, and nothing was sent that changes it. */
export class Blocked extends Error {
	readonly reason: string;
	readonly facts: Record<string, unknown>;
	constructor(reason: string, message: string, facts: Record<string, unknown> = {}) {
		super(message);
		this.name = "Blocked";
		this.reason = reason;
		this.facts = facts;
	}
}

export interface Instance {
	pid: number;
	hidden: boolean;
	active: boolean;
}

export interface Inventory {
	installed: { path: string; version: string | null } | null;
	instances: Instance[];
}

export interface Target {
	browser: BrowserKey;
	pid: number;
	tab: string;
}

export const CALL_TIMEOUT_MS = 15_000;

const FAILURE_GUIDANCE: Record<string, string> = {
	"automation-denied":
		"macOS denied Automation for this host application. Allow it in System Settings > Privacy & Security > Automation, then retry.",
	"automation-not-determined":
		"macOS has not yet asked whether this host application may control the browser. Call browser_tabs with requestPermission true while the operator is present to answer the prompt.",
	"javascript-from-apple-events-off":
		'This browser profile does not allow JavaScript from Apple Events. The operator enables it in the browser menu View > Developer > "Allow JavaScript from Apple Events" for the profile that owns the tab.',
	"devtools-disallowed":
		"Browser policy disallows developer tools for this page or profile, which also blocks Apple Events JavaScript.",
	"tab-not-found":
		"The tab is closed or belongs to another browser process. List tabs again; operations never move to another tab.",
	"not-running": "The selected browser process is no longer running. The tool never starts a browser.",
	"pid-mismatch": "The pid now belongs to another application.",
	"origin-mismatch": "The tab does not show the expected origin, so the operation was not sent.",
	"apple-event-timeout":
		"The browser did not answer in time. An open JavaScript dialog or a busy page blocks Apple Events JavaScript until the operator dismisses it; the request can still run when the page resumes.",
};

export function guidance(reason: string): string | undefined {
	return FAILURE_GUIDANCE[reason];
}

/** Maps an Apple Events failure to a stable reason. Chromium reports error 12 when JavaScript from Apple Events is off and 13 when policy disallows developer tools. */
export function failureReason(error: OsaFailure): string {
	if (error.code?.startsWith("automation-")) return error.code;
	if (error.code) return error.code;
	switch (error.number) {
		case -1743:
			return "automation-denied";
		case -1744:
			return "automation-not-determined";
		case 12:
			return "javascript-from-apple-events-off";
		case 13:
			return "devtools-disallowed";
		case -600:
		case -609:
			return "not-running";
		case -1712:
			return "apple-event-timeout";
		case -1728:
		case -1719:
			return "tab-not-found";
		default:
			if (/can.t be found/i.test(error.message)) return "not-running";
			return "apple-events-error";
	}
}

export function checkPlatform(platform: string): void {
	if (platform !== "darwin") throw new Blocked("unsupported-platform", "Browser session tools support macOS only.");
}

export function requireAccess(deps: SessionDeps, browser: BrowserKey, required: AccessLevel): AccessLevel {
	const granted = deps.readAccess()[browser];
	if (!accessCovers(granted, required)) {
		throw new Blocked(
			"access-not-configured",
			`${BROWSERS[browser].name} is not configured for ${required} access on this machine (browser.access.${browser} is ${granted ?? "unset"}). The operator sets it in the browser section of the harness configuration document or PI_BROWSER_ACCESS.`,
			{ configured: granted ?? null, required },
		);
	}
	return granted as AccessLevel;
}

export async function call(
	deps: SessionDeps,
	request: OsaRequest,
	signal: AbortSignal | undefined,
	timeoutMs = CALL_TIMEOUT_MS,
): Promise<OsaReply> {
	return deps.run(request, { signal, timeoutMs });
}

export interface AvailabilityQuery {
	browser: BrowserKey;
	bundleId: string;
	checkAutomation: boolean;
}

export interface AvailabilityEntry {
	browser: BrowserKey;
	installed: { path: string; version: string | null } | null;
	instances: Instance[];
	automation: string;
}

/**
 * Installation and running facts for several applications in one JXA invocation.
 * Automation is checked only for an application that is configured and running.
 */
export async function discoverAvailability(
	deps: SessionDeps,
	queries: readonly AvailabilityQuery[],
	signal?: AbortSignal,
): Promise<AvailabilityEntry[]> {
	if (queries.length === 0) return [];
	const reply = await call(deps, { op: "availability", queries }, signal);
	return expectValue<{ browsers: AvailabilityEntry[] }>(reply).browsers;
}

export interface WindowRow {
	id: string;
	index: number;
	title: string | null;
	mode: string | null;
	minimized: boolean;
	visible: boolean;
	activeTabIndex: number;
	tabs: { id: string; url: string | null; title: string | null; loading: boolean }[];
}

export type TabsDiscoveryRequest = {
	op: "tabs";
	bundleId: string;
	pid?: number;
	inspectAllowed: boolean;
	requestPermission: boolean;
};

/**
 * One discovery invocation: inventory, process selection, optional permission
 * request, fresh execution-time checks, and the window reads.
 */
export interface TabsDiscovery {
	inventory: Inventory;
	kind: "ok" | "blocked" | "ambiguous-process";
	pid: number | null;
	automation: string | null;
	windows: WindowRow[];
	blocked: { reason: string; message: string } | null;
	instances: Instance[];
}

export async function discoverTabs(
	deps: SessionDeps,
	request: TabsDiscoveryRequest,
	signal?: AbortSignal,
): Promise<TabsDiscovery> {
	const reply = await call(
		deps,
		request,
		signal,
		request.requestPermission ? 120_000 : CALL_TIMEOUT_MS,
	);
	return expectValue<TabsDiscovery>(reply);
}

export function userDataDir(args: string | null): string | null {
	if (!args) return null;
	const match = /--user-data-dir=(.+?)(?=\s--|$)/.exec(args);
	return match ? match[1].trim() : null;
}

/** Raises Blocked for a failed reply; returns the value otherwise. */
export function expectValue<T>(reply: OsaReply): T {
	if (reply.ok) return reply.value as T;
	const reason = failureReason(reply.error);
	if (reason === "apple-event-timeout") {
		// The browser received the request; a blocked page can still run it later.
		throw new TransportError("timeout", "unknown", guidance(reason) as string);
	}
	throw new Blocked(reason, guidance(reason) ?? reply.error.message, {
		appleEvents: { number: reply.error.number, message: reply.error.message },
		...(reply.error.extra && typeof reply.error.extra === "object"
			? (reply.error.extra as Record<string, unknown>)
			: {}),
	});
}

export interface ExecuteReply {
	window: string;
	url: string | null;
	title: string | null;
	result: string | null;
	/** Why the tab URL or title is absent; the script result above is unaffected. */
	metadataError?: { number: number | null; message: string } | null;
}

/** Runs one page script in the tab, identified by id inside the selected process. */
export async function executeInTab(
	deps: SessionDeps,
	spec: BrowserSpec,
	target: Target,
	script: string,
	signal?: AbortSignal,
	timeoutMs = CALL_TIMEOUT_MS,
): Promise<ExecuteReply> {
	const seconds = Math.ceil(timeoutMs / 1000);
	const reply = await call(
		deps,
		{ op: "execute", bundleId: spec.bundleId, pid: target.pid, tab: target.tab, script, seconds },
		signal,
		timeoutMs + 1000,
	);
	return expectValue<ExecuteReply>(reply);
}

/** Parses the JSON envelope a page script returns. A missing envelope is a page-side failure, not success. */
export function envelope(reply: ExecuteReply): Record<string, unknown> {
	if (reply.result === null) {
		throw new Blocked(
			"no-page-result",
			"The page script returned no result; the page may have blocked or replaced it.",
		);
	}
	try {
		const value = JSON.parse(reply.result) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {}
	throw new Blocked("no-page-result", "The page script returned an unexpected value.");
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Decodes an Apple Events QuickDraw rectangle (top, left, bottom, right as native 16-bit integers). */
export function decodeRect(value: unknown): Rect | null {
	const encoded = value && typeof value === "object" ? (value as { qdrect?: unknown }).qdrect : undefined;
	if (typeof encoded !== "string") return null;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length !== 8) return null;
	const top = bytes.readInt16LE(0);
	const left = bytes.readInt16LE(2);
	const bottom = bytes.readInt16LE(4);
	const right = bytes.readInt16LE(6);
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function isTransportError(error: unknown): error is TransportError {
	return error instanceof TransportError;
}

export function normalOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Blocked("invalid-origin", "origin must be an absolute origin such as https://example.com.");
	}
	if (url.origin === "null" || url.origin !== value.replace(/\/$/, "").toLowerCase()) {
		throw new Blocked(
			"invalid-origin",
			`origin must be exactly scheme://host[:port]; ${url.origin === "null" ? "this URL has no origin" : `use ${url.origin}`}.`,
		);
	}
	return url.origin;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new TransportError("cancelled", "none", "Cancelled."));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new TransportError("cancelled", "none", "Cancelled."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
