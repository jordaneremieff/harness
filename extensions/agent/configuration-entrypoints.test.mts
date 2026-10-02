import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { chooseDashboardAction, type AgentCommandAction } from "./command.ts";
import { configurationDialog } from "./configuration-dialog.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";

function summary(overrides: Partial<AgentConversationSummary> = {}): AgentConversationSummary {
	return { id: "storage-1:7", storageId: "storage-1", name: "Parser review", cwd: "/work/parser", owner: "here", modifiedAt: 1, state: "idle", cost: 0, partial: false, model: { provider: "test", modelId: "test-model", thinkingLevel: "high" }, ...overrides };
}
function dialogs(selections: Array<string | undefined>, inputs: Array<string | undefined> = []) {
	const notices: string[] = [];
	const titles: string[] = [];
	const ctx = { ui: {
		select: async (title: string) => { titles.push(title); return selections.shift(); },
		input: async () => inputs.shift(),
		notify: (text: string) => notices.push(text),
	} } as unknown as ExtensionCommandContext;
	return { ctx, notices, titles };
}

test("native configuration dialogs keep drafts local, validate fields, and preserve Apply and Cancel", async () => {
	const snapshot = summary();
	const selections = ["Apply", "Model", "Name", "Reasoning", "high", "Apply"];
	const inputs = ["not-exact", "Dialog name"];
	const d = dialogs(selections, inputs);
	const before = structuredClone(snapshot);
	const patch = await configurationDialog(snapshot, d.ctx);
	assert.deepEqual(patch, { name: "Dialog name", thinkingLevel: "high" });
	assert.deepEqual(snapshot, before);
	assert.equal(d.notices.length, 2);
	assert.match(d.notices[0], /requires at least one/);
	assert.match(d.notices[1], /exact provider\/model identity/);
	assert.match(d.titles[0], /Configure storage-1:7/);
	assert.match(d.titles[0], /name=Parser review; model=test\/test-model; reasoning=high/);

	const cancelled = dialogs(["Name", "Cancel"], ["Discarded name"]);
	assert.equal(await configurationDialog(snapshot, cancelled.ctx), undefined);
	assert.deepEqual(snapshot, before);
});

test("configuration dialogs show fields without a stored model as unavailable", async () => {
	const snapshot = summary({ model: undefined, name: undefined });
	const d = dialogs(["Apply"], []);
	assert.equal(await configurationDialog(snapshot, d.ctx), undefined);
	assert.match(d.titles[0], /name=\(unnamed\); model=\(unavailable\); reasoning=\(unavailable\)/);
});

test("the dashboard configure entry reaches the same dialog and returns its patch", async () => {
	const snapshot = summary();
	const selections = ["configure: Change an idle session's name, model, or reasoning", "Name", "Apply"];
	const inputs = ["Renamed"];
	const d = dialogs(selections, inputs);
	const action: AgentCommandAction = {
		name: "configure", description: "Change an idle session's name, model, or reasoning", args: [{ name: "session", complete: "session" }],
		dialog: async (target, ctx) => {
			assert.ok(target);
			const patch = await configurationDialog(target, ctx);
			return patch ? JSON.stringify(patch) : undefined;
		},
		run: async () => undefined,
	};
	const result = await chooseDashboardAction([action], snapshot, d.ctx);
	assert.equal(result, JSON.stringify({ name: "Renamed" }));
});
