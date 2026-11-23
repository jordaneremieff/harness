import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { DurableContribution } from "../../durable-services.ts";

export function stopTask(durable: typeof Durable, enter: (id: Durable.TaskId) => void | Promise<void>) {
	return durable.defineTask<Record<string, never>, { phase: "work" }, null>({
		name: "fixture.stop-recovery",
		version: 1,
		initial: () => ({ phase: "work" }),
		phases: {
			work: async (task, runtime, context) => {
				await enter(task.id);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export default function register(pi: ExtensionAPI): void {
	let wait: Durable.Harness["waitForTask"];
	let setupError: string | undefined;
	const executed: Durable.TaskId[] = [];
	pi.events.emit("durable:contribution", {
		name: "fixture.stop-recovery",
		source: fileURLToPath(import.meta.url),
		create(host) {
			wait = host.harness.waitForTask.bind(host.harness);
			try {
				host.harness.resume();
			} catch (error) {
				setupError = String(error);
			}
			return host.durable.defineExtension({
				name: "fixture.stop-recovery",
				tasks: [
					stopTask(host.durable, (id) => {
						executed.push(id);
					}),
				],
			});
		},
		commands: [
			{
				name: "stop-outcomes",
				description: "Read the fixture task outcomes",
				async run({ args, context }) {
					const tasks = await Promise.all((JSON.parse(args) as Durable.TaskId[]).map((id) => wait(id, context)));
					return JSON.stringify({ setupError, executed, outcomes: tasks.map(({ state }) => state.outcome.status) });
				},
			},
		],
	} satisfies DurableContribution);
}
