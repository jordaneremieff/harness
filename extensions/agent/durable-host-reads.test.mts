import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-host-reads-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

it("returns the admission of a rewind without the outcome of its correction, also with a wait member", async (t) => {
	const host = await DurableHost.open(hostOptions(join(fixtureRoot(t), "run.sqlite"), await scriptedRuntime([answerMessage("first answer"), answerMessage("corrected answer")]), fixtureRegistry()), BACKGROUND_CONTEXT);
	try {
		const submitted = await host.submit({ message: "first prompt", requestId: "rewind-source" });
		await host.wait(submitted.submissionId, BACKGROUND_CONTEXT);
		const assistant = (await host.root().entries({}, 20, undefined, BACKGROUND_CONTEXT)).items.find((entry) => entry.kind === "pi.assistant");
		assert.ok(assistant, "the first answer is retained");

		const rewind = (await host.request("rewind", { entryId: assistant.id, correction: "corrected prompt", wait: true })) as { conversationId: ConversationId; submissionId: SubmissionId };
		assert.deepEqual(Object.keys(rewind).sort(), ["conversationId", "deduped", "identity", "predecessorEntryId", "submissionId"], "the response carries the admission only");
		const corrected = await host.wait(rewind.submissionId, BACKGROUND_CONTEXT);
		assert.equal(corrected.status, "done");
		assert.equal(corrected.conversationId, rewind.conversationId);
	} finally {
		await host.close();
	}
});
