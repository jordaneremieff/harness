import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChordError } from "@earendil-works/chord";
import { connectTransport, createTransportServer } from "../../transport/index.ts";
import { HostLink } from "./client.mts";
import { CHILD, deferred, FakeHost, frame, receipt, STORAGE } from "./fake-host.mts";

const input = { operationId: "cancel-example", message: "Describe this fixture.", mode: "steer" as const };

test("local submission cancellation ends the wait without cancelling admitted work or replaying input", { timeout: 10000 }, async t => {
  const complete = deferred<void>(); const completed = deferred<void>();
  const host = await FakeHost.start({ handler: async call => {
    if (call.member !== "task-submit") return;
    await complete.promise; completed.resolve();
    return receipt(CHILD, `ui:${input.operationId}`);
  } });
  t.after(() => complete.resolve()); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const controller = new AbortController();
  const waiting = link.submit(CHILD, input, "fixture", controller.signal);
  const refused = assert.rejects(waiting, { code: "cancelled", uncertain: true });
  const admitted = await host.waitForCall(call => call.member === "task-submit");
  const cancelled = admitted.signal.aborted ? Promise.resolve() : once(admitted.signal, "abort");
  controller.abort(); await refused; await cancelled;
  assert.equal(link.connected, true); assert.equal(link.supports("task-submit"), true);
  complete.resolve(); await completed.promise;
  assert.deepEqual(await link.request("dashboard", null), []);
  assert.equal(link.submit(CHILD, input, "fixture"), waiting);
  assert.equal(host.calls.filter(call => call.member === "task-submit").length, 1);
  assert.equal(host.calls.filter(call => call.member === "abort").length, 0);
});

test("an already cancelled request never reaches the host", { timeout: 10000 }, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(link.submit(CHILD, input, "fixture", controller.signal), { code: "cancelled", uncertain: false });
  assert.deepEqual(host.calls, []);
});

for (const error of [new ChordError("unavailable", "host: refused", { reason: "claim" }),
  new ChordError("unavailable", "version: refused", { reason: "version" }),
  new ChordError("invalid", "input: refused", { reason: "payload" })]) {
  test(`a connected remote ${error.code}/${error.reason} response is not link loss`, { timeout: 10000 }, async t => {
    const host = await FakeHost.start({ handler: call => { if (call.member === "dashboard") throw error; return undefined; } });
    t.after(() => host.close()); const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
    await assert.rejects(link.request("dashboard", null), { code: error.code, reason: error.reason, message: error.message });
    assert.equal(link.connected, true); assert.equal(link.supports("dashboard"), true);
    await assert.rejects(link.request("dashboard", null), { code: error.code });
    assert.equal(host.calls.length, 2);
  });
}

test("the public operation gateway refuses a wrong contract before payload dispatch", { timeout: 10000 }, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const client = await connectTransport({ serverId: host.serverId, path: host.endpoint.socketPath });
  t.after(() => client.dispose());
  assert.equal((await client.request({ method: "runtime-contract" }) as { format: string }).format, "pi.agent.contract/1");
  await assert.rejects(client.request({ method: "task-submit", params: "invalid payload", requestId: "fixture",
    contract: { request: "task-submit/1.0.0", response: "wrong" } }), { code: "unavailable", reason: "version" });
  assert.deepEqual(host.calls, []); assert.equal(client.connected, true);
});

for (const disposeBeforeStart of [false, true]) {
  test(`observation keeps only the latest pre-start frame${disposeBeforeStart ? " and discards it on disposal" : ""}`, { timeout: 10000 }, async t => {
    const host = await FakeHost.start(); t.after(() => host.close());
    let decoded = deferred<void>();
    const link = await HostLink.connect(host.endpoint, { onMeasure: name => {
      if (name === "native.observe-frame.validate") decoded.resolve();
    } });
    t.after(() => link.close());
    const token = "buffer-token";
    await link.request("observe-open", { token, scope: "conversation", sessionId: STORAGE }, { identity: STORAGE, token });
    const seen: number[] = [];
    const sub = await link.subscribeObservation(token, value => seen.push(value.revision), STORAGE);
    assert.equal(sub.baseline.revision, 1);
    for (const revision of [2, 3, 4]) {
      decoded = deferred<void>(); await host.publish(frame(revision)); await decoded.promise;
    }
    assert.deepEqual(seen, []);
    if (disposeBeforeStart) await sub.dispose();
    sub.start(); sub.start();
    assert.deepEqual(seen, disposeBeforeStart ? [] : [4]);
    await sub.dispose(); await sub.dispose();
    await link.request("observe-close", { token }, { token });
    assert.equal(host.tokenCount, 0); assert.equal(link.connected, true);
  });
}

test("changes feed supplies a baseline and full replacement values without read invalidations", { timeout: 10000 }, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const changed = deferred<void>(); const seen: number[] = [];
  const sub = await link.subscribeChanges(revision => { seen.push(revision); if (revision === 3) changed.resolve(); });
  sub.start(); assert.deepEqual(seen, [0]);
  await link.request("dashboard", null); assert.deepEqual(seen, [0]);
  host.publishChanges(3); await changed.promise; assert.deepEqual(seen, [0, 3]);
  await sub.dispose(); assert.equal(link.connected, true);
});

