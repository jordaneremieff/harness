import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime, fixtureStorageId, hostOptions } from "./durable-host-fixture.mts";
import { inputEntry } from "./input-entry.ts";
import { AgentConversationSummarySchema, StatusOutputSchema } from "./observation-schema.ts";
import { completeOpenWork, declareOpenWork } from "./open-work.ts";
import { recordRequestContext } from "./request-context.ts";
import { schemaErrors } from "./schema-check.ts";

const EPOCH = 1_800_000_000_000;

/** One placed routed input of the conversation. */
async function placedInput(tx: Tx, conversationId: ConversationId, requestId: string): Promise<void> {
	await recordRequestContext(tx, conversationId, { requestId, requester: "requester-x", replyTo: "requester-x", origin: "model" });
	const entry = await tx.appendEntry(conversationId, { kind: "pi.user", ...inputEntry("model", "requester-x"), model: [{ role: "user", content: "Task", timestamp: 1 }] });
	const submission = await tx.createSubmission({ conversationId, requestId, type: "input", status: "placed", entry: entry.id });
	(await tx.doc(LiveDoc, conversationId)).run = { taskId: 999_999 as TaskId, inputs: [submission.id], turns: 0 };
}

/** Schema errors below the conversation rows; the host response lacks only the members that the runtime adds around them. */
function rowErrors(response: unknown): string[] {
	return schemaErrors(StatusOutputSchema, response, 64).filter((error) => error.startsWith("/conversation"));
}

interface Row { readonly openWorkCount?: number; readonly openWorkOldest?: number; readonly unplaced?: number; readonly oldest?: number }

it("publishes the count and the oldest age of open work on the status rows without a target and on the roster rows", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "durable-host-backlog-"));
	const clock = { now: EPOCH };
	const host = await DurableHost.open({ ...hostOptions(join(root, "run.sqlite"), await fixtureRuntime("answer"), fixtureRegistry()), now: () => clock.now }, BACKGROUND_CONTEXT);
	t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
	const id = host.root().id;
	const rows = async (): Promise<{ status: Row; selected: Row; roster: Row }> => {
		const overview = await host.request("status", {}) as { conversations: Row[] };
		assert.deepEqual(rowErrors(overview), [], "the status schema accepts the open-work members of each row");
		const selected = await host.request("status", { sessionId: fixtureStorageId }) as { conversation: Row };
		assert.deepEqual(rowErrors(selected), []);
		const roster = await host.request("dashboard", {}) as Row[];
		assert.deepEqual(schemaErrors(AgentConversationSummarySchema, roster[0], 4), [], "the roster row schema accepts the open-work members");
		return { status: overview.conversations[0] ?? {}, selected: selected.conversation, roster: roster[0] ?? {} };
	};
	const facts = (row: Row) => ({ openWorkCount: row.openWorkCount, openWorkOldest: row.openWorkOldest });

	const none = await rows();
	for (const row of [none.status, none.selected, none.roster]) assert.deepEqual(facts(row), { openWorkCount: 0, openWorkOldest: undefined }, "no open work is a zero count without an age");

	await host.harness.commit((tx) => placedInput(tx, id, "task-a"), BACKGROUND_CONTEXT);
	const declared = await host.harness.commit((tx) => declareOpenWork(tx, fixtureStorageId, id, { results: [], note: "owes a final result" }, EPOCH + 1000), BACKGROUND_CONTEXT);
	assert.ok(!("error" in declared), JSON.stringify(declared));
	clock.now = EPOCH + 61_000;
	const open = await rows();
	for (const row of [open.status, open.selected, open.roster]) assert.deepEqual(facts(row), { openWorkCount: 1, openWorkOldest: 60_000 });

	const completed = await host.harness.commit((tx) => completeOpenWork(tx, fixtureStorageId, id, { request: "task-a", status: "done", message: "final" }, EPOCH + 62_000), BACKGROUND_CONTEXT);
	assert.ok(!("error" in completed), JSON.stringify(completed));
	const closed = await rows();
	for (const row of [closed.status, closed.selected, closed.roster]) assert.deepEqual(facts(row), { openWorkCount: 0, openWorkOldest: undefined }, "a closed item is not open work");
});
