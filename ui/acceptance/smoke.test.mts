import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bootstrap } from "../shared/api.ts";
import { assertFixturePresentation, options, requireFake } from "./smoke.mts";

test("smoke requires explicit launch and output arguments", () => {
  assert.throws(() => options([]), /--url/);
  assert.throws(() => options(["--url", "http://127.0.0.1:1234/"]), /--out/);
});

test("smoke accepts only explicit loopback HTTP URLs", () => {
  for (const url of ["http://localhost:1234/", "http://127.0.0.1/", "https://127.0.0.1:1234/", "http://user:secret@127.0.0.1:1234/", "http://example.com:1234/"]) {
    assert.throws(() => options(["--url", url, "--out", "."]), /127.0.0.1/);
  }
  const parsed = options(["--url", "http://127.0.0.1:1234/#launch=synthetic", "--out", "."]);
  assert.equal(parsed.fake, false);
});

test("automatic session and project setup require fixture mode", () => {
  for (const argument of ["--cwd", "--session"]) {
    assert.throws(() => options(["--url", "http://127.0.0.1:1234/", "--out", ".", argument, "/example"]), /requires --fake/);
  }
  const parsed = options(["--url", "http://127.0.0.1:1234/", "--out", ".", "--fake", "--cwd", "/example", "--prompt", "fixture", "--dialog-prompt", "/fixture-dialog"]);
  assert.equal(parsed.fake, true);
  assert.equal(parsed.prompt, "fixture");
  assert.equal(parsed.dialogPrompt, "/fixture-dialog");
});

test("fixture presentation refuses empty tool result headers and false send uncertainty", () => {
  assert.doesNotThrow(() => assertFixturePresentation({ emptyToolResultHeaders: 0, inputReceipt: "Admitted" }));
  assert.throws(() => assertFixturePresentation({ emptyToolResultHeaders: 1, inputReceipt: "Admitted" }), /empty toolResult/);
  assert.throws(() => assertFixturePresentation({ emptyToolResultHeaders: 0, inputReceipt: "Send not confirmed" }), /unconfirmed send/);
  assert.throws(() => assertFixturePresentation({ emptyToolResultHeaders: 0, inputReceipt: "Admitted", controlReceipt: "Target exited before a receipt arrived" }), /provisional error/);
  assert.doesNotThrow(() => assertFixturePresentation({ emptyToolResultHeaders: 0, inputReceipt: "Admitted", controlReceipt: "Control completed" }));
});

test("fixture prompt guard refuses absent and real providers and checks selected primary", () => {
  const state = { workspace: { primaryKey: "selected" }, primaries: [
    { key: "other", model: { provider: "acceptance-fixture" } },
    { key: "selected", model: { provider: "real-provider" } },
  ] } as Bootstrap;
  assert.throws(() => requireFake(state), /Refuse prompts/);
  state.primaries[1].model = undefined;
  assert.throws(() => requireFake(state), /Refuse prompts/);
  state.primaries[1].model = { provider: "acceptance-fixture", id: "synthetic", name: "Fixture", input: ["text"], reasoning: true };
  assert.doesNotThrow(() => requireFake(state));
  state.workspace.primaryKey = "missing";
  assert.throws(() => requireFake(state), /No selected primary/);
});
