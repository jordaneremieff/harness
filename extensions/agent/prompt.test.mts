import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { fixture } from "./native-fixture.mts";

test("the full-transcript hook retains system and tool changes in the native provider request", async () => {
	const f = await fixture(`export default pi => {
		pi.on("context", event => ({ messages: event.messages }));
		pi.on("context_with_system", event => ({ messages: [...event.messages, { role: "system", content: "FULL_TRANSCRIPT_MARKER", toolsRemoved: [{ name: "bash" }, { name: "edit" }, { name: "write" }], timestamp: Date.now() }] }));
	};`);
	try {
		await f.worker.start("context"); await f.worker.waitForIdle();
		assert.equal(f.worker.lastErrorMessage(), undefined);
		assert.match(getCurrentSystemPrompt(f.requests[0].messages), /FULL_TRANSCRIPT_MARKER/u);
		assert.deepEqual(getCurrentTools(f.requests[0].messages).map((tool) => tool.name), ["read"]);
	} finally { await f.close(); }
});

test("the canonical projection applies setup context edits without changing raw history", async () => {
	let target = "";
	const f = await fixture(undefined, { setup: async (manager) => {
		target = manager.appendMessage({ role: "user", content: "RAW_SECRET", timestamp: 1 });
		manager.appendContextEdit(target, { content: "PROJECTED_TEXT" });
	} });
	try {
		assert.match(JSON.stringify(f.worker.sessionManager().getEntry(target)), /RAW_SECRET/u);
		assert.doesNotMatch(JSON.stringify(f.worker.sessionManager().buildSessionProjection().messages), /RAW_SECRET/u);
		await f.worker.start("Use context"); await f.worker.waitForIdle();
		assert.match(JSON.stringify(f.requests[0]), /PROJECTED_TEXT/u);
		assert.doesNotMatch(JSON.stringify(f.requests[0]), /RAW_SECRET/u);
	} finally { await f.close(); }
});
