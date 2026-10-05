import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { executeAwait } from "./await-execution.ts";

for (const failure of ["setup", "absent", "start", "disconnect", "snapshot"] as const) it(`cleans invocation resources after ${failure} failure`, async () => {
	let stopped = 0; let owned: Context | undefined; let commits = 0;
	const api = {
		conversationId: 1, taskId: 10, callId: "await-call",
		async commit() { commits++; return commits === 2 ? [] : undefined; },
		async conversation() { return { id: 1 }; },
		async snapshot() { if (failure === "snapshot") throw new Error("snapshot failure"); return { declarations: [{ taskId: 10, decision: "awaiting" }] }; },
		async watchDoc(_kind: unknown, context: Context) {
			owned = context;
			if (failure === "setup") throw new Error("setup failure");
			if (failure === "absent") return undefined;
			return {
				start() { if (failure === "start") throw new Error("start failure"); },
				async stop() { stopped++; },
				closed: failure === "disconnect" ? Promise.resolve({ reason: "session_closed" }) : new Promise(() => {}),
			};
		},
	} as unknown as ToolExecutionApi;
	await assert.rejects(executeAwait({ results: [{ sessionId: "foreign", submissionId: 5 }] }, api, BACKGROUND_CONTEXT, "store", async (_method, _params, context) => new Promise((_resolve, reject) => {
		if (context?.abortSignal?.aborted) reject(new Error("cancelled"));
		else context?.abortSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
	})), failure === "absent" ? /not committed/u : /failure|session_closed/u);
	assert.equal(owned?.abortSignal?.aborted, true);
	assert.equal(stopped, failure === "setup" || failure === "absent" ? 0 : 1);
});
