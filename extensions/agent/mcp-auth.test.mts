import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import lockfile, { type LockOptions } from "proper-lockfile";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { StreamableHttpTransport, type McpFetch } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError, McpOAuthProvider, type McpOAuthState, type AuthorizationServerMetadata } from "@earendil-works/pi-mcp/oauth";
import { McpCredentialFileLock, McpRefreshLock, NativeMcpAuth, type CredentialFileLock } from "./mcp-auth.ts";

const url = "https://mcp.example.test/mcp";
const key = `mcp__docs|${url}`;
const metadata: AuthorizationServerMetadata = {
	issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize", token_endpoint: "https://auth.example.test/token",
	response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
};
const rotated = { access_token: "synthetic-new", refresh_token: "synthetic-next", token_type: "Bearer", expires_in: 3600 };
function grant(): McpOAuthState {
	return { serverUrl: url, tokens: { access_token: "synthetic-old", refresh_token: "synthetic-original", token_type: "Bearer" }, tokensExpireAt: 1,
		discovery: { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata } };
}
function deferred() {
	let resolve!: () => void;
	return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}
function fixture(t: TestContext, initial = grant(), fileLock?: CredentialFileLock) {
	const dir = mkdtempSync(join(tmpdir(), "mcp-auth-test-"));
	const path = join(dir, "mcp-auth.json");
	writeFileSync(path, JSON.stringify({ [key]: initial }));
	const owner = new NativeMcpAuth(dir, undefined, fileLock);
	t.after(async () => { await owner.close(); rmSync(dir, { recursive: true, force: true }); });
	return { dir, path, owner, read: () => JSON.parse(readFileSync(path, "utf8")) as Record<string, McpOAuthState> };
}
function provider(owner: NativeMcpAuth, oauth?: Extract<McpServerConfig, { url: string }>["oauth"]) {
	return owner.provider("docs", { url, oauth }, (value) => value);
}
function refreshFetch(t: TestContext, run: McpFetch) { t.mock.method(globalThis, "fetch", run); }
function rejectedToken(token = "synthetic-old") {
	return { token, serverUrl: new URL(url), fetch: globalThis.fetch, response: new Response(null, { status: 401 }) };
}

it("refreshes production CIMD state without registration or stored client information", async (t) => {
	const f = fixture(t); let calls = 0;
	refreshFetch(t, async (input, init) => {
		assert.equal(String(input), metadata.token_endpoint); assert.ok(init?.signal);
		assert.equal(new URLSearchParams(String(init.body)).get("client_id"), "https://pi.dev/oauth/client.json");
		calls++; return Response.json(rotated);
	});
	assert.equal(await provider(f.owner).token(), rotated.access_token);
	assert.equal(calls, 1); assert.deepEqual(f.read()[key].tokens, rotated);
	assert.equal(f.read()[key].clientInformation, undefined);
});

it("shares refresh ownership between native owners and reuses the replacement token", async (t) => {
	const f = fixture(t); const other = new NativeMcpAuth(f.dir); t.after(() => other.close());
	const entered = deferred(); const release = deferred(); t.after(release.resolve); let calls = 0;
	refreshFetch(t, async () => { calls++; entered.resolve(); await release.promise; return calls === 1 ? Response.json(rotated) : Response.json({ error: "invalid_grant" }, { status: 400 }); });
	const first = provider(f.owner).token(); await entered.promise;
	const second = provider(other).token(); release.resolve();
	assert.deepEqual(await Promise.all([first, second]), [rotated.access_token, rotated.access_token]);
	assert.equal(calls, 1); assert.deepEqual(f.read()[key].tokens, rotated);
});

