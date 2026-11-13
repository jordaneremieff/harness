import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
	captureOrigin,
	focusOrigin,
	parseOrigin,
	terminalOriginMain,
	trustedRexExecutable,
	type Runner,
	type RunResult,
	type TerminalOrigin,
} from "./terminal-origin.ts";

const hostId = "00000000-0000-0000-0000-000000000001";
const instanceId = "00000000-0000-0000-0000-000000000002";
const sessionId = "session:00000000-0000-0000-0000-000000000003";
const blockId = "block:00000000-0000-0000-0000-000000000004";
const server = "unix:///synthetic/rex.sock";
const env = { REX_SERVER: server, REX_SESSION: sessionId, REX_BLOCK: blockId };
const exact = { server, hostId, instanceId, sessionId, blockId };
const origin: TerminalOrigin = {
	version: 1,
	terminal: "Rex",
	application: { bundleId: "com.superlogical.rex" },
	exact,
};
const snapshot = { hostId, instanceId, sessionId, placed: true };
function reply(value: unknown): RunResult {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}
function fake(...results: RunResult[]) {
	const calls: Array<{ executable: string; args: readonly string[]; options: Parameters<Runner>[2] }> = [];
	const run: Runner = async (executable, args, options) => {
		calls.push({ executable, args, options });
		const result = results.shift();
		assert.ok(result, "No unplanned Rex invocation");
		return result;
	};
	return { run, calls };
}

test("capture returns null without a Rex terminal environment and never invokes Rex", async () => {
	const f = fake();
	assert.equal(await captureOrigin({}, f.run), null);
	assert.equal(await captureOrigin({ REX_BIN_DIR: "/untrusted" }, f.run), null);
	assert.equal(f.calls.length, 0);
});

test("partial or invalid launch hints retain only the Rex application", async () => {
	for (const partial of [{ REX_SERVER: server }, { REX_SESSION: sessionId }, { ...env, REX_BLOCK: "label" }]) {
		const f = fake();
		assert.deepEqual(await captureOrigin(partial, f.run), {
			version: 1,
			terminal: "Rex",
			application: { bundleId: "com.superlogical.rex" },
		});
		assert.equal(f.calls.length, 0);
	}
});

test("complete capture records confirmed host and instance, not ambient executable or focus", async () => {
	const f = fake(reply(snapshot));
	assert.deepEqual(
		await captureOrigin({ ...env, REX_BIN_DIR: "/untrusted", REX_CLIENT: "client:wrong" }, f.run),
		origin,
	);
	assert.equal(f.calls.length, 1);
	const call = f.calls[0];
	assert.equal(call.executable, trustedRexExecutable());
	assert.match(
		call.executable,
		/Library\/Application Support\/com\.superlogical\.rex\/RexServer\/Versions\/Current\/Rex Server\.app\/Contents\/MacOS\/rex$/,
	);
	assert.ok(call.args.includes(`--server=${server}`));
	assert.ok(call.args.includes(sessionId));
	assert.equal(call.options.timeout, 3000);
	assert.equal(call.options.maxBuffer, 32768);
	assert.ok(Object.keys(call.options.env).every((key) => !key.startsWith("REX_")));
	assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--args") + 1]), { sessionId, blockId });
});

test("unreachable, incomplete, mismatched or unplaced captures retain the application only", async () => {
	for (const result of [
		{ code: 3, stdout: "", stderr: "unreachable" },
		{ code: null, stdout: "", stderr: "", failure: "missing" as const },
		{ code: null, stdout: "", stderr: "", failure: "timeout" as const },
		reply({ ...snapshot, hostId: undefined }),
		reply({ ...snapshot, instanceId: "invalid" }),
		reply({ ...snapshot, sessionId: "session:00000000-0000-0000-0000-000000000005" }),
		reply({ ...snapshot, placed: false }),
		{ code: 0, stdout: "not json", stderr: "" },
	]) {
		const f = fake(result);
		assert.equal((await captureOrigin(env, f.run))?.exact, undefined);
		assert.equal(f.calls.length, 1);
	}
});

test("focus validates the exact record and uses a second identity-guarded mutation", async () => {
	const response = { outcome: "focused", detail: "Block selected; Mac window unverified." };
	const f = fake(reply(snapshot), reply(response));
	assert.deepEqual(await focusOrigin(origin, f.run), response);
	assert.equal(f.calls.length, 2);
	assert.ok(f.calls.every((call) => call.executable === trustedRexExecutable()));
	const args = f.calls[1].args;
	assert.deepEqual(JSON.parse(args[args.indexOf("--args") + 1]), { ...exact, focus: true });
	const script = String(args[args.indexOf("-e") + 1]);
	assert.ok(script.indexOf("s.instance_id ~= a.instanceId") < script.indexOf('rex.call("session.focus_block"'));
	assert.ok(script.includes("v.session_id ~= a.sessionId or not placed"));
	assert.ok(!script.includes("client."));
});

