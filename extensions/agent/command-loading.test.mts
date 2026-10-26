import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("loads dashboard modules only for an interactive dashboard request", () => {
	const script = `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const loaded = [];
		registerHooks({ load(url, context, next) {
			if (/\\/(dashboard|action-dialogs)\\.ts$/.test(url)) loaded.push(url);
			return next(url, context);
		} });
		const { createAgentCommand } = await import(${JSON.stringify(new URL("./command.ts", import.meta.url).href)});
		const command = createAgentCommand([], {}, {});
		assert.deepEqual(loaded, []);
		await command.openDashboard({ hasUI: false });
		await command.getArgumentCompletions("");
		assert.deepEqual(loaded, []);
		let calls = 0;
		let finish;
		const gate = new Promise(resolve => finish = resolve);
		const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "fixture" }, ui: { custom: async () => { calls++; await gate; } } };
		const opening = command.openDashboard(ctx);
		await command.openDashboard(ctx);
		for (let attempt = 0; calls === 0 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(calls, 1);
		assert.equal(loaded.filter(url => url.endsWith("/dashboard.ts")).length, 1);
		assert.equal(loaded.filter(url => url.endsWith("/action-dialogs.ts")).length, 1);
		finish();
		await opening;
		await command.openDashboard(ctx);
		assert.equal(calls, 2);
		assert.equal(loaded.filter(url => url.endsWith("/dashboard.ts")).length, 1);
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
});