it("discards a losing refresh's token invalidation and reuses the committed rotation", { timeout: 5000 }, async (t) => {
	const firstEntered = deferred(); const secondEntered = deferred();
	const releaseWinner = deferred(); const releaseLoser = deferred();
	t.after(() => { releaseWinner.resolve(); releaseLoser.resolve(); });
	const f = fixture(t);
	// Bypass refresh coordination to exercise conditional persistence after ownership loss.
	const other = new NativeMcpAuth(f.dir, { withRefreshLock: (_key, fn) => fn() });
	t.after(() => other.close());
	const invalidation = t.mock.method(McpOAuthProvider.prototype, "invalidateCredentials");
	let calls = 0;
	refreshFetch(t, async (_input, init) => {
		assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "synthetic-original");
		if (++calls === 1) {
			firstEntered.resolve(); await releaseWinner.promise; return Response.json(rotated);
		}
		secondEntered.resolve(); await releaseLoser.promise;
		return Response.json({ error: "invalid_grant" }, { status: 400 });
	});
	const winner = provider(f.owner); const loser = provider(other);
	const first = winner.token(); await firstEntered.promise;
	const second = loser.token(); await secondEntered.promise;
	releaseWinner.resolve(); assert.equal(await first, rotated.access_token);
	const saved = f.read(); assert.deepEqual(saved[key].tokens, rotated);
	releaseLoser.resolve(); assert.equal(await second, rotated.access_token);
	assert.deepEqual(invalidation.mock.calls.map((call) => call.arguments), [["tokens"]]);
	assert.deepEqual(f.read(), saved);
	assert.equal(await loser.token(), rotated.access_token);
	assert.equal(calls, 2); assert.deepEqual(f.read(), saved);
});

/** Ordinary Pi's store is private. This writer reproduces its directory lock and whole-file save protocol. */
function ordinaryWrite(path: string, states: Record<string, McpOAuthState>): void {
	const release = lockfile.lockSync(path, { realpath: false });
	try { writeFileSync(path, JSON.stringify(states)); }
	finally { release(); }
}

for (const outcome of ["new sign-in", "logout", "invalid-grant loser"] as const) {
	it(`preserves an ordinary writer's ${outcome} during native refresh`, async (t) => {
		const f = fixture(t); const newer = { ...grant(), tokens: { ...rotated, access_token: "synthetic-sign-in" }, tokensExpireAt: Date.now() + 3600000 };
		const unrelated = { ...grant(), serverUrl: "https://other.example.test/mcp" };
		const auth = provider(f.owner); let calls = 0;
		refreshFetch(t, async () => {
			calls++;
			ordinaryWrite(f.path, { ...(outcome === "logout" ? {} : { [key]: newer }), unrelated });
			return outcome === "invalid-grant loser" ? Response.json({ error: "invalid_grant" }, { status: 400 }) : Response.json(rotated);
		});
		if (outcome === "logout") await assert.rejects(auth.onUnauthorized(rejectedToken()), McpOAuthAuthorizationRequiredError);
		else {
			assert.equal(await auth.token(), newer.tokens.access_token);
			assert.equal(await auth.token(), newer.tokens.access_token);
		}
		assert.equal(calls, 1);
		assert.deepEqual(f.read(), { ...(outcome === "logout" ? {} : { [key]: newer }), unrelated });
	});
}

it("does not fall back to a URL-only grant after committed canonical logout", async (t) => {
	const f = fixture(t); const urlOnly = { ...grant(), tokens: { ...rotated, access_token: "synthetic-url-only" } };
	refreshFetch(t, async () => { ordinaryWrite(f.path, { [url]: urlOnly }); return Response.json(rotated); });
	await assert.rejects(provider(f.owner).onUnauthorized(rejectedToken()), McpOAuthAuthorizationRequiredError);
	assert.deepEqual(f.read(), { [url]: urlOnly });
});

it("fails a lock timeout without running an unlocked mutation", { timeout: 35_000 }, async (t) => {
	const f = fixture(t);
	const release = await lockfile.lock(f.path, { realpath: false });
	const before = readFileSync(f.path, "utf8"); let writes = 0;
	try {
		await assert.rejects(new McpCredentialFileLock().withFileLock(f.path, () => { writes++; writeFileSync(f.path, "{}"); }), { code: "ELOCKED" });
		assert.equal(writes, 0); assert.equal(readFileSync(f.path, "utf8"), before); assert.ok(existsSync(`${f.path}.lock`));
	} finally { await release(); }
});

