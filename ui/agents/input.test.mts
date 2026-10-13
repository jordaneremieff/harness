import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../shared/api.ts";
import { captureSubmitInput, nativeInputDigest, submitInputDigest, type SubmitInput } from "./input.mts";
import { decodeNativeMessage, decodeOperatorInput } from "./contract.mts";
import { CHILD } from "./fake-host.mts";

const image = {digest: "a".repeat(64), mimeType: "image/png" as const, bytes: 3, width: 1, height: 1, name: "pixel.png"};
const input: SubmitInput = {operationId: "image-input", targetKey: "00000000-0000-4000-8000-000000000009", message: "", mode: "steer", images: [image]};
const native = {type: "image" as const, mimeType: "image/png" as const, data: "AAAA"};
const envelope = (message: unknown) => ({sessionId: CHILD, origin: "operator", requester: "ui:fixture", replyTo: CHILD, requestId: "ui:image-input", whenBusy: "steer", message});

test("metadata input strictly validates the complete tuple and captures image references deeply", () => {
  const captured = captureSubmitInput(input);
  assert.deepEqual(captured, input); assert.notEqual(captured.images, input.images); assert.notEqual(captured.images[0], image);
  for (const patch of [{images: undefined}, {operationId: "key\n"}, {operationId: "x".repeat(126)}, {targetKey: `${input.targetKey}\n`}, {images: [{...image, digest: `${image.digest}\n`}]}, {targetKey: "../escape"}, {root: "/other"}, {message: "x".repeat(LIMITS.textBytes + 1)}, {mode: "reject"}, {images: [image, image]}, {images: [{...image, data: "AAAA"}]}, {images: [{...image, name: "../x"}]}, {images: [{...image, width: 8193}]}, {images: [{...image, bytes: LIMITS.imageBytes + 1}]}]) {
    assert.throws(() => captureSubmitInput({...input, ...patch} as SubmitInput), {code: "invalid_request"});
  }
  assert.throws(() => captureSubmitInput({...input, images: []}), {code: "invalid_request"});
  assert.throws(() => captureSubmitInput({...input, images: [{...image, get width(): number {throw Error("getter");}}]}), {code: "invalid_request"});
});
test("metadata digest binds target, order and every image field without base64", () => {
  const second = {...image, digest: "b".repeat(64)}, original = {...input, images: [image, second]};
  const digest = submitInputDigest(CHILD, captureSubmitInput(original));
  for (const candidate of [{...original, images: [second, image]}, {...original, targetKey: "00000000-0000-4000-8000-000000000008"}, ...Object.entries(image).map(([key, value]) => ({...original, images: [{...image, [key]: typeof value === "number" ? value + 1 : `${value}x`}, second]}))]) {
    assert.notEqual(submitInputDigest(CHILD, candidate), digest);
  }
  assert.notEqual(submitInputDigest(`${CHILD}0`, original), digest);
});
test("native input keeps strings and permits only optional leading text with image parts", () => {
  assert.equal(decodeNativeMessage("text"), "text");
  assert.deepEqual(decodeNativeMessage([native]), [native]);
  assert.deepEqual(decodeNativeMessage([{type: "text", text: "caption"}, native]), [{type: "text", text: "caption"}, native]);
  const invalid = [[], [{type: "text", text: "caption"}], [{type: "text", text: ""}, native], [native, {type: "text", text: "tail"}], [{type: "text", text: "a"}, {type: "text", text: "b"}, native], [{...native, extra: true}], [{...native, mimeType: "image/gif"}], [{type: "file", data: "AAAA"}], Array(5).fill(native)];
  for (const value of invalid) assert.throws(() => decodeOperatorInput(envelope(value)));
});
test("native image base64 is canonical and bounded without the former string cap", () => {
  for (const data of ["", "AAA", "AB==", "AAF=", "AAAA\n", "AAA\n", "AA\r\n", "data:image/png;base64,AAAA", "----", "AAAA===="]) assert.throws(() => decodeOperatorInput(envelope([{...native, data}])));
  const data = Buffer.alloc(1024 * 1024).toString("base64");
  assert.equal((decodeNativeMessage([{...native, data}]) as {data: string}[])[0].data, data);
  const over = Buffer.alloc(LIMITS.imageBytes + 1).toString("base64");
  assert.throws(() => decodeNativeMessage([{...native, data: over}]));
  const half = Buffer.alloc(LIMITS.imageBytes / 2 + 1).toString("base64");
  assert.throws(() => decodeNativeMessage([{...native, data: half}, {...native, data: half}]));
});
test("native envelope bound counts escaped UTF-8 text and its header", () => {
  const message = decodeOperatorInput(envelope("x".repeat(1024 * 1024 + 1))).message;
  assert.equal(typeof message, "string"); assert.equal((message as string).length, 1024 * 1024 + 1);
  assert.throws(() => decodeOperatorInput(envelope("\u0000".repeat(Math.ceil(LIMITS.inputFrameBytes / 6)))));
  assert.throws(() => decodeOperatorInput({...envelope([native]), replyTo: "another"}));
});
test("native admission validates data properties and serializes its envelope only once", t => {
  let calls = 0; const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {calls++; return stringify(...args);});
  decodeOperatorInput(envelope([native])); assert.equal(calls, 1);
  const accessor = {...native, get data(): string {throw Error("getter");}};
  assert.throws(() => decodeOperatorInput(envelope([accessor])), /Invalid input property/);
  const sparse = Array(1); assert.throws(() => decodeOperatorInput(envelope(sparse)));
  const tagged = Object.assign([native], {extra: true}); assert.throws(() => decodeOperatorInput(envelope(tagged)));
  assert.throws(() => decodeOperatorInput({...envelope([native]), get requester(): string {throw Error("getter");}}), /Invalid input property/);
  assert.throws(() => decodeOperatorInput({...envelope([native]), operationId: undefined}), /Invalid input property/);
  assert.equal(calls, 1);
});

test("native digest distinguishes text shape, images, MIME, mode and recipient", () => {
  const original = {operationId: "key", mode: "steer" as const, message: [native]};
  const digest = nativeInputDigest(CHILD, original, "fixture");
  for (const changed of [{...original, message: "AAAA"}, {...original, message: [{...native, data: "AAAB"}]}, {...original, message: [{...native, mimeType: "image/jpeg" as const}]}, {...original, mode: "followUp" as const}]) assert.notEqual(nativeInputDigest(CHILD, changed, "fixture"), digest);
  assert.notEqual(nativeInputDigest(CHILD, original, "other"), digest);
});
