import assert from "node:assert/strict";
import test from "node:test";
import { boundResult, resultByteLimit, RexCore } from "./core.ts";
import type { RexCallContext, RexResult } from "./core.ts";
import { changeOwnership, initialOwnershipState, validateOwnershipState } from "./ownership.ts";
import type { OwnershipState, OwnershipStore } from "./ownership.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

const session = "session:11111111-1111-4111-8111-111111111111";
const window = "window:22222222-2222-4222-8222-222222222222";
const block = "block:33333333-3333-4333-8333-333333333333";
const otherSession = "session:44444444-4444-4444-8444-444444444444";
const target = { server: "launch", session, block, source: "explicit" as const };
const context: RexCallContext = { ownerId: "owner", callId: "create", cwd: process.cwd() };
function reply(value: unknown): CliResult {
	return {
		outcome: "exited",
		exitCode: 0,
		signal: null,
		stdout: JSON.stringify(value),
		stderr: "",
		bytes: 0,
		truncated: false,
		started: true,
	};
}
function storeFixture(): OwnershipStore & { state: OwnershipState } {
	let tail = Promise.resolve();
	return {
		state: initialOwnershipState(),
		async read() {
			return structuredClone(this.state);
		},
		update(_owner, change) {
			const next = tail.then(() => {
				this.state = change(this.state);
				return structuredClone(this.state);
			});
			tail = next.then(
				() => {},
				() => {},
			);
			return next;
		},
	};
}
class FakeTransport implements RexTransport {
	calls: { args: readonly string[]; method?: string; data: Record<string, unknown> }[] = [];
	handler?: (
		method: string,
		data: Record<string, unknown>,
		call: CliCall,
	) => CliResult | undefined | Promise<CliResult | undefined>;
	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		const index = args.indexOf("call");
		const method = index >= 0 ? args[index + 1] : undefined;
		const data = index >= 0 ? (JSON.parse(args[index + 2] ?? "{}") as Record<string, unknown>) : {};
		this.calls.push({ args, method, data });
		if (args.includes("whoami")) return serverIdentityReply(args);
		const handled = method ? await this.handler?.(method, data, call) : undefined;
		if (handled) return handled;
		if (method === "target.resolve") return resolveReply(data);
		if (method === "session.create")
			return reply({ session_id: session, initial_windows: [{ window_id: window, block_ids: [block] }] });
		if (method === "session.new_window") return reply({ window_id: window, block_ids: [block] });
		if (method === "session.describe_block") return reply({ block: { block_id: block, window_id: window } });
		if (method === "session.list_blocks") return reply({ blocks: [{ block_id: block, window_id: window }] });
		if (method === "com.superlogical.terminal.process") return reply({ last_exit: null, child: { pid: 42 } });
		return reply({});
	}
	dispose() {}
}
function serverIdentityReply(args: readonly string[]): CliResult {
	const selected = args[args.indexOf("--server") + 1];
	return reply({
		endpoint: selected === "other" ? "unix:///other" : "unix:///launch",
		host_id: selected === "other" ? "other-host" : "launch-host",
		instance_id: "instance",
	});
}
function resolveReply(data: Record<string, unknown>): CliResult {
	const kind = (data.kinds as string[])[0];
	const ids: Record<string, string> = { session, window, block };
	return reply({
		results: [
			{
				status: "resolved",
				target: {
					kind,
					label: "work",
					session_id: session,
					...(kind === "block" ? { window_id: window } : {}),
					[`${kind}_id`]: ids[kind ?? ""],
				},
			},
		],
	});
}
function fixture(options: { server?: string; maxRecords?: number; maxOutputBytes?: number; maxWaitMs?: number; isCallActive?: (ownerId: string, callId: string) => boolean } = {}) {
	const store = storeFixture();
	const transport = new FakeTransport();
	const core = new RexCore({
		store,
		transport,
		isCallActive: () => false,
		...options,
		env: { REX_SERVER: "launch", REX_SESSION: session, REX_BLOCK: block },
	});
	return { core, store, transport };
}

test("creation retains pending intent before its external effect and refuses same-call replay", async () => {
	const f = fixture();
	f.transport.handler = (method) => {
		if (method === "session.create") assert.equal(f.store.state.records[0]?.phase, "pending");
		return undefined;
	};
	const request = {
		op: "create" as const,
		kind: "session" as const,
		label: "project",
		command: ["node", "server.mjs"],
		shell: "none",
	};
	const created = await f.core.execute(request, context);
	assert.equal(created.outcome, "created");
	assert.equal(created.target?.blockId, block);
	assert.equal(f.store.state.records[0]?.phase, "confirmed");
	const creation = f.transport.calls.find((call) => call.method === "session.create");
	assert.ok(creation);
	const windows = creation.data.initial_windows as Array<{ layout: { block: { options: Record<string, unknown> } } }>;
	assert.equal(windows[0]?.layout.block.options.shell, "none");
	assert.equal(windows[0]?.layout.block.options.login, false);
	const auto = fixture();
	await auto.core.execute({ op: "create", kind: "session", label: "auto-shell", command: ["node", "server.mjs"] }, context);
	const autoCreation = auto.transport.calls.find((call) => call.method === "session.create");
	assert.ok(autoCreation);
	const autoWindows = autoCreation.data.initial_windows as Array<{ layout: { block: { options: Record<string, unknown> } } }>;
	assert.equal(autoWindows[0]?.layout.block.options.login, undefined);
	assert.equal(autoWindows[0]?.layout.block.options.shell, undefined);
	const replay = await f.core.execute(request, context);
	assert.equal(replay.ok, false);
	assert.match(replay.error ?? "", /do not replay/);
	assert.equal(f.transport.calls.filter((call) => call.method === "session.create").length, 1);
});

