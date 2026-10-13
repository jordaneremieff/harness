import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { it } from "node:test";
import type { Frame } from "@earendil-works/chord";
import { createUnixLink, type LocalTransportRefusal } from "./index.ts";

class ControlledSocket extends EventEmitter {
	readonly writableLength = 0;
	readonly writes: string[] = [];
	readonly callbacks: ((error?: Error | null) => void)[] = [];
	failure: "sync" | "async" | undefined;
	write(data: string, callback: (error?: Error | null) => void): boolean {
		if (this.failure === "sync") throw new Error("write interrupted");
		this.writes.push(data);
		this.callbacks.push(callback);
		return true;
	}
	destroy(): void { this.emit("close"); }
	end(callback: () => void): void { callback(); }
	complete(index: number): void { this.callbacks[index](this.failure === "async" ? new Error("write interrupted") : undefined); }
	get socket(): Socket { return this as unknown as Socket; }
}
const frame = { t: "result", id: 1, value: "😀\u0000" } as const;
const encodedBytes = Buffer.byteLength(JSON.stringify(frame));

it("keeps every encoded write charged until its callback, even with an empty socket queue", () => {
	const socket = new ControlledSocket();
	const link = createUnixLink(socket.socket, { expectedKind: "host", maxQueueBytes: (encodedBytes + 1) * 2 });
	let refused: LocalTransportRefusal | undefined;
	link.onSendRefusal((_frame, error) => { refused = error; });
	link.send(frame); link.send(frame);
	assert.equal(link.closed, false);
	socket.complete(0);
	link.send(frame);
	assert.equal(link.closed, false);
	link.send(frame);
	assert.equal(link.closed, true);
	assert.equal(socket.writes.length, 3);
	assert.equal(refused?.reason, "queue-limit");
	assert.equal(refused?.encodedBytes, encodedBytes);
	// Late callbacks after close do not restore capacity or notify twice.
	socket.complete(1); socket.complete(2);
});

it("releases only completed writes and ignores duplicate callbacks", () => {
	const socket = new ControlledSocket();
	const link = createUnixLink(socket.socket, { expectedKind: "host", maxQueueBytes: (encodedBytes + 1) * 2 });
	link.send(frame); link.send(frame);
	socket.complete(1); socket.complete(1);
	link.send(frame);
	assert.equal(link.closed, false);
	link.send(frame);
	assert.equal(link.closed, true);
	assert.equal(socket.writes.length, 3);
});

it("includes LF in the queue bound and excludes LF from the outgoing frame bound", () => {
	const accepted = new ControlledSocket();
	const link = createUnixLink(accepted.socket, { expectedKind: "host", maxFrameBytes: 1, maxSendFrameBytes: encodedBytes, maxQueueBytes: encodedBytes + 1 });
	link.send(frame);
	assert.equal(link.closed, false);
	assert.equal(Buffer.byteLength(accepted.writes[0]), encodedBytes + 1);
	link.close();
	for (const options of [{ maxSendFrameBytes: encodedBytes - 1 }, { maxSendFrameBytes: encodedBytes, maxQueueBytes: encodedBytes }]) {
		const socket = new ControlledSocket();
		const refused = createUnixLink(socket.socket, { expectedKind: "host", ...options });
		refused.send(frame);
		assert.equal(refused.closed, true);
		assert.equal(socket.writes.length, 0);
	}
});

for (const failure of ["sync", "async"] as const) it(`does not label a ${failure} socket write error as a definite refusal`, () => {
	const socket = new ControlledSocket(); socket.failure = failure;
	const link = createUnixLink(socket.socket, { expectedKind: "host" });
	let refusals = 0, closes = 0;
	link.onSendRefusal(() => { refusals++; }); link.onClose(() => { closes++; });
	assert.doesNotThrow(() => link.send(frame));
	if (failure === "async") socket.complete(0);
	assert.equal(link.closed, true);
	assert.equal(closes, 1);
	assert.equal(refusals, 0);
});

it("reports serialization refusal before close and before socket write", () => {
	const socket = new ControlledSocket();
	const link = createUnixLink(socket.socket, { expectedKind: "host" });
	const cycle: { t: "result"; id: number; value?: unknown } = { t: "result", id: 1 }; cycle.value = cycle;
	const events: string[] = [];
	link.onSendRefusal((value, error) => { assert.equal(value, cycle); events.push(error.reason); });
	link.onClose(() => events.push("close"));
	link.send(cycle as Frame);
	assert.deepEqual(events, ["serialization", "close"]);
	assert.equal(socket.writes.length, 0);
});

for (const maxSendFrameBytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) it("rejects an invalid outgoing bound before socket setup", () => {
	const socket = new ControlledSocket();
	assert.throws(() => createUnixLink(socket.socket, { expectedKind: "host", maxSendFrameBytes }), RangeError);
	assert.equal(socket.listenerCount("data"), 0);
});
