import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { armRestart, createRestartCommand, type RestartHosts, type RestartProcess } from "./restart.ts";

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-restart-")));
	const cli = join(root, "pi cli's.mjs"), session = join(root, "session 'saved'.jsonl");
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "pi cli's.mjs" } }));
	writeFileSync(cli, "// fixture"); writeFileSync(session, "saved");
	const events = new EventEmitter();
	const calls: string[] = [], notices: string[] = [];
	const host: RestartProcess = Object.assign(events, { argv: [process.execPath, cli, "--fork", "a prompt"], execArgv: ["--title=Pi 'quoted'"], execPath: process.execPath, env: { FIXTURE: "not printed" }, execve: (() => { throw new Error("unexpected exec"); }) as RestartProcess["execve"] });
	const state = { session, sessionId: "saved-session", sessionDir: root, leaf: "tip", idle: true, queued: false, managed: false, hosts: { identity: "owners" } as RestartHosts };
	const ctx = {
		hasUI: true, mode: "tui", cwd: root,
		sessionManager: { getSessionFile: () => state.session, getSessionId: () => state.sessionId, getSessionDir: () => state.sessionDir, getLeafId: () => state.leaf },
		isIdle: () => state.idle, hasPendingMessages: () => state.queued,
		ui: { confirm: async () => { calls.push("confirm"); return true; }, notify: (text: string) => notices.push(text) },
		shutdown: () => { calls.push("shutdown"); },
	} as unknown as ExtensionContext;
	const guard = { pending: false };
	const options = { process: host, packageDir: () => root, managedChild: () => state.managed, hosts: () => state.hosts, guard };
	const command = createRestartCommand(options);
	return { root, cli, session, events, host, calls, notices, state, ctx, options, command, guard, close: () => { chmodSync(cli, 0o600); rmSync(root, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof fixture>;
const refusals: Array<[string, (f: Fixture) => void, RegExp]> = [
	["no UI", (f) => { f.ctx.hasUI = false; }, /interactive Pi CLI/u],
	["RPC mode", (f) => { f.ctx.mode = "rpc"; }, /interactive Pi CLI/u],
	["print mode", (f) => { f.ctx.mode = "print"; }, /interactive Pi CLI/u],
	["managed child", (f) => { f.state.managed = true; }, /interactive Pi CLI/u],
	["SDK launcher", (f) => { f.host.argv[1] = f.session; }, /interactive Pi CLI/u],
	["missing launcher", (f) => { f.host.argv = [process.execPath]; }, /interactive Pi CLI/u],
	["invalid package metadata", (f) => { writeFileSync(join(f.root, "package.json"), "{}"); }, /interactive Pi CLI/u],
	["missing execve", (f) => { f.host.execve = undefined; }, /does not support process.execve/u],
	["missing executable", (f) => { f.host.execPath = join(f.root, "absent"); }, /not executable/u],
	["non-executable runtime", (f) => { f.host.execPath = f.session; chmodSync(f.session, 0o600); }, /not executable/u],
	["unreadable CLI", (f) => { chmodSync(f.cli, 0); }, /not readable/u],
	["missing session accessor", (f) => { f.ctx.sessionManager.getSessionFile = () => undefined; }, /not saved/u],
	["relative session path", (f) => { f.state.session = "relative.jsonl"; }, /absolute file/u],
	["missing session file", (f) => { unlinkSync(f.session); }, /not saved/u],
	["empty session file", (f) => { writeFileSync(f.session, ""); }, /non-empty file/u],
	["session path is a directory", (f) => { f.state.session = f.root; }, /non-empty file/u],
	["terminal control argument", (f) => { f.host.execArgv = ["--title=unsafe\ntext"]; }, /control characters/u],
	["busy primary", (f) => { f.state.idle = false; }, /active or queued work/u],
	["queued primary input", (f) => { f.state.queued = true; }, /active or queued work/u],
	["busy agent hosts", (f) => { f.state.hosts.refusal = "Restart refused. Agent sessions have active or queued work: nested."; }, /nested/u],
	["unsaved agent state", (f) => { f.state.hosts.refusal = "Restart refused. Agent sessions have unsaved state: child."; }, /unsaved state/u],
];
for (const [name, arrange, message] of refusals) test(`restart preflight refuses ${name} without confirmation or an exit listener`, async () => {
	const f = fixture();
	try {
		arrange(f); await f.command.handler("", f.ctx);
		assert.deepEqual(f.calls, []); assert.equal(f.events.listenerCount("exit"), 0); assert.equal(f.guard.pending, false);
		assert.equal(f.notices.length, 1); assert.match(f.notices[0], message);
	} finally { f.close(); }
});

test("restart refuses arguments without preflight", async () => {
	const f = fixture();
	try {
		f.ctx.isIdle = () => { throw new Error("preflight ran"); };
		await f.command.handler("now", f.ctx); assert.deepEqual(f.notices, ["Usage: /restart"]); assert.deepEqual(f.calls, []);
	} finally { f.close(); }
});

test("cancel leaves the session, filesystem, guard, and exit listeners unchanged", async () => {
	const f = fixture();
	try {
		f.ctx.ui.confirm = async () => { f.calls.push("confirm"); return false; };
		await f.command.handler("", f.ctx); await f.command.handler("", f.ctx);
		assert.deepEqual(f.calls, ["confirm", "confirm"]); assert.deepEqual(f.notices, []);
		assert.equal(f.events.listenerCount("exit"), 0); assert.equal(f.guard.pending, false); assert.equal(readFileSync(f.session, "utf8"), "saved");
	} finally { f.close(); }
});

for (const [name, change] of [
	["session identity", (f: Fixture) => { f.state.sessionId = "different"; }],
	["session file", (f: Fixture) => { f.state.session = f.cli; }],
	["session directory", (f: Fixture) => { f.state.sessionDir = join(f.root, "other"); }],
	["session file replacement", (f: Fixture) => { const replacement = join(f.root, "replacement.jsonl"); writeFileSync(replacement, "replacement"); renameSync(replacement, f.session); }],
	["current directory", (f: Fixture) => { f.ctx.cwd = join(f.root, "other"); }],
	["launch arguments", (f: Fixture) => { f.host.execArgv = ["--title=different"]; }],
	["agent host identities", (f: Fixture) => { f.state.hosts.identity = "another child"; }],
	["active primary", (f: Fixture) => { f.state.idle = false; }],
	["queued primary", (f: Fixture) => { f.state.queued = true; }],
	["active agent host", (f: Fixture) => { f.state.hosts.refusal = "Restart refused. Agent sessions have active or queued work: child."; }],
	["unsaved agent host", (f: Fixture) => { f.state.hosts.refusal = "Restart refused. Agent sessions have unsaved state: child."; }],
] as const) test(`restart rechecks ${name} after confirmation`, async () => {
	const f = fixture();
	try {
		f.ctx.ui.confirm = async () => { f.calls.push("confirm"); change(f); return true; };
		await f.command.handler("", f.ctx);
		assert.deepEqual(f.calls, ["confirm"]); assert.equal(f.events.listenerCount("exit"), 0); assert.equal(f.guard.pending, false);
		assert.match(f.notices[0], /^Restart refused\./u);
	} finally { f.close(); }
});

test("restart permits a saved custom entry appended during confirmation", async () => {
	const f = fixture();
	try {
		const native = SessionManager.create(f.root, f.root);
		native.appendMessage(fauxAssistantMessage("saved conversation"));
		f.ctx.sessionManager = native;
		const file = native.getSessionFile(); assert.ok(file);
		const before = statSync(file), leaf = native.getLeafId();
		let entryId = "";
		f.ctx.ui.confirm = async () => {
			f.calls.push("confirm");
			entryId = native.appendCustomEntry("fixture.checkpoint", { saved: true });
			return true;
		};
		await f.command.handler("", f.ctx);
		assert.notEqual(native.getLeafId(), leaf); assert.ok(statSync(file).size > before.size);
		assert.equal(statSync(file).ino, before.ino);
		assert.deepEqual(f.calls, ["confirm", "shutdown"]); assert.deepEqual(f.notices, []);
		assert.equal(f.events.listenerCount("exit"), 1);
		assert.deepEqual(SessionManager.open(file).getEntry(entryId), native.getEntry(entryId));
	} finally { f.close(); }
});

test("restart excludes duplicate admission across registered command instances", async () => {
	const f = fixture();
	try {
		let release!: (accepted: boolean) => void;
		f.ctx.ui.confirm = () => { f.calls.push("confirm"); return new Promise<boolean>((resolve) => { release = resolve; }); };
		const command = createRestartCommand({ ...f.options, guard: undefined });
		const duplicate = createRestartCommand({ ...f.options, guard: undefined });
		const first = command.handler("", f.ctx);
		await duplicate.handler("", f.ctx);
		assert.deepEqual(f.calls, ["confirm"]); assert.match(f.notices[0], /already pending/u);
		release(false); await first; assert.equal(f.events.listenerCount("exit"), 0);
	} finally { f.close(); }
});

test("accepted restart arms once before graceful shutdown with exact argv and unchanged environment", async () => {
	const f = fixture(); const output: string[] = [];
	try {
		let captured: unknown[] = [];
		f.ctx.ui.confirm = async (title, body) => {
			assert.equal(title, "Restart this Pi session?");
			assert.match(body, /Subagent workers and other extensions' work/u);
			assert.match(body, /A running ! command also stops/u);
			assert.match(body, /private compaction queue/u);
			f.calls.push("confirm"); return true;
		};
		f.host.execve = (file, args, env) => { captured = [file, args, env]; throw new TypeError("sensitive text"); };
		f.ctx.shutdown = () => { assert.equal(f.events.listenerCount("exit"), 1); f.calls.push("shutdown"); };
		const command = createRestartCommand({ ...f.options, write: (_fd, text) => output.push(text) });
		await command.handler("  ", f.ctx); await command.handler("", f.ctx);
		assert.deepEqual(f.calls, ["confirm", "shutdown"]); assert.equal(f.events.listenerCount("exit"), 1);
		f.events.emit("exit", 0);
		assert.deepEqual(captured, [process.execPath, [process.execPath, ...f.host.execArgv, f.cli, "--session-dir", f.root, "--session", f.session], f.host.env]);
		assert.equal(captured[2], f.host.env); assert.equal(f.events.listenerCount("exit"), 0);
		assert.match(output[0], /'\\''quoted'\\''/u); assert.match(output[0], /^Restarting Pi\./u);
		assert.doesNotMatch(output.join(""), /not printed|sensitive text|--fork|a prompt/u);
		assert.match(output[1], /failed after shutdown: invalid restart arguments/u); assert.equal(f.host.exitCode, 1);
	} finally { f.close(); }
});

test("nonzero exit performs no write or exec", () => {
	const f = fixture();
	try {
		armRestart({ executable: "unused", args: ["unused"] }, f.host, () => { assert.fail("unexpected output"); });
		f.events.emit("exit", 1); assert.equal(f.events.listenerCount("exit"), 0); assert.equal(f.host.exitCode, undefined);
	} finally { f.close(); }
});

test("shutdown rejection removes the listener and releases admission without unsafe cause text", async () => {
	const f = fixture();
	try {
		f.ctx.shutdown = () => { throw Object.assign(new Error("private value"), { code: "EACCES" }); };
		await f.command.handler("", f.ctx);
		assert.equal(f.events.listenerCount("exit"), 0); assert.equal(f.guard.pending, false);
		assert.deepEqual(f.notices, ["Restart failed before shutdown: EACCES. This session remains open."]);
	} finally { f.close(); }
});

test("restart replaces the process after graceful cleanup with the same PID", { skip: typeof process.execve !== "function", timeout: 15_000 }, () => {
	const root = mkdtempSync(join(tmpdir(), "agent-restart-exit-"));
	try {
		const sentinel = join(root, "cleanup");
		const replacement = `import{readFileSync,writeSync}from'node:fs';writeSync(1,'REPLACED '+JSON.stringify({pid:process.pid,cleanup:readFileSync(${JSON.stringify(sentinel)},'utf8')})+'\\n');`;
		const source = `import{writeFileSync,writeSync}from'node:fs';import{armRestart}from${JSON.stringify(new URL("./restart.ts", import.meta.url).href)};writeSync(1,'BEFORE '+process.pid+'\\n');armRestart({executable:process.execPath,args:[process.execPath,'--input-type=module','-e',${JSON.stringify(replacement)}]});await Promise.resolve();writeFileSync(${JSON.stringify(sentinel)},'complete');writeSync(1,'CLEANUP complete\\n');process.exit(0);`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 12_000, maxBuffer: 64 * 1024 });
		assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
		const before = /^BEFORE (\d+)$/mu.exec(result.stdout); assert.ok(before);
		const after = /^REPLACED (.+)$/mu.exec(result.stdout); assert.ok(after, result.stdout);
		assert.deepEqual(JSON.parse(after[1]), { pid: Number(before[1]), cleanup: "complete" });
		assert.ok(result.stdout.indexOf("CLEANUP complete\n") < result.stdout.indexOf("Restarting Pi."));
		assert.ok(result.stdout.indexOf("Restarting Pi.") < result.stdout.indexOf('\nREPLACED '));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
