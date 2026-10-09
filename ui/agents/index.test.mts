import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createAgentService, deriveEndpoint } from "./index.mts";
import { deferred, descriptor, FakeHost, frame, receipt } from "./fake-host.mts";

const storageId = "00000000-0000-4000-8000-000000000001";
const input = { operationId: "operation-example", message: "An exact retained input.", mode: "steer" as const };
const hasCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code: string }).code, code); return true;
};
async function stored(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "ui-service-"));
  await mkdir(join(directory, "durable"));
  const record = { storageId, cwd: directory, agentDir: directory, packageDir: directory,
    storagePath: join(directory, "durable", `${storageId}.sqlite`),
    model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(join(directory, "durable", `${storageId}.json`), JSON.stringify(record));
  const service = createAgentService({ store: directory, installationId: "fixture-installation" });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, directory };
}

test("catalog refresh is explicit and cached roster stays readable after close", async t => {
  const { service } = await stored(t);
  assert.equal(service.roster().scan.state, "not-started");
  assert.deepEqual(service.roster().rows, []);
  await service.refresh();
  assert.equal(service.roster().rows[0].id, storageId);
  await service.close();
  assert.equal(service.roster().rows[0].id, storageId);
  assert.throws(() => service.refresh(), hasCode("not_ready"));
});

test("offline selection and history refuse without host acquisition", async t => {
  const { service } = await stored(t);
  await service.refresh();
  await assert.rejects(service.select("workspace", storageId), hasCode("stored"));
  await assert.rejects(service.history(storageId), hasCode("stored"));
  await assert.rejects(service.abort(storageId), hasCode("stored"));
  assert.equal(service.roster().rows[0].state, "unavailable");
});

test("operation keys preserve exact text and target across offline failure", async t => {
  const { service } = await stored(t);
  await service.refresh();
  const original = service.submit(storageId, input);
  const repeated = service.submit(storageId, { ...input });
  assert.equal(original, repeated);
  await assert.rejects(original, hasCode("stored"));
  await assert.rejects(service.submit(storageId, { ...input, message: "Changed text" }), hasCode("operation_conflict"));
  await assert.rejects(service.submit(`${storageId}:2`, input), hasCode("operation_conflict"));
  await assert.rejects(service.retrySubmit(storageId, { ...input, mode: "followUp" }), hasCode("operation_conflict"));
  await assert.rejects(service.retrySubmit(storageId, input), hasCode("stored"));
});

test("inputs and inspection cursors reject before any host connection", async t => {
  const { service } = await stored(t);
  await service.refresh();
  for (const candidate of [{ ...input, message: " " }, { ...input, message: "x".repeat(65537) }, { ...input, operationId: "bad/key" }]) {
    await assert.rejects(service.submit(storageId, candidate), hasCode("invalid_request"));
  }
  await assert.rejects(service.history(storageId, { limit: 101 }), hasCode("invalid_request"));
  await assert.rejects(service.inspect(storageId, { view: "exact" }), hasCode("invalid_request"));
  await assert.rejects(service.inspect(storageId, { view: "result" }), hasCode("invalid_request"));
  await assert.rejects(service.inspect(storageId, { view: "history", cursor: { text: "x".repeat(4096) } }), hasCode("invalid_request"));
  for (const identity of ["../escape", `${storageId}:1`, `${storageId}:02`, `${storageId}:9007199254740992`]) {
    await assert.rejects(service.history(identity), hasCode("invalid_request"));
  }
});

