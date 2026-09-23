import assert from "node:assert/strict";
import { it } from "node:test";
import { createManagedHostBus } from "./host-role.ts";

it("reports only its exact currently claimed native identity and removes its listener", () => {
	let owned = false;
	const host = createManagedHostBus("child", () => owned);
	const roles: unknown[] = [];
	host.bus.on("harness:session-host:role", (role) => roles.push(role));
	const request = (sessionId: string, version = 1) => host.bus.emit("harness:session-host:request", { version, sessionId });
	request("child");
	assert.equal(roles.length, 0);
	owned = true;
	request("foreign"); request("child", 2);
	assert.equal(roles.length, 0);
	request("child");
	assert.deepEqual(roles, [{ version: 1, sessionId: "child", role: "managed-child" }]);
	owned = false; request("child");
	assert.equal(roles.length, 1);
	owned = true; host.dispose(); host.dispose(); request("child");
	assert.equal(roles.length, 1);
});

it("keeps replacement buses separate even when native identities are equal", () => {
	const previous = createManagedHostBus("same", () => true);
	const next = createManagedHostBus("same", () => true);
	let oldReplies = 0; let nextReplies = 0;
	previous.bus.on("harness:session-host:role", () => oldReplies++);
	next.bus.on("harness:session-host:role", () => nextReplies++);
	previous.dispose();
	previous.bus.emit("harness:session-host:request", {version:1,sessionId:"same"});
	next.bus.emit("harness:session-host:request", {version:1,sessionId:"same"});
	assert.equal(oldReplies, 0); assert.equal(nextReplies, 1);
	next.dispose();
});
