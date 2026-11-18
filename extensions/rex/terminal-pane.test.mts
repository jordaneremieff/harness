import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { focusPane, parseFocusRequest, parsePaneRequest, parseResizeRequest, resizePane, splitPane, type PaneFocusRequest, type PaneRequest, type PaneResizeRequest } from "./terminal-pane.ts";
import { trustedRexExecutable, type Runner } from "./terminal-origin.ts";

const exact = { server: "unix:///private/rex.sock", hostId: "11111111-1111-1111-1111-111111111111", instanceId: "22222222-2222-2222-2222-222222222222", sessionId: "session:33333333-3333-3333-3333-333333333333", blockId: "block:44444444-4444-4444-4444-444444444444" };
const env = { REX_SERVER: exact.server, REX_SESSION: exact.sessionId, REX_BLOCK: exact.blockId };
const origin = { version: 1 as const, terminal: "Rex" as const, application: { bundleId: "com.superlogical.rex" as const }, exact };
const request = (): PaneRequest => ({ version: 1, origin, argv: ["/Applications/Reader.app/Contents/MacOS/Reader", "--pane", "/store/opens/quoted name $(false).json"], cwd: "/work/project" });
const receipt = { server: exact.server, hostId: exact.hostId, instanceId: exact.instanceId, sessionId: exact.sessionId, anchorId: exact.blockId, windowId: "window:55555555-5555-5555-5555-555555555555", blockId: "block:66666666-6666-6666-6666-666666666666", direction: "horizontal" as const };

test("the fixed helper preserves literal argv and exact inherited IDs in one guarded mutation", async () => {
	let calls = 0;
	const run: Runner = async (executable, args, options) => {
		calls++;
		assert.equal(executable, trustedRexExecutable());
		assert.ok(args.includes(`--server=${exact.server}`));
		assert.equal(args[args.indexOf("--session") + 1], exact.sessionId);
		const payload = JSON.parse(args[args.indexOf("--args") + 1]);
		assert.deepEqual(payload.argv.slice(0, 1), ["/usr/bin/env"]);
		const offer = JSON.parse(String(payload.argv[1]).replace(/^PI_PANE_STACKING=/u, "")) as string[];
		assert.equal(offer.length, 2, "the program receives the pane stacking command of this Unix socket server");
		assert.match(offer[1] ?? "", /\/pane-stacking\.mts$/u);
		assert.deepEqual(payload.argv.slice(2), request().argv, "the program's own arguments stay literal");
		assert.equal(payload.blockId, exact.blockId);
		const script = args[args.indexOf("-e") + 1];
		assert.match(script, /s\.host_id ~= a\.hostId/u);
		assert.match(script, /anchor_id=a\.blockId/u);
		assert.match(script, /shell="none", command=a\.argv/u);
		assert.match(script, /anchorWindow ~= paneWindow/u);
		assert.match(script, /focus=false/u);
		assert.equal(Object.keys(options.env).some((key) => key.startsWith("REX_")), false);
		return { code: 0, stderr: "", stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt }) };
	};
	assert.deepEqual(await splitPane(request(), env, run), { version: 1, outcome: "created", detail: "Created.", receipt });
	assert.equal(calls, 1);
});

test("absent, application-only and mismatched launch context never create", async () => {
	let calls = 0;
	const run: Runner = async () => { calls++; throw new Error("not called"); };
	assert.equal((await splitPane({ ...request(), origin: null }, env, run)).outcome, "unavailable");
	assert.equal((await splitPane({ ...request(), origin: { version: 1, terminal: "Rex", application: origin.application } }, env, run)).outcome, "unavailable");
	for (const changed of [{}, { ...env, REX_BLOCK: "other" }, { ...env, REX_SERVER: "other" }, { ...env, REX_SESSION: "other" }]) {
		assert.equal((await splitPane(request(), changed, run)).outcome, "stale");
	}
	assert.equal(calls, 0);
});

for (const outcome of ["stale", "unavailable", "uncertain"] as const) test(`${outcome} stays explicit and triggers no retry`, async () => {
	let calls = 0;
	const run: Runner = async () => { calls++; return { code: 0, stderr: "", stdout: JSON.stringify({ outcome, detail: "Target not confirmed.", ...(outcome === "uncertain" ? { receipt } : {}) }) }; };
	const observed = await splitPane(request(), env, run);
	assert.equal(observed.outcome, outcome);
	if (outcome === "uncertain") assert.deepEqual(observed.receipt, receipt);
	assert.equal(calls, 1);
});

