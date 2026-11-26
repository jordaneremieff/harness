import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	floatPane,
	parseFloatRequest,
	parsePaneRequest,
	splitPane,
	type FloatRequest,
	type PaneRequest,
} from "./terminal-pane.ts";
import { trustedRexExecutable, type Runner } from "./terminal-origin.ts";

const exact = {
	server: "unix:///private/rex.sock",
	hostId: "11111111-1111-1111-1111-111111111111",
	instanceId: "22222222-2222-2222-2222-222222222222",
	blockId: "block:44444444-4444-4444-4444-444444444444",
};
const env = { REX_SERVER: exact.server, REX_BLOCK: exact.blockId };
const origin = {
	version: 1 as const,
	terminal: "Rex" as const,
	application: { bundleId: "com.superlogical.rex" as const },
	exact,
};
const request = (): PaneRequest => ({
	version: 1,
	origin,
	argv: ["/Applications/Reader.app/Contents/MacOS/Reader", "--pane", "/store/opens/quoted name $(false).json"],
	cwd: "/work/project",
});
const receipt = {
	server: exact.server,
	hostId: exact.hostId,
	instanceId: exact.instanceId,
	anchorId: exact.blockId,
	blockId: "block:66666666-6666-6666-6666-666666666666",
};

test("the fixed helper preserves literal argv and exact inherited IDs in one guarded mutation", async () => {
	let calls = 0;
	const run: Runner = async (executable, args, options) => {
		calls++;
		assert.equal(executable, trustedRexExecutable());
		assert.ok(args.includes(`--server=${exact.server}`));
		assert.equal(args.includes("--session"), false, "the anchor's block names its session at the time of the call");
		assert.equal(args[args.indexOf("--block") + 1], exact.blockId);
		const payload = JSON.parse(args[args.indexOf("--args") + 1]);
		assert.deepEqual(payload.argv.slice(0, 1), ["/usr/bin/env"]);
		const offer = JSON.parse(String(payload.argv[1]).replace(/^PI_PANE_STACKING=/u, "")) as string[];
		assert.equal(offer.length, 2, "the program receives the pane stacking command of this Unix socket server");
		assert.match(offer[1] ?? "", /\/pane-stacking\.mts$/u);
		assert.deepEqual(payload.argv.slice(2), request().argv, "the program's own arguments stay literal");
		assert.equal(payload.blockId, exact.blockId);
		const script = args[args.indexOf("-e") + 1];
		assert.match(script, /s\.host_id ~= a\.hostId/u);
		assert.match(script, /local session = rex\.session_id/u);
		assert.match(script, /session_id=session, anchor_id=a\.blockId/u);
		assert.match(script, /shell="none", command=a\.argv/u);
		assert.match(script, /anchorWindow ~= paneWindow/u);
		assert.match(script, /focus=false/u);
		assert.equal(
			Object.keys(options.env).some((key) => key.startsWith("REX_")),
			false,
		);
		return { code: 0, stderr: "", stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt }) };
	};
	assert.deepEqual(await splitPane(request(), env, run), {
		version: 1,
		outcome: "created",
		detail: "Created.",
		receipt,
	});
	assert.equal(calls, 1);
});

test("absent, application-only and mismatched launch context never create", async () => {
	let calls = 0;
	const run: Runner = async () => {
		calls++;
		throw new Error("not called");
	};
	assert.equal((await splitPane({ ...request(), origin: null }, env, run)).outcome, "unavailable");
	assert.equal(
		(
			await splitPane(
				{ ...request(), origin: { version: 1, terminal: "Rex", application: origin.application } },
				env,
				run,
			)
		).outcome,
		"unavailable",
	);
	for (const changed of [{}, { ...env, REX_BLOCK: "other" }, { ...env, REX_SERVER: "other" }]) {
		assert.equal((await splitPane(request(), changed, run)).outcome, "stale");
	}
	assert.equal(calls, 0);
	const created = { code: 0, stderr: "", stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt }) };
	assert.equal(
		(await splitPane(request(), { ...env, REX_SESSION: "session:other" }, async () => created)).outcome,
		"created",
		"a launch session does not name the pane: its tab can move to another session",
	);
});