test("null observation state reports unavailability without disabling the negotiated operation", { timeout: 10000 }, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const token = "unavailable-token";
  await link.request("observe-open", { token, scope: "conversation", sessionId: STORAGE }, { token, identity: STORAGE });
  const failed = deferred<Error>(); const frames: number[] = [];
  const sub = await link.subscribeObservation(token, value => frames.push(value.revision), STORAGE, failed.resolve);
  sub.start(); host.unavailable(token);
  assert.equal((await failed.promise as Error & { code: string }).code, "host_unavailable");
  assert.equal(link.supports("observe-frame"), true); assert.equal(link.connected, true);
  await host.publish(frame(8));
  await sub.dispose(); await link.request("observe-close", { token }, { token });
  assert.deepEqual(frames, []);
});

test("explicit observation close joins automatic release and acknowledges an absent token", { timeout: 10000 }, async t => {
  const gate = deferred<void>(); const entered = deferred<void>();
  const host = await FakeHost.start({ observationReleaseGate: gate.promise, onObservationRelease: () => entered.resolve() });
  t.after(() => gate.resolve()); t.after(() => host.close());
  const owner = await HostLink.connect(host.endpoint); t.after(() => owner.close());
  const foreign = await HostLink.connect(host.endpoint); t.after(() => foreign.close());
  const token = "release-token";
  await owner.request("observe-open", { token, scope: "conversation", sessionId: STORAGE }, { token, identity: STORAGE });
  const sub = await owner.subscribeObservation(token, () => {}, STORAGE);
  await sub.dispose(); await entered.promise;
  assert.equal(host.tokenCount, 1);
  await assert.rejects(foreign.request("observe-close", { token }, { token }), { code: "invalid", reason: "token" });
  let acknowledged = false;
  const closing = owner.request("observe-close", { token }, { token }).then(value => { acknowledged = true; return value; });
  const connection = host.calls.find(call => call.member === "observe-open")?.connection;
  await host.waitForCall(call => call.member === "observe-close" && call.connection === connection);
  assert.equal(acknowledged, false); assert.equal(host.tokenCount, 1);
  gate.resolve(); assert.deepEqual(await closing, { closed: false });
  assert.deepEqual(await owner.request("observe-close", { token }, { token }), { closed: false });
  assert.equal(host.tokenCount, 0); assert.equal(owner.connected, true); assert.equal(foreign.connected, true);
});

test("link loss rejects a pending feed hydration as host_unavailable", { timeout: 10000 }, async t => {
  const gate = deferred<void>(); const entered = deferred<void>();
  const host = await FakeHost.start({ subscriptionGate: gate.promise, onSubscribe: () => entered.resolve() });
  t.after(() => gate.resolve()); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const token = "pending-token";
  await link.request("observe-open", { token, scope: "conversation", sessionId: STORAGE }, { token, identity: STORAGE });
  const pending = assert.rejects(link.subscribeObservation(token, () => {}, STORAGE), { code: "host_unavailable" });
  await entered.promise;
  const closing = link.close(); await pending; gate.resolve(); await closing;
  await host.waitForRelease(); assert.equal(host.tokenCount, 0);
});

test("the UI frame bound closes an oversized peer response without replay", { timeout: 10000 }, async t => {
  const host = await FakeHost.start({ maxFrameBytes: 20 * 1024 * 1024, handler: call =>
    call.member === "dashboard" ? "x".repeat(16 * 1024 * 1024) : undefined });
  t.after(() => host.close()); const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  await assert.rejects(link.request("dashboard", null), { code: "host_unavailable", uncertain: false });
  assert.equal(link.connected, false); assert.equal(host.calls.length, 1);
});

test("runtime-contract negotiation shares the handshake deadline and releases its ready connection", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ui-negotiation-"));
  const gate = deferred<void>(); const entered = deferred<{ peerId: string; signal: AbortSignal }>();
  const released = deferred<string>(); const calls: string[] = []; let answered = false;
  const endpoint = { serverId: "negotiation-host", socketPath: join(directory, "host.sock") };
  const server = createTransportServer({ serverId: endpoint.serverId, path: endpoint.socketPath,
    request: async (request, peerId, signal) => {
      calls.push(request.method);
      if (request.method === "runtime-contract") {
        entered.resolve({ peerId, signal }); await gate.promise; answered = true;
      }
      return null;
    },
    release: peerId => released.resolve(peerId),
  });
  t.after(async () => {
    gate.resolve(); t.mock.timers.reset();
    try { await server.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await server.start(); t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const connecting = HostLink.connect(endpoint, { handshakeTimeoutMs: 30000 }).finally(() => { settled = true; });
  const refused = assert.rejects(connecting, { code: "host_unavailable", uncertain: false,
    message: "Host handshake or negotiation exceeded its deadline." });
  t.mock.timers.tick(10000);
  // Admission of this method requires the public hello and Endpoint readiness to have completed.
  const { peerId, signal } = await entered.promise;
  assert.deepEqual(calls, ["runtime-contract"]); assert.equal(signal.aborted, false);
  t.mock.timers.tick(19999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); await refused;
  assert.equal(settled, true); assert.equal(await released.promise, peerId);
  assert.equal(signal.aborted, true); assert.equal(answered, false);
  assert.deepEqual(calls, ["runtime-contract"]);
});

test("a silent socket handshake expires without dispatch or host acquisition", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "ui-silent-"));
  const server = createServer(socket => { socket.on("error", () => {}); socket.resume(); });
  const socketPath = join(directory, "s.sock"); server.listen(socketPath); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(HostLink.connect({ serverId: "silent-host", socketPath }, { handshakeTimeoutMs: 20 }), { code: "host_unavailable" });
});
