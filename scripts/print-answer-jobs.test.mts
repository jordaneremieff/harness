/**
 * A real `pi -p` run with the Agent and Jobs extensions loaded, against a scripted provider: a background job
 * settles after the run already wrote a text report, its completion message starts another turn, and the
 * printed answer is the text that answers that completion, not an empty output after `agent_work`.
 *
 * The scripted model reads `jobs` status until the job has settled. Jobs sends the completion in the same
 * tick in which the job settles, so the completion is queued before the report ends the turn.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ORDINARY_TEXT_ANSWER } from "../extensions/agent/ordinary-work.ts";
import { call, lastWorkResult, printRun, text, work } from "../extensions/agent/print-run-fixture.mts";

const jobsExtension = fileURLToPath(new URL("../extensions/jobs/index.ts", import.meta.url));

type Job = { id: string; status: string };

function latestJob(context: TranscriptContext): Job | undefined {
	const result = context.messages.findLast((message) => message.role === "toolResult" && (message.toolName === "bash" || message.toolName === "jobs"));
	return result?.role === "toolResult" ? (result.details as { job?: Job } | undefined)?.job : undefined;
}

function completionArrived(context: TranscriptContext, id: string): boolean {
	return context.messages.some((message) => message.role === "user" && (typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).some((value) => value.startsWith(`Background job ${id} `)));
}

it("prints the answer to a background job's completion that arrives after an earlier text report", { timeout: 90000 }, async () => {
	const report = "The check runs in the background; its result follows when it settles.";
	let phase: "start" | "wait" | "reported" | "reminded" | "done" = "start";
	const run = await printRun({
		mode: "text", prompt: "Run the check in the background.", extensions: [jobsExtension],
		script: (context, index) => {
			if (index > 40 || phase === "done") return undefined;
			if (phase === "start") { phase = "wait"; return call("bash", { command: "printf 'check passed\\n'", background: true }); }
			const job = latestJob(context);
			assert.ok(job, "the bash and jobs results carry the job");
			if (phase === "wait") {
				if (job.status === "running") return call("jobs", { action: "status", id: job.id });
				assert.equal(job.status, "succeeded");
				assert.equal(completionArrived(context, job.id), false, "the completion waits for the run to stop");
				phase = "reported";
				return text(report);
			}
			if (phase === "reported") {
				assert.ok(completionArrived(context, job.id), "the completion starts the next turn");
				phase = "reminded";
				return work();
			}
			assert.equal(lastWorkResult(context), ORDINARY_TEXT_ANSWER);
			phase = "done";
			return text("The background check passed.");
		},
	});
	assert.deepEqual({ stdout: run.stdout, stderr: run.stderr, code: run.code }, { stdout: "The background check passed.\n", stderr: "", code: 0 });
	assert.ok(run.requests.length >= 4 && run.requests.length <= 41, `${run.requests.length} requests`);
});
