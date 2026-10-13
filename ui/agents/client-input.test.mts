import assert from "node:assert/strict";
import { test } from "node:test";
import { HostLink } from "./client.mts";
import { CHILD, FakeHost } from "./fake-host.mts";
import type { NativeInputPart } from "./input.mts";

test("native input retains validated parts and its stable key after caller mutation", async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const parts: NativeInputPart[] = [{type: "text", text: "caption"}, {type: "image", data: "AAAA", mimeType: "image/png"}];
  const original = structuredClone(parts);
  const sent = link.submit(CHILD, {operationId: "captured-parts", mode: "steer", message: parts}, "fixture");
  parts[0] = {type: "text", text: "changed"};
  parts[1] = {type: "image", data: "AAAB", mimeType: "image/jpeg"};
  await sent;
  assert.deepEqual(host.calls[0].params?.message, original);
  assert.equal(host.calls[0].wireRequestId, "ui:captured-parts");
  await link.submit(CHILD, {operationId: "captured-parts", mode: "steer", message: original}, "fixture");
  await assert.rejects(link.submit(CHILD, {operationId: "captured-parts", mode: "steer", message: parts}, "fixture"), {code: "operation_conflict", uncertain: false});
  assert.equal(host.calls.length, 1);
});

test("native input keys respect the complete Endpoint request key bound", async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  const input = {operationId: "a".repeat(125), mode: "steer" as const, message: "text"};
  const admitted = await link.submit(CHILD, input, "fixture");
  assert.equal(admitted.result.requestId?.length, 128);
  await assert.rejects(link.submit(CHILD, {...input, operationId: "a".repeat(126)}, "fixture"), {code: "invalid_request", uncertain: false});
  assert.equal(host.calls.length, 1);
});
