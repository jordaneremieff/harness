import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OrdinaryPlaybook } from "./ordinary-playbook.ts";
import type { PlaybookCatalog } from "./playbook-catalog.ts";

function fixture() {
	const sessionManager = SessionManager.inMemory();
	const shown: Array<string | undefined> = [];
	const ctx = { sessionManager, hasUI: true } as unknown as ExtensionContext;
	const ready: PlaybookCatalog = { state: "ready", dir: "/catalog", entries: [{ name: "maker", summary: "Build directly.", body: "Make the changes." }], diagnostics: [] };
	let catalog = ready;
	const controller = new OrdinaryPlaybook({ appendEntry: (type, data) => { sessionManager.appendCustomEntry(type, data); } }, () => catalog, (_ctx, badge) => shown.push(badge));
	return { ctx, shown, ready, controller, sessionManager, setCatalog: (next: PlaybookCatalog) => { catalog = next; } };
}

it("shows only a chosen playbook in the agent cell and marks a choice that waits for the next run", () => {
	const { ctx, shown, ready, controller } = fixture();
	controller.restore(ctx);
	assert.equal(shown.at(-1), undefined, "no choice adds nothing to the agent cell");
	assert.equal(controller.status(ctx), "This session: no playbook.");
	assert.equal(controller.set("maker", ctx), "This session now uses the maker playbook.");
	assert.equal(shown.at(-1), "maker");
	assert.equal(controller.badge, "maker");
	assert.match(controller.start(ctx, ready) ?? "", /Make the changes/u);
	assert.equal(controller.set("off", ctx), "This session now uses no playbook. The current run keeps the maker playbook; the next run uses it.");
	assert.equal(shown.at(-1), "maker \u2192 off");
	assert.deepEqual(controller.state(ctx), { saved: null, origin: "you chose it", running: "maker" });
	controller.restore(ctx);
	assert.equal(shown.at(-1), undefined);
	assert.deepEqual(controller.state(ctx), { saved: null, origin: "you chose it" });
	assert.equal(controller.start(ctx, ready), undefined);
	assert.equal(controller.set("maker", ctx), "This session now uses the maker playbook. The current run keeps no playbook; the next run uses it.");
	assert.equal(shown.at(-1), "off \u2192 maker");
});

it("marks a playbook as not sent when an earlier handler replaced the whole prompt, until a run sends it", () => {
	const { ctx, shown, ready, controller } = fixture();
	controller.set("maker", ctx);
	assert.match(controller.start(ctx, ready, true) ?? "", /Make the changes/u);
	assert.equal(shown.at(-1), "maker not sent");
	controller.restore(ctx);
	assert.equal(shown.at(-1), "maker not sent", "the mark stays after the run");
	assert.match(controller.status(ctx), /did not receive it: another extension replaced the whole system prompt/u);
	assert.equal(controller.state(ctx).unsent, true);
	controller.start(ctx, ready);
	controller.restore(ctx);
	assert.equal(shown.at(-1), "maker");
	assert.equal(controller.state(ctx).unsent, undefined);
});

it("flags a saved playbook whose file no longer supplies instructions and an unsupported saved form", () => {
	const { ctx, shown, controller, setCatalog, sessionManager } = fixture();
	controller.set("maker", ctx);
	setCatalog({ state: "ready", dir: "/catalog", entries: [], diagnostics: [] });
	assert.match(controller.status(ctx), /maker playbook\. Its file supplies no instructions now/u);
	assert.equal(shown.at(-1), "maker unavailable");
	sessionManager.appendCustomEntry("agent.playbook", { version: 2, origin: "operator", name: "maker" });
	controller.restore(ctx);
	assert.equal(shown.at(-1), "unknown");
	assert.equal(controller.state(ctx).saved, undefined);
});
