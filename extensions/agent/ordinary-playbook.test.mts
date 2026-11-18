import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OrdinaryPlaybook } from "./ordinary-playbook.ts";
import type { PlaybookCatalog } from "./playbook-catalog.ts";

it("keeps the active playbook and its pending successor visible without replacing the Agent footer", () => {
	const sessionManager = SessionManager.inMemory();
	const statuses = new Map<string, string>([["agent", "Worker is busy"]]);
	const ctx = { sessionManager, hasUI: true, ui: { setStatus: (key: string, value: string) => statuses.set(key, value) } } as unknown as ExtensionContext;
	const catalog: PlaybookCatalog = { state: "ready", dir: "/catalog", entries: [{ name: "maker", summary: "Build directly.", body: "Make the changes." }], diagnostics: [] };
	const controller = new OrdinaryPlaybook({ appendEntry: (type, data) => { sessionManager.appendCustomEntry(type, data); } }, () => catalog);
	controller.restore(ctx);
	assert.match(controller.set("maker", ctx), /maker \(operator\).*Build directly/u);
	assert.match(controller.start(ctx, catalog) ?? "", /Make the changes/u);
	const receipt = controller.set("off", ctx);
	assert.match(receipt, /current: maker \(operator\).*next run: off \(operator\)/u);
	assert.equal(statuses.get("agent-playbook"), receipt);
	controller.restore(ctx);
	assert.equal(statuses.get("agent-playbook"), "Playbook: off (operator)");
	assert.equal(statuses.get("agent"), "Worker is busy");
	assert.equal(controller.start(ctx, catalog), undefined);
});