test("timeout, malformed acknowledgement and missing receipt remain uncertain without retry", async () => {
	for (const response of [{ code: null, failure: "timeout" as const, stdout: "", stderr: "" }, { code: 0, stdout: "not JSON", stderr: "" }, { code: 0, stdout: JSON.stringify({ outcome: "created", detail: "Created." }), stderr: "" }, { code: 0, stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt: { ...receipt, anchorId: "other" } }), stderr: "" }]) {
		let calls = 0;
		const observed = await splitPane(request(), env, async () => { calls++; return response; });
		assert.equal(observed.outcome, "uncertain");
		assert.equal(calls, 1);
	}
});

test("the subprocess reads bounded stdin and refuses a missing origin before terminal access", async () => {
	const observed = await new Promise<string>((resolve, reject) => {
		const child = execFile(process.execPath, [fileURLToPath(new URL("./terminal-pane.ts", import.meta.url)), "split"], { timeout: 7000, maxBuffer: 32768, encoding: "utf8" }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
		child.stdin?.end(JSON.stringify({ ...request(), origin: null }));
	});
	assert.equal(JSON.parse(observed).outcome, "unavailable");
});

test("request admission bounds argv, rejects NUL and requires absolute program/cwd", () => {
	for (const change of [{ argv: [] }, { argv: ["relative"] }, { argv: ["/bin/program", "\0"] }, { argv: ["/bin/program", "x".repeat(4097)] }, { argv: Array(65).fill("/bin/program") }, { cwd: "relative" }, { extra: true }, { origin: {} }]) assert.throws(() => parsePaneRequest(JSON.stringify({ ...request(), ...change })));
	assert.throws(() => parsePaneRequest(" ".repeat(16385)), /exceeds/u);
	assert.deepEqual(parsePaneRequest(JSON.stringify(request())).argv, request().argv);
});

test("placement and label admission preserves absent defaults and accepts the inclusive share range", () => {
	for (const share of [0.15, 0.5, 0.85]) {
		const parsed = parsePaneRequest(JSON.stringify({ ...request(), placement: { side: "below", share }, label: "Reader 2" }));
		assert.deepEqual(parsed.placement, { side: "below", share });
		assert.equal(parsed.label, "Reader 2");
	}
	const plain = parsePaneRequest(JSON.stringify(request()));
	assert.equal(plain.placement, undefined);
	assert.equal(plain.label, undefined);
	for (const change of [
		{ placement: null },
		{ placement: [] },
		{ placement: {} },
		{ placement: { side: "left", share: 0.5 } },
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
	]) assert.throws(() => parsePaneRequest(JSON.stringify({ ...request(), ...change })));
	const emoji = "😀".repeat(32);
	assert.equal([...emoji].length, 32);
	assert.equal(parsePaneRequest(JSON.stringify({ ...request(), label: emoji })).label, emoji);
});

test("defaults and explicit placement map to Rex direction, side, ratio and label", async () => {
	const observe = async (change: Partial<PaneRequest>) => {
		let calls = 0;
		let payload: Record<string, unknown> | undefined;
		let script = "";
		const run: Runner = async (_executable, args) => {
			calls++;
			script = args[args.indexOf("-e") + 1] ?? "";
			payload = JSON.parse(args[args.indexOf("--args") + 1]) as Record<string, unknown>;
			return { code: 0, stderr: "", stdout: JSON.stringify({ outcome: "created", detail: "Created.", receipt: { ...receipt, direction: payload.direction } }) };
		};
		assert.equal((await splitPane({ ...request(), ...change }, env, run)).outcome, "created");
		assert.equal(calls, 1);
		assert.ok(payload);
		return { payload, script };
	};
	const defaults = await observe({});
	assert.equal(defaults.payload.direction, "horizontal");
	assert.equal(defaults.payload.ratio, 0.5);
	assert.equal(defaults.payload.label, "Reader");
	const right = await observe({ placement: { side: "right", share: 0.25 } });
	assert.equal(right.payload.direction, "horizontal");
	assert.equal(right.payload.ratio, 0.75);
	assert.equal(right.payload.label, "Reader");
	const below = await observe({ placement: { side: "below", share: 0.3 }, label: "Build log" });
	assert.equal(below.payload.direction, "vertical");
	assert.equal(below.payload.ratio, 0.7);
	assert.equal(below.payload.label, "Build log");
	for (const { script } of [defaults, right, below]) {
		assert.match(script, /direction=a\.direction, side="after", ratio=a\.ratio/u);
		assert.match(script, /label=a\.label/u);
		assert.match(script, /focus=false/u);
	}
});

test("resize matches the receipt window and asks Rex to move one ordered split", async () => {
	let calls = 0;
	const request: PaneResizeRequest = { version: 1, receipt: { ...receipt, direction: "vertical" }, share: 0.185 };
	const run: Runner = async (executable, args, options) => {
		calls++;
		assert.equal(executable, trustedRexExecutable());
		assert.ok(args.includes(`--server=${exact.server}`));
		assert.equal(args[args.indexOf("--session") + 1], exact.sessionId);
		assert.equal(options.timeout, 5000);
		assert.equal(options.maxBuffer, 32768);
		assert.deepEqual(JSON.parse(args[args.indexOf("--args") + 1]), { ...request.receipt, ratio: 0.815 });
		const script = args[args.indexOf("-e") + 1];
		assert.match(script, /s\.host_id ~= a\.hostId or s\.instance_id ~= a\.instanceId/u);
		assert.match(script, /placement\(view, a\.anchorId\) ~= a\.windowId or placement\(view, a\.blockId\) ~= a\.windowId/u);
		assert.match(script, /"session\.resize_pane".*before_block_id=a\.anchorId, after_block_id=a\.blockId, direction=a\.direction, ratio=a\.ratio/u);
		return { code: 0, stdout: JSON.stringify({ outcome: "resized", detail: "Resized." }), stderr: "" };
	};
	assert.equal((await resizePane(request, env, run)).outcome, "resized");
	assert.equal((await resizePane(request, { ...env, REX_BLOCK: "other" }, run)).outcome, "stale");
	assert.equal(calls, 1);
});

test("resize rejects bad receipts and shares, and does not retry uncertain effects", async () => {
	const request: PaneResizeRequest = { version: 1, receipt, share: 0.5 };
	for (const share of [0.1, 0.9]) assert.equal(parseResizeRequest(JSON.stringify({ ...request, share })).share, share);
	for (const invalid of [{ share: 0.099 }, { share: 0.901 }, { share: "0.5" }, { receipt: { ...receipt, direction: undefined } }, { receipt: { ...receipt, blockId: receipt.anchorId } }, { receipt: { ...receipt, windowId: "window:other" } }]) {
		assert.throws(() => parseResizeRequest(JSON.stringify({ ...request, ...invalid })));
	}
	for (const outcome of ["stale", "unavailable", "uncertain"] as const) {
		let calls = 0;
		const run: Runner = async () => {
			calls++;
			return outcome === "uncertain"
				? { code: null, failure: "timeout", stdout: "", stderr: "" }
				: { code: 0, stdout: JSON.stringify({ outcome, detail: "The split is unavailable." }), stderr: "" };
		};
		assert.equal((await resizePane(request, env, run)).outcome, outcome);
		assert.equal(calls, 1);
	}
});

test("focus moves Rex focus to the receipt anchor only in the window the session shows", async () => {
	let calls = 0;
	const request: PaneFocusRequest = { version: 1, receipt: { ...receipt, direction: "vertical" } };
	const run: Runner = async (executable, args, options) => {
		calls++;
		assert.equal(executable, trustedRexExecutable());
		assert.ok(args.includes(`--server=${exact.server}`));
		assert.equal(args[args.indexOf("--session") + 1], exact.sessionId);
		assert.equal(options.timeout, 5000);
		assert.deepEqual(JSON.parse(args[args.indexOf("--args") + 1]), request.receipt);
		const script = args[args.indexOf("-e") + 1];
		assert.match(script, /s\.host_id ~= a\.hostId or s\.instance_id ~= a\.instanceId/u);
		assert.match(script, /placement\(view, a\.anchorId\) ~= a\.windowId or placement\(view, a\.blockId\) ~= a\.windowId/u);
		assert.match(script, /view\.active_window_id ~= a\.windowId/u);
		assert.match(script, /"session\.focus_block", \{session_id=a\.sessionId, block_id=a\.anchorId\}/u);
		return { code: 0, stdout: JSON.stringify({ outcome: "focused", detail: "Focused." }), stderr: "" };
	};
	assert.equal((await focusPane(request, env, run)).outcome, "focused");
	assert.equal((await focusPane(request, { ...env, REX_BLOCK: receipt.blockId }, run)).outcome, "stale");
	assert.equal(calls, 1);
});

test("focus rejects bad receipts and extra fields, and does not retry uncertain effects", async () => {
	const request: PaneFocusRequest = { version: 1, receipt };
	assert.deepEqual(parseFocusRequest(JSON.stringify(request)), request);
	for (const invalid of [{ version: 2 }, { share: 0.5 }, { receipt: { ...receipt, anchorId: "block:other" } }, { receipt: { ...receipt, blockId: receipt.anchorId } }, { receipt: undefined }]) {
		assert.throws(() => parseFocusRequest(JSON.stringify({ ...request, ...invalid })));
	}
	for (const outcome of ["stale", "unavailable", "uncertain"] as const) {
		let calls = 0;
		const run: Runner = async () => {
			calls++;
			return outcome === "uncertain"
				? { code: 0, stdout: "not json", stderr: "" }
				: { code: 0, stdout: JSON.stringify({ outcome, detail: "The session shows another window." }), stderr: "" };
		};
		assert.equal((await focusPane(request, env, run)).outcome, outcome);
		assert.equal(calls, 1);
	}
});
