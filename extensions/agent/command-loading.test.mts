import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("loads the work view, its forms and owner views only for an interactive request", () => {
	const script = `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const loaded = [];
		registerHooks({ load(url, context, next) {
			if (/\\/(dashboard|agent-forms|panel-modules)\\.ts$/.test(url)) loaded.push(url);
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
		assert.equal(loaded.filter(url => url.endsWith("/agent-forms.ts")).length, 1);
		assert.equal(loaded.filter(url => url.endsWith("/panel-modules.ts")).length, 0, "owner views wait for their own first use");
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

it("keeps profile dialog and native contribution modules deferred until command or contribution use", () => {
	const script = `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		const loaded = [];
		registerHooks({ load(url, context, next) {
			if (/\\/(profile-dialog|dashboard|dashboard-state|agent-git|agent-forms|panel-modules|durable-agents|durable-observation|durable-services)\\.ts$/.test(url)) loaded.push(url);
			return next(url, context);
		} });
		const { default: register } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
		let contribution;
		await register({
			events: {
				emit(channel, value) {
					if (channel === "durable:contribution") contribution = value;
				},
				on: () => () => {},
			},
			on: () => () => {},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			registerToolRenderer() {},
			getThinkingLevel: () => "off",
			getSettings: () => ({}),
		});
		assert.ok(contribution, "ordinary registration synchronously publishes the contribution descriptor");
		assert.deepEqual(loaded, [], "registration does not load dialog or native implementation modules");
	`;
	const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024,
	});
	assert.equal(child.status, 0, child.stderr || child.error?.message);
});

