import assert from "node:assert/strict";
import test from "node:test";
import { validateRequest } from "./schema.ts";
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

test("cleanup uses exact presence without fetching oversized block descriptions", async () => {
	const f = fixture({ maxOutputBytes: 4096 });
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	f.transport.handler = (method, _data, call) => {
		if (method !== "session.describe_block") return undefined;
		const description = reply({ api: { description: "x".repeat(60000) } });
		assert.ok(Buffer.byteLength(description.stdout) > call.maxOutputBytes);
		return { ...description, outcome: "output_limit", truncated: true };
	};
	const response = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	assert.equal(response.ok, true);
	assert.equal(response.effects.recordId, "close");
	assert.equal(f.transport.calls.some((call) => call.method === "session.describe_block"), false);
	assert.deepEqual(f.transport.calls.filter((call) => call.method === "target.resolve").map((call) => call.data),
		[{ kinds: ["block"], queries: [block], scope: { session } }]);
	assert.deepEqual(f.transport.calls.filter((call) => call.method === "block.close").map((call) => call.data),
		[{ session_id: session, block_id: block }]);
});

test("cleanup refuses absent, ambiguous, unavailable and mismatched exact targets before effect admission", async () => {
	for (const observed of [
		reply({ results: [{ status: "not_found" }] }),
		reply({ results: [{ status: "ambiguous" }] }),
		{ ...reply({}), outcome: "timeout" as const, exitCode: null },
		reply({ results: [{ status: "resolved", target: { block_id: block, session_id: otherSession } }] }),
		reply({ results: [{ status: "resolved", target: { block_id: "block:55555555-5555-4555-8555-555555555555", session_id: session } }] }),
	]) {
		const f = fixture();
		await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
		f.transport.handler = (method) => method === "target.resolve" ? observed : undefined;
		const response = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
		assert.equal(response.ok, false);
		assert.equal(response.effects.state, "none");
		assert.equal(f.store.state.records.length, 1);
		assert.equal(f.store.state.records[0]?.phase, "confirmed");
		assert.equal(f.transport.calls.some((call) => call.method === "block.close"), false);
	}
});

test("cleanup refuses a changed server instance before target lookup or closure", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	const run = f.transport.run.bind(f.transport);
	f.transport.run = (args, call) => args.includes("whoami")
		? Promise.resolve(reply({ endpoint: "unix:///launch", host_id: "launch-host", instance_id: "replacement" })) : run(args, call);
	const response = await f.core.execute({ op: "cleanup", recordId: "create" }, { ...context, callId: "close" });
	assert.equal(response.ok, false);
	assert.match(response.error ?? "", /server identity changed/);
	assert.equal(response.effects.state, "none");
	assert.equal(f.transport.calls.some((call) => call.method === "target.resolve" || call.method === "block.close"), false);
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
    if (method !== "target.resolve") return undefined;
    await f.store.update("owner", (state) => changeOwnership(state, "create", { note: "The claim changed during preflight." }));
    return resolveReply({ kinds: ["block"] });
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
	assert.ok(bounds.every((bound) => bound === 1022));
});

/** A terminal whose output exceeds one bounded reply, served the way Rex pages a format result. */
function longOutputFixture(lines: string[], maxBytes: number) {
	const f = fixture({ maxOutputBytes: maxBytes * 4 });
	const whole = Buffer.from(lines.join("\n"));
	const part = (offset: number, budget: number) => {
		let start = offset;
		while (start < whole.length && ((whole[start] ?? 0) & 0xc0) === 0x80) start++;
		let end = Math.min(whole.length, offset + budget);
		const cost = () => Buffer.byteLength(JSON.stringify(whole.subarray(offset, end).toString())) - 2 - 2 * (start - offset);
		while (end > start && (end < whole.length && ((whole[end] ?? 0) & 0xc0) === 0x80 || cost() > budget)) end--;
		const data = whole.subarray(offset, end).toString();
		assert.ok(cost() <= budget);
		return { data, eof: end >= whole.length };
	};
	f.transport.handler = (method, data) => {
		const args = data.args as Record<string, number>;
		if (method === "com.superlogical.terminal.format") {
			assert.equal(args.max_bytes, maxBytes - 2);
			const first = part(0, args.max_bytes);
			return reply(first.eof ? { content: first.data, total: whole.length, eof: true } : { content: first.data, total: whole.length, id: 7 });
		}
		if (method === "com.superlogical.terminal.blob_read") {
			assert.equal(args.id, 7);
			assert.ok(args.max_bytes <= maxBytes);
			return reply({ id: 7, total: whole.length, ...part(args.offset ?? 0, args.max_bytes) });
		}
		return undefined;
	};
	return { ...f, whole };
}