test("unacknowledged creation remains unknown and never retries automatically", async () => {
	const f = fixture();
	f.transport.handler = (method) =>
		method === "session.create" ? { ...reply({}), outcome: "timeout", exitCode: null } : undefined;
	const request = { op: "create" as const, kind: "session" as const, label: "project" };
	const first = await f.core.execute(request, context);
	assert.equal(first.effects.state, "unknown");
	assert.equal(f.store.state.records[0]?.phase, "unknown");
	await f.core.execute(request, context);
	assert.equal(f.transport.calls.filter((call) => call.method === "session.create").length, 1);
});

test("configured and explicit remote servers never receive inherited local IDs", async () => {
	for (const configured of [true, false]) {
		const f = fixture(configured ? { server: "other" } : {});
		const response = await f.core.execute(
			{ op: "inspect", ...(configured ? {} : { target: { server: "other" } }) },
			context,
		);
		assert.equal(response.ok, false);
		assert.match(response.error ?? "", /differs from the launch server/);
		assert.equal(
			f.transport.calls.some((call) => call.method === "target.resolve"),
			false,
		);
	}
});

test("explicit remote blocks do not acquire inherited session or block selectors", async () => {
	const f = fixture({ server: "other" });
	const response = await f.core.execute({ op: "inspect", view: "process", target: { block } }, context);
	assert.equal(response.ok, true);
	const lookups = f.transport.calls.filter((call) => call.method === "target.resolve");
	assert.deepEqual(
		lookups.map((call) => call.data.kinds),
		[["block"]],
	);
	assert.equal(lookups[0]?.data.scope, undefined);
});

test("named-session focus is deliberate and conflicting explicit anchors are refused", async () => {
	const f = fixture();
	assert.equal(
		(await f.core.execute({ op: "inspect", view: "process", target: { session, source: "focus" } }, context)).ok,
		true,
	);
	const lookup = f.transport.calls.filter((call) => call.method === "target.resolve").at(-1);
	assert.deepEqual(lookup?.data.queries, [""]);
	assert.deepEqual(lookup?.data.scope, { session });
	f.transport.handler = (method, data) =>
		method === "target.resolve" && (data.kinds as string[])[0] === "block"
			? reply({
					results: [
						{
							status: "resolved",
							target: { kind: "block", block_id: block, session_id: otherSession, label: "wrong" },
						},
					],
				})
			: undefined;
	const conflict = await f.core.execute({ op: "inspect", target }, context);
	assert.match(conflict.error ?? "", /outside the explicit session/);
});

test("server aliases do not bypass the launch-block input guard", async () => {
	const f = fixture();
	const response = await f.core.execute({ op: "input", target, text: "danger" }, context);
	assert.equal(response.ok, false);
	assert.match(response.error ?? "", /terminal that hosts this agent/);
	assert.equal(
		f.transport.calls.some((call) => call.method === "com.superlogical.terminal.write"),
		false,
	);
});

test("the reserved ownership slot permits cleanup at the creation capacity", async () => {
	const f = fixture({ maxRecords: 2 });
	const create = { op: "create" as const, kind: "session" as const, label: "work" };
	assert.equal((await f.core.execute(create, context)).ok, true);
	assert.equal((await f.core.execute(create, { ...context, callId: "second" })).ok, false);
	const closed = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	assert.equal(closed.ok, true);
	assert.equal(f.store.state.records.length, 2);
	assert.ok(f.store.state.records.every((record) => record.phase === "closed"));
	assert.deepEqual(
		f.transport.calls.filter((call) => call.method === "block.close").map((call) => call.data),
		[{ session_id: session, block_id: block }],
	);
	assert.equal(
		f.transport.calls.some((call) => call.method === "session.destroy"),
		false,
	);
	assert.equal(
		(await f.core.execute({ op: "cleanup", recordId: "close", forget: true }, { ...context, callId: "forget" })).ok,
		true,
	);
});

test("copied claims do not transfer cleanup rights and repeated cleanup does not race unknown effects", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	const copied = await f.core.execute(
		{ op: "cleanup", recordId: "create" },
		{ ...context, ownerId: "fork", callId: "fork-close" },
	);
	assert.equal(copied.ok, false);
	f.transport.handler = (method) =>
		method === "block.close" ? { ...reply({}), outcome: "timeout", exitCode: null } : undefined;
	const unknown = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	assert.equal(unknown.effects.state, "unknown");
	const repeated = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "new-close" });
	assert.equal(repeated.ok, false);
	assert.equal(f.transport.calls.filter((call) => call.method === "block.close").length, 1);
});

