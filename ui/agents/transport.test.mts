import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { Frame } from "@earendil-works/chord";
import { createUnixLink, LocalTransportRefusal, type TransportRequest } from "../../transport/index.ts";
import { LIMITS } from "../shared/api.ts";
import { HostLink } from "./client.mts";
import { deferred, FakeHost, receipt, STORAGE } from "./fake-host.mts";

class PendingSocket extends EventEmitter {
  readonly writableLength = 0;
  readonly writes: string[] = [];
  readonly callbacks: ((error?: Error | null) => void)[] = [];
  failSync = false;
  write(data: string, callback: (error?: Error | null) => void): boolean {
    if (this.failSync) throw Error("sync write");
    this.writes.push(data); this.callbacks.push(callback); return true;
  }
  destroy(): void { this.emit("close"); }
  end(callback: () => void): void { callback(); }
  get socket(): Socket { return this as unknown as Socket; }
}
function publicLink(socket: PendingSocket) {
  return createUnixLink(socket.socket, {expectedKind: "host", maxFrameBytes: 16 * 1024 * 1024,
    maxSendFrameBytes: LIMITS.inputFrameBytes - 1, maxQueueBytes: LIMITS.agentPendingBytes});
}
function inspectWrites(t: TestContext, inspect: (frame: Frame, bytes: number, args: unknown[]) => void): void {
  const write = Socket.prototype.write;
  t.mock.method(Socket.prototype, "write", function(this: Socket, ...args: unknown[]) {
    const chunk = args[0];
    if (typeof chunk === "string" && chunk.startsWith("{") && chunk.endsWith("\n")) {
      inspect(JSON.parse(chunk) as Frame, Buffer.byteLength(chunk), args);
    }
    return Reflect.apply(write, this, args) as boolean;
  });
}
function endpointRequest(frame: Frame): TransportRequest | undefined {
  return frame.t === "call" && frame.member === "request" ? frame.args as TransportRequest : undefined;
}

test("public framing charges encoded image and control bytes through their write callbacks", () => {
  const socket = new PendingSocket(), link = publicLink(socket);
  const image: Frame = {t: "call", id: 1, hold: 1, member: "request", args: {message: [{type: "image", data: "", mimeType: "image/png"}]}};
  const header = Buffer.byteLength(JSON.stringify(image)) + 1;
  (image.args as {message: {data: string}[]}).message[0].data = "a".repeat(LIMITS.inputFrameBytes - header);
  const control: Frame = {t: "cancel", id: 1};
  const imageBytes = Buffer.byteLength(JSON.stringify(image)) + 1;
  const controlBytes = Buffer.byteLength(JSON.stringify(control)) + 1;
  assert.equal(imageBytes, LIMITS.inputFrameBytes);
  const remainder: Frame = {t: "result", id: 2,
    value: "a".repeat(LIMITS.agentPendingBytes - imageBytes - controlBytes - Buffer.byteLength(JSON.stringify({t: "result", id: 2, value: ""})) - 1)};
  link.send(image); link.send(control); link.send(remainder);
  assert.equal(link.closed, false);
  assert.equal(socket.writes.reduce((total, write) => total + Buffer.byteLength(write), 0), LIMITS.agentPendingBytes);
  assert.deepEqual(JSON.parse(socket.writes[0]), image);
  socket.callbacks[1](); socket.callbacks[1]();
  link.send(control); assert.equal(link.closed, false); assert.equal(socket.writes.length, 4);
  let refusal: LocalTransportRefusal | undefined;
  link.onSendRefusal((_frame, error) => {refusal = error;});
  link.send(control);
  assert.ok(refusal instanceof LocalTransportRefusal);
  assert.equal(refusal.reason, "queue-limit"); assert.equal(refusal.encodedBytes, controlBytes - 1);
  assert.equal(socket.writes.length, 4); assert.equal(link.closed, true);
  socket.callbacks[0](); socket.callbacks[2](); socket.callbacks[3]();
  link.send(image); assert.equal(socket.writes.length, 4);
});

test("public frame bounds count escaped UTF-8, JSON structure and LF before any write", () => {
  const socket = new PendingSocket(), link = publicLink(socket);
  const frame: Frame = {t: "result", id: 1, value: "😀\u0000\n\""};
  const encoded = JSON.stringify(frame);
  link.send(frame);
  assert.equal(socket.writes[0], `${encoded}\n`);
  assert.ok(Buffer.byteLength(encoded) > String(frame.value).length);
  socket.callbacks[0]();
  const oversize: Frame = {t: "result", id: 1, value: "a".repeat(LIMITS.inputFrameBytes - Buffer.byteLength(JSON.stringify({t: "result", id: 1, value: ""})))};
  let refusal: LocalTransportRefusal | undefined;
  link.onSendRefusal((_frame, error) => {refusal = error;}); link.send(oversize);
  assert.ok(refusal instanceof LocalTransportRefusal);
  assert.equal(refusal.reason, "frame-limit"); assert.equal(refusal.encodedBytes, LIMITS.inputFrameBytes);
  assert.equal(socket.writes.length, 1); assert.equal(link.closed, true);
});

