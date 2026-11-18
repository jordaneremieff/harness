import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

interface Key { key: string; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }
interface Context { sendKey: string; connection: string; state?: string; hasDraft: boolean }
const scope = {} as { composer: { logic: {
    keyDecision(key: Key, context: Context): { kind: string; behavior?: string };
    actionFor(state: string, options: Partial<Context>): { kind: string; label: string; disabled: boolean };
} } };
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./logic.ts", import.meta.url), "utf8")), scope);
const { keyDecision, actionFor } = scope.composer.logic;
const choose = (key: Partial<Key> = {}, context: Partial<Context> = {}) =>
    keyDecision({ key: "Enter", ...key }, { sendKey: "return", connection: "connected", hasDraft: true, ...context });

test("Return sends; Shift-Return and the alternate send preference preserve newlines", () => {
    assert.equal(choose().behavior, "send");
    assert.equal(choose({ shiftKey: true }).kind, "none");
    assert.equal(choose({}, { sendKey: "command" }).kind, "none");
    assert.equal(choose({ metaKey: true }, { sendKey: "command" }).behavior, "send");
});

test("working Return steers and Option-Return queues; composing text cannot send", () => {
    assert.equal(choose({}, { state: "working" }).behavior, "steer");
    assert.equal(choose({ altKey: true }, { state: "working" }).behavior, "queue");
    assert.equal(choose({ altKey: true }, { state: "idle" }).behavior, "send");
    assert.equal(choose({ isComposing: true }).kind, "none");
    assert.equal(choose({}, { connection: "reconnecting" }).kind, "consume");
});

test("Escape aborts active work or returns the keyboard to the terminal", () => {
    assert.equal(choose({ key: "Escape" }, { state: "working" }).kind, "abort");
    assert.equal(choose({ key: "Escape" }, { state: "waiting" }).kind, "release");
});

test("the working action stops only when the draft is empty", () => {
    assert.equal(actionFor("working", { connection: "connected" }).kind, "stop");
    assert.equal(actionFor("working", { connection: "connected", hasDraft: true }).label, "Steer");
    assert.equal(actionFor("idle", { connection: "reconnecting", hasDraft: true }).disabled, true);
});