test("current child snapshots establish fast completion and distinguish nonzero failure", async () => {
	const f = fixture();
	for (const code of [0, 7]) {
		f.transport.handler = (method) =>
			method === "com.superlogical.terminal.process" ? reply({ last_exit: { exit_code: code } }) : undefined;
		const response = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
		assert.equal(response.outcome, code === 0 ? "child_completed" : "child_failed");
		assert.equal(response.ok, code === 0);
	}
	assert.equal(
		f.transport.calls.some((call) => call.args.includes("wait")),
		false,
	);
});

test("unknown claims require deliberate release before forgetting and never become success", async () => {
	const f = fixture({ maxRecords: 2 });
	f.transport.handler = (method) =>
		method === "session.create" ? { ...reply({}), outcome: "timeout", exitCode: null } : undefined;
	await f.core.execute({ op: "create", kind: "session", label: "uncertain" }, context);
	assert.equal(
		(await f.core.execute({ op: "cleanup", recordId: "create", forget: true }, { ...context, callId: "early-forget" }))
			.ok,
		false,
	);
	assert.equal(
		(await f.core.execute({ op: "reconcile", recordId: "create", release: true }, { ...context, callId: "no-note" }))
			.ok,
		false,
	);
	const released = await f.core.execute(
		{
			op: "reconcile",
			recordId: "create",
			release: true,
			note: "I inspected and handled the native effects; this claim no longer owns terminal work.",
		},
		{ ...context, callId: "release" },
	);
	assert.equal(released.outcome, "claim_released");
	assert.equal(f.store.state.records[0]?.phase, "released");
	const repeated = await f.core.execute({ op: "create", kind: "session", label: "uncertain" }, context);
	assert.equal(repeated.ok, false);
	assert.equal(
		(await f.core.execute({ op: "cleanup", recordId: "create", forget: true }, { ...context, callId: "forget" })).ok,
		true,
	);
	assert.equal(f.store.state.records.length, 0);
	assert.equal(f.transport.calls.filter((call) => call.method === "session.create").length, 1);
});

test("failed intent persistence prevents all native effects", async () => {
	const f = fixture();
	f.store.update = async () => {
		throw new Error("persistence unavailable");
	};
	const response = await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	assert.equal(response.ok, false);
	assert.match(response.error ?? "", /persistence unavailable/);
	assert.equal(
		f.transport.calls.some((call) => call.method === "session.create"),
		false,
	);
});

test("explicit recovery distinguishes present, absent and uncertain owned blocks without replay", async () => {
	for (const presence of ["present", "absent", "unknown"] as const) {
		const f = fixture();
		await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
		f.transport.handler = (method) =>
			method === "block.close" ? { ...reply({}), outcome: "timeout", exitCode: null } : undefined;
		await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
		f.transport.handler = (method) => {
			if (method !== "target.resolve") return undefined;
			if (presence === "absent") return reply({ results: [{ status: "not_found" }] });
			if (presence === "unknown")
				return { ...reply({}), outcome: "timeout", exitCode: null, stderr: "exact connection failure" };
			return undefined;
		};
		const recovered = await f.core.execute(
			{ op: "reconcile", recordId: "create", recover: true },
			{ ...context, callId: "recover" },
		);
		assert.equal(recovered.ok, presence !== "unknown");
		assert.equal(
			f.store.state.records[0]?.phase,
			presence === "present" ? "confirmed" : presence === "absent" ? "closed" : "unknown",
		);
		assert.equal(f.transport.calls.filter((call) => call.method === "block.close").length, 1);
		if (presence === "present") {
			f.transport.handler = undefined;
			assert.equal(
				(await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "new-close" })).ok,
				true,
			);
			assert.equal(f.transport.calls.filter((call) => call.method === "block.close").length, 2);
		}
	}
});

test("an active cleanup producer prevents recovery and a second cleanup across core instances", async () => {
  let active = true;
  const f = fixture({ isCallActive: (_owner, callId) => active && callId === "close" });
  await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.transport.handler = async (method) => {
    if (method !== "block.close") return undefined;
    enter();
    await gate;
    return reply({});
  };
  const cleanup = f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
  await entered;
  const other = new RexCore({ store: f.store, transport: f.transport, isCallActive: (_owner, callId) => active && callId === "close", env: { REX_SERVER: "launch" } });
  try {
    const recovery = await other.execute({ op: "reconcile", recordId: "create", recover: true }, { ...context, callId: "recover" });
    assert.equal(recovery.outcome, "cleanup_still_active_or_unknown");
    const second = await other.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "second-close" });
    assert.equal(second.ok, false);
    assert.equal(f.transport.calls.filter((call) => call.method === "block.close").length, 1);
  } finally { release(); await cleanup; active = false; }
});