for (const failure of ["sync", "async"] as const) test(`public ${failure} write failure settles cleanup without definite non-admission`, () => {
  const socket = new PendingSocket(), link = publicLink(socket);
  const frame: Frame = {t: "result", id: 1, value: "payload"};
  let refusals = 0, closes = 0;
  link.onSendRefusal(() => {refusals++;}); link.onClose(() => {closes++;});
  link.send(frame); socket.callbacks[0]();
  socket.failSync = failure === "sync"; link.send(frame);
  if (failure === "async") {socket.callbacks[1](Error("async write")); socket.callbacks[1]();}
  assert.equal(link.closed, true); assert.equal(closes, 1); assert.equal(refusals, 0);
  link.send(frame); assert.equal(socket.writes.length, failure === "sync" ? 1 : 2);
});

test("host link preserves a definite framed refusal when the client disconnects", {timeout: 15000}, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const envelope = {sessionId: STORAGE, message: "", origin: "operator", requester: "ui:fixture", replyTo: STORAGE, requestId: "ui:frame", whenBusy: "steer"};
  const textBytes = LIMITS.inputFrameBytes - Buffer.byteLength(JSON.stringify(envelope)) - 4;
  await assert.rejects(link.submit(STORAGE, {operationId: "frame", message: "a".repeat(textBytes), mode: "steer"}, "fixture"), {code: "payload_too_large", uncertain: false});
  assert.equal(host.calls.length, 0); assert.equal(link.connected, false);
});

test("HostLink writes an exact complete frame and refuses one byte more without dispatch", {timeout: 15000}, async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const sizes: number[] = [];
  inspectWrites(t, (frame, bytes) => {
    if (endpointRequest(frame)?.requestId?.startsWith("ui:wire-")) sizes.push(bytes);
  });
  const send = (operationId: string, length: number) => link.submit(STORAGE, {operationId, message: "a".repeat(length), mode: "steer"}, "fixture");
  const initial = LIMITS.inputFrameBytes - 2048;
  await send("wire-a", initial);
  const overhead = sizes[0] - initial; assert.ok(overhead > 4);
  await send("wire-b", LIMITS.inputFrameBytes - overhead);
  assert.equal(sizes[1], LIMITS.inputFrameBytes);
  await assert.rejects(send("wire-c", LIMITS.inputFrameBytes - overhead + 1), {code: "payload_too_large", uncertain: false});
  assert.equal(sizes.length, 2); assert.equal(host.calls.length, 2); assert.equal(link.connected, false);
});

test("HostLink queue refusal belongs only to the unsent input while admitted input stays uncertain", {timeout: 15000}, async t => {
  const held = deferred<ReturnType<typeof receipt>>();
  const host = await FakeHost.start({handler: call => call.member === "task-submit" ? held.promise : undefined});
  const link = await HostLink.connect(host.endpoint);
  let completed: ((error?: Error | null) => void) | undefined;
  t.after(async () => {completed?.(); held.resolve(receipt(STORAGE, "ui:queued-a")); await link.close(); await host.close();});
  inspectWrites(t, (frame, _bytes, args) => {
    if (endpointRequest(frame)?.requestId !== "ui:queued-a") return;
    const index = args.findIndex(arg => typeof arg === "function");
    assert.notEqual(index, -1); completed = args[index] as (error?: Error | null) => void;
    args[index] = () => {};
  });
  const first = link.submit(STORAGE, {operationId: "queued-a", message: "a".repeat(LIMITS.inputFrameBytes - 2048), mode: "steer"}, "fixture");
  const uncertain = assert.rejects(first, {code: "host_unavailable", uncertain: true});
  await host.waitForCall(call => call.member === "task-submit");
  assert.ok(completed);
  await assert.rejects(link.submit(STORAGE, {operationId: "queued-b", message: "b".repeat(6 * 1024 * 1024), mode: "steer"}, "fixture"), {code: "capacity", uncertain: false});
  await uncertain;
  assert.equal(host.calls.length, 1); assert.equal(host.calls[0].wireRequestId, "ui:queued-a");
  assert.equal(link.connected, false);
  completed(); completed(); held.resolve(receipt(STORAGE, "ui:queued-a"));
});

test("HostLink socket failure leaves its dispatched input uncertain, not locally refused", {timeout: 15000}, async t => {
  const held = deferred<ReturnType<typeof receipt>>();
  const host = await FakeHost.start({handler: call => call.member === "task-submit" ? held.promise : undefined});
  const link = await HostLink.connect(host.endpoint);
  let completed: ((error?: Error | null) => void) | undefined;
  t.after(async () => {held.resolve(receipt(STORAGE, "ui:write-failure")); await link.close(); await host.close();});
  inspectWrites(t, (frame, _bytes, args) => {
    if (endpointRequest(frame)?.requestId !== "ui:write-failure") return;
    const index = args.findIndex(arg => typeof arg === "function");
    assert.notEqual(index, -1); completed = args[index] as (error?: Error | null) => void;
    args[index] = () => {};
  });
  const sent = link.submit(STORAGE, {operationId: "write-failure", message: "input", mode: "steer"}, "fixture");
  const uncertain = assert.rejects(sent, {code: "host_unavailable", uncertain: true});
  await host.waitForCall(call => call.member === "task-submit");
  assert.ok(completed); completed(Error("socket write failed")); await uncertain;
  assert.equal(host.calls.length, 1); assert.equal(link.connected, false);
});
