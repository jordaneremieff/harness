import assert from "node:assert/strict";
import { it } from "node:test";
import type * as Durable from "@earendil-works/pi-durable";
import { abortScopeContains } from "./abort-scope.ts";

it("finds a background owner above an intermediate task", async () => {
	const tx = {
		conversation: async (id: number) => id === 2 ? { id, owner: { conversationId: 1, taskId: 10 } } : { id },
		task: async (id: number) => id === 10 ? { background: false, owner: 11 } : { background: true },
	} as unknown as Durable.Tx;
	const caller = 2 as Durable.ConversationId, target = 1 as Durable.ConversationId;
	assert.equal(await abortScopeContains(tx, caller, target, false), false);
	assert.equal(await abortScopeContains(tx, caller, target, true), true);
});

it("refuses when an ownership task is unavailable", async () => {
	const tx = { conversation: async () => ({ owner: { conversationId: 1, taskId: 10 } }), task: async () => undefined } as unknown as Durable.Tx;
	assert.equal(await abortScopeContains(tx, 2 as Durable.ConversationId, 1 as Durable.ConversationId, false), true);
});
