import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";

const rotated = { access_token: "synthetic-new", refresh_token: "synthetic-next", token_type: "Bearer", expires_in: 3600 };
function deferred() {
	let resolve!: () => void;
	return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

async function requestBody(request: IncomingMessage): Promise<string> {
	let body = "";
	for await (const part of request) {
		body += part.toString();
		if (body.length > 65_536) throw new Error("Fixture request exceeds bound");
	}
	return body;
}

async function scenario(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "mcp-process-test-"));
	const entered = deferred(); const release = deferred();
	const children: { child: ChildProcess; done: Promise<unknown> }[] = [];
	let exchanges = 0; const requests: string[] = []; const errors: unknown[] = [];
	async function tokenResponse(body: string, response: ServerResponse) {
		const form = new URLSearchParams(body);
		assert.equal(form.get("refresh_token"), "synthetic-original");
		assert.equal(form.get("client_id"), "https://pi.dev/oauth/client.json");
		if (++exchanges === 1) {
			entered.resolve(); await release.promise;
			response.end(JSON.stringify(rotated));
		} else response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
	}
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST") { response.writeHead(405).end(); return; }
			const body = await requestBody(request);
			response.setHeader("content-type", "application/json");
			if (request.url === "/token") {
				await tokenResponse(body, response); return;
			}
			assert.equal(request.url, "/mcp");
			assert.equal(request.headers.authorization, `Bearer ${rotated.access_token}`);
			const message = JSON.parse(body); requests.push(message.method);
			if (message.id === undefined) { response.writeHead(202).end(); return; }
			const result = message.method === "initialize"
				? { protocolVersion: "2025-11-25", serverInfo: { name: "auth-fixture", version: "1" }, capabilities: { tools: {} } }
				: { tools: [] };
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		})().catch((error) => { errors.push(error); response.writeHead(500).end(); });
	});
	t.after(async () => {
		release.resolve();
		for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.all(children.map(({ done }) => done));
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`; const url = `${base}/mcp`; const key = `mcp__docs|${url}`;
	const state: McpOAuthState = {
		serverUrl: url, tokens: { access_token: "synthetic-old", refresh_token: "synthetic-original", token_type: "Bearer" }, tokensExpireAt: 1,
		discovery: { authorizationServerUrl: base, authorizationServerMetadata: {
			issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
		} },
	};
	const unrelated = { serverUrl: "https://unrelated.example.test/mcp", tokens: { access_token: "synthetic-unrelated", token_type: "Bearer" } };
	const path = join(dir, "mcp-auth.json");
	writeFileSync(path, JSON.stringify({ [key]: state, unrelated }));
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { docs: { url } } }));
	function start(args: string[], ipc = false) {
		const starting = deferred(); let stdout = ""; let stderr = "";
		const child = spawn(process.execPath, args, {
			cwd: dir, env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", NO_COLOR: "1" },
			stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"], timeout: 15_000, killSignal: "SIGKILL",
		});
		child.on("message", (message) => { if ((message as { type?: string }).type === "starting") starting.resolve(); });
		child.stdout?.on("data", (data) => { stdout += data.toString(); if (stdout.length > 65_536) child.kill("SIGKILL"); });
		child.stderr?.on("data", (data) => { stderr += data.toString(); if (stderr.length > 65_536) child.kill("SIGKILL"); });
		const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
			child.on("error", (error) => { stderr += String(error); });
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
		children.push({ child, done });
		return { done, starting: () => Promise.race([starting.promise, done.then((result) => { throw new Error(`Child exited before refresh: ${JSON.stringify(result)}`); })]) };
	}
	function native() { return start([fileURLToPath(new URL("./mcp-auth-process-fixture.mts", import.meta.url)), dir, url], true); }
	function verify() {
		assert.deepEqual(errors, []); assert.equal(exchanges, 1);
		const states = JSON.parse(readFileSync(path, "utf8"));
		assert.deepEqual(states[key].tokens, rotated); assert.deepEqual(states.unrelated, unrelated);
	}
	return { entered, release, start, native, verify, requests };
}

it("serialises refresh between two native OS processes with the production adapters", { timeout: 20_000 }, async (t) => {
	const f = await scenario(t); const first = f.native();
	await Promise.race([f.entered.promise, first.done.then((result) => { throw new Error(JSON.stringify(result)); })]);
	const second = f.native(); await second.starting(); f.release.resolve();
	for (const result of await Promise.all([first.done, second.done])) {
		assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { token: rotated.access_token });
	}
	f.verify();
});

it("shares ordinary CLI refresh ownership with a native OS process", { timeout: 20_000 }, async (t) => {
	const f = await scenario(t);
	const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	const ordinary = f.start([cli, "mcp", "list", "--json"]);
	await Promise.race([f.entered.promise, ordinary.done.then((result) => { throw new Error(JSON.stringify(result)); })]);
	const native = f.native(); await native.starting(); f.release.resolve();
	const [ordinaryResult, nativeResult] = await Promise.all([ordinary.done, native.done]);
	assert.equal(ordinaryResult.code, 0, ordinaryResult.stderr);
	const report = JSON.parse(ordinaryResult.stdout);
	assert.deepEqual(report.errors, []); assert.equal(report.servers[0].name, "docs"); assert.equal(report.servers[0].state, "connected");
	assert.equal(nativeResult.code, 0, nativeResult.stderr); assert.deepEqual(JSON.parse(nativeResult.stdout), { token: rotated.access_token });
	assert.ok(f.requests.includes("initialize")); assert.ok(f.requests.includes("tools/list")); f.verify();
});
