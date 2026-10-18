import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAgentService, deriveEndpoint } from "./index.mts";
import { CHILD, STORAGE, deferred, descriptor, FakeHost, receipt, type FakeHostOptions } from "./fake-host.mts";
import { validateImageBytes } from "../server/images.mts";
import type { SubmitInput } from "./input.mts";

const targetKey = "00000000-0000-4000-8000-000000000009";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from("/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9/KKKKAP/2Q==", "base64");
async function fixture(t: TestContext, options: FakeHostOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "ui-image-input-"));
  // Socket endpoints need a short private path on systems with small Unix address limits.
  const agentDir = await mkdtemp("/tmp/ui-img-");
  const record = {storageId: STORAGE, cwd: root, agentDir, packageDir: root, storagePath: join(root, "durable", `${STORAGE}.sqlite`), model: {provider: "fixture", modelId: "unknown-input"}, thinkingLevel: "off", createdAt: "2026-01-01T00:00:00.000Z"};
  const endpoint = deriveEndpoint(record);
  await mkdir(join(root, "durable")); await writeFile(join(root, "durable", `${STORAGE}.json`), JSON.stringify(record));
  await mkdir(dirname(endpoint.socketPath), {recursive: true}); await mkdir(dirname(endpoint.claimPath), {recursive: true});
  await writeFile(endpoint.claimPath, JSON.stringify({sessionId: STORAGE, cwd: root, host: hostname(), createdAt: record.createdAt, pid: process.pid}));
  const host = await FakeHost.start({...options, endpoint});
  const service = createAgentService({store: root, stateDir: root, installationId: "images", agentDir: root});
  t.after(async () => {await service.close(); await host.close(); await rm(root, {recursive: true, force: true}); await rm(agentDir, {recursive: true, force: true});});
  await service.refresh();
  const saved = async (bytes = png, mimeType: "image/png" | "image/jpeg" = "image/png") => {
    const image = {...validateImageBytes(bytes, mimeType), name: mimeType === "image/png" ? "pixel.png" : "pixel.jpg"};
    await mkdir(join(root, "images", targetKey), {recursive: true, mode: 0o700});
    const path = join(root, "images", targetKey, `${image.digest}.bin`); await writeFile(path, bytes, {mode: 0o600});
    return {image, path};
  };
  return {root, host, service, saved};
}
function submitted(images: SubmitInput["images"], operationId = "image", message = "caption", mode: SubmitInput["mode"] = "steer"): SubmitInput {
  return {operationId, message, mode, targetKey, images};
}

