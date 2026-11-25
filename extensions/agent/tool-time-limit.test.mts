import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type * as Durable from "@earendil-works/pi-durable";
import { acquireHost } from "./host-client.ts";
import { runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { limitExtensionToolTime, limitToolTime, ToolTimeLimitError } from "./tool-time-limit.ts";

type Tool = Durable.ToolRegistration;
const api = {} as Parameters<Tool["execute"]>[1];

function tool(execute: Tool["execute"]): Tool {
	return { name: "probe", description: "probe", parameters: {}, execute } as unknown as Tool;
}

it("ends a call that never settles with the limit error and cancels its context", async () => {
	let signal: AbortSignal | undefined;
	const bounded = limitToolTime(
		tool(async (_args, _api, context) => {
			signal = context.abortSignal;
			return new Promise(() => {});
		}),
		30,
	);
	await assert.rejects(bounded.execute({}, api, BACKGROUND_CONTEXT), (error: unknown) => {
		assert.ok(error instanceof ToolTimeLimitError);
		assert.match(error.message, /The probe call did not finish within 30 ms.*agent\.toolCallMaxMinutes/u);
		return true;
	});
	assert.equal(signal?.aborted, true, "a tool that honours cancellation sees its context cancelled");
});

it("returns a result within the limit and keeps the caller's own cancellation reason", async () => {
	const quick = limitToolTime(
		tool(async () => ({ output: [{ type: "text", text: "done" }] })),
		60_000,
	);
	assert.deepEqual(await quick.execute({}, api, BACKGROUND_CONTEXT), { output: [{ type: "text", text: "done" }] });
	const caller = withCancel(BACKGROUND_CONTEXT);
	const waiting = limitToolTime(
		tool(async () => new Promise(() => {})),
		60_000,
	).execute({}, api, caller.context);
	caller.cancel(new Error("caller stopped"));
	await assert.rejects(waiting, (error: unknown) => !(error instanceof ToolTimeLimitError));
});

it("leaves tools unchanged without a limit and bounds wrapped tools", async () => {
	const base = tool(async () => new Promise(() => {}));
	assert.equal(limitToolTime(base, 0), base);
	const extension = limitExtensionToolTime(
		{ name: "x", wraps: [{ tool: "probe", wrap: (inner: Tool) => ({ ...inner, execute: inner.execute }) }] },
		20,
	);
	const wrap = extension.wraps?.[0];
	assert.ok(wrap !== undefined && "tool" in wrap);
	await assert.rejects(wrap.wrap(base).execute({}, api, BACKGROUND_CONTEXT), ToolTimeLimitError);
});

it("ends a real host's tool call that never settles, so the run finishes", { timeout: 60_000 }, async (t) => {
	const f = runtimeFixture(t);
	const client = await acquireHost(f.metadata, {
		env: { ...f.env("effect"), PI_AGENT_TOOL_CALL_MAX_MINUTES: "0.005" },
	});
	trackHost(t, client.pid);
	t.after(() => client.close());
	const submitted = (await client.request("submit", {
		message: "run the effect",
		requestId: "bounded-effect",
		ownerId: f.ownerId,
		origin: "operator",
	})) as { submissionId: number };
	const receipt = await waitForReceipt(client, f.ownerId, submitted.submissionId, 30_000);
	assert.equal(receipt.status, "done");
	const history = (await client.request("inspect", { view: "history", source: "toolResult", limit: 10 })) as {
		entries: Array<{ text?: string }>;
	};
	assert.match(JSON.stringify(history.entries), /fixture-effect call did not finish within 300 ms/u);
});
