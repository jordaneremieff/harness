import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { StdioTransport } from "@earendil-works/pi-mcp";
import { guardStdio, type McpGuardian } from "./mcp-guardian.ts";

it("registers a process before transport start settles", async () => {
	let resolve!: () => void;
	const pending = new Promise<void>((done) => { resolve = done; });
	const registered: number[] = [];
	const transport = { pid: 42, start: () => pending, onClose: () => () => {} } as unknown as StdioTransport;
	const guardian = { register: (pid: number) => registered.push(pid), unregister: () => {} } as unknown as McpGuardian;
	guardStdio(transport, guardian);
	const start = transport.start();
	assert.deepEqual(registered, [42]);
	resolve();
	await start;
});

it("exits the guardian after clean close", { timeout: 10000, skip: process.platform === "win32" }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-guardian-clean-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const source = `
import { guardStdio, McpGuardian } from './extensions/agent/mcp-guardian.ts';
import { StdioTransport } from '@earendil-works/pi-mcp';
const guard = new McpGuardian(console.error);
const server = new StdioTransport({command: process.execPath, args: ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); setInterval(()=>{},1000)"]});
guardStdio(server, guard);
const starting = server.start();
const pid = server.pid;
await starting;
await server.close();
guard.close();
console.log(JSON.stringify([guard.processId, pid]));
`;
	const host = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), env: { ...process.env, PI_AGENT_DIR: directory, PI_AGENT_SESSIONS_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
	const [chunk] = await once(host.stdout, "data") as [Buffer];
	const pids: number[] = JSON.parse(chunk.toString().trim());
	assert.equal(pids.length, 2);
	assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
	await once(host, "exit");
	const end = Date.now() + 3000;
	const alive = new Set(pids);
	while (alive.size > 0 && Date.now() < end) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		for (const pid of alive) { try { process.kill(pid, 0); } catch { alive.delete(pid); } }
	}
	assert.equal(alive.size, 0);
});

it("kills a registered stdio server after its host is killed", { timeout: 12000, skip: process.platform === "win32" }, async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "mcp-guardian-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const source = `
import { StdioTransport } from '@earendil-works/pi-mcp';
import { guardStdio, McpGuardian } from './extensions/agent/mcp-guardian.ts';
const guard = new McpGuardian(console.error);
const server = new StdioTransport({ command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{}); process.stdin.resume(); console.log(JSON.stringify({jsonrpc:'2.0',method:'ready'})); setInterval(()=>{},1000)"] });
server.onMessage(() => console.log(server.pid));
guardStdio(server, guard);
const starting = server.start();
await starting;
setInterval(()=>{},1000);
`;
	const host = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), env: { ...process.env, PI_AGENT_DIR: directory, PI_AGENT_SESSIONS_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL"); });
	const [chunk] = await once(host.stdout, "data") as [Buffer];
	const pid = Number(chunk.toString().trim());
	assert.ok(Number.isSafeInteger(pid) && pid > 0);
	host.kill("SIGKILL");
	await once(host, "exit");
	const end = Date.now() + 6000;
	let alive = true;
	while (alive && Date.now() < end) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		try { process.kill(pid, 0); } catch { alive = false; }
	}
	assert.equal(alive, false, "guardian must stop the server after host death");
});