test("cleanup refuses ownership state that changes after resource preflight", async () => {
  const f = fixture();
  await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
  f.transport.handler = async (method) => {
    if (method !== "session.describe_block") return undefined;
    await f.store.update("owner", (state) => changeOwnership(state, "create", { note: "The claim changed during preflight." }));
    return reply({ block: { block_id: block } });
  };
  const response = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
  assert.equal(response.ok, false);
  assert.match(response.error ?? "", /ownership changed after preflight/);
  assert.equal(f.transport.calls.some((call) => call.method === "block.close"), false);
});

test("child observer timeouts stay distinct from cancellation and execution failure", async () => {
  const f = fixture({ maxOutputBytes: 4096 });
  const run = f.transport.run.bind(f.transport);
  for (const outcome of ["timeout", "cancelled", "spawn_error"] as const) {
    f.transport.run = (args, call) => args.includes("wait") ? Promise.resolve({ ...reply({}), outcome, exitCode: null }) : run(args, call);
    const response = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
    assert.equal(response.outcome, outcome === "spawn_error" ? "observation_failed" : outcome);
    assert.equal(response.effects.state, "none");
  }
});

test("reconciliation failures stay incomplete and preserve exact identities and errors", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	f.transport.handler = (method) =>
		method === "target.resolve"
			? { ...reply({}), outcome: "timeout", exitCode: null, stderr: "exact connection failure" }
			: undefined;
	const response = await f.core.execute({ op: "reconcile", recordId: "create" }, context);
	assert.equal(response.ok, false);
	assert.equal(response.outcome, "reconciliation_incomplete");
	assert.equal(response.error, "exact connection failure");
	assert.equal(response.records?.[0]?.resources[0]?.blockId, block);
	assert.equal(f.store.state.records[0]?.phase, "confirmed");
});

test("owned records use bounded pages with exact omission counts", async () => {
	const f = fixture();
	for (let index = 0; index < 6; index++)
		await f.core.execute({ op: "create", kind: "session", label: "work" }, { ...context, callId: `create-${index}` });
	const first = await f.core.execute({ op: "owned" }, context);
	assert.equal(first.coverage.totalRecords, 6);
	assert.equal(first.coverage.returnedRecords, 4);
	assert.equal(first.coverage.omittedRecords, 2);
	assert.equal(first.coverage.nextOffset, 4);
	const second = await f.core.execute({ op: "owned", offset: 4 }, context);
	assert.equal(second.coverage.returnedRecords, 2);
	assert.equal(second.coverage.omittedRecords, 4);
	assert.equal(second.coverage.nextOffset, undefined);
});

test("complete tool results omit bulk data at the aggregate cap while preserving target and effects", async () => {
	const f = fixture({ maxOutputBytes: 4096 });
	f.transport.handler = (method) => (method !== "target.resolve" && method !== "session.list_blocks" ? reply({ bulk: "x".repeat(60000) }) : undefined);
	const response = await f.core.execute({ op: "inspect", view: "summary", target }, context);
	assert.equal(response.ok, true);
	assert.equal(response.target?.blockId, block);
	assert.equal(response.effects.state, "none");
	assert.equal(response.coverage.dataOmitted, true);
	assert.equal(response.coverage.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096 + 98304);
});

test("odd output limits produce integer default capture and text-wait byte bounds", async () => {
	const f = fixture({ maxOutputBytes: 4097 });
	f.transport.handler = (method) => method === "com.superlogical.terminal.format" ? reply({ content: "ready", eof: true }) : undefined;
	assert.equal((await f.core.execute({ op: "inspect", view: "summary", target }, context)).ok, true);
	assert.equal((await f.core.execute({ op: "inspect", view: "capture", target }, context)).ok, true);
	assert.equal((await f.core.execute({ op: "wait", condition: "text", text: "ready", target }, context)).ok, true);
	const bounds = f.transport.calls.filter((call) => call.method === "com.superlogical.terminal.format").map((call) => (call.data.args as Record<string, unknown>).max_bytes);
	assert.ok(bounds.length >= 3);
	assert.ok(bounds.every((bound) => bound === 1024));
});

test("cleanup acknowledgement preserves released original and attempt claims without revival", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	f.transport.handler = async (method) => {
		if (method !== "block.close") return undefined;
		enter();
		await gate;
		return reply({});
	};
	const cleanup = f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	await entered;
	try {
		for (const recordId of ["create", "close"]) {
			const released = await f.core.execute({ op: "reconcile", recordId, release: true, note: "I release this bookkeeping claim; native work remains independent." }, { ...context, callId: `release-${recordId}` });
			assert.equal(released.ok, true);
		}
	} finally { release(); await cleanup; }
	assert.ok(f.store.state.records.every((record) => record.phase === "released"));
	const recovery = await f.core.execute({ op: "reconcile", recordId: "create", recover: true }, { ...context, callId: "recover" });
	assert.equal(recovery.ok, false);
	assert.equal(recovery.outcome, "claim_released");
	assert.equal(f.store.state.records[0]?.phase, "released");
});

