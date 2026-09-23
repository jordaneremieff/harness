import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { AgentStore } from "./store.ts";
import { AgentWorkerSession } from "./worker.ts";

test("inspection pages preserve entry identity and bounded UTF-8 detail reconstruction", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-inspect-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const runtime = await createTestRuntime({ refreshOnCreate: false });
	const worker = await AgentWorkerSession.create({ cwd, agentDir, store, modelRuntime: runtime, model: { provider: "agent-test", modelId: "model" }, rootContext: BACKGROUND_CONTEXT });
	try {
		for (let index = 0; index < 15; index++) await worker.appendCustomEntry("inspection.record", { index, content: "中文🧪".repeat(4000) });
		const ids = new Set<string>();
		let cursor: number | undefined;
		do {
			const page = await worker.inspect({ limit: 12, cursor });
			assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") < 32000);
			assert.ok("entries" in page && page.entries);
			for (const entry of page.entries) { assert.ok(!ids.has(entry.id)); ids.add(entry.id); }
			cursor = page.nextCursor ?? undefined;
		} while (cursor !== undefined);
		assert.deepEqual(ids, new Set(worker.sessionManager().getEntries().map((entry) => entry.id)));
		const target = worker.sessionManager().getEntries().find((entry) => entry.type === "custom" && entry.customType === "inspection.record");
		assert.ok(target);
		let offset: number | undefined = 0;
		let text = "";
		do {
			const page = await worker.inspect({ entryId: target.id, offset });
			assert.ok("text" in page && typeof page.text === "string");
			assert.ok(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8") < 32000);
			text += page.text;
			offset = page.nextOffset ?? undefined;
		} while (offset !== undefined);
		const record = JSON.parse(text);
		assert.equal(record.id, target.id);
		assert.deepEqual(record.data, target.type === "custom" ? target.data : undefined);
		await worker.close();
		await worker.close();
	} finally { await worker.close(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true }); }
});