test("changed server host or instance, session gone and block gone/detached are stale without focus", async () => {
	for (const value of [
		{ ...snapshot, hostId: "00000000-0000-0000-0000-000000000006" },
		{ ...snapshot, instanceId: "00000000-0000-0000-0000-000000000006" },
		{ ...snapshot, sessionId: "session:00000000-0000-0000-0000-000000000006" },
		{ ...snapshot, placed: false },
		{ outcome: "stale", detail: "Rex terminal block is gone or detached." },
	]) {
		const f = fake(reply(value));
		assert.equal((await focusOrigin(origin, f.run)).outcome, "stale");
		assert.equal(f.calls.length, 1);
	}
	const f = fake({
		code: 3,
		stdout: "",
		stderr: `Error: session target "${sessionId}" not found\n`,
		failure: "failed",
	});
	assert.equal((await focusOrigin(origin, f.run)).outcome, "stale");
	assert.equal(f.calls.length, 1);
});

test("a change between read and mutation stays stale, without retry", async () => {
	const f = fake(reply(snapshot), reply({ outcome: "stale", detail: "Rex server host or instance changed." }));
	assert.equal((await focusOrigin(origin, f.run)).outcome, "stale");
	assert.equal(f.calls.length, 2);
});

test("missing program, timeout and unknown failure are unavailable; timed-out focus is not retried", async () => {
	for (const failure of ["missing", "timeout", "failed"] as const) {
		const result = { code: null, stdout: "", stderr: "private diagnostics\n", failure };
		const f = fake(result);
		const value = await focusOrigin(origin, f.run);
		assert.equal(value.outcome, "unavailable");
		assert.ok(!value.detail.includes("private diagnostics"));
		assert.equal(f.calls.length, 1);
	}
	const f = fake(reply(snapshot), { code: null, stdout: "", stderr: "", failure: "timeout" });
	assert.equal((await focusOrigin(origin, f.run)).outcome, "unavailable");
	assert.equal(f.calls.length, 2);
});

test("application-only return never invokes a terminal operation", async () => {
	const f = fake();
	const { exact: _exact, ...app } = origin;
	assert.equal((await focusOrigin(app, f.run)).outcome, "unavailable");
	assert.equal(f.calls.length, 0);
});

test("stdin rejects malformed data, controls, oversized input and executable fields before any invocation", async () => {
	for (const input of [
		"null",
		"{",
		"{}",
		`${JSON.stringify(origin)}\n{}`,
		"x".repeat(16385),
		JSON.stringify({ ...origin, executable: "/untrusted/rex" }),
		JSON.stringify({ ...origin, application: { bundleId: "untrusted.application" } }),
		JSON.stringify({ ...origin, exact: { ...exact, executable: "/untrusted/rex" } }),
		JSON.stringify({ ...origin, exact: { ...exact, blockId: "label" } }),
		JSON.stringify({ ...origin, exact: { ...exact, server: "unix:///path\ncommand" } }),
		Buffer.from([0xff]),
	]) {
		const f = fake();
		const result = await terminalOriginMain(["focus"], Readable.from([input]), {}, f.run);
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.ok(result.stderr.length < 128 && result.stderr.endsWith("\n"));
		assert.equal(f.calls.length, 0);
	}
});

test("CLI prints exactly one JSON value and exits zero for capture and focus outcomes", async () => {
	const capture = await terminalOriginMain(["capture"], Readable.from([]), {}, fake().run);
	assert.deepEqual(capture, { code: 0, stdout: "null\n", stderr: "" });
	const f = fake(reply(snapshot), reply({ outcome: "focused", detail: "Block selected." }));
	const focus = await terminalOriginMain(["focus"], Readable.from([JSON.stringify(origin)]), {}, f.run);
	assert.equal(focus.code, 0);
	assert.equal(focus.stderr, "");
	assert.deepEqual(JSON.parse(focus.stdout), { outcome: "focused", detail: "Block selected." });
	assert.deepEqual(parseOrigin(JSON.stringify(origin)), origin);
});

test("import performs no subprocess or output work, even with complete launch hints", () => {
	const script = `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
cp.execFile = () => { throw new Error('Import spawned a process'); };
syncBuiltinESMExports();
await import(${JSON.stringify(new URL("./terminal-origin.ts", import.meta.url).href)});
process.stdout.write('inert');`;
	assert.equal(
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, ...env },
			encoding: "utf8",
			timeout: 10000,
			maxBuffer: 4096,
		}),
		"inert",
	);
});