for (const outcome of ["stale", "unavailable", "uncertain"] as const)
	test(`${outcome} stays explicit and triggers no retry`, async () => {
		let calls = 0;
		const run: Runner = async () => {
			calls++;
			return {
				code: 0,
				stderr: "",
				stdout: JSON.stringify({
					outcome,
					detail: "Target not confirmed.",
					...(outcome === "uncertain" ? { receipt } : {}),
				}),
			};
		};
		const observed = await splitPane(request(), env, run);
		assert.equal(observed.outcome, outcome);
		if (outcome === "uncertain") assert.deepEqual(observed.receipt, receipt);
		assert.equal(calls, 1);
	});

test("timeout, malformed acknowledgement and missing receipt remain uncertain without retry", async () => {
	for (const response of [
		{ code: null, failure: "timeout" as const, stdout: "", stderr: "" },
		{ code: 0, stdout: "not JSON", stderr: "" },
		{ code: 0, stdout: JSON.stringify({ outcome: "created", detail: "Created." }), stderr: "" },
		{
			code: 0,
			stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt: { ...receipt, anchorId: "other" } }),
			stderr: "",
		},
	]) {
		let calls = 0;
		const observed = await splitPane(request(), env, async () => {
			calls++;
			return response;
		});
		assert.equal(observed.outcome, "uncertain");
		assert.equal(calls, 1);
	}
});

test("the subprocess reads bounded stdin and refuses a missing origin before terminal access", async () => {
	const observed = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[fileURLToPath(new URL("./terminal-pane.ts", import.meta.url)), "split"],
			{ timeout: 7000, maxBuffer: 32768, encoding: "utf8" },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
		child.stdin?.end(JSON.stringify({ ...request(), origin: null }));
	});
	assert.equal(JSON.parse(observed).outcome, "unavailable");
});

test("request admission bounds argv, rejects NUL and requires absolute program/cwd", () => {
	for (const change of [
		{ argv: [] },
		{ argv: ["relative"] },
		{ argv: ["/bin/program", "\0"] },
		{ argv: ["/bin/program", "x".repeat(4097)] },
		{ argv: Array(65).fill("/bin/program") },
		{ cwd: "relative" },
		{ extra: true },
		{ origin: {} },
	])
		assert.throws(() => parsePaneRequest(JSON.stringify({ ...request(), ...change })));
	assert.throws(() => parsePaneRequest(" ".repeat(16385)), /exceeds/u);
	assert.deepEqual(parsePaneRequest(JSON.stringify(request())).argv, request().argv);
});

test("placement and label admission preserves absent defaults and accepts the inclusive share range", () => {
	for (const share of [0.15, 0.5, 0.85]) {
		const parsed = parsePaneRequest(
			JSON.stringify({ ...request(), placement: { side: "left", share }, label: "Reader 2" }),
		);
		assert.deepEqual(parsed.placement, { side: "left", share });
		assert.equal(parsed.label, "Reader 2");
	}
	const plain = parsePaneRequest(JSON.stringify(request()));
	assert.equal(plain.placement, undefined);
	assert.equal(plain.label, undefined);
	for (const change of [
		{ placement: null },
		{ placement: [] },
		{ placement: {} },
		{ placement: { side: "above", share: 0.5 } },
		{ placement: { side: "below", share: 0.5 } },
		{ placement: { side: "right" } },
		{ placement: { side: "right", share: "0.5" } },
		{ placement: { side: "right", share: 0.149 } },
		{ placement: { side: "right", share: 0.851 } },
		{ placement: { side: "right", share: null } },
		{ placement: { side: "right", share: 0.5, extra: true } },
		{ label: "" },
		{ label: "x".repeat(33) },
		{ label: "line\nbreak" },
		{ label: "\u0000" },
		{ label: "\u200b" },
		{ label: "\ud800" },
	])
		assert.throws(() => parsePaneRequest(JSON.stringify({ ...request(), ...change })));
	const emoji = "😀".repeat(32);
	assert.equal([...emoji].length, 32);
	assert.equal(parsePaneRequest(JSON.stringify({ ...request(), label: emoji })).label, emoji);
});

