import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { it } from "node:test";
import { createUnixLink } from "./unix-link.ts";

class ControlledSocket extends EventEmitter {
	readonly writableLength = 0;
	readonly writes: Uint8Array[] = [];
	readonly callbacks: ((error?: Error | null) => void)[] = [];
	failure: "sync" | "async" | undefined;
	write(data: Uint8Array, callback: (error?: Error | null) => void): boolean {
		if (this.failure === "sync") throw new Error("write interrupted");
		this.writes.push(data); this.callbacks.push(callback); return true;
	}
	destroy(): void { this.emit("close"); }
	end(callback: () => void): void { callback(); }
	complete(index: number): void { this.callbacks[index](this.failure === "async" ? new Error("write interrupted") : undefined); }
	get socket(): Socket { return this as unknown as Socket; }
}
const message = Buffer.from("😀\u0000");
const encodedBytes = message.byteLength;
it("keeps every encoded write charged until its callback, even with an empty socket queue", () => {
	const socket = new ControlledSocket();
	const link = createUnixLink(socket.socket, { expectedKind: "host", maxQueueBytes: (encodedBytes + 4) * 2 });
	link.send(message); link.send(message); assert.equal(link.closed, false);
	socket.complete(1); link.send(message); assert.equal(link.closed, false);
	link.send(message); assert.equal(link.closed, true); assert.equal(socket.writes.length, 4);
	assert.match(link.reason, /queue/);
	socket.complete(2); socket.complete(3);
});
it("releases only completed writes and ignores duplicate callbacks", () => {
	const socket = new ControlledSocket(); const link = createUnixLink(socket.socket, { expectedKind: "host", maxQueueBytes: (encodedBytes + 4) * 2 });
	link.send(message); link.send(message); socket.complete(2); socket.complete(2);
	link.send(message); assert.equal(link.closed, false);
	link.send(message); assert.equal(link.closed, true); assert.equal(socket.writes.length, 4);
});
it("includes the length prefix in the queue bound but not the payload bound", () => {
	const accepted = new ControlledSocket();
	const link = createUnixLink(accepted.socket, { expectedKind: "host", maxFrameBytes: 1, maxSendFrameBytes: encodedBytes, maxQueueBytes: encodedBytes + 4 });
	link.send(message); assert.equal(link.closed, false); assert.equal(accepted.writes[1].byteLength, encodedBytes + 4); link.close();
	for (const options of [{ maxSendFrameBytes: encodedBytes - 1 }, { maxSendFrameBytes: encodedBytes, maxQueueBytes: encodedBytes + 3 }]) {
		const socket = new ControlledSocket(); const refused = createUnixLink(socket.socket, { expectedKind: "host", ...options });
		refused.send(message); assert.equal(refused.closed, true); assert.equal(socket.writes.length, 1);
	}
});
for (const failure of ["sync", "async"] as const) it(`closes once after a ${failure} socket write error`, () => {
	const socket = new ControlledSocket(); const link = createUnixLink(socket.socket, { expectedKind: "host" }); socket.failure = failure;
	let closes = 0; link.onClose(() => closes++);
	assert.doesNotThrow(() => link.send(message)); if (failure === "async") socket.complete(1);
	assert.equal(link.closed, true); assert.equal(closes, 1);
});
it("refuses non-byte input before a payload write", () => {
	const socket = new ControlledSocket(); const link = createUnixLink(socket.socket, { expectedKind: "host" });
	link.send({} as Uint8Array); assert.equal(link.closed, true); assert.match(link.reason, /nonempty bytes/); assert.equal(socket.writes.length, 1);
});
for (const maxSendFrameBytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) it("rejects an invalid outgoing bound before socket setup", () => {
	const socket = new ControlledSocket(); assert.throws(() => createUnixLink(socket.socket, { expectedKind: "host", maxSendFrameBytes }), RangeError); assert.equal(socket.listenerCount("data"), 0);
});