test("capture returns the most recent output when scrollback exceeds the bound", async () => {
	const lines = Array.from({ length: 400 }, (_, index) => `build output line ${index} with enough text to exceed the bound`);
	lines.push("READY on http://localhost:3000");
	const f = longOutputFixture(lines, 4096);
	const response = await f.core.execute({ op: "inspect", view: "capture", target }, context);
	const data = response.data as { content: string; total: number; start: number; end: number };
	assert.equal(response.ok, true);
	assert.ok(data.content.endsWith("READY on http://localhost:3000"), "the end of the output is returned");
	assert.ok(data.content.startsWith("build output line "), "the slice starts at a line boundary");
	assert.ok(Buffer.byteLength(JSON.stringify(data.content)) <= 4096);
	assert.equal(data.total, f.whole.length);
	assert.equal(data.end, f.whole.length);
	assert.equal(data.start, f.whole.length - Buffer.byteLength(data.content));
	assert.equal(response.coverage.truncated, true);
	const reads = f.transport.calls.filter((call) => call.method === "com.superlogical.terminal.blob_read");
	assert.ok(reads.length >= 1 && reads.length <= 1 + Math.ceil(Math.log2(4094)), `continuation reads: ${reads.length}`);
	assert.equal((reads[0]?.data.args as Record<string, number> | undefined)?.offset, f.whole.length - 4094);
});

test("capture keeps multibyte output whole and short output unchanged", async () => {
	const lines = Array.from({ length: 300 }, (_, index) => `ééééééééééé 日本語テキスト ${index}`);
	lines.push("END-MB");
	const long = longOutputFixture(lines, 2048);
	const data = (await long.core.execute({ op: "inspect", view: "capture", target }, context)).data as { content: string; start: number; end: number };
	assert.ok(data.content.endsWith("END-MB"));
	assert.ok(!data.content.includes("\ufffd"));
	assert.match(data.content, /^ééééééééééé 日本語テキスト \d+\n/);
	assert.equal(data.start, long.whole.length - Buffer.byteLength(data.content));
	const short = longOutputFixture(["$ npm test", "all green"], 2048);
	const response = await short.core.execute({ op: "inspect", view: "capture", target }, context);
	assert.deepEqual(response.data, { content: "$ npm test\nall green", total: short.whole.length, start: 0, end: short.whole.length });
	assert.equal(response.coverage.truncated, false);
	assert.equal(short.transport.calls.some((call) => call.method === "com.superlogical.terminal.blob_read"), false);
});

test("text readiness matches a marker printed after more output than one bounded reply", async () => {
	const lines = Array.from({ length: 400 }, (_, index) => `compiling module ${index} ... done`);
	lines.push("Local: http://localhost:5173/");
	const f = longOutputFixture(lines, 4096);
	const response = await f.core.execute({ op: "wait", condition: "text", text: "Local: http://localhost:5173/", timeoutMs: 1000, target }, context);
	assert.equal(response.outcome, "condition_observed");
	assert.equal(response.ok, true);
	assert.equal(response.coverage.truncated, true);
	const summary = await f.core.execute({ op: "inspect", view: "summary", target }, context);
	assert.ok(((summary.data as { capture: { content: string } }).capture.content).endsWith("Local: http://localhost:5173/"));
});