async function liveFixture(t: { after(fn: () => Promise<void>): void }, options: Parameters<typeof FakeHost.start>[0] = {}) {
  const { service, directory } = await stored(t);
  // A short ephemeral private directory keeps the contract-derived socket below its path bound.
  const agentDir = await mkdtemp("/tmp/ui-agent-");
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const record = { storageId, cwd: directory, agentDir, packageDir: directory,
    storagePath: join(directory, "durable", `${storageId}.sqlite`), model: { provider: "fixture", modelId: "fixture" },
    thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(join(directory, "durable", `${storageId}.json`), JSON.stringify(record));
  const endpoint = deriveEndpoint(record);
  await mkdir(dirname(endpoint.socketPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(endpoint.claimPath), { recursive: true, mode: 0o700 });
  await writeFile(endpoint.claimPath, JSON.stringify({ sessionId: storageId, cwd: directory,
    host: hostname(), createdAt: "2026-01-01T00:00:00.000Z", pid: process.pid }), { mode: 0o600 });
  const host = await FakeHost.start({ ...options, endpoint });
  t.after(() => host.close());
  await service.refresh();
  return { service, host, endpoint, record, directory };
}

async function changedEndpoint(t: { after(fn: () => Promise<void>): void }, fixture: Awaited<ReturnType<typeof liveFixture>>) {
  const { service, record, directory } = fixture;
  const changed = { ...record, cwd: join(directory, "new-project") };
  await mkdir(changed.cwd);
  const endpoint = deriveEndpoint(changed);
  await mkdir(dirname(endpoint.claimPath), { recursive: true, mode: 0o700 });
  await writeFile(endpoint.claimPath, JSON.stringify({ sessionId: storageId, cwd: changed.cwd,
    host: hostname(), createdAt: "2026-01-01T00:00:00.000Z", pid: process.pid }), { mode: 0o600 });
  const replacement = await FakeHost.start({ endpoint });
  t.after(() => replacement.close());
  await writeFile(join(directory, "durable", `${storageId}.json`), JSON.stringify(changed));
  await service.refresh();
  return replacement;
}

test("live workspaces pool one endpoint and release only their own observations", async t => {
  const { service, host } = await liveFixture(t);
  await Promise.all([service.select("first", storageId), service.select("second", `${storageId}:2`)]);
  assert.equal(host.connectionCount, 1);
  assert.equal(host.tokenCount, 2);
  await service.disconnectWorkspace("first");
  assert.equal(host.tokenCount, 1);
  assert.equal(host.connectionCount, 1);
  await service.disconnectWorkspace("second");
  await host.waitForRelease();
  assert.equal(host.connectionCount, 0);
  assert.equal(host.tokenCount, 0);
});

test("uncertain input reconnects and retries only through the explicit original key action", async t => {
  const held = deferred<ReturnType<typeof receipt>>();
  let first = true;
  const { service, host } = await liveFixture(t, { handler: call => {
    if (call.member === "task-submit" && first) { first = false; return held.promise; }
    return undefined;
  } });
  await service.select("workspace", storageId);
  const pending = service.submit(storageId, input);
  const rejected = assert.rejects(pending, hasCode("host_unavailable"));
  await host.waitForCall(call => call.member === "task-submit");
  await host.disconnect(); await rejected;
  held.resolve(receipt(storageId, `ui:${input.operationId}`));
  await host.waitForRelease();
  await assert.rejects(service.submit(storageId, input), hasCode("host_unavailable"));
  assert.equal(host.calls.filter(call => call.member === "task-submit").length, 1);
  await service.reconnect("workspace");
  const admission = await service.retrySubmit(storageId, input);
  assert.equal(admission.result.requestId, `ui:${input.operationId}`);
  const calls = host.calls.filter(call => call.member === "task-submit");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, calls[1].params);
  assert.equal(calls[0].wireRequestId, calls[1].wireRequestId);
  await assert.rejects(service.retrySubmit(storageId, { ...input, message: "Edited text" }), hasCode("operation_conflict"));
});

test("target re-entry opens a fresh connection and a fresh frame epoch after disconnect", async t => {
  const epochs: number[] = [];
  const directory = await mkdtemp(join(tmpdir(), "ui-frame-service-"));
  const agentDir = await mkdtemp("/tmp/ui-agent-");
  const record = { storageId, cwd: directory, agentDir, packageDir: directory,
    storagePath: join(directory, "durable", `${storageId}.sqlite`), model: { provider: "fixture", modelId: "fixture" },
    thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
  const endpoint = deriveEndpoint(record);
  await mkdir(join(directory, "durable"));
  await writeFile(join(directory, "durable", `${storageId}.json`), JSON.stringify(record));
  await mkdir(dirname(endpoint.socketPath), { recursive: true });
  await mkdir(dirname(endpoint.claimPath), { recursive: true });
  await writeFile(endpoint.claimPath, JSON.stringify({ sessionId: storageId, cwd: directory,
    host: hostname(), createdAt: "2026-01-01T00:00:00.000Z", pid: process.pid }));
  const next = deferred<void>();
  const service = createAgentService({ store: directory, installationId: "fixture-installation", onFrame: (_workspace, _identity, epoch) => {
    epochs.push(epoch); if (epochs.length === 2) next.resolve();
  } });
  const host = await FakeHost.start({ endpoint, subscriptionFrame: () => frame(3) });
  t.after(async () => { await service.close(); await host.close(); await rm(directory, { recursive: true, force: true }); await rm(agentDir, { recursive: true, force: true }); });
  await service.refresh(); await service.select("workspace", storageId);
  await new Promise<void>(resolve => setImmediate(resolve));
  await host.disconnect(); await host.waitForRelease();
  await service.select("workspace", storageId); await next.promise;
  assert.deepEqual(epochs, [1, 2]);
  assert.equal(host.lifecycle.filter(event => event.kind === "connect").length, 2);
});

test("close rejects pending snapshot setup without waiting for its host response", { timeout: 10000 }, async t => {
  const held = deferred<Record<string, never>>();
  const { service, host } = await liveFixture(t, { handler: call => call.member === "snapshot" ? held.promise : undefined });
  const selected = service.select("workspace", storageId);
  const rejected = assert.rejects(selected, hasCode("host_unavailable"));
  await host.waitForCall(call => call.member === "snapshot");
  await host.waitForCall(call => call.member === "observe-open");
  try {
    await service.close();
    await rejected;
    assert.equal(service.roster().rows[0].id, storageId);
  } finally { held.resolve({}); }
  await host.waitForRelease();
  assert.equal(host.tokenCount, 0);
  assert.equal(host.connectionCount, 0);
});

test("prepare negotiates one shared link without selection or observation and submit reuses it", async t => {
  const { service, host } = await liveFixture(t);
  const [root, child] = await Promise.all([service.prepare(storageId), service.prepare(`${storageId}:2`)]);
  assert.deepEqual(root, child);
  assert.equal(root["task-submit"], true);
  assert.equal(root["observe-open"], true);
  assert.equal(host.connectionCount, 1);
  assert.equal(host.tokenCount, 0);
  assert.equal(host.calls.length, 0);
  await service.prepare(storageId);
  await service.submit(`${storageId}:2`, input);
  assert.equal(host.connectionCount, 1);
  assert.deepEqual(host.calls.map(call => call.member), ["task-submit"]);
  assert.equal(host.calls[0].params?.sessionId, `${storageId}:2`);
  assert.equal(host.tokenCount, 0);
  await service.disconnectWorkspace("workspace");
  await host.waitForRelease();
  assert.equal(host.connectionCount, 0);
});

test("prepare refuses stored and unknown hosts without selecting or opening an observation", async t => {
  const { service } = await stored(t);
  await service.refresh();
  await assert.rejects(service.prepare(storageId), hasCode("stored"));
  await assert.rejects(service.prepare("unknown-storage"), hasCode("host_unavailable"));
  assert.equal(service.roster().rows[0].state, "unavailable");
});

test("prepare returns negotiated operation support without requiring observation support", async t => {
  const remote = await descriptor();
  const operations = remote.operations as Record<string, unknown>;
  delete operations["observe-open"]; delete operations["task-submit"];
  const { service, host } = await liveFixture(t, { descriptor: remote });
  const capabilities = await service.prepare(storageId);
  assert.equal(capabilities["observe-open"], false);
  assert.equal(capabilities["task-submit"], false);
  assert.equal(capabilities.abort, true);
  assert.deepEqual(host.calls, []); assert.equal(host.tokenCount, 0);
});

test("prepare refuses an incompatible host contract without observation", async t => {
  const { service, host } = await liveFixture(t, { descriptor: { format: "unknown" } });
  await assert.rejects(service.prepare(storageId), hasCode("protocol_error"));
  await host.waitForRelease();
  assert.deepEqual(host.calls, []); assert.equal(host.tokenCount, 0);
});

test("prepare reconnects a dropped link without observing or replaying admitted input", async t => {
  const { service, host } = await liveFixture(t);
  const first = await service.prepare(storageId);
  await service.submit(storageId, input);
  await host.disconnect(); await host.waitForRelease();
  const second = await service.prepare(storageId);
  assert.deepEqual(second, first); assert.equal(second["task-submit"], true);
  assert.equal(host.lifecycle.filter(event => event.kind === "connect").length, 2);
  assert.equal(host.connectionCount, 1); assert.equal(host.tokenCount, 0);
  assert.deepEqual(host.calls.map(call => call.member), ["task-submit"]);
});

test("prepare preserves a connected observation and never reopens a disconnected observation", async t => {
  const { service, host } = await liveFixture(t);
  await service.select("workspace", storageId);
  const calls = host.calls.length;
  await service.prepare(storageId);
  assert.equal(host.connectionCount, 1); assert.equal(host.tokenCount, 1);
  assert.equal(host.calls.length, calls);
  await host.disconnect(); await host.waitForRelease();
  const supported = await service.prepare(storageId);
  assert.equal(supported["task-submit"], true);
  assert.equal(host.connectionCount, 1); assert.equal(host.tokenCount, 0);
  assert.equal(host.calls.length, calls);
  await service.select("workspace", storageId);
  assert.equal(host.connectionCount, 1); assert.equal(host.tokenCount, 1);
});

test("prepare replaces a changed retained endpoint through explicit attach-only negotiation", async t => {
  const fixture = await liveFixture(t); const { service, host } = fixture;
  await service.prepare(storageId);
  const replacement = await changedEndpoint(t, fixture);
  assert.notEqual(replacement.endpoint.serverId, host.endpoint.serverId);
  assert.notEqual(replacement.endpoint.socketPath, host.endpoint.socketPath);
  const supported = await service.prepare(storageId);
  assert.equal(supported["task-submit"], true);
  await host.waitForRelease();
  assert.equal(host.connectionCount, 0); assert.equal(replacement.connectionCount, 1);
  assert.equal(replacement.tokenCount, 0); assert.equal(replacement.calls.length, 0);
  assert.equal(host.calls.length, 0);
});

test("prepare refuses changed endpoints while the storage has a connected observation", async t => {
  const fixture = await liveFixture(t); const { service, host } = fixture;
  await service.select("workspace", `${storageId}:2`);
  const calls = host.calls.length;
  const replacement = await changedEndpoint(t, fixture);
  await assert.rejects(service.prepare(storageId), error => {
    hasCode("host_unavailable")(error);
    assert.match((error as Error).message, /Reconnect.*explicitly/);
    return true;
  });
  assert.equal(host.connectionCount, 1); assert.equal(host.tokenCount, 1);
  assert.equal(host.calls.length, calls);
  assert.equal(replacement.connectionCount, 0); assert.equal(replacement.calls.length, 0);
  assert.equal(replacement.tokenCount, 0);
  assert.equal(host.lifecycle.filter(event => event.kind === "connect").length, 1);
  await service.reconnect("workspace");
  await host.waitForRelease();
  assert.equal(host.connectionCount, 0); assert.equal(host.tokenCount, 0);
  assert.equal(replacement.connectionCount, 1); assert.equal(replacement.tokenCount, 1);
  const replacementCalls = replacement.calls.length;
  const supported = await service.prepare(storageId);
  assert.equal(supported["task-submit"], true);
  assert.equal(replacement.connectionCount, 1); assert.equal(replacement.tokenCount, 1);
  assert.equal(replacement.calls.length, replacementCalls);
});

for (const claim of ["absent", "unknown"] as const) {
  test(`prepare rechecks an ${claim} writer claim after disconnect without opening a host link`, async t => {
    const { service, host, endpoint } = await liveFixture(t);
    await service.prepare(storageId);
    await host.disconnect(); await host.waitForRelease();
    if (claim === "absent") await rm(endpoint.claimPath);
    else await writeFile(endpoint.claimPath, "{}");
    await assert.rejects(service.prepare(storageId), hasCode(claim === "absent" ? "stored" : "host_unavailable"));
    assert.equal(host.lifecycle.filter(event => event.kind === "connect").length, 1);
    assert.equal(host.connectionCount, 0); assert.equal(host.tokenCount, 0); assert.equal(host.calls.length, 0);
  });
}

test("prepared links obey the storage link cap and detach frees their capacity", { timeout: 15000 }, async t => {
  const { service, directory } = await stored(t);
  const agentDir = await mkdtemp("/tmp/ui-agent-");
  const hosts: FakeHost[] = []; const identities: string[] = [];
  t.after(async () => { await Promise.all(hosts.map(host => host.close())); await rm(agentDir, { recursive: true, force: true }); });
  for (let i = 1; i <= 33; i++) {
    const identity = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const record = { storageId: identity, cwd: directory, agentDir, packageDir: directory,
      storagePath: join(directory, "durable", `${identity}.sqlite`), model: { provider: "fixture", modelId: "fixture" },
      thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z" };
    const endpoint = deriveEndpoint(record);
    await writeFile(join(directory, "durable", `${identity}.json`), JSON.stringify(record));
    await mkdir(dirname(endpoint.socketPath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(endpoint.claimPath), { recursive: true, mode: 0o700 });
    await writeFile(endpoint.claimPath, JSON.stringify({ sessionId: identity, cwd: directory,
      host: hostname(), createdAt: "2026-01-01T00:00:00.000Z", pid: process.pid }), { mode: 0o600 });
    identities.push(identity); hosts.push(await FakeHost.start({ endpoint }));
  }
  await service.refresh();
  await Promise.all(identities.slice(0, 32).map(identity => service.prepare(identity)));
  await assert.rejects(service.prepare(identities[32]), hasCode("capacity"));
  assert.equal(hosts[32].connectionCount, 0);
  await hosts[0].disconnect(); await hosts[0].waitForRelease();
  await Promise.all([service.prepare(identities[0]), service.prepare(identities[0])]);
  assert.equal(hosts[0].lifecycle.filter(event => event.kind === "connect").length, 2);
  assert.equal(hosts.reduce((sum, host) => sum + host.connectionCount, 0), 32);
  await assert.rejects(service.prepare(identities[32]), hasCode("capacity"));
  assert.equal(hosts[32].connectionCount, 0);
  assert.ok(hosts.every(host => host.tokenCount === 0 && host.calls.length === 0));
  await service.disconnectWorkspace("workspace");
  await Promise.all(hosts.slice(0, 32).map((host, index) => host.waitForRelease(index === 0 ? 2 : 1)));
  await service.prepare(identities[32]);
  assert.equal(hosts[32].connectionCount, 1); assert.equal(hosts[32].tokenCount, 0);
});

test("prepare handshake deadline returns an unavailable error without observation", { timeout: 10000 }, async t => {
  const { service, host, endpoint } = await liveFixture(t);
  await host.close();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socketPath, resolve); });
  await assert.rejects(service.prepare(storageId), hasCode("host_unavailable"));
  assert.equal(host.tokenCount, 0); assert.deepEqual(host.calls, []);
});

test("configure reports an explicit unavailable control without a host", async t => {
  const { service } = await stored(t);
  assert.equal(service.configure(storageId, { name: "Name" }).available, false);
  await service.disconnectWorkspace("workspace");
  await service.close();
  await service.close();
});
