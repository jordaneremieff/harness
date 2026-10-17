import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Frame } from "@earendil-works/chord";
import { Value } from "typebox/value";
import { createUnixLink, Endpoint, Feed } from "../../transport/index.ts";
import { deferred } from "./fake-host.mts";

// Synthetic frames follow Chord's public Frame type and the Endpoint/Feed schemas.
// They are protocol fixtures, not captures from an operator's session.
const identity = "00000000-0000-4000-8000-000000000001";
const request = { method: "task-submit", params: { sessionId: identity, message: 'Line one.\nQuote: "雪".',
  origin: "operator", requester: "ui:fixture", replyTo: identity, requestId: "ui:fixture-input", whenBusy: "steer" },
  requestId: "ui:fixture-input", contract: { request: "task-submit/1.0.0", response: "task-submit/1.2.0" } };
const response = { value: { submissionId: 7, conversationId: 1, deduped: false, identity,
  result: { sessionId: identity, submissionId: 7, requestId: "ui:fixture-input" } } };
const state = { ready: true, value: { revision: 1 } };
const frames = [
  { t: "hello", name: "fixture-host", kind: "host", codeVersion: 0, protocol: 4 },
  { t: "call", id: 1, hold: 1, member: "request", args: request },
  { t: "result", id: 1, value: response },
  { t: "state", hold: 2, m: "value", as: "snap", value: state },
  { t: "result", id: 3, error: { code: "unavailable", message: "unavailable/version: Operation contract mismatch", reason: "version" } },
  { t: "cancel", id: 4 },
  { t: "result", id: 5, value: {} },
  { t: "result", id: 6, value: { value: null } },
] satisfies Frame[];

test("schema-derived Chord frames round-trip exact UTF-8 bytes through the public Unix Link", { timeout: 10000 }, async t => {
  assert.equal(Endpoint.name, "pi.agent.endpoint"); assert.equal(Endpoint.version, 1);
  assert.equal(Feed.name, "pi.agent.feed"); assert.equal(Feed.version, 1);
  const method = Endpoint.def.variants.default.methods.request;
  assert.equal(Value.Check(method.args, request), true);
  for (const value of [response, {}, { value: null }]) assert.equal(Value.Check(method.result, value), true);
  assert.equal(Value.Check(Feed.def.variants.default.state.value, state), true);
  assert.equal(Value.Check(Endpoint.input, { serverId: "fixture-host", extra: true }), false);
  assert.equal(Value.Check(method.args, { ...request, extra: true }), false);
  assert.equal(Value.Check(Feed.input, { serverId: "fixture-host", kind: "changes" }), true);
  assert.equal(Value.Check(Feed.input, { serverId: "fixture-host", kind: "observation", token: "fixture-token" }), true);
  const bytes = await readFile(new URL("./transport-frames.jsonl", import.meta.url));
  assert.deepEqual(Buffer.from(frames.map(frame => `${JSON.stringify(frame)}\n`).join("")), bytes);
  assert.deepEqual(bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)), frames);
  const directory = await mkdtemp(join(tmpdir(), "ui-frames-"));
  await chmod(directory, 0o700);
  const accepted = deferred<ReturnType<typeof createUnixLink>>();
  const server = createServer(socket => accepted.resolve(createUnixLink(socket, { expectedName: "fixture-host", expectedKind: "host" })));
  const address = join(directory, "f.sock");
  server.listen(address); await once(server, "listening"); await chmod(address, 0o600);
  const socket = createConnection(address);
  t.after(async () => {
    socket.destroy(); (await accepted.promise).close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await once(socket, "connect");
  const link = await accepted.promise;
  const decoded: Frame[] = [];
  const incoming = deferred<void>();
  link.receive(frame => { decoded.push(frame); if (decoded.length === frames.length) incoming.resolve(); });
  // Split a UTF-8 code point; the remaining write also coalesces several frames.
  const split = bytes.indexOf(Buffer.from("雪")) + 1;
  socket.write(bytes.subarray(0, split)); socket.write(bytes.subarray(split));
  await incoming.promise; assert.deepEqual(decoded, frames);
  const outgoing = deferred<Buffer>();
  const chunks: Buffer[] = []; let size = 0;
  socket.on("data", chunk => {
    chunks.push(chunk); size += chunk.length;
    if (size >= bytes.length) outgoing.resolve(Buffer.concat(chunks));
  });
  for (const frame of frames) link.send(frame);
  assert.deepEqual(await outgoing.promise, bytes);
});
