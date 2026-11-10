/**
 * Native MCP OAuth state shares ordinary Pi's credential file, not its interactive sign-in.
 * Automatic refresh shares ordinary Pi's cross-process lock; short credential-file locks
 * protect conditional persistence independently of the remote exchange.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import { authorizeMcp, McpOAuthAuthorizationRequiredError, McpOAuthProvider, parseWwwAuthenticate } from "@earendil-works/pi-mcp/oauth";
import type { AuthorizationServerMetadata, McpOAuthState, McpOAuthStateStore, OAuthChallenge } from "@earendil-works/pi-mcp/oauth";

type HttpConfig = Extract<McpServerConfig, { url: string }>;
type OAuthSettings = NonNullable<HttpConfig["oauth"]>;

/** Reported ownership only; the lock heartbeat does not detect loss immediately. */
export interface RefreshLease { readonly valid: boolean }

/** Per-server refresh ownership, scoped to agentDir. An omitted lease from an injected lock is valid. */
export interface RefreshLock {
	withRefreshLock<T>(key: string, fn: (lease?: RefreshLease) => Promise<T>): Promise<T>;
}

/** Short synchronous credential mutations only. Never hold this lock over network I/O. */
export interface CredentialFileLock {
	withFileLock<T>(path: string, fn: () => T): Promise<T>;
}

const lockRetries = { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 };

/** The low-level exclusive lock operation; tests supply controlled acquisition and callbacks. */
export interface McpLockDriver {
	lock: typeof lockfile.lock;
}

const defaultLockDriver: McpLockDriver = { lock: lockfile.lock };

export class McpRefreshLock implements RefreshLock {
	private readonly agentDir: string;
	private readonly driver: McpLockDriver;
	constructor(agentDir: string, driver: McpLockDriver = defaultLockDriver) { this.agentDir = agentDir; this.driver = driver; }

	async withRefreshLock<T>(key: string, fn: (lease?: RefreshLease) => Promise<T>): Promise<T> {
		mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
		const path = join(this.agentDir, `mcp-auth-refresh-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`);
		let compromised = false;
		const release = await this.driver.lock(path, {
			realpath: false, stale: 20_000, retries: lockRetries,
			onCompromised: () => {
				compromised = true;
				// An admitted rotation still needs conditional persistence under the separate file lock.
				process.emitWarning("MCP refresh lock ownership was lost; credential writes remain conditional", { code: "MCP_REFRESH_LOCK_COMPROMISED" });
			},
		});
		try { return await fn({ get valid() { return !compromised; } }); }
		finally { if (!compromised) await release(); }
	}
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Ordinary Pi's credential target and default stale threshold; never run network I/O here. */
export class McpCredentialFileLock implements CredentialFileLock {
	private readonly driver: McpLockDriver;
	constructor(driver: McpLockDriver = defaultLockDriver) { this.driver = driver; }

	async withFileLock<T>(path: string, fn: () => T): Promise<T> {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		let compromised: Error | undefined;
		const release = await this.driver.lock(path, {
			realpath: false, retries: lockRetries,
			onCompromised: (error) => {
				compromised = error;
				process.emitWarning("MCP credential lock ownership was lost", { code: "MCP_CREDENTIAL_LOCK_COMPROMISED" });
			},
		});
		try {
			if (compromised) throw compromised;
			return fn();
		} finally { if (!compromised) await release(); }
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

	constructor(agentDir: string, refreshLock: RefreshLock = new McpRefreshLock(agentDir), fileLock: CredentialFileLock = new McpCredentialFileLock()) {
		this.file = new CredentialFile(resolve(agentDir, "mcp-auth.json"), fileLock);
		this.refreshLock = refreshLock;
	}

	private assertAdmission(lease?: RefreshLease): void {
		if (this.closed) throw new Error("MCP authentication is closed");
		if (lease?.valid === false) throw new Error("MCP refresh lock ownership was lost");
	}

	provider(name: string, config: HttpConfig, resolveSecret: (value: string) => string | undefined): NativeMcpAuthProvider {
		const url = new URL(config.url).href;
		const key = `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}|${url}`;
		let refreshing: Promise<void> | undefined;
		const refresh = (rejected: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge): Promise<void> => {
			if (this.closed) return Promise.reject(new Error("MCP authentication is closed"));
			if (refreshing) return refreshing;
			refreshing = this.refreshLock.withRefreshLock(key, async (lease) => {
				this.assertAdmission(lease);
				const start = await this.file.load(key, url);
				this.assertAdmission(lease);
				if (!start?.state.tokens?.access_token) throw new McpOAuthAuthorizationRequiredError();
				if (start.state.tokens.access_token !== rejected) return;
				if (!start.state.tokens.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				await this.exchange(key, url, start, config.oauth ?? {}, resolveSecret, fetch, challenge, lease);
			}).finally(() => { if (refreshing) this.pending.delete(refreshing); refreshing = undefined; });
			this.pending.add(refreshing);
			return refreshing;
		};
		return {
			token: async () => {
				if (this.closed) throw new Error("MCP authentication is closed");
				await refreshing?.catch(() => undefined);
				const state = (await this.file.load(key, url))?.state;
				if (state?.tokensExpireAt !== undefined && state.tokensExpireAt <= Date.now() + 30_000) {
					await refresh(state.tokens?.access_token).catch(() => undefined);
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

	private async exchange(key: string, url: string, start: StoredGrant, settings: OAuthSettings, resolveSecret: (value: string) => string | undefined, fetch: McpFetch, challenge?: OAuthChallenge, lease?: RefreshLease): Promise<void> {
		let admitted = false;
		const request = boundedFetch(fetch);
		const guardedFetch: McpFetch = (input, init) => {
			if (init?.method === "POST" && init.body instanceof URLSearchParams && init.body.has("grant_type")) {
				this.assertAdmission(lease);
				admitted = true;
			}
			return request(input, init);
		};
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
				scope: challenge?.scope ?? settings.scope, fetch: guardedFetch,
				// An automatic refresh must not register a client or replace a pending sign-in's state and verifier.
				refreshOnly: true,
			});
			if (result === "REDIRECT") failure = new McpOAuthAuthorizationRequiredError();
		} catch (error) { failure = error; }
		// OAuth fallback stages sign-in state after generic fetch errors; refused admission must not save it.
		if (!admitted) this.assertAdmission(lease);
		const saved = await this.file.commit(key, url, start, staged);
		if (!saved.replaced && failure !== undefined) throw failure;
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled([...this.pending]);
	}
}