test("defaults and explicit placement map to a horizontal Rex split with side, ratio and label", async () => {
	const observe = async (change: Partial<PaneRequest>) => {
		let calls = 0;
		let payload: Record<string, unknown> | undefined;
		let script = "";
		const run: Runner = async (_executable, args) => {
			calls++;
			script = args[args.indexOf("-e") + 1] ?? "";
			payload = JSON.parse(args[args.indexOf("--args") + 1]) as Record<string, unknown>;
			return {
				code: 0,
				stderr: "",
				stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt }),
			};
		};
		assert.equal((await splitPane({ ...request(), ...change }, env, run)).outcome, "created");
		assert.equal(calls, 1);
		assert.ok(payload);
		return { payload, script };
	};
	const defaults = await observe({});
	assert.equal(defaults.payload.ratio, 0.5);
	assert.equal(defaults.payload.label, "Reader");
	const left = await observe({ placement: { side: "left", share: 0.25 }, label: "Build log" });
	assert.equal(left.payload.side, "before");
	assert.equal(left.payload.ratio, 0.25);
	assert.equal(left.payload.label, "Build log");
	const right = await observe({ placement: { side: "right", share: 0.25 } });
	assert.equal(right.payload.ratio, 0.75);
	assert.equal(right.payload.label, "Reader");
	for (const { payload } of [defaults, right]) assert.equal(payload.side, "after");
	for (const { script } of [defaults, left, right]) {
		assert.match(script, /direction="horizontal", side=a\.side, ratio=a\.ratio/u);
		assert.match(script, /label=a\.label/u);
		assert.match(script, /focus=false/u);
	}
});

test("a gone anchor block is stale for split, without retry", async () => {
	let calls = 0;
	const gone =
		(block: string): Runner =>
		async () => {
			calls++;
			return { code: 3, failure: "failed", stdout: "", stderr: `Error: block target "${block}" not found\n` };
		};
	assert.equal((await splitPane(request(), env, gone(exact.blockId))).outcome, "stale");
	assert.equal(calls, 1);
	assert.equal(
		(await splitPane(request(), env, gone("block:other"))).outcome,
		"uncertain",
		"another failure after dispatch stays uncertain",
	);
});

const floatRequest = (): FloatRequest => ({
	version: 1,
	origin,
	argv: ["/opt/pi/bin/pi", "--troll", "session-1", "--", `a "quoted" $(false) instruction ${"x".repeat(5000)}`],
	cwd: "/work/project",
	bounds: [0.01, 0.016, 0.32, 0.52],
	label: "Troll",
});
const floatReceipt = {
	server: exact.server,
	hostId: exact.hostId,
	instanceId: exact.instanceId,
	anchorId: exact.blockId,
	blockId: "block:77777777-7777-7777-7777-777777777777",
	layerId: "layer:88888888-8888-8888-8888-888888888888",
};

