import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./native-fixture.mts";

test("explicit commands stay separate from peer custom-message text", async () => {
	const f = await fixture(`export default pi => { pi.registerCommand("record", { handler: async () => { pi.appendEntry("command.called", {}); } }); };`);
	try {
		await f.worker.deliverCustomMessage({ customType: "agent.peer", content: "/record", display: true }, { triggerTurn: true });
		await f.worker.waitForIdle();
		assert.equal(f.worker.sessionManager().getEntries().some((entry) => entry.type === "custom" && entry.customType === "command.called"), false);
		await f.worker.runCommand("record", "");
		assert.ok(f.worker.sessionManager().getEntries().some((entry) => entry.type === "custom" && entry.customType === "command.called"));
		assert.equal(f.requests.length, 1);
		await assert.rejects(f.worker.runCommand("missing", ""), /unknown command/u);
	} finally { await f.close(); }
});

test("native queue admission remains visible and does not claim durable replay", async () => {
	const f = await fixture();
	try {
		await f.worker.steer("next input");
		assert.equal(f.worker.observation().pending, 1);
		assert.match((await f.worker.inspect()).execution.recovery, /no in-flight replay/u);
		await f.worker.start("first").then(() => assert.fail("queued input must block a separate admission"), () => undefined);
		assert.equal(f.worker.hasPendingHostWork(), true);
	} finally { await f.close(); }
});
