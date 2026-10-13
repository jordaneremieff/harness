import assert from "node:assert/strict";
import { test } from "node:test";
import { createHost, type Frame, type Link } from "@earendil-works/chord";
import { connectUnixLink, Endpoint } from "../../transport/index.ts";
import { LIMITS } from "../shared/api.ts";
import { FramedTransportBudget } from "./transport.mts";
import { HostLink } from "./client.mts";
import { deferred, FakeHost, STORAGE } from "./fake-host.mts";

test("framed byte accounting includes the header and concurrent controls until settlement", async () => {
  const budget = new FramedTransportBudget(), held = deferred<void>(); let forwarded = 0;
  const transport = budget.wrap({send: () => {forwarded++; return held.promise;}, close() {}});
  const image = transport.send(new Uint8Array(LIMITS.inputFrameBytes));
  const control = transport.send(new Uint8Array(LIMITS.agentPendingBytes - LIMITS.inputFrameBytes));
  await assert.rejects(transport.send(new Uint8Array(1)), {code: "capacity", uncertain: false});
  await assert.rejects(transport.send(new Uint8Array(LIMITS.inputFrameBytes + 1)), {code: "payload_too_large", uncertain: false});
  assert.equal(forwarded, 2);
  held.resolve(); await Promise.all([image, control]);
  await transport.send(new Uint8Array(LIMITS.inputFrameBytes)); assert.equal(forwarded, 3);
});
test("failed writes release byte accounting without claiming remote non-admission", async () => {
  const budget = new FramedTransportBudget(); let calls = 0;
  const transport = budget.wrap({send: () => {calls++; if (calls === 1) throw Error("sync write"); return Promise.reject(Error("async write"));}, close() {}});
  await assert.rejects(transport.send(new Uint8Array(LIMITS.inputFrameBytes)), /sync write/);
  await assert.rejects(transport.send(new Uint8Array(LIMITS.inputFrameBytes)), /async write/);
  await assert.rejects(transport.send(new Uint8Array(LIMITS.inputFrameBytes)), /async write/);
  assert.equal(calls, 3);
});
test("host link preserves a definite framed refusal when the client disconnects", {timeout: 15000}, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const envelope = {sessionId: STORAGE, message: "", origin: "operator", requester: "ui:fixture", replyTo: STORAGE, requestId: "ui:frame", whenBusy: "steer"};
  const textBytes = LIMITS.inputFrameBytes - Buffer.byteLength(JSON.stringify(envelope)) - 4;
  await assert.rejects(link.submit(STORAGE, {operationId: "frame", message: "a".repeat(textBytes), mode: "steer"}, "fixture"), {code: "payload_too_large", uncertain: false});
  assert.equal(host.calls.length, 0); assert.equal(link.connected, false);
});

test("real client encoding reaches the byte wrapper once and attributes only its own refused frame", {timeout: 15000}, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const budget = new FramedTransportBudget(), sizes: number[] = [];
  const unix = await connectUnixLink(host.endpoint.socketPath, {expectedName: host.serverId, expectedKind: "host", maxQueueBytes: LIMITS.agentPendingBytes});
  const bounded = budget.wrap({close: () => unix.close(), send: async chunk => {
    unix.send(JSON.parse(Buffer.from(chunk).toString("utf8")) as Frame);
  }});
  const link: Link = {
    get closed() { return unix.closed; },
    send: frame => {
      const chunk = Buffer.from(`${JSON.stringify(frame)}\n`);
      sizes.push(chunk.byteLength);
      void bounded.send(chunk).catch(() => unix.close("Native frame refused"));
    },
    receive: handler => unix.receive(handler), onClose: handler => unix.onClose(handler), close: reason => unix.close(reason),
  };
  const client = createHost({kind: "client", upstream: link}); t.after(() => client.close());
  const endpoint = client.get(Endpoint, {serverId: host.serverId}, {at: host.serverId}); await endpoint.ready;
  const send = (length: number) => client.root(ctx => endpoint.request({method: "task-submit", params:
    {sessionId: STORAGE, message: "a".repeat(length), origin: "operator", requester: "ui:fixture", replyTo: STORAGE, requestId: "ui:frame", whenBusy: "steer"},
    requestId: "ui:frame", contract: {request: "task-submit/1.0.0", response: "task-submit/1.2.0"},
  }, ctx));
  const initialLength = LIMITS.inputFrameBytes - 2048;
  const first = budget.capture(() => send(initialLength)); await first.promise; assert.equal(first.refused, undefined);
  const overhead = (sizes.at(-1) ?? 0) - initialLength; assert.ok(overhead > 4);
  const exact = budget.capture(() => send(LIMITS.inputFrameBytes - overhead)); await exact.promise;
  assert.equal(sizes.at(-1), LIMITS.inputFrameBytes); assert.equal(exact.refused, undefined);
  const over = budget.capture(() => send(LIMITS.inputFrameBytes - overhead + 1));
  await assert.rejects(over.promise); assert.equal(sizes.at(-1), LIMITS.inputFrameBytes + 1);
  assert.equal(over.refused?.code, "payload_too_large"); assert.equal(over.refused?.uncertain, false);
  assert.equal(host.calls.length, 2);
});
