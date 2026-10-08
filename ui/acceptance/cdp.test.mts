import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { CDP, Page, awaitDevTools, type Socket, type SocketEvent } from "./cdp.mts";

class MockSocket implements Socket {
  readyState = 1;
  sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  listeners = new Map<string, Set<(event: SocketEvent) => void>>();
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.emit("close", {}); }
  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener); this.listeners.set(type, entries);
  }
  removeEventListener(type: string, listener: (event: SocketEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: SocketEvent): void { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  frame(data: unknown): void { this.emit("message", { data: JSON.stringify(data) }); }
  reply(index: number, result: unknown): void { this.frame({ id: this.sent[index].id, result }); }
}

function setup(): { socket: MockSocket; cdp: CDP } {
  const socket = new MockSocket();
  return { socket, cdp: new CDP(socket, 1000) };
}
function child(): ChildProcess {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as unknown as ChildProcess;
}

test("responses correlate out of order and preserve session envelopes", async () => {
  const { socket, cdp } = setup();
  try {
    const a = cdp.send("Runtime.evaluate", { expression: "1" }, { sessionId: "page" });
    const b = cdp.send("Browser.getVersion");
    socket.reply(1, { product: "test" }); socket.reply(0, { value: 1 });
    assert.deepEqual(await a, { value: 1 }); assert.deepEqual(await b, { product: "test" });
    assert.equal(socket.sent[0].sessionId, "page");
  } finally { cdp.close(); }
});

test("event awaits filter method, target and predicate, independently of responses", async () => {
  const { socket, cdp } = setup();
  try {
    let done = false;
    const event = cdp.waitForEvent("Page.load", (params) => params.ready === true, { sessionId: "page" }).then((value) => { done = true; return value; });
    socket.frame({ method: "Page.load", sessionId: "other", params: { ready: true } });
    socket.frame({ method: "Page.load", sessionId: "page", params: { ready: false } });
    await Promise.resolve(); assert.equal(done, false);
    socket.frame({ method: "Page.load", sessionId: "page", params: { ready: true } });
    assert.deepEqual(await event, { ready: true });
  } finally { cdp.close(); }
});

test("protocol errors reject only their command", async () => {
  const { socket, cdp } = setup();
  try {
    const pending = cdp.send("bad");
    socket.frame({ id: socket.sent[0].id, error: { code: -1, message: "refused" } });
    await assert.rejects(pending, /refused/);
    const good = cdp.send("good"); socket.reply(1, {}); await good;
  } finally { cdp.close(); }
});

test("disconnect rejects all commands and event awaits; closed driver refuses sends", async () => {
  const { socket, cdp } = setup();
  const command = cdp.send("one"); const event = cdp.waitForEvent("two");
  socket.close();
  await assert.rejects(command, /closed/); await assert.rejects(event, /closed/);
  await assert.rejects(cdp.send("three"), /closed/); cdp.close();
});

test("abort and deadlines remove pending requests without poisoning the connection", async () => {
  const { socket, cdp } = setup();
  try {
    const controller = new AbortController();
    const event = cdp.waitForEvent("never", undefined, { signal: controller.signal });
    controller.abort(new Error("cancelled")); await assert.rejects(event, /cancelled/);
    await assert.rejects(cdp.send("never", {}, { timeoutMs: 1 }), /timeout/);
    await assert.rejects(cdp.waitForEvent("never", undefined, { timeoutMs: 1 }), /timeout/);
    const good = cdp.send("still-open"); socket.reply(1, {}); await good;
  } finally { cdp.close(); }
});

test("already-aborted requests never write", async () => {
  const { socket, cdp } = setup();
  try {
    const signal = AbortSignal.abort(new Error("cancelled"));
    await assert.rejects(cdp.send("never", {}, { signal }), /cancelled/);
    await assert.rejects(cdp.waitForEvent("never", undefined, { signal }), /cancelled/);
    assert.equal(socket.sent.length, 0);
  } finally { cdp.close(); }
});

test("malformed frames reject pending work and close rejects new work", async () => {
  const { socket, cdp } = setup();
  const pending = cdp.send("waiting");
  socket.emit("message", { data: "{" });
  await assert.rejects(pending, /JSON/); cdp.close();
  await assert.rejects(cdp.send("late"), /JSON/);
});

test("socket send failure removes the request", async () => {
  const { socket, cdp } = setup();
  socket.send = () => { throw new Error("write failed"); };
  await assert.rejects(cdp.send("test"), /write failed/); cdp.close();
});

test("connect awaits the open event and rejects nonlocal endpoints before construction", async () => {
  const socket = new MockSocket(); socket.readyState = 0;
  const pending = CDP.connect("ws://127.0.0.1:1234/devtools/browser/test", () => socket);
  socket.readyState = 1; socket.emit("open", {});
  const cdp = await pending; cdp.close();
  let called = false;
  await assert.rejects(CDP.connect("ws://example.com:1234/test", () => { called = true; return socket; }), /loopback/);
  assert.equal(called, false);
});

test("DevTools readiness joins stderr chunks and requires a complete loopback URL", async () => {
  const process = child();
  const pending = awaitDevTools(process);
  process.stderr?.emit("data", Buffer.from("noise\nDevTools listen"));
  process.stderr?.emit("data", Buffer.from("ing on ws://127.0.0.1:1234/devtools/"));
  process.stderr?.emit("data", Buffer.from("browser/test\n"));
  assert.equal(await pending, "ws://127.0.0.1:1234/devtools/browser/test");
  assert.equal(process.listenerCount("exit"), 0);
});

test("DevTools readiness rejects early exit, spawn error, nonlocal endpoint and timeout", async () => {
  for (const mode of ["exit", "error", "nonlocal", "timeout"]) {
    const process = child(); const pending = awaitDevTools(process, mode === "timeout" ? 1 : 1000);
    if (mode === "exit") process.emit("exit", 1);
    if (mode === "error") process.emit("error", new Error("spawn failed"));
    if (mode === "nonlocal") process.stderr?.emit("data", "DevTools listening on ws://0.0.0.0:1234/test\n");
    await assert.rejects(pending);
    assert.equal(process.listenerCount("exit"), 0);
  }
});

test("evaluate returns values and surfaces browser exceptions", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  try {
    const value = page.evaluate("2"); socket.reply(0, { result: { value: 2 } }); assert.equal(await value, 2);
    const exception = page.evaluate("bad()"); socket.reply(1, { exceptionDetails: { text: "bad evaluation" } });
    await assert.rejects(exception, /bad evaluation/);
    assert.equal(socket.sent[0].params.awaitPromise, true);
  } finally { cdp.close(); }
});