it("reclaims a stale directory and owns the lock during the mutation", async (t) => {
	const f = fixture(t); mkdirSync(`${f.path}.lock`);
	const stale = new Date(Date.now() - 11000); utimesSync(`${f.path}.lock`, stale, stale);
	await new McpCredentialFileLock().withFileLock(f.path, () => { assert.ok(existsSync(`${f.path}.lock`)); writeFileSync(f.path, "{}"); });
	assert.equal(existsSync(`${f.path}.lock`), false); assert.deepEqual(f.read(), {});
});

it("drains a completed remote rotation before close resolves", async (t) => {
	const entered = deferred(); const release = deferred(); t.after(release.resolve); let operations = 0;
	const fileLock = new McpCredentialFileLock();
	const lock: CredentialFileLock = { async withFileLock(path, fn) { if (++operations === 3) { entered.resolve(); await release.promise; } return fileLock.withFileLock(path, fn); } };
	const f = fixture(t, grant(), lock);
	refreshFetch(t, async () => Response.json(rotated));
	const auth = provider(f.owner); const token = auth.token(); await entered.promise;
	let closed = false; const close = f.owner.close().then(() => { closed = true; });
	await Promise.resolve(); assert.equal(closed, false); assert.equal(f.read()[key].tokens?.access_token, "synthetic-old");
	release.resolve(); await close; await token; await auth.settled();
	assert.deepEqual(f.read()[key].tokens, rotated);
});

it("does not exchange after close while waiting for refresh ownership", async (t) => {
	const f = fixture(t); const held = deferred(); const release = deferred();
	const lock = new McpRefreshLock(f.dir);
	const holder = lock.withRefreshLock(key, async () => { held.resolve(); await release.promise; });
	await held.promise;
	let calls = 0; refreshFetch(t, async () => { calls++; return Response.json(rotated); });
	const refresh = provider(f.owner).onUnauthorized(rejectedToken());
	const rejected = assert.rejects(refresh, /authentication is closed/u);
	const close = f.owner.close(); release.resolve();
	await Promise.all([holder, rejected, close]);
	assert.equal(calls, 0); assert.deepEqual(f.read()[key], grant());
});

it("does not exchange after close while waiting for the credential reread", async (t) => {
	const entered = deferred(); const release = deferred(); t.after(release.resolve);
	const fileLock = new McpCredentialFileLock();
	const lock: CredentialFileLock = { async withFileLock(path, fn) { entered.resolve(); await release.promise; return fileLock.withFileLock(path, fn); } };
	const f = fixture(t, grant(), lock); let calls = 0;
	refreshFetch(t, async () => { calls++; return Response.json(rotated); });
	const refresh = provider(f.owner).onUnauthorized(rejectedToken());
	const rejected = assert.rejects(refresh, /authentication is closed/u);
	await entered.promise; const close = f.owner.close(); release.resolve();
	await Promise.all([rejected, close]); assert.equal(calls, 0);
	assert.deepEqual(f.read()[key], grant());
});

it("reports compromised refresh ownership without releasing a replacement lease", async (t) => {
	const f = fixture(t); let compromise: ((error: Error) => unknown) | undefined; let releases = 0;
	const warning = t.mock.method(process, "emitWarning", () => undefined);
	t.mock.method(lockfile, "lock", async (_path: string, options?: LockOptions) => {
		compromise = options?.onCompromised;
		return async () => { releases++; };
	});
	const result = await new McpRefreshLock(f.dir).withRefreshLock(key, async () => {
		assert.ok(compromise); compromise(new Error("synthetic ownership loss")); return "completed";
	});
	assert.equal(result, "completed"); assert.equal(releases, 0);
	assert.deepEqual(warning.mock.calls[0].arguments, ["MCP refresh lock ownership was lost; credential writes remain conditional", { code: "MCP_REFRESH_LOCK_COMPROMISED" }]);
});

