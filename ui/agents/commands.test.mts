import assert from "node:assert/strict";
import test from "node:test";
import { HostLink } from "./client.mts";
import { ContractError, decodeInput, decodeResponse, RESERVED_COMMANDS, type JsonObject } from "./contract.mts";
import { commandReply, descriptor, FakeHost, STORAGE, statusReply } from "./fake-host.mts";

const code = (expected: string) => (error: unknown): boolean => {
	assert.equal((error as { code?: string }).code, expected);
	return true;
};
function refuse(fn: () => unknown): void {
	assert.throws(fn, (error: unknown) => error instanceof ContractError && error.code === "malformed");
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

test("status decodes the host inventory and keeps a not-live reply without one", () => {
	const reply = decodeResponse("status", statusReply());
	assert.equal(reply.inventory?.contributions[0].name, "fixture-contribution");
	assert.deepEqual(reply.inventory?.ordinaryOnly, ["fixture-ordinary"]);
	const stored = decodeResponse("status", { conversation: {}, live: false, storageId: STORAGE });
	assert.equal(stored.inventory, undefined);
	const failed = clone(statusReply()); (failed.inventory as JsonObject).failed = [{ path: "/x/extension.ts", error: "boom" }];
	assert.equal(decodeResponse("status", failed).inventory?.failed?.[0].path, "/x/extension.ts");
});

test("status refuses a malformed inventory", () => {
	const bad = (mutate: (value: JsonObject) => void) => { const value = clone(statusReply()); mutate(value.inventory as JsonObject); return value; };
	refuse(() => decodeResponse("status", bad(inventory => { inventory.contributions = {} as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { (inventory.contributions as JsonObject[])[0].commands = [{ name: "x" }] as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { (inventory.contributions as JsonObject[])[0].extra = 1; })));
	refuse(() => decodeResponse("status", bad(inventory => { inventory.ordinaryOnly = [1] as never; })));
	refuse(() => decodeResponse("status", bad(inventory => { inventory.failed = [{ path: "x" }] as never; })));
	refuse(() => decodeResponse("status", { storageId: STORAGE, inventory: {} }));
	refuse(() => decodeResponse("status", { conversation: {} }));
});

test("a command result names its target and shape", () => {
	const result = decodeResponse("command", commandReply(STORAGE, "ping", "pong"), { identity: STORAGE });
	assert.equal(result.text, "pong");
	assert.equal(decodeResponse("command", commandReply(STORAGE, "ping", ""), { identity: STORAGE }).text, "");
	refuse(() => decodeResponse("command", { ...commandReply(STORAGE, "ping", "pong"), extra: 1 }, { identity: STORAGE }));
	refuse(() => decodeResponse("command", commandReply(`${STORAGE}:2`, "ping", "pong"), { identity: STORAGE }));
	refuse(() => decodeResponse("command", { ...commandReply(STORAGE, "ping", "pong"), text: 3 }, { identity: STORAGE }));
});

test("command and status requests accept exactly the documented parameters", () => {
	assert.deepEqual(decodeInput("status", { sessionId: STORAGE }), { sessionId: STORAGE });
	refuse(() => decodeInput("status", { sessionId: STORAGE, conversationId: 1 }));
	const request = { sessionId: STORAGE, name: "ping", args: "a b", invocationId: "ui:operation" };
	assert.deepEqual(decodeInput("command", request), request);
	assert.deepEqual(decodeInput("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:operation" }), { sessionId: STORAGE, name: "ping", invocationId: "ui:operation" });
	for (const name of RESERVED_COMMANDS) refuse(() => decodeInput("command", { ...request, name }));
	for (const bad of [{ name: "" }, { name: "has space" }, { name: "/ping" }, { name: "x".repeat(129) }, { args: 3 }, { args: "x".repeat(64 * 1024 + 1) },
		{ invocationId: "" }, { invocationId: "has space" }, { data: {} }, { sessionId: "bad id" }]) refuse(() => decodeInput("command", { ...request, ...bad }));
	refuse(() => decodeInput("command", { sessionId: STORAGE, name: "ping" }));
});

test("a link negotiates status and command and runs a command once through the exact operations", async t => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("status"), true);
	assert.equal(link.supports("command"), true);
	const reply = await link.request("status", { sessionId: STORAGE }, { identity: STORAGE }) as { inventory: { contributions: unknown[] } };
	assert.equal(reply.inventory.contributions.length, 1);
	const result = await link.request("command", { sessionId: STORAGE, name: "ping", args: "", invocationId: "ui:op-1" }, { identity: STORAGE }) as { text: string };
	assert.equal(result.text, "pong");
	assert.deepEqual(host.calls.map(call => call.member), ["status", "command"]);
	assert.deepEqual(host.calls[0].expected, { request: "status/1.0.0", response: "481a5267ce06c0ed2bb89e85e142e3a5d58c78828fb502c46ff815a3cb889197", durable: (await descriptor() as { upstream: { durable: string } }).upstream.durable });
	assert.equal((host.calls[1].expected as { request: string; response: string }).request, "command/1.1.0");
	assert.equal((host.calls[1].expected as { request: string; response: string }).response, "command/1.0.0");
	assert.equal(host.calls[1].params?.invocationId, "ui:op-1");
});

test("a host without the command identities refuses before any call and keeps other operations", async t => {
	const remote = await descriptor();
	const operations = remote.operations as Record<string, Record<string, unknown>>;
	operations.command.request = "command/2.0.0";
	delete operations.status;
	const host = await FakeHost.start({ descriptor: remote as never });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	assert.equal(link.supports("status"), false);
	assert.equal(link.supports("command"), false);
	assert.equal(link.supports("abort"), true);
	await assert.rejects(link.request("status", { sessionId: STORAGE }, { identity: STORAGE }), code("contract_mismatch"));
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:op" }, { identity: STORAGE }), code("contract_mismatch"));
	assert.equal(host.calls.length, 0);
});

test("a command is refused locally when reserved or malformed, before any call", async t => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "reload", invocationId: "ui:op" }, { identity: STORAGE }), code("invalid_request"));
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "tree", args: "1", invocationId: "ui:op" }, { identity: STORAGE }), code("invalid_request"));
	assert.equal(host.calls.length, 0);
});

test("a result for another command name or a malformed result is an uncertain protocol error and disables the operation", async t => {
	const host = await FakeHost.start({ handler: call => {
		if (call.member !== "command") return undefined;
		return call.params?.name === "ping" ? commandReply(STORAGE, "other", "x") : { name: call.params?.name, text: 1 } as JsonObject;
	} });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	await assert.rejects(link.request("command", { sessionId: STORAGE, name: "ping", invocationId: "ui:op" }, { identity: STORAGE }), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "protocol_error");
		assert.equal((error as { uncertain?: boolean }).uncertain, true);
		return true;
	});
	assert.equal(link.supports("command"), false);
	assert.equal(link.supports("status"), true);
});
