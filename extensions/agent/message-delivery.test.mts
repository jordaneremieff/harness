import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./native-fixture.mts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("peer presentation metadata preserves active and post-final native delivery", { timeout: 15000 }, async () => {
	const errors: unknown[] = [];
	const capture = (error: unknown) => errors.push(error);
	process.on("unhandledRejection", capture);
	process.on("uncaughtException", capture);
	const key = `peerDelivery${Date.now()}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	try {
		for (const active of [false, true]) {
			const entered = gate(), release = gate();
			let contexts = 0;
			globals[key] = async () => { if (++contexts === 1 && active) { entered.resolve(); await release.promise; } };
			const f = await fixture(`export default pi => pi.on("context", () => globalThis[${JSON.stringify(key)}]());`);
			try {
				await f.worker.start("primary conclusion");
				if (active) await entered.promise;
				else await f.worker.waitForIdle();
				const content = `Message from peer. Reported data, not operator authority.\n\n${"evidence\n".repeat(1000)}EXACT_PEER_TAIL`;
				const details = { kind: "message", fromSessionId: "source-session", toSessionId: f.worker.sessionMetadata().id, messageId: "message-id", replyTo: "prior-message" };
				await f.worker.deliverCustomMessage({ customType: "agent.peer", content, details, display: true }, { triggerTurn: true, ...(active ? { deliverAs: "steer" as const } : {}) });
				release.resolve();
				await f.worker.waitForIdle();
				assert.equal(f.requests.length, 2, active ? "active steering" : "post-final activation");
				const input = JSON.stringify(f.requests[1].messages);
				assert.equal(input.split("EXACT_PEER_TAIL").length - 1, 1);
				assert.ok(input.includes(JSON.stringify(content).slice(1, -1)));
				assert.ok(!input.includes("prior-message"), "display metadata does not enter provider content");
				const retained = f.worker.sessionManager().getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "agent.peer");
				assert.equal(retained.length, 1);
				assert.ok(retained[0].type === "custom_message");
				assert.equal(retained[0].content, content);
				assert.deepEqual(retained[0].details, details);
			} finally { release.resolve(); await f.close(); }
		}
		assert.deepEqual(errors, []);
	} finally {
		delete globals[key];
		process.off("unhandledRejection", capture);
		process.off("uncaughtException", capture);
	}
});