it("refuses a credential callback after reported ownership loss", async (t) => {
	const f = fixture(t); let writes = 0; let releases = 0;
	const warning = t.mock.method(process, "emitWarning", () => undefined);
	t.mock.method(lockfile, "lock", async (_path: string, options?: LockOptions) => {
		options?.onCompromised?.(new Error("synthetic ownership loss"));
		return async () => { releases++; };
	});
	await assert.rejects(new McpCredentialFileLock().withFileLock(f.path, () => { writes++; }), /synthetic ownership loss/u);
	assert.equal(writes, 0); assert.equal(releases, 0); assert.equal(warning.mock.callCount(), 1);
});

it("releases refresh ownership after a failed callback", async (t) => {
	const f = fixture(t); const lock = new McpRefreshLock(f.dir);
	await assert.rejects(lock.withRefreshLock(key, async () => { throw new Error("synthetic failure"); }), /synthetic failure/u);
	assert.equal(await lock.withRefreshLock(key, async () => "reacquired"), "reacquired");
});

it("reads URL-only state without taking it over", async (t) => {
	const state = grant(); delete state.tokensExpireAt;
	const f = fixture(t, state); ordinaryWrite(f.path, { [url]: state });
	assert.equal(await provider(f.owner).token(), state.tokens?.access_token);
	assert.deepEqual(f.read(), { [url]: state });
});

const configurations: { name: string; oauth?: Extract<McpServerConfig, { url: string }>["oauth"]; supports?: boolean; iss?: boolean; expectedClient?: string; expectedRedirect?: string; error?: RegExp }[] = [
	{ name: "explicit client", oauth: { clientId: "registered-client", clientSecret: "synthetic-secret" }, expectedClient: "registered-client" },
	{ name: "forced unsupported CIMD", oauth: { clientRegistration: "cimd" }, supports: false, error: /clientRegistration.*cimd.*requires/u },
	{ name: "DCR", oauth: { clientRegistration: "dcr" }, expectedClient: "dynamic-client", expectedRedirect: "http://127.0.0.1/callback" },
	{ name: "named client and scope", oauth: { clientName: "test-client", scope: "configured-scope" }, expectedClient: "dynamic-client", expectedRedirect: "http://127.0.0.1/callback" },
	{ name: "custom callback with port", oauth: { callbackUrl: "http://localhost:8765/custom", callbackPort: 9999 }, expectedClient: "dynamic-client", expectedRedirect: "http://localhost:8765/custom" },
	{ name: "callbackPort", oauth: { clientRegistration: "dcr", callbackPort: 8765 }, expectedClient: "dynamic-client", expectedRedirect: "http://127.0.0.1:8765/callback" },
	{ name: "metadata override", oauth: { authServerMetadataUrl: "https://auth.example.test/override" }, expectedClient: "https://pi.dev/oauth/client.json" },
	{ name: "server-specific document", iss: false, expectedClient: `https://pi.dev/oauth/${createHash("sha256").update(url).digest().subarray(0, 9).toString("base64url")}/client.json` },
	{ name: "auto falls back to DCR", supports: false, expectedClient: "dynamic-client", expectedRedirect: "http://127.0.0.1/callback" },
];
for (const row of configurations) {
	it(`honours OAuth configuration: ${row.name}`, async (t) => {
		const state = grant(); const meta = { ...metadata, registration_endpoint: "https://auth.example.test/register", token_endpoint_auth_methods_supported: row.oauth?.clientSecret ? ["client_secret_post"] : ["none"], client_id_metadata_document_supported: row.supports ?? true, authorization_response_iss_parameter_supported: row.iss ?? true };
		state.discovery = { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: meta };
		const f = fixture(t, state); const requests: string[] = [];
		refreshFetch(t, async (input, init) => {
			requests.push(String(input));
			if (String(input) === row.oauth?.authServerMetadataUrl) return Response.json(meta);
			if (String(input) === meta.registration_endpoint) {
				const body = JSON.parse(String(init?.body));
				assert.deepEqual(body.redirect_uris, [row.expectedRedirect]);
				assert.equal(body.client_name, row.oauth?.clientName ?? "pi");
				assert.equal(body.scope, row.oauth?.scope);
				return Response.json({ ...body, client_id: "dynamic-client" });
			}
			assert.equal(String(input), meta.token_endpoint);
			const body = new URLSearchParams(String(init?.body)); assert.equal(body.get("client_id"), row.expectedClient);
			if (row.oauth?.clientSecret) assert.equal(body.get("client_secret"), row.oauth.clientSecret);
			return Response.json(rotated);
		});
		if (row.error) await assert.rejects(provider(f.owner, row.oauth).onUnauthorized(rejectedToken()), row.error);
		else assert.equal(await provider(f.owner, row.oauth).token(), rotated.access_token);
		if (row.oauth?.authServerMetadataUrl) assert.ok(requests.includes(row.oauth.authServerMetadataUrl));
	});
}