test("recovery rechecks cleanup producer activity inside the ownership transaction", async () => {
	let active = false;
	const f = fixture({ isCallActive: (_owner, callId) => active && callId === "close" });
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	f.transport.handler = (method) => method === "block.close" ? { ...reply({}), outcome: "timeout", exitCode: null } : undefined;
	await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	f.transport.handler = undefined;
	const update = f.store.update.bind(f.store);
	f.store.update = (owner, change) => { active = true; return update(owner, change); };
	const recovered = await f.core.execute({ op: "reconcile", recordId: "create", recover: true }, { ...context, callId: "recover" });
	assert.equal(recovered.ok, false);
	assert.match(recovered.error ?? "", /active or unknown at recovery admission/);
	assert.equal(f.store.state.records[0]?.phase, "unknown");
});

test("aggregate native-data omission retains the outer-CLI-only qualification", async () => {
	const f = fixture({ maxOutputBytes: 4096 });
	f.transport.handler = (method) => method === "new.capability" ? reply({ failed: true, bulk: "x".repeat(200000) }) : undefined;
	const response = await f.core.execute({ op: "native", kind: "api", method: "new.capability", target }, context);
	assert.equal(response.ok, true);
	assert.equal(response.coverage.dataOmitted, true);
	assert.match(response.effects.note ?? "", /Outer CLI success only/);
	assert.match(response.effects.note ?? "", /No inner application outcome was established/);
	assert.equal(response.target?.blockId, block);
});

test("queued cancellation prevents release, recovery and forgetting at state admission", async () => {
	for (const operation of ["release", "recover", "forget"] as const) {
		const f = fixture();
		await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
		if (operation === "forget") await f.store.update("owner", (state) => changeOwnership(state, "create", { phase: "released" }));
		const before = structuredClone(f.store.state);
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const update = f.store.update.bind(f.store);
		f.store.update = async (owner, change) => { enter(); await gate; return update(owner, change); };
		const controller = new AbortController();
		const call = { ...context, callId: operation, signal: controller.signal };
		const request = operation === "forget"
			? { op: "cleanup" as const, recordId: "create", forget: true }
			: { op: "reconcile" as const, recordId: "create", release: operation === "release", recover: operation === "recover", note: "I release only the retained claim." };
		const pending = f.core.execute(request, call);
		await entered;
		controller.abort();
		release();
		const response = await pending;
		assert.equal(response.ok, false);
		assert.equal(response.outcome, "cancelled");
		assert.deepEqual(f.store.state, before);
	}
});

test("configured low wait caps supply valid defaults without weakening explicit timeout bounds", async () => {
	const f = fixture({ maxWaitMs: 1000 });
	const durations: number[] = [];
	f.transport.handler = (method, _data, call) => {
		if (method === "com.superlogical.terminal.process") return reply({ last_exit: { exit_code: 0 } });
		if (method === "new.capability") { durations.push(call.timeoutMs); return reply({}); }
		return undefined;
	};
	assert.equal((await f.core.execute({ op: "wait", condition: "child_exit", target }, context)).ok, true);
	assert.equal((await f.core.execute({ op: "native", kind: "api", method: "new.capability", target }, { ...context, callId: "native-default" })).ok, true);
	assert.deepEqual(durations, [1000]);
	assert.equal((await f.core.execute({ op: "wait", condition: "child_exit", timeoutMs: 1001, target }, context)).ok, false);
	assert.equal((await f.core.execute({ op: "native", kind: "api", method: "new.capability", timeoutMs: 1001, target }, { ...context, callId: "native-explicit" })).ok, false);
	assert.deepEqual(durations, [1000]);
});

test("native actions distinguish absent arguments from explicit objects without changing Lua", async () => {
	const f = fixture();
	const inputs: Array<Record<string, unknown> | undefined> = [undefined, {}, { mode: "explicit" }];
	for (const [index, args] of inputs.entries()) {
		const response = await f.core.execute({ op: "native", kind: "action", action: "com.superlogical.terminal.reset", target, ...(args === undefined ? {} : { args }) }, { ...context, callId: `action-${index}` });
		assert.equal(response.ok, true);
		const command = f.transport.calls.at(-1)?.args;
		assert.ok(command);
		const position = command.indexOf("--args");
		if (args === undefined) assert.equal(position, -1);
		else {
			assert.ok(position >= 0);
			assert.deepEqual(JSON.parse(command[position + 1] ?? ""), args);
		}
	}
	for (const [index, args] of inputs.entries()) {
		const response = await f.core.execute({ op: "native", kind: "lua", code: "return rex.args", target, ...(args === undefined ? {} : { args }) }, { ...context, callId: `lua-${index}` });
		assert.equal(response.ok, true);
		const command = f.transport.calls.at(-1)?.args;
		assert.ok(command);
		const position = command.indexOf("--args");
		assert.ok(position >= 0);
		assert.deepEqual(JSON.parse(command[position + 1] ?? ""), args ?? {});
	}
});

