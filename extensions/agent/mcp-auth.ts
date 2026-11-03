/**
 * Native MCP OAuth state shares ordinary Pi's credential file, not its interactive sign-in.
 * Automatic refresh is serialised across native instances in one process; cross-process
 * serialisation with ordinary Pi awaits the compatible proper-lockfile refresh lock.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import { authorizeMcp, McpOAuthAuthorizationRequiredError, McpOAuthProvider, parseWwwAuthenticate } from "@earendil-works/pi-mcp/oauth";
import type { AuthorizationServerMetadata, McpOAuthState, McpOAuthStateStore, OAuthChallenge } from "@earendil-works/pi-mcp/oauth";

type HttpConfig = Extract<McpServerConfig, { url: string }>;
type OAuthSettings = NonNullable<HttpConfig["oauth"]>;

/**
 * Replacement seam for the compatible per-server proper-lockfile adapter, scoped to agentDir.
 * Its target is mcp-auth-refresh-<first 16 hex digits of sha256(key)> in that directory.
 */
export interface RefreshLock {
	withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Short synchronous credential mutations only. Never hold this lock over network I/O. */
export interface CredentialFileLock {
	withFileLock<T>(path: string, fn: () => T): Promise<T>;
}

const refreshes = new Map<string, Promise<unknown>>();
const processRefreshLock: RefreshLock = {
	async withRefreshLock(key, fn) {
		const previous = refreshes.get(key);
		const next = (previous ?? Promise.resolve()).catch(() => undefined).then(fn);
		refreshes.set(key, next);
		try { return await next; }
		finally { if (refreshes.get(key) === next) refreshes.delete(key); }
	},
};

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Ordinary Pi uses the same directory with proper-lockfile. Mutations here are synchronous
 * and short. Reclaim only after 30 seconds without renewal, then recheck inode and mtime.
 * A wait timeout fails closed. This is not a renewable network/refresh lock.
 */
export class McpCredentialFileLock implements CredentialFileLock {
	async withFileLock<T>(path: string, fn: () => T): Promise<T> {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const lockPath = `${path}.lock`;
		const deadline = Date.now() + 25_000;
		while (!this.acquire(lockPath)) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for MCP credential lock ${lockPath}`);
			await new Promise<void>((done) => setTimeout(done, 100));
		}
		const held = statSync(lockPath);
		try { return fn(); }
		finally { this.release(lockPath, held); }
	}

	private release(path: string, held: Stats): void {
		try {
			const current = statSync(path);
			if (current.dev === held.dev && current.ino === held.ino && current.mtimeMs === held.mtimeMs) rmdirSync(path);
		} catch (error) { if (!missing(error)) throw error; }
	}

	private acquire(path: string): boolean {
		try { mkdirSync(path); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		try {
			const before = statSync(path);
			if (Date.now() - before.mtimeMs <= 30_000) return false;
			const current = statSync(path);
			if (current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) rmdirSync(path);
		} catch (error) { if (!missing(error)) throw error; }
		return false;
	}
}

interface StoredGrant { key: string; state: McpOAuthState }

class CredentialFile {
	readonly path: string;
	private readonly lock: CredentialFileLock;

	constructor(path: string, lock: CredentialFileLock) { this.path = path; this.lock = lock; }

	private states(): Record<string, McpOAuthState> {
		let text: string;
		try { text = readFileSync(this.path, "utf8"); }
		catch (error) { if (missing(error)) return {}; throw error; }
		const parsed: unknown = text.trim() ? JSON.parse(text) : {};
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, McpOAuthState> : {};
	}

	private select(states: Record<string, McpOAuthState>, key: string, url: string): StoredGrant | undefined {
		// Ordinary Pi owns URL-only key takeover; native reads never migrate it.
		const storedKey = states[key] ? key : url;
		const state = states[storedKey];
		return state?.serverUrl === url ? { key: storedKey, state } : undefined;
	}

	load(key: string, url: string): Promise<StoredGrant | undefined> {
		return this.lock.withFileLock(this.path, () => this.select(this.states(), key, url));
	}

	/** A committed newer grant wins; a committed logout is never resurrected. */
	commit(key: string, url: string, start: StoredGrant, next: McpOAuthState): Promise<{ state: McpOAuthState; replaced: boolean }> {
		return this.lock.withFileLock(this.path, () => {
			const states = this.states();
			// A removed canonical entry is logout, even if a URL-only entry still exists.
			if (start.key === key && states[key]?.serverUrl !== url) throw new McpOAuthAuthorizationRequiredError();
			const current = this.select(states, key, url);
			if (!current) throw new McpOAuthAuthorizationRequiredError();
			if (!isDeepStrictEqual(current.state.tokens, start.state.tokens)) {
				if (!current.state.tokens?.access_token) throw new McpOAuthAuthorizationRequiredError();
				return { state: current.state, replaced: true };
			}
			if (!isDeepStrictEqual(current.state, start.state)) throw new Error("MCP OAuth state changed during refresh; retry with the current state");
			states[current.key] = next;
			const temporary = `${this.path}.${randomUUID()}.tmp`;
			writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
			return { state: next, replaced: false };
		});
	}
}

function redirectUrl(settings: OAuthSettings, state: McpOAuthState): string {
	const callback = new URL(settings.callbackUrl ?? "http://127.0.0.1/callback");
	if (callback.port && settings.callbackUrl !== undefined) return settings.callbackUrl;
	if (settings.callbackPort !== undefined) { callback.port = String(settings.callbackPort); return callback.href; }
	const client = state.clientInformation;
	return (client && "redirect_uris" in client ? client.redirect_uris[0] : undefined) ?? "http://127.0.0.1/callback";
}

function offersDocument(settings: OAuthSettings): boolean {
	if (settings.clientRegistration === "cimd") return true;
	if (settings.clientRegistration === "dcr" || settings.clientId || settings.clientName) return false;
	if (settings.callbackUrl === undefined) return true;
	const callback = new URL(settings.callbackUrl);
	return callback.pathname === "/callback" && callback.hostname !== "[::1]";
}

function documentFor(url: string, redirect: string, metadata: AuthorizationServerMetadata | undefined, settings: OAuthSettings) {
	if (!metadata?.client_id_metadata_document_supported || !metadata.token_endpoint_auth_methods_supported?.includes("none")) {
		if (settings.clientRegistration === "cimd") throw new Error('oauth.clientRegistration "cimd" requires Client ID Metadata Documents for public clients');
		return undefined;
	}
	if (metadata.authorization_response_iss_parameter_supported) return { url: "https://pi.dev/oauth/client.json", redirectUrl: redirect };
	const server = new URL(url); server.hash = "";
	const id = createHash("sha256").update(server.href).digest().subarray(0, 9).toString("base64url");
	const callback = new URL(redirect); callback.pathname = `/callback/${id}`;
	return { url: `https://pi.dev/oauth/${id}/client.json`, redirectUrl: callback.href };
}

function boundedFetch(fetch: McpFetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(15_000);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

export interface NativeMcpAuthProvider extends AuthProvider {
	onUnauthorized: NonNullable<AuthProvider["onUnauthorized"]>;
	settled(): Promise<void>;
}

/** One execution's refresh lifetime; the lock owner is shared across executions. */
export class NativeMcpAuth {
	private readonly file: CredentialFile;
	private readonly pending = new Set<Promise<void>>();
	private closed = false;

	private readonly refreshLock: RefreshLock;

	constructor(agentDir: string, refreshLock: RefreshLock = processRefreshLock, fileLock: CredentialFileLock = new McpCredentialFileLock()) {
		this.file = new CredentialFile(resolve(agentDir, "mcp-auth.json"), fileLock);
		this.refreshLock = refreshLock;
	}

	provider(name: string, config: HttpConfig, resolveSecret: (value: string) => string | undefined): NativeMcpAuthProvider {
		const url = new URL(config.url).href;
		const key = `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}|${url}`;
		let refreshing: Promise<void> | undefined;
		const refresh = (rejected: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge): Promise<void> => {
			if (this.closed) return Promise.reject(new Error("MCP authentication is closed"));
			if (refreshing) return refreshing;
			refreshing = this.refreshLock.withRefreshLock(key, async () => {
				const start = await this.file.load(key, url);
				if (!start?.state.tokens?.access_token) throw new McpOAuthAuthorizationRequiredError();
				if (start.state.tokens.access_token !== rejected) return;
				if (!start.state.tokens.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				await this.exchange(key, url, start, config.oauth ?? {}, resolveSecret, fetch, challenge);
			}).finally(() => { if (refreshing) this.pending.delete(refreshing); refreshing = undefined; });
			this.pending.add(refreshing);
			return refreshing;
		};
		return {
			token: async () => {
				if (this.closed) throw new Error("MCP authentication is closed");
				await refreshing;
				const state = (await this.file.load(key, url))?.state;
				if (state?.tokensExpireAt !== undefined && state.tokensExpireAt <= Date.now() + 30_000) {
					await refresh(state.tokens?.access_token);
					return (await this.file.load(key, url))?.state.tokens?.access_token;
				}
				return state?.tokens?.access_token;
			},
			onUnauthorized: async (context) => {
				const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
				if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
				await refresh(context.token, context.fetch, challenge);
			},
			settled: async () => { await refreshing?.catch(() => undefined); },
		};
	}

	private async exchange(key: string, url: string, start: StoredGrant, settings: OAuthSettings, resolveSecret: (value: string) => string | undefined, fetch: McpFetch, challenge?: OAuthChallenge): Promise<void> {
		let staged = structuredClone(start.state);
		const store: McpOAuthStateStore = { load: () => structuredClone(staged), save: (state) => { staged = structuredClone(state); } };
		const redirect = redirectUrl(settings, start.state);
		const provider = new McpOAuthProvider({
			serverUrl: url, redirectUrl: redirect, store,
			clientMetadata: { client_name: settings.clientName ?? "pi" },
			clientMetadataDocument: offersDocument(settings) ? (metadata) => documentFor(url, redirect, metadata, settings) : undefined,
			clientId: settings.clientId,
			clientSecret: settings.clientSecret === undefined ? undefined : resolveSecret(settings.clientSecret),
			onRedirect: () => undefined,
		});
		let failure: unknown;
		try {
			// No caller signal: a remote rotation must reach persistence even after its request ends.
			const result = await authorizeMcp(provider, {
				serverUrl: url, resourceMetadataUrl: challenge?.resourceMetadataUrl,
				authorizationServerMetadataUrl: settings.authServerMetadataUrl === undefined ? undefined : new URL(settings.authServerMetadataUrl),
				scope: challenge?.scope ?? settings.scope, fetch: boundedFetch(fetch),
			});
			if (result === "REDIRECT") failure = new McpOAuthAuthorizationRequiredError();
		} catch (error) { failure = error; }
		const saved = await this.file.commit(key, url, start, staged);
		if (!saved.replaced && failure !== undefined) throw failure;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.pending]);
	}
}