test("navigation handles load events before the command response and ignores another loader", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  const original = socket.send.bind(socket);
  socket.send = (text) => {
    original(text); const index = socket.sent.length - 1; const command = socket.sent[index];
    if (command.method === "Page.navigate") {
      socket.frame({ method: "Page.lifecycleEvent", sessionId: "page", params: { name: "load", frameId: "frame", loaderId: "loader" } });
      socket.reply(index, { frameId: "frame", loaderId: "loader" });
    } else socket.reply(index, {});
  };
  try { await page.navigate("http://127.0.0.1:1234/"); }
  finally { cdp.close(); }
});

test("navigation waits for the matching loader after the response", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  const original = socket.send.bind(socket);
  let finished = false;
  socket.send = (text) => {
    original(text); const index = socket.sent.length - 1;
    socket.reply(index, socket.sent[index].method === "Page.navigate" ? { frameId: "frame", loaderId: "loader" } : {});
  };
  try {
    const navigation = page.navigate("http://127.0.0.1:1234/").then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.frame({ method: "Page.lifecycleEvent", sessionId: "page", params: { name: "load", frameId: "frame", loaderId: "old" } });
    await Promise.resolve(); assert.equal(finished, false);
    socket.frame({ method: "Page.lifecycleEvent", sessionId: "page", params: { name: "load", frameId: "frame", loaderId: "loader" } });
    await navigation;
  } finally { cdp.close(); }
});

test("failed navigation cancels its registered lifecycle waiter", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  const original = socket.send.bind(socket);
  socket.send = (text) => {
    original(text); const index = socket.sent.length - 1;
    socket.reply(index, socket.sent[index].method === "Page.navigate" ? { errorText: "refused" } : {});
  };
  try { await assert.rejects(page.navigate("http://127.0.0.1:1234/"), /refused/); }
  finally { cdp.close(); }
});

test("screenshot writes decoded PNG bytes and viewport uses CSS metrics", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  const directory = await mkdtemp(join(tmpdir(), "cdp-test-"));
  try {
    const metrics = page.viewport(800, 900); socket.reply(0, {}); await metrics;
    assert.deepEqual(socket.sent[0].params, { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    const path = join(directory, "capture.png");
    const bytes = Buffer.from([137, 80, 78, 71]);
    const screenshot = page.screenshot(path); socket.reply(1, { data: bytes.toString("base64") }); await screenshot;
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(socket.sent[1].params.captureBeyondViewport, false);
  } finally { cdp.close(); await rm(directory, { recursive: true, force: true }); }
});

test("DOM waits use a MutationObserver and browser timing uses an animation frame", async () => {
  const { socket, cdp } = setup(); const page = new Page(cdp, "page");
  try {
    const wait = page.waitFor("document.querySelector('h1')", 50); socket.reply(0, { result: { value: true } }); await wait;
    const expression = String(socket.sent[0].params.expression);
    assert.match(expression, /MutationObserver/); assert.match(expression, /observer.disconnect/);
    assert.doesNotMatch(expression, /setInterval/);
    const timing = page.timing("2"); socket.reply(1, { result: { value: { value: 2, durationMs: 3 } } });
    assert.deepEqual(await timing, { value: 2, durationMs: 3 });
    assert.match(String(socket.sent[1].params.expression), /requestAnimationFrame/);
  } finally { cdp.close(); }
});

test("predicate failure rejects only that event waiter", async () => {
  const { socket, cdp } = setup();
  try {
    const bad = cdp.waitForEvent("event", () => { throw new Error("predicate failed"); });
    const good = cdp.waitForEvent("event");
    socket.frame({ method: "event", params: { value: 1 } });
    await assert.rejects(bad, /predicate failed/); assert.deepEqual(await good, { value: 1 });
  } finally { cdp.close(); }
});

test("connection failure and open deadline dispose socket listeners", async () => {
  for (const mode of ["error", "close", "timeout"]) {
    const socket = new MockSocket(); socket.readyState = 0;
    const pending = CDP.connect("ws://127.0.0.1:1234/test", () => socket, mode === "timeout" ? 1 : 1000);
    if (mode !== "timeout") socket.emit(mode, {});
    await assert.rejects(pending, /failed|timeout/);
    assert.equal(socket.readyState, 3);
    assert.equal([...socket.listeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
  }
});

test("late command responses after abort do not resolve another request", async () => {
  const { socket, cdp } = setup();
  try {
    const controller = new AbortController(); const aborted = cdp.send("cancel", {}, { signal: controller.signal });
    controller.abort(); await assert.rejects(aborted);
    const good = cdp.send("good"); socket.reply(0, { wrong: true }); socket.reply(1, { correct: true });
    assert.deepEqual(await good, { correct: true });
  } finally { cdp.close(); }
});