test("escaped and astral tails preserve fitting markers, encoded bounds and raw offsets across consumers", async () => {
	for (const prefix of ["\\".repeat(5000), '\\"'.repeat(2500), "😀".repeat(1250), "\u0001".repeat(5000)]) {
		const f = longOutputFixture([prefix + "READY"], 1024);
		const handler = f.transport.handler;
		f.transport.handler = (method, data, call) => method === "com.superlogical.terminal.process"
			? reply({ last_exit: { exit_code: 0 } }) : handler?.(method, data, call);
		const captured = await f.core.execute({ op: "inspect", view: "capture", target }, context);
		const data = captured.data as { content: string; start: number; end: number; total: number };
		assert.equal(captured.ok, true);
		assert.ok(data.content.endsWith("READY"));
		assert.ok(!data.content.includes("\ufffd"));
		assert.ok(Buffer.byteLength(JSON.stringify(data.content)) <= 1024);
		assert.equal(data.end, f.whole.length);
		assert.equal(data.total, f.whole.length);
		assert.equal(data.start, data.total - Buffer.byteLength(data.content));
		assert.equal(captured.coverage.truncated, true);
		assert.equal((await f.core.execute({ op: "wait", condition: "text", text: "READY", target }, context)).outcome, "condition_observed");
		const completed = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
		assert.equal(completed.outcome, "child_completed");
		assert.ok((completed.data as { capture: { content: string } }).capture.content.endsWith("READY"));
	}
});

test("Unicode tails preserve every byte alignment and EOF offsets across capture consumers", async () => {
	for (const prefix of ["😀".repeat(1250), "😀".repeat(1250) + "\\".repeat(200), "\ufffd".repeat(1700)]) {
		for (let padding = 0; padding < 4; padding++) {
			const f = longOutputFixture([`${prefix}${"x".repeat(padding)}READY`], 1024);
			const handler = f.transport.handler;
			f.transport.handler = (method, data, call) => method === "com.superlogical.terminal.process"
				? reply({ last_exit: { exit_code: 0 } }) : handler?.(method, data, call);
			await f.core.execute({ op: "create", kind: "session", label: "unicode" }, context);
			const capture = (await f.core.execute({ op: "inspect", view: "capture", target }, context)).data;
			const completed = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
			const observed = await f.core.execute({ op: "observe", recordId: "create", maxBytes: 1024 }, context);
			assert.equal(observed.ok, true);
			const owned = (observed.data as { reports: { observations: { capture: unknown }[] }[] }).reports[0]?.observations[0]?.capture;
			for (const value of [capture, (completed.data as { capture: unknown }).capture, owned]) {
				const data = value as { content: string; start: number; end: number; total: number };
				assert.ok(data.content.endsWith("READY"));
				assert.ok(Buffer.byteLength(JSON.stringify(data.content)) <= 1024);
				assert.equal(data.total, f.whole.length);
				assert.equal(data.end, f.whole.length);
				assert.equal(data.start, data.total - Buffer.byteLength(data.content));
				assert.equal(Buffer.compare(Buffer.from(data.content), f.whole.subarray(data.start)), 0);
			}
			assert.equal((await f.core.execute({ op: "wait", condition: "text", text: "READY", target }, context)).outcome, "condition_observed");
			const reads = f.transport.calls.filter((call) => call.method === "com.superlogical.terminal.blob_read");
			assert.ok(reads.length <= 4 * (1 + Math.ceil(Math.log2(1022))));
			assert.ok(reads.every((call) => (call.data.args as { offset: number }).offset >= f.whole.length - 1022));
		}
	}
});

test("capture refuses inconsistent snapshot identity, totals and EOF byte ranges", async () => {
	for (const change of [{ id: 8 }, { total: 1 }, { data: "x", eof: true }, { data: "x", eof: false }]) {
		const f = longOutputFixture([`${"😀".repeat(1250)}READY`], 1024);
		const handler = f.transport.handler;
		f.transport.handler = async (method, data, call) => {
			const response = await handler?.(method, data, call);
			if (method !== "com.superlogical.terminal.blob_read" || !response) return response;
			return reply({ ...JSON.parse(response.stdout), ...change });
		};
		const response = await f.core.execute({ op: "inspect", view: "capture", target }, context);
		assert.equal(response.ok, false);
		assert.match(response.error ?? "", /continuation|raw EOF range/);
		assert.equal(response.effects.state, "none");
		assert.ok(f.transport.calls.filter((call) => call.method === "com.superlogical.terminal.blob_read").length <= 11);
	}
});