test("default summary uses narrow metadata at the configured default byte budget", async () => {
	const f = fixture({ maxOutputBytes: 32768 });
	const metadata = { block_id: block, window_id: window, label: "project", creator_name: "com.superlogical.terminal", placement: "placed" };
	const handle = (method: string) => {
		if (method === "session.list_blocks") return reply({ blocks: [metadata] });
		if (method === "session.describe_block") return reply({ block: metadata, api: { methods: { custom: { description: "x".repeat(60000) } }, events: { changed: {} } } });
		return undefined;
	};
	f.transport.handler = handle;
	const summary = await f.core.execute({ op: "inspect", view: "summary", target }, context);
	assert.equal(summary.ok, true);
	const data = summary.data as Record<string, unknown>;
	assert.deepEqual(data.description, { block: metadata });
	assert.equal(f.transport.calls.some((call) => call.method === "session.describe_block"), false);
	assert.equal(JSON.stringify(summary).includes('"methods"'), false);
	const broad = fixture({ maxOutputBytes: 65536 });
	broad.transport.handler = handle;
	const explicit = await broad.core.execute({ op: "native", kind: "api", method: "session.describe_block", args: { session_id: session, block_id: block }, target }, { ...context, callId: "describe-explicit" });
	assert.equal(explicit.ok, true);
	const native = explicit.data as { value: { api: { methods: { custom: { description: string } } } } };
	assert.equal(native.value.api.methods.custom.description.length, 60000);
});

test("unsupported retained metadata is refused before any owned closure", async () => {
	for (const location of ["state", "record", "server", "resource"] as const) {
		const f = fixture();
		await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
		const entry = f.store.state.records[0];
		assert.ok(entry);
		const resource = entry.resources[0];
		assert.ok(resource);
		Object.assign({ state: f.store.state, record: entry, server: entry.server, resource }[location], { unsupported: "x".repeat(200000) });
		const response = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
		assert.equal(response.ok, false);
		assert.match(response.error ?? "", /unsupported fields/);
		assert.equal(response.effects.state, "none");
		assert.equal(f.transport.calls.some((call) => call.method === "block.close"), false);
	}
});

test("canonical bounds encoded diagnostics without changing post-effect outcome or identity", async () => {
	const f = fixture({ maxOutputBytes: 32768 });
	f.transport.handler = (method) => method === "new.capability" ? { ...reply({}), exitCode: 1, stderr: "\u0001".repeat(32768) } : undefined;
	const response = await f.core.execute({ op: "native", kind: "api", method: "new.capability", target }, context);
	assert.equal(response.ok, false);
	assert.equal(response.outcome, "cli_failure");
	assert.equal(response.effects.state, "unknown");
	assert.equal(response.effects.recordId, context.callId);
	assert.equal(response.target?.blockId, block);
	assert.equal(f.store.state.records[0]?.phase, "unknown");
	assert.ok(response.coverage.truncatedFields?.includes("error"));
	assert.ok(Buffer.byteLength(JSON.stringify(response.error)) <= 4096);
	assert.match(response.error ?? "", /\[truncated\]$/);
	assert.ok(Buffer.byteLength(JSON.stringify(response)) <= resultByteLimit(32768));
	assert.equal(f.transport.calls.filter((call) => call.method === "new.capability").length, 1);
});

function maximumIdentityEnvelope(): RexResult {
	const surrogate = "\ud800";
	const server = { endpoint: surrogate.repeat(4096), selection: surrogate.repeat(4096), hostId: surrogate.repeat(128), instanceId: surrogate.repeat(128) };
	const resources = Array.from({ length: 32 }, () => ({ kind: "block" as const, sessionId: session, windowId: window, blockId: block }));
	const state = validateOwnershipState({ version: 1, records: Array.from({ length: 4 }, (_, index) => ({
		callId: `${index}${surrogate.repeat(1023)}`, ownerId: "owner", requestDigest: "a".repeat(64), server,
		operation: "create", phase: "unknown", resources, createdAt: "2026-11-02", updatedAt: "2026-11-02",
	})) });
	return { ok: true, outcome: "acknowledged", target: { server, source: "explicit", sessionId: session, windowId: window, blockId: block, clientId: "client:55555555-5555-4555-8555-555555555555" },
		data: { bulk: "x".repeat(200000) }, error: "\u0001".repeat(32768),
		effects: { state: "confirmed", recordId: surrogate.repeat(1024), resources, note: `Outer CLI success only. No inner application outcome was established. ${"\u0001".repeat(2048)}` },
		records: state.records.map((record) => ({ recordId: record.callId, server: record.server, resources: record.resources })),
		coverage: { bounded: true, pageOffset: 8, totalRecords: 256, returnedRecords: 4, omittedRecords: 252, nextOffset: 12, note: "😀".repeat(4096) } };
}

