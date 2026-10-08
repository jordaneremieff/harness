import assert from "node:assert/strict";
import { test } from "node:test";
import { HostLink } from "./client.mts";
import { FakeHost, STORAGE } from "./fake-host.mts";

const protocolError = (error: unknown) => {
  assert.equal((error as { code: string }).code, "protocol_error"); return true;
};
const exact = { view: "exact", sessionId: STORAGE, conversationId: 1, entryId: 7, offset: 0,
  text: "{}", nextOffset: null, truncated: false };
const result = { view: "result", sessionId: STORAGE, conversationId: 1, submissionId: 7,
  status: "queued", usage: { models: {}, tools: {} } };
for (const [name, params, response] of [
  ["view", { sessionId: STORAGE, view: "result", submissionId: 7 }, exact],
  ["submission", { sessionId: STORAGE, view: "result", submissionId: 8 }, result],
  ["entry", { sessionId: STORAGE, view: "exact", entryId: 8 }, exact],
  ["offset", { sessionId: STORAGE, view: "exact", entryId: 7, offset: 10 }, exact],
] as const) {
  test(`inspection refuses a mismatched ${name} without disabling abort`, async t => {
    const host = await FakeHost.start({ handler: call => call.member === "inspect" ? response : undefined });
    t.after(() => host.close());
    const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
    await assert.rejects(link.request("inspect", params, { identity: STORAGE }), protocolError);
    assert.equal(link.supports("inspect"), false);
    assert.equal(link.supports("abort"), true);
    assert.equal(host.calls.length, 1);
  });
}
test("abort refuses a returned background effect different from its captured request", async t => {
  const host = await FakeHost.start({ handler: call => call.member === "abort"
    ? { conversationId: 1, identity: STORAGE, background: true } : undefined });
  t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  await assert.rejects(link.request("abort", { sessionId: STORAGE, background: false }, { identity: STORAGE }), protocolError);
  assert.equal(link.supports("abort"), false);
  assert.equal(link.supports("task-submit"), true);
});
test("malformed input refuses before dispatch without disabling a valid host operation", async t => {
  const host = await FakeHost.start(); t.after(() => host.close());
  const link = await HostLink.connect(host.endpoint); t.after(() => link.close());
  await assert.rejects(link.request("snapshot", { sessionId: STORAGE, limit: 201 }), { code: "invalid_request" });
  await assert.rejects(link.request("abort", { sessionId: STORAGE, background: "yes" }), { code: "invalid_request" });
  await assert.rejects(link.request("changes", null), { code: "invalid_request" });
  assert.equal(link.supports("snapshot"), true);
  assert.equal(link.supports("abort"), true);
  assert.deepEqual(host.calls, []);
});