test("escaped suffix search retains a complete fitting readiness marker", async () => {
	const marker = `${'\\"'.repeat(250)}READY`;
	const f = longOutputFixture(["😀".repeat(1250) + marker], 1024);
	const response = await f.core.execute({ op: "wait", condition: "text", text: marker, target }, context);
	assert.equal(response.outcome, "condition_observed");
});

test("tail line alignment preserves a fitting final marker before blank terminal rows", async () => {
	const f = longOutputFixture(["\\".repeat(5000) + "READY", "", ""], 1024);
	const response = await f.core.execute({ op: "wait", condition: "text", text: "READY", target }, context);
	assert.equal(response.outcome, "condition_observed");
});

test("child exit results carry the most recent output and survive a capture failure", async () => {
	const f = fixture();
	f.transport.handler = (method) => {
		if (method === "com.superlogical.terminal.process") return reply({ last_exit: { exit_code: 1, error: "exit status 1" } });
		if (method === "com.superlogical.terminal.format") return reply({ content: "1 failing\n  AssertionError: expected 2 to equal 3", total: 46, eof: true });
		return undefined;
	};
	const failed = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
	assert.equal(failed.outcome, "child_failed");
	const data = failed.data as { capture: { content: string; start: number; end: number }; process: { last_exit: { exit_code: number } } };
	assert.equal(data.process.last_exit.exit_code, 1);
	assert.match(data.capture.content, /AssertionError/);
	assert.equal(failed.coverage.truncated, false);
	f.transport.handler = (method) => {
		if (method === "com.superlogical.terminal.process") return reply({ last_exit: { exit_code: 0 } });
		if (method === "com.superlogical.terminal.format") return { ...reply({}), outcome: "timeout", exitCode: null };
		return undefined;
	};
	const completed = await f.core.execute({ op: "wait", condition: "child_exit", target }, context);
	assert.equal(completed.outcome, "child_completed");
	assert.equal(completed.ok, true);
	assert.equal(typeof (completed.data as { captureError?: string }).captureError, "string");
	assert.equal("capture" in (completed.data as object), false);
});

