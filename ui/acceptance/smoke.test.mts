import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Bootstrap } from "../shared/api.ts";
import { assertFixturePresentation, openProject, options, requireFake, type Options } from "./smoke.mts";

function setupPage(calls: string[], provider = "acceptance-fixture") {
  const state = { workspace: { primaryKey: "fixture" }, primaries: [{ key: "fixture", model: { provider } }] } as Bootstrap;
  return {
    async evaluate<T = unknown>(expression: string): Promise<T> {
      calls.push(`evaluate:${expression}`);
      return state as T;
    },
    async waitFor(expression: string): Promise<void> { calls.push(`wait:${expression}`); },
  };
}
const setupOptions: Options = { url: "http://127.0.0.1:1234/", out: ".", fake: true, cwd: "/fixture-project", prompt: "no-dialog" };
const projectSteps = [
  /evaluate:.*"#project-button"/,
  /wait:.*#modal\[open\] #picker-project/,
  /evaluate:.*"#picker-project".*node.value="\/fixture-project"/,
  /evaluate:.*textContent.trim\(\)==="Continue"/,
  /wait:.*#modal\[open\] #picker-search/,
];
const readySteps = [/wait:.*#model-button/, /evaluate:.*fetch\('\/api\/bootstrap'/];
function assertSteps(calls: string[], expected: RegExp[]): void {
  assert.equal(calls.length, expected.length);
  expected.forEach((pattern, index) => { assert.match(calls[index], pattern, `Setup step ${index + 1}`); });
}

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

test("fixture project setup continues before starting a new session", async () => {
  const calls: string[] = [];
  const checks: string[] = [];
  await openProject(setupPage(calls), setupOptions, async (name, action, scope) => {
    checks.push(`${name}:${scope}`);
    await action();
  });
  assert.deepEqual(checks, ["7.1 explicit disposable project/session open:fixture"]);
  assertSteps(calls, [...projectSteps, /evaluate:.*textContent.trim\(\)==="Start new session"/, ...readySteps]);
});

test("fixture saved session setup uses the current named fields and writer confirmation", async () => {
  const calls: string[] = [];
  await openProject(setupPage(calls), { ...setupOptions, session: "/fixture-session.jsonl" }, async (_name, action) => action());
  assertSteps(calls, [...projectSteps,
    /evaluate:.*textContent.trim\(\)==="Open saved session path…"/,
    /wait:.*#modal\[open\] #picker-session-path/,
    /evaluate:.*textContent==="Project directory".*node.value="\/fixture-project"/,
    /evaluate:.*textContent==="Saved session path".*node.value="\/fixture-session.jsonl"/,
    /evaluate:.*textContent.trim\(\)==="Resume saved session"/,
    /evaluate:.*textContent.trim\(\)==="No other writer · Resume"/,
    ...readySteps,
  ]);
});

test("fixture setup leaves read-only runs untouched and still rejects a real selected provider", async () => {
  const calls: string[] = [];
  const check = async (_name: string, action: () => Promise<void>) => action();
  await openProject(setupPage(calls), { ...setupOptions, fake: false }, check);
  await openProject(setupPage(calls), { ...setupOptions, cwd: undefined }, check);
  assert.deepEqual(calls, []);
  await assert.rejects(openProject(setupPage(calls, "real-provider"), setupOptions, check), /Refuse prompts/);
});

test("smoke CLI help exits successfully without launch, output, or prompt arguments", async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("./smoke.mts", import.meta.url)), "--help"],
    { timeout: 10_000, maxBuffer: 8192 });
  assert.equal(stderr, "");
  assert.match(stdout, /^Usage: node ui\/acceptance\/smoke\.mts/);
  for (const flag of ["--help", "--url", "--out", "--fake", "--cwd", "--session", "--prompt", "--dialog-prompt"]) assert.ok(stdout.includes(flag), flag);
  assert.match(stdout, /without browser startup/);
  assert.match(stdout, /default run submits no model prompts/);
});