it("uses the challenge resource metadata and scope without an interactive redirect", async (t) => {
	const state = grant(); delete state.discovery; delete state.tokensExpireAt;
	const f = fixture(t, state); let resourceSeen = false; let scope: string | null = null;
	const fetch: McpFetch = async (input, init) => {
		if (String(input) === "https://mcp.example.test/resource") { resourceSeen = true; return Response.json({ resource: url, authorization_servers: [metadata.issuer] }); }
		if (String(input).includes(".well-known")) return Response.json({ ...metadata, registration_endpoint: "https://auth.example.test/register" });
		if (String(input).endsWith("/register")) { const body = JSON.parse(String(init?.body)); scope = body.scope; return Response.json({ ...body, client_id: "dynamic-client" }); }
		return Response.json({ error: "invalid_grant" }, { status: 400 });
	};
	const auth = provider(f.owner, { clientRegistration: "dcr", scope: "configured" });
	await assert.rejects(auth.onUnauthorized({ token: state.tokens?.access_token, serverUrl: new URL(url), response: new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.test/resource", scope="challenged"' } }), fetch }), McpOAuthAuthorizationRequiredError);
	assert.equal(resourceSeen, true); assert.equal(scope, "challenged"); assert.equal(f.read()[key].tokens, undefined);
});

it("sends the stored token after a transient refresh failure and reports sign-in after a 401", async (t) => {
	const f = fixture(t); let refreshes = 0; const sent: string[] = [];
	refreshFetch(t, async (input, init) => {
		if (String(input) === metadata.token_endpoint) {
			refreshes++;
			return Response.json({ error: refreshes === 1 ? "server_error" : "invalid_grant" }, { status: refreshes === 1 ? 503 : 400 });
		}
		assert.equal(String(input), url);
		sent.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(null, { status: 401 });
	});
	const transport = new StreamableHttpTransport({ url, authProvider: provider(f.owner), openGetStream: false });
	t.after(() => transport.close());
	await transport.start();
	await assert.rejects(transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), McpOAuthAuthorizationRequiredError);
	assert.deepEqual(sent, ["Bearer synthetic-old"]);
	assert.equal(refreshes, 2); assert.equal(f.read()[key].tokens, undefined);
});

it("requires sign-in without a refresh token and for insufficient scope", async (t) => {
	const state = grant(); assert.ok(state.tokens); delete state.tokens.refresh_token;
	const f = fixture(t, state); let requests = 0;
	refreshFetch(t, async () => { requests++; throw new Error("unexpected network"); });
	const auth = provider(f.owner);
	assert.equal(await auth.token(), state.tokens.access_token);
	await assert.rejects(auth.onUnauthorized(rejectedToken()), McpOAuthAuthorizationRequiredError);
	await assert.rejects(auth.onUnauthorized({ token: state.tokens.access_token, serverUrl: new URL(url), fetch: globalThis.fetch, response: new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope"' } }) }), McpOAuthAuthorizationRequiredError);
	assert.equal(requests, 0);
});