test("real worker sends verified PNG and JPEG references with captured metadata and native routing", {timeout: 15000}, async t => {
  const f = await fixture(t), first = await f.saved(), second = await f.saved(jpeg, "image/jpeg");
  assert.equal(f.service.imageInputAvailable(CHILD), false);
  assert.equal((await f.service.prepare(CHILD)).images, true); assert.equal(f.service.imageInputAvailable(CHILD), true);
  assert.equal(f.service.imageInputAvailable(STORAGE), false);
  for (const mode of ["steer", "followUp"] as const) {
    const input = submitted([first.image, second.image], mode, "caption", mode), original = structuredClone(input);
    const sent = f.service.submit(CHILD, input); input.images[0] = {...first.image, name: "changed.png"};
    await sent; const call = f.host.calls.filter(call => call.member === "task-submit").at(-1); assert.ok(call);
    assert.deepEqual(call.params, {sessionId: CHILD, origin: "operator", requester: "ui:images", replyTo: CHILD, requestId: `ui:${mode}`, whenBusy: mode,
      message: ['caption', `Attached image "pixel.png" (image/png): ${first.path}`, `Attached image "pixel.jpg" (image/jpeg): ${second.path}`].join('\n\n')});
    assert.equal(call.wireRequestId, `ui:${mode}`);
    assert.deepEqual(await readFile(first.path), png); assert.deepEqual(await readFile(second.path), jpeg); assert.deepEqual(original.images.map(image => image.name), ['pixel.png', 'pixel.jpg']);
    await assert.rejects(f.service.submit(CHILD, input), {code: "operation_conflict"});
  }
  await f.service.submit(CHILD, submitted([first.image], "image-only", ""));
  const only = f.host.calls.at(-1); assert.ok(only); assert.equal(only.params?.message, `Attached image "pixel.png" (image/png): ${first.path}`);
  await f.service.submit(CHILD, submitted([], "text-only", "plain")); assert.equal(f.host.calls.at(-1)?.params?.message, "plain");
  await f.service.disconnectWorkspace("unused"); assert.equal(f.service.imageInputAvailable(CHILD), false);
});
test("large verified image input retains exact bytes and sends a target-bound reference", {timeout: 15000}, async t => {
  const f = await fixture(t);
  // Header-policy acceptance is intentional; this does not assert full raster decoding.
  const bytes = Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(2 * 1024 * 1024), jpeg.subarray(-2)]), saved = await f.saved(bytes, "image/jpeg");
  await f.service.submit(CHILD, submitted([saved.image], "large", ""));
  const call = f.host.calls.at(-1); assert.ok(call); assert.ok(bytes.length > 1024 * 1024);
  assert.deepEqual(call.params, {sessionId: CHILD, origin: 'operator', requester: 'ui:images', replyTo: CHILD, requestId: 'ui:large', whenBusy: 'steer', message: `Attached image "pixel.jpg" (image/jpeg): ${saved.path}`});assert.equal(call.wireRequestId, 'ui:large');
  const stored=await readFile(saved.path);assert.deepEqual(stored,bytes);assert.equal(createHash('sha256').update(stored).digest('hex'),saved.image.digest);
});
test("uncertain images preserve their key and require explicit retry with freshly verified bytes", {timeout: 15000}, async t => {
  const held = deferred<ReturnType<typeof receipt>>(); let attempts = 0;
  t.after(() => held.resolve(receipt(CHILD, "ui:uncertain-image")));
  const f = await fixture(t, {handler: call => {
    if (call.member !== "task-submit") return;
    attempts++; return attempts === 1 ? held.promise : {...receipt(CHILD, "ui:uncertain-image"), deduped: true};
  }});
  const saved = await f.saved(), input = submitted([saved.image], "uncertain-image");
  await f.service.prepare(CHILD);
  const first = f.service.submit(CHILD, input), failed = assert.rejects(first, {code: "host_unavailable", uncertain: true});
  await f.host.waitForCall(call => call.member === "task-submit");
  const disconnected = f.host.disconnect(); await failed;
  assert.equal(f.service.imageInputAvailable(CHILD), false); held.resolve(receipt(CHILD, "ui:uncertain-image"));
  await disconnected;
  await f.service.prepare(CHILD); await f.service.history(CHILD);
  await assert.rejects(f.service.submit(CHILD, input), {uncertain: true}); assert.equal(attempts, 1);
  await assert.rejects(f.service.retrySubmit(CHILD, {...input, images: [{...saved.image, name: "changed.png"}]}), {code: "operation_conflict"});
  await writeFile(saved.path, Buffer.alloc(png.length));
  await assert.rejects(f.service.retrySubmit(CHILD, input), {code: "image_unavailable"}); assert.equal(attempts, 1);
  await writeFile(saved.path, png);
  const retry = await f.service.retrySubmit(CHILD, input); assert.equal(retry.deduped, true); assert.equal(attempts, 2);
  const calls = f.host.calls.filter(call => call.member === "task-submit"); assert.deepEqual(calls[0].params, calls[1].params); assert.equal(calls[0].wireRequestId, calls[1].wireRequestId);
});
test("one storage slot covers initial and retry image dispatch before another blob read", {timeout: 15000}, async t => {
  const held = deferred<ReturnType<typeof receipt>>();
  const f = await fixture(t, {handler: call => call.member === "task-submit" && call.params?.requestId === "ui:held" ? held.promise : undefined});
  const saved = await f.saved(), input = submitted([saved.image], "held");
  const first = f.service.submit(CHILD, input); await f.host.waitForCall(call => call.member === "task-submit");
  const repeat = f.service.retrySubmit(CHILD, input);
  const missing = submitted([{...saved.image, digest: "a".repeat(64)}], "sibling", "");
  await assert.rejects(f.service.submit(STORAGE, missing), {code: "capacity", uncertain: false});
  await assert.rejects(f.service.retrySubmit(STORAGE, missing), {code: "capacity", uncertain: false});
  await f.service.submit(STORAGE, submitted([], "control-text", "plain"));
  assert.equal(f.host.calls.filter(call => call.member === "task-submit").length, 2);
  held.resolve(receipt(CHILD, "ui:held")); await Promise.all([first, repeat]);
  await assert.rejects(f.service.retrySubmit(STORAGE, missing), {code: "image_unavailable"});
});
test("teardown rejects pending image admission as uncertain and never replays", {timeout: 15000}, async t => {
  const held = deferred<ReturnType<typeof receipt>>();
  const f = await fixture(t, {handler: call => call.member === "task-submit" ? held.promise : undefined});
  const saved = await f.saved(); await f.service.prepare(CHILD);
  const sent = f.service.submit(CHILD, submitted([saved.image])), rejected = assert.rejects(sent, {code: "host_unavailable", uncertain: true});
  await f.host.waitForCall(call => call.member === "task-submit"); await f.service.close(); await rejected;
  assert.equal(f.service.imageInputAvailable(CHILD), false); assert.equal(f.host.calls.length, 1); held.resolve(receipt(CHILD, "ui:image"));
});
test("negotiated image refusal precedes byte reads and leaves independent reads available", {timeout: 15000}, async t => {
  const remote = await descriptor(); delete (remote.operations as Record<string, unknown>)["task-submit"];
  const f = await fixture(t, {descriptor: remote});
  assert.equal((await f.service.prepare(CHILD)).images, false); assert.equal(f.service.imageInputAvailable(CHILD), false);
  const metadata = {...validateImageBytes(png, "image/png"), name: "unavailable.png"};
  await assert.rejects(f.service.submit(CHILD, submitted([metadata])), {code: "contract_mismatch", uncertain: false});
  await f.service.history(CHILD); assert.deepEqual(f.host.calls.map(call => call.member), ["snapshot"]);
});