test("irreducible valid identity metadata fits the minimum budget with exact reference pagination", () => {
	const original = maximumIdentityEnvelope();
	for (const budget of [resultByteLimit(4096), resultByteLimit(32768)]) {
		const bounded = boundResult(original, budget);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= budget);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 97864);
		assert.equal(bounded.ok, original.ok);
		assert.equal(bounded.outcome, original.outcome);
		assert.deepEqual(bounded.target, original.target);
		assert.deepEqual(bounded.effects.resources, original.effects.resources);
		assert.equal(bounded.effects.recordId, original.effects.recordId);
		assert.equal(bounded.effects.state, original.effects.state);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded.error)) <= 4096);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded.effects.note)) <= 1024);
		assert.ok(Buffer.byteLength(JSON.stringify(bounded.coverage.note)) <= 1024);
		const emitted = bounded.records?.length ?? 0;
		assert.equal(bounded.coverage.emittedRecordRefs, emitted);
		assert.equal(bounded.coverage.omittedRecordRefs, 4 - emitted);
		assert.deepEqual(bounded.coverage.omittedRecordIds, original.records?.slice(emitted).map((record) => record.recordId));
		assert.deepEqual(bounded.records, original.records?.slice(0, emitted));
		assert.equal(bounded.coverage.returnedRecords, 4);
		assert.equal(bounded.coverage.omittedRecords, 252);
		assert.equal(bounded.coverage.nextPageOffset, 12);
		assert.equal(bounded.coverage.nextOffset, 8 + emitted);
		assert.match(bounded.coverage.note ?? "", /recordId/);
		assert.match(bounded.coverage.note ?? "", /does not establish an inner application outcome/);
		assert.match(bounded.effects.note ?? "", /Outer CLI success only/);
		assert.equal(/\p{Cs}/u.test(bounded.coverage.note ?? ""), false);
		assert.deepEqual(boundResult(bounded, budget), bounded);
	}
});

test("repeated canonical reduction accumulates omitted identities without pagination skips", () => {
	const original = maximumIdentityEnvelope();
	const partial = boundResult(original, resultByteLimit(100000));
	assert.ok((partial.records?.length ?? 0) > 0);
	assert.ok((partial.coverage.omittedRecordRefs ?? 0) > 0);
	const smaller = boundResult({ ...partial, data: { bulk: "x".repeat(200000) } }, resultByteLimit(4096));
	assert.deepEqual(smaller.coverage.omittedRecordIds, original.records?.map((record) => record.recordId));
	assert.equal(smaller.coverage.omittedRecordRefs, 4);
	assert.equal(smaller.coverage.emittedRecordRefs, 0);
	assert.equal(smaller.coverage.nextPageOffset, 12);
	assert.equal(smaller.coverage.nextOffset, 8);
	assert.equal(smaller.coverage.returnedRecords, 4);
	assert.equal(smaller.coverage.omittedRecords, 252);
	assert.ok(Buffer.byteLength(JSON.stringify(smaller)) <= resultByteLimit(4096));
	const lastPage = { ...original, coverage: { ...original.coverage, totalRecords: 12, omittedRecords: 8, nextOffset: undefined } };
	const partialLast = boundResult(lastPage, resultByteLimit(100000));
	const smallerLast = boundResult(partialLast, resultByteLimit(4096));
	assert.equal(smallerLast.coverage.nextPageOffset, undefined);
	assert.equal(smallerLast.coverage.nextOffset, 8);
	assert.deepEqual(smallerLast.coverage.omittedRecordIds, original.records?.map((record) => record.recordId));
});

test("reference omission preserves an earlier partial-observation continuation", () => {
	const original = maximumIdentityEnvelope();
	for (const [offset, observed] of [[8, 1], [0, 0]] as const) {
		const interrupted: RexResult = { ...original, ok: false, outcome: "reconciliation_incomplete", target: undefined, effects: { state: "none" },
			coverage: { ...original.coverage, pageOffset: offset, returnedRecords: observed, omittedRecords: 256 - observed, nextOffset: offset + observed } };
		const reduced = boundResult(interrupted, resultByteLimit(100000));
		assert.ok((reduced.coverage.emittedRecordRefs ?? 0) > observed);
		assert.ok((reduced.coverage.omittedRecordRefs ?? 0) > 0);
		assert.equal(reduced.coverage.nextPageOffset, offset + observed);
		assert.equal(reduced.coverage.nextOffset, offset + observed);
		assert.equal(reduced.coverage.returnedRecords, observed);
		assert.equal(reduced.coverage.omittedRecords, 256 - observed);
		assert.equal(reduced.ok, false);
		assert.equal(reduced.effects.state, "none");
	}
});

test("unsupported irreducible metadata reports an explicit post-effect boundary instead of false no-effect output", () => {
	const invalid = maximumIdentityEnvelope();
	invalid.records = [];
	if (invalid.target) invalid.target.server.endpoint = "x".repeat(200000);
	assert.throws(() => boundResult(invalid, resultByteLimit(32768)), /Native effects may already exist: outcome=acknowledged; effectState=confirmed; recordId=/);
});