test("float creates one floating layer in the anchor's tab and runs the program through the account shell", async () => {
	let calls = 0;
	const run: Runner = async (executable, args, options) => {
		calls++;
		assert.equal(executable, trustedRexExecutable());
		assert.ok(args.includes(`--server=${exact.server}`));
		assert.equal(args[args.indexOf("--block") + 1], exact.blockId);
		const payload = JSON.parse(args[args.indexOf("--args") + 1]);
		assert.deepEqual(payload.argv, floatRequest().argv, "the program's arguments stay literal and unwrapped");
		assert.deepEqual(payload.bounds, floatRequest().bounds);
		assert.equal(payload.square, false);
		assert.equal(payload.label, "Troll");
		const script = args[args.indexOf("-e") + 1];
		assert.match(script, /s\.host_id ~= a\.hostId/u);
		assert.match(script, /session\.new_layer", \{session_id=session, window_id=window, bounds=bounds, focus=false/u);
		assert.match(script, /if a\.square then/u);
		assert.match(script, /method="size"/u);
		assert.match(script, /command=a\.argv, cwd=a\.cwd, interactive=true/u);
		assert.doesNotMatch(script, /shell="none"/u);
		assert.match(script, /placement\(after, receipt\.blockId\) ~= window/u);
		assert.equal(
			Object.keys(options.env).some((key) => key.startsWith("REX_")),
			false,
		);
		return {
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt: floatReceipt }),
		};
	};
	assert.deepEqual(await floatPane(floatRequest(), env, run), {
		version: 1,
		outcome: "created",
		detail: "Created.",
		receipt: floatReceipt,
	});
	assert.equal(calls, 1);
});

test("float refuses bounds outside the tab, oversized arguments and unknown fields", () => {
	for (const bounds of [
		[0, 0, 1],
		[0, 0, 0.05, 0.5],
		[0.5, 0, 0.6, 0.5],
		[0, 0.6, 0.5, 0.5],
		[-0.1, 0, 0.5, 0.5],
		[0, 0, Number.NaN, 0.5],
		"0,0,1,1",
	]) {
		assert.throws(() => parseFloatRequest(JSON.stringify({ ...floatRequest(), bounds })), /Float bounds/u);
	}
	assert.throws(() => parseFloatRequest(JSON.stringify({ ...floatRequest(), argv: ["pi"] })), /absolute program/u);
	assert.throws(
		() => parseFloatRequest(JSON.stringify({ ...floatRequest(), argv: ["/bin/pi", "x".repeat(8193)] })),
		/bounded/u,
	);
	assert.throws(() => parseFloatRequest(JSON.stringify({ ...floatRequest(), placement: {} })), /Invalid float/u);
	assert.throws(() => parseFloatRequest(JSON.stringify({ ...floatRequest(), square: false })), /Invalid float/u);
	assert.equal(parseFloatRequest(JSON.stringify({ ...floatRequest(), square: true })).square, true);
	assert.equal(Object.hasOwn(parseFloatRequest(JSON.stringify(floatRequest())), "square"), false);
	assert.deepEqual(parseFloatRequest(JSON.stringify({ ...floatRequest(), bounds: [0, 0, 1, 1] })).bounds, [0, 0, 1, 1]);
});

test("float never creates without the captured origin and keeps uncertain results explicit", async () => {
	let calls = 0;
	const never: Runner = async () => {
		calls++;
		throw new Error("not called");
	};
	assert.equal((await floatPane({ ...floatRequest(), origin: null }, env, never)).outcome, "unavailable");
	assert.equal((await floatPane(floatRequest(), { ...env, REX_BLOCK: "other" }, never)).outcome, "stale");
	assert.equal(calls, 0);
	for (const receipt of [
		undefined,
		{ ...floatReceipt, anchorId: "block:99999999-9999-9999-9999-999999999999" },
		{ ...floatReceipt, layerId: "layer:short" },
		{ ...floatReceipt, extra: true },
	]) {
		const run: Runner = async () => ({
			code: 0,
			stderr: "",
			stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt }),
		});
		assert.equal((await floatPane(floatRequest(), env, run)).outcome, "uncertain");
	}
	const gone: Runner = async () => ({
		code: 3,
		failure: "failed",
		stdout: "",
		stderr: `Error: block target "${exact.blockId}" not found\n`,
	});
	assert.equal((await floatPane(floatRequest(), env, gone)).outcome, "stale");
});