test("creation focus is explicit for windows and splits and refused for sessions", async () => {
	const f = fixture();
	await f.core.execute({ op: "create", kind: "window", label: "Tests", focus: true, target: { session } }, { ...context, callId: "window" });
	await f.core.execute({ op: "create", kind: "split", label: "Logs", target: { session, block } }, { ...context, callId: "split" });
	await f.core.execute({ op: "create", kind: "split", label: "Shown", focus: true, target: { session, block } }, { ...context, callId: "shown" });
	const focus = f.transport.calls.filter((call) => call.method === "session.new_window" || call.method === "session.new_split").map((call) => call.data.focus);
	assert.deepEqual(focus, [true, false, true]);
	const refused = await f.core.execute({ op: "create", kind: "session", label: "Project", focus: true }, { ...context, callId: "session" });
	assert.equal(refused.ok, false);
	assert.equal(refused.effects.state, "none");
	assert.match(refused.error ?? "", /focus applies to window and split/);
	assert.equal(f.transport.calls.some((call) => call.method === "session.create"), false);
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

test("configured low wait caps supply valid defaults and bound explicit timeouts with a named cap", async () => {
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
	const cappedWait = await f.core.execute({ op: "wait", condition: "child_exit", timeoutMs: 45000, target }, context);
	assert.equal(cappedWait.ok, true);
	assert.match(cappedWait.coverage.note ?? "", /requested 45000 ms deadline exceeded the configured 1000 ms cap/);
	const cappedNative = await f.core.execute({ op: "native", kind: "api", method: "new.capability", timeoutMs: 45000, target }, { ...context, callId: "native-explicit" });
	assert.equal(cappedNative.ok, true);
	assert.deepEqual(durations, [1000, 1000]);
	assert.match(cappedNative.coverage.note ?? "", /used 1000 ms/);
	assert.equal((await f.core.execute({ op: "wait", condition: "child_exit", timeoutMs: 300001, target }, context)).ok, false);
	assert.deepEqual(durations, [1000, 1000]);
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

function workProcess(index: number) {
	return index === 0 ? { child: { pid: 42 }, last_exit: null } : { last_exit: { exit_code: index === 2 ? 7 : 0 } };
}

type WorkReports = { reports: Array<{ recordId: string; phase: string; observedAt: string; complete: boolean; error?: string; observations: Array<{ resource: { blockId?: string }; presence: string; childState: string; observedAt: string; process?: { child?: { pid: number }; last_exit: { exit_code: number } | null }; processError?: string; status?: unknown; statusError?: string; capture?: { content: string }; captureError?: string; error?: string }> }> };

async function workFixture(maxOutputBytes = 32768) {
	const f = fixture({ maxOutputBytes, maxWaitMs: 1000 });
	await f.core.execute({ op: "create", kind: "session", label: "work" }, context);
	const original = f.store.state.records[0];
	assert.ok(original);
	const ids = Array.from({ length: 5 }, (_, index) => `block:33333333-3333-4333-8333-33333333333${index}`);
	f.store.state.records = ids.map((blockId, index) => ({ ...original, callId: `work-${index}`, resources: [{ kind: "block", sessionId: session, blockId }] }));
	f.transport.calls.length = 0;
	f.transport.handler = (method, data) => {
		if (method === "target.resolve" && (data.kinds as string[])[0] === "block") {
			const id = (data.queries as string[])[0];
			return reply({ results: [{ status: id === ids[3] ? "not_found" : "resolved", target: { kind: "block", block_id: id, session_id: session, window_id: window } }] });
		}
		const index = ids.indexOf(String(data.block_id));
		if (method === "com.superlogical.terminal.process") return reply(workProcess(index));
		if (method === "com.superlogical.terminal.program_status") return reply({ records: [{ state: "done", title: "not completion evidence" }] });
		if (method === "com.superlogical.terminal.format") return index === 4 ? { ...reply({}), outcome: "timeout", exitCode: null } : reply({ content: `work-${index}-tail`, total: 11, eof: true });
		return undefined;
	};
	f.store.update = async () => { throw new Error("Observation must not write ownership."); };
	return { ...f, ids };
}

test("owned observation distinguishes running, exited and absent work without changing claims", async () => {
	const f = await workFixture();
	const before = JSON.stringify(f.store.state);
	const response = await f.core.execute({ op: "observe" }, context);
	assert.equal(response.ok, true);
	assert.equal(response.outcome, "observed");
	assert.equal(response.effects.state, "none");
	assert.equal(response.coverage.totalRecords, 5);
	assert.equal(response.coverage.returnedRecords, 4);
	assert.equal(response.coverage.nextOffset, 4);
	const { reports } = response.data as WorkReports;
	assert.deepEqual(reports.map((report) => report.observations[0]?.childState), ["running", "exited", "exited", "unavailable"]);
	assert.equal(reports[3]?.observations[0]?.presence, "absent");
	for (const [index, report] of reports.entries()) {
		assert.equal(report.recordId, `work-${index}`);
		assert.equal(report.phase, "confirmed");
		assert.ok(Number.isFinite(Date.parse(report.observedAt)));
		const observed = report.observations[0];
		assert.equal(observed?.resource.blockId, f.ids[index]);
		assert.ok(Number.isFinite(Date.parse(observed?.observedAt ?? "")));
		if (index === 3) continue;
		const selected = { ...target, block: f.ids[index] };
		const process = await f.core.execute({ op: "inspect", view: "process", target: selected }, context);
		const status = await f.core.execute({ op: "inspect", view: "status", target: selected }, context);
		const capture = await f.core.execute({ op: "inspect", view: "capture", target: selected }, context);
		assert.equal(JSON.stringify(observed?.process), JSON.stringify(process.data));
		assert.equal(JSON.stringify(observed?.status), JSON.stringify(status.data));
		assert.equal(JSON.stringify(observed?.capture), JSON.stringify(capture.data));
		if (index > 0) {
			const waited = await f.core.execute({ op: "wait", condition: "child_exit", target: selected }, context);
			assert.equal(waited.outcome, index === 1 ? "child_completed" : "child_failed");
			assert.equal(observed?.process?.last_exit?.exit_code, index === 1 ? 0 : 7);
		}
	}
	assert.equal(JSON.stringify(f.store.state), before);
	const allowed = new Set(["target.resolve", "com.superlogical.terminal.process", "com.superlogical.terminal.program_status", "com.superlogical.terminal.format"]);
	assert.ok(f.transport.calls.every((call) => call.method ? allowed.has(call.method) : call.args.includes("whoami")));
});

test("owned observation preserves partial evidence and unresolved stored phases", async () => {
	const f = await workFixture();
	const failedOutput = await f.core.execute({ op: "observe", recordId: "work-4" }, context);
	assert.equal(failedOutput.outcome, "observation_incomplete");
	const observed = (failedOutput.data as WorkReports).reports[0]?.observations[0];
	assert.equal(observed?.presence, "present");
	assert.equal(observed?.childState, "exited");
	assert.equal(observed?.process?.last_exit?.exit_code, 0);
	assert.ok(observed?.status);
	assert.match(observed?.captureError ?? "", /timeout/);
	const first = f.store.state.records[0];
	assert.ok(first);
	first.phase = "pending";
	first.resources = [];
	f.transport.calls.length = 0;
	const pending = await f.core.execute({ op: "observe", recordId: "work-0", phase: "pending" }, context);
	assert.equal(pending.ok, false);
	assert.equal((pending.data as WorkReports).reports[0]?.phase, "pending");
	assert.match((pending.data as WorkReports).reports[0]?.error ?? "", /No acknowledged resource IDs/);
	assert.equal(f.transport.calls.length, 0);
	for (const recordId of ["missing", "work", "foreign"]) {
		const empty = await f.core.execute({ op: "observe", recordId }, context);
		assert.equal(empty.ok, true);
		assert.equal(empty.coverage.returnedRecords, 0);
	}
});

test("unavailable and changed servers stay unknown without erasing other observations", async () => {
	for (const failure of ["unavailable", "changed"] as const) {
		const f = await workFixture();
		const first = f.store.state.records[0];
		assert.ok(first);
		first.server = { ...first.server, endpoint: "unix:///unavailable" };
		const run = f.transport.run.bind(f.transport);
		f.transport.run = (args, call) => args.includes("unix:///unavailable")
			? Promise.resolve(failure === "unavailable" ? { ...reply({}), outcome: "spawn_error", exitCode: null, error: "server unavailable" } : reply({ endpoint: "unix:///unavailable", host_id: "changed", instance_id: "new-instance" }))
			: run(args, call);
		const response = await f.core.execute({ op: "observe", limit: 2 }, context);
		assert.equal(response.outcome, "observation_incomplete");
		const { reports } = response.data as WorkReports;
		assert.equal(reports[0]?.observations[0]?.presence, "unknown");
		assert.ok(reports[0]?.error);
		assert.equal(reports[1]?.observations[0]?.childState, "exited");
		assert.equal(reports[1]?.observations[0]?.capture?.content, "work-1-tail");
	}
});

test("observation bounds pages and shared field bytes with explicit per-field omissions", async () => {
	const f = await workFixture(4096);
	const handler = f.transport.handler;
	f.transport.handler = (method, data, call) => method === "com.superlogical.terminal.program_status" ? reply({ records: [{ msg: "x".repeat(5000) }] }) : handler?.(method, data, call);
	const response = await f.core.execute({ op: "observe", limit: 2, maxBytes: 256 }, context);
	assert.equal(response.ok, false);
	assert.equal(response.coverage.truncated, true);
	assert.equal(response.coverage.returnedRecords, 2);
	assert.equal(response.coverage.nextOffset, 2);
	assert.ok(Buffer.byteLength(JSON.stringify(response)) <= resultByteLimit(4096));
	for (const report of (response.data as WorkReports).reports) {
		assert.ok(report.observations[0]?.process);
		assert.match(report.observations[0]?.statusError ?? "", /byte budget/);
		assert.ok(report.observations[0]?.capture?.content.endsWith("tail"));
	}
	let fieldBytes = 0;
	f.transport.handler = (method, data, call) => {
		if (method === "com.superlogical.terminal.program_status") return reply({ records: [] });
		if (method === "com.superlogical.terminal.format") {
			const max = Number((data.args as { max_bytes: number }).max_bytes);
			return reply({ content: `${"x".repeat(max - 8)}READY`, total: max - 3, eof: true });
		}
		return handler?.(method, data, call);
	};
	const shared = await f.core.execute({ op: "observe", limit: 4 }, context);
	for (const report of (shared.data as WorkReports).reports) for (const entry of report.observations) {
		for (const field of [entry.process, entry.status, entry.capture]) if (field !== undefined) fieldBytes += Buffer.byteLength(JSON.stringify(field));
	}
	assert.ok(fieldBytes <= 4096);
	assert.ok((shared.data as WorkReports).reports[0]?.observations[0]?.capture?.content.endsWith("READY"));
	assert.equal((await f.core.execute({ op: "observe", limit: 5 }, context)).ok, false);
	assert.equal((await f.core.execute({ op: "observe", maxBytes: 255 }, context)).ok, false);
	const next = await f.core.execute({ op: "observe", offset: response.coverage.nextOffset, limit: 1 }, context);
	assert.equal(next.records?.[0]?.recordId, "work-2");
});

test("observation cancellation and one capped page deadline stop reads, not terminal work", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const stop of ["cancel", "deadline"] as const) {
		const f = await workFixture();
		const before = JSON.stringify(f.store.state);
		const handler = f.transport.handler;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		let active = 0;
		let maximum = 0;
		f.transport.handler = (method, data, call) => {
			if (method !== "com.superlogical.terminal.process") return handler?.(method, data, call);
			active++;
			maximum = Math.max(maximum, active);
			entered();
			return new Promise((resolve) => call.signal?.addEventListener("abort", () => { active--; resolve({ ...reply({}), outcome: "cancelled", exitCode: null }); }, { once: true }));
		};
		const controller = new AbortController();
		const pending = f.core.execute({ op: "observe", timeoutMs: 300000 }, { ...context, signal: controller.signal });
		await started;
		assert.deepEqual(f.transport.calls.filter((call) => call.method).map((call) => call.method), ["target.resolve", "com.superlogical.terminal.process"], "no other native read overlaps the blocked process read");
		const count = f.transport.calls.length;
		if (stop === "cancel") controller.abort(); else t.mock.timers.tick(1000);
		const response = await pending;
		assert.equal(response.outcome, stop === "cancel" ? "observation_cancelled" : "observation_timeout");
		assert.match(response.coverage.note ?? "", /configured 1000 ms cap/);
		assert.equal(maximum, 1);
		assert.equal(active, 0);
		assert.equal(f.transport.calls.length, count, "no later native read starts after interruption");
		assert.equal((response.data as WorkReports).reports.length, 4);
		assert.equal((response.data as WorkReports).reports[1]?.observations[0]?.presence, "unknown");
		assert.equal(JSON.stringify(f.store.state), before);
		assert.equal(f.transport.calls.some((call) => call.method === "block.close" || call.method?.endsWith(".write")), false);
	}
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

test("catalogue discovery filters literal names before bounded pages and reads fresh installed order", async () => {
	const f = fixture();
	const longName = `session.${"complete-name.".repeat(20)}open`;
	let installed = ["z.method", "session.[literal]", longName, "Session.upper", ...Array.from({ length: 58 }, (_, index) => `future.method.${index}`)];
	const run = f.transport.run.bind(f.transport);
	let reads = 0;
	f.transport.run = (args, call) => {
		if (!args.includes("list")) return run(args, call);
		assert.deepEqual(args.slice(-3), ["api", "list", "--quiet"]);
		reads++;
		return Promise.resolve({ ...reply(null), stdout: `${installed.join("\r\n")}\r\n` });
	};
	const before = structuredClone(f.store.state);
	const defaults = await f.core.execute({ op: "native", kind: "catalog" }, context);
	assert.equal(defaults.ok, true);
	assert.deepEqual((defaults.data as { methods: string[] }).methods, installed.slice(0, 50));
	assert.equal((defaults.data as { nextOffset: number }).nextOffset, 50);
	assert.equal(defaults.coverage.truncated, true);
	const first = await f.core.execute({ op: "native", kind: "catalog", query: "session.", limit: 1 }, context);
	assert.deepEqual((first.data as { methods: string[] }).methods, ["session.[literal]"]);
	assert.equal((first.data as { totalMethods: number }).totalMethods, installed.length);
	assert.equal((first.data as { matchedMethods: number }).matchedMethods, 2);
	assert.equal((first.data as { returnedMethods: number }).returnedMethods, 1);
	assert.equal((first.data as { omittedMethods: number }).omittedMethods, 1);
	assert.equal((first.data as { nextOffset: number }).nextOffset, 1);
	const second = await f.core.execute({ op: "native", kind: "catalog", query: "session.", offset: 1, limit: 1 }, context);
	assert.deepEqual((second.data as { methods: string[] }).methods, [longName]);
	assert.equal((second.data as { nextOffset?: number }).nextOffset, undefined);
	assert.equal((second.data as { omittedMethods: number }).omittedMethods, 1);
	const literal = await f.core.execute({ op: "native", kind: "catalog", query: "[" }, context);
	assert.deepEqual((literal.data as { methods: string[] }).methods, ["session.[literal]"]);
	for (const selector of [{ query: "SESSION" }, { query: "missing" }, { offset: 1048576 }]) {
		const empty = await f.core.execute({ op: "native", kind: "catalog", ...selector }, context);
		assert.equal(empty.ok, true);
		assert.deepEqual((empty.data as { methods: string[] }).methods, []);
		assert.equal((empty.data as { nextOffset?: number }).nextOffset, undefined);
	}
	const all = await f.core.execute({ op: "native", kind: "catalog", limit: 100 }, context);
	assert.deepEqual((all.data as { methods: string[] }).methods, installed);
	assert.equal(all.coverage.truncated, false);
	installed = ["session.newly-installed", "session.[literal]"];
	const fresh = await f.core.execute({ op: "native", kind: "catalog", query: "session.", limit: 1 }, context);
	assert.deepEqual((fresh.data as { methods: string[] }).methods, ["session.newly-installed"]);
	assert.equal(reads, 9);
	assert.deepEqual(f.store.state, before);
	assert.equal(fresh.effects.state, "none");
});

test("catalogue bounds and kind-specific fields are rejected without native effects", async () => {
	const f = fixture();
	for (const kind of ["describe", "api", "lua", "action"] as const) {
		for (const fields of [{ query: "method" }, { offset: 0 }, { limit: 1 }]) {
			const request = { op: "native" as const, kind, ...fields };
			assert.equal(validateRequest("rex_native", request).ok, false);
			const response = await f.core.execute(request, context);
			assert.equal(response.ok, false);
			assert.match(response.error ?? "", /only to native catalog/);
		}
	}
	assert.deepEqual(f.transport.calls, []);
	for (const fields of [{ query: "" }, { query: "x".repeat(257) }, { offset: -1 }, { offset: 1.5 }, { offset: 1048577 }, { limit: 0 }, { limit: 101 }]) {
		const request = { op: "native" as const, kind: "catalog" as const, ...fields };
		assert.equal(validateRequest("rex_native", request).ok, false);
		assert.equal((await f.core.execute(request, context)).ok, false);
	}
	assert.equal(validateRequest("rex_native", { op: "native", kind: "catalog", query: "[", offset: 0, limit: 100 }).ok, true);
	assert.equal(f.store.state.records.length, 0);
});

test("catalogue command and output-limit errors never become empty successful matches", async () => {
	for (const failure of [
		{ ...reply(null), exitCode: 2, stdout: "partial.method\n", stderr: "catalogue unavailable" },
		{ ...reply(null), outcome: "output_limit" as const, exitCode: null, truncated: true, stdout: "partial.method\n" },
		{ ...reply(null), truncated: true, stdout: "partial.method\n" },
	]) {
		const f = fixture();
		const run = f.transport.run.bind(f.transport);
		f.transport.run = (args, call) => args.includes("list") ? Promise.resolve(failure) : run(args, call);
		const response = await f.core.execute({ op: "native", kind: "catalog", query: "missing" }, context);
		assert.equal(response.ok, false);
		assert.equal(response.outcome, failure.truncated ? "output_limit" : "cli_failure");
		assert.equal(response.effects.state, "none");
		assert.equal((response.data as { methods?: unknown }).methods, undefined);
		assert.equal(f.store.state.records.length, 0);
	}
});