test("raw API JSON remains lossless and conflicting native target arguments are refused", async () => {
	const f = fixture();
	const args = { session_id: session, block_id: block, args: { null: null, empty: [], object: {} } };
	await f.core.execute({ op: "native", kind: "api", method: "new.capability", args, target }, context);
	assert.deepEqual(f.transport.calls.find((call) => call.method === "new.capability")?.data, args);
	const conflict = await f.core.execute(
		{ op: "native", kind: "api", method: "new.capability", args: { session_id: otherSession }, target },
		{ ...context, callId: "conflict" },
	);
	assert.equal(conflict.ok, false);
	assert.match(conflict.error ?? "", /conflicts with the resolved target/);
});

test("owned lookup filters this owner's stored claims before pagination without CLI or writes", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	const original = f.store.state.records[0];
	assert.ok(original);
	const phases = ["pending", "confirmed", "unknown", "closed", "released", "unknown"] as const;
	f.store.state.records = phases.map((phase, index) => ({ ...original, callId: `complete-record-identity-${index}`, phase }));
	f.store.state.records.push({ ...original, callId: "foreign-record", ownerId: "foreign", phase: "unknown" });
	const before = structuredClone(f.store.state);
	f.transport.calls.length = 0;
	f.store.update = async () => { throw new Error("Owned lookup must not write."); };
	const first = await f.core.execute({ op: "owned", phase: "unknown", limit: 1 }, context);
	assert.equal(first.ok, true);
	assert.deepEqual(first.records?.map((record) => record.recordId), ["complete-record-identity-2"]);
	assert.equal(first.coverage.totalRecords, 2);
	assert.equal(first.coverage.returnedRecords, 1);
	assert.equal(first.coverage.omittedRecords, 1);
	assert.equal(first.coverage.nextOffset, 1);
	assert.equal((first.data as { inheritedRecords: number }).inheritedRecords, 1);
	assert.match((first.data as { note: string }).note, /not current presence or cleanup permission/);
	const second = await f.core.execute({ op: "owned", phase: "unknown", offset: 1, limit: 1 }, context);
	assert.equal(second.ok, true);
	assert.deepEqual(second.records?.map((record) => record.recordId), ["complete-record-identity-5"]);
	assert.equal(second.coverage.nextOffset, undefined);
	for (const phase of phases) {
		const response = await f.core.execute({ op: "owned", phase }, context);
		assert.equal(response.ok, true);
		assert.ok((response.data as { records: Array<{ phase: string }> }).records.every((record) => record.phase === phase));
	}
	const exact = await f.core.execute({ op: "owned", recordId: "complete-record-identity-2", phase: "unknown" }, context);
	assert.equal(exact.ok, true);
	assert.equal(exact.coverage.totalRecords, 1);
	assert.equal(exact.records?.[0]?.resources[0]?.blockId, block);
	for (const selector of [{ recordId: "missing" }, { recordId: "foreign-record" }, { recordId: "complete-record-identity" }, { recordId: "complete-record-identity-2", phase: "closed" as const }, { phase: "unknown" as const, offset: 2 }]) {
		const empty = await f.core.execute({ op: "owned", ...selector }, context);
		assert.equal(empty.ok, true);
		assert.deepEqual(empty.records, []);
		assert.equal(empty.coverage.returnedRecords, 0);
		assert.equal(empty.coverage.nextOffset, undefined);
	}
	assert.deepEqual(f.transport.calls, []);
	assert.deepEqual(f.store.state, before);
});

test("owned filtered continuation uses filtered offsets after aggregate reference omission", async () => {
	const f = fixture({ maxOutputBytes: 4096 });
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	const original = f.store.state.records[0];
	assert.ok(original);
	const envelope = maximumIdentityEnvelope();
	assert.ok(envelope.target);
	const server = envelope.target.server;
	f.store.state.records = [original, ...Array.from({ length: 4 }, (_, index) => ({ ...original, callId: `unknown-${index}`, phase: "unknown" as const, server, resources: envelope.effects.resources ?? [] }))];
	const before = structuredClone(f.store.state);
	f.transport.calls.length = 0;
	const page = await f.core.execute({ op: "owned", phase: "unknown" }, context);
	assert.equal(page.ok, true);
	assert.equal(page.coverage.totalRecords, 4);
	assert.equal(page.coverage.returnedRecords, 4);
	assert.equal(page.coverage.dataOmitted, true);
	const emitted = page.records?.length ?? 0;
	assert.ok(emitted > 0 && emitted < 4);
	assert.equal(page.coverage.nextOffset, emitted);
	assert.deepEqual(page.coverage.omittedRecordIds, Array.from({ length: 4 - emitted }, (_, index) => `unknown-${index + emitted}`));
	const next = await f.core.execute({ op: "owned", phase: "unknown", offset: page.coverage.nextOffset, limit: 1 }, context);
	assert.equal(next.records?.[0]?.recordId, `unknown-${emitted}`);
	assert.deepEqual(f.transport.calls, []);
	assert.deepEqual(f.store.state, before);
});
