/** Pi Durable entrypoint for the autonomous `/evo [direction]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { parseEvoInvocation } from "./command.ts";
import { buildEvoKickoff } from "./kickoff.ts";
import { readPiReleaseIntake } from "./release.ts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Command text shared by the ordinary command and the Durable contribution. */
export const EVO_COMMAND_DESCRIPTION =
	"Coordinate autonomous harness improvement through full Pi sessions; optional trailing text directs the run";

/** Structural copy of the package-level Durable contribution contract. */
export interface DurableContribution {
	readonly name: string;
	readonly source: string;
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
	readonly commands?: readonly DurableCommand[];
}

/** Structural copy of the package-level contribution host. */
export interface DurableContributionHost {
	readonly durable: typeof Durable;
	readonly services: AgentSessionServices;
	readonly cwd: string;
	readonly agentDir: string;
	readonly storageId: string;
	readonly signal: AbortSignal;
	readonly inventory: DurableInventory;
}

/** Structural copy of the host inventory exposed to contributions. */
export interface DurableInventory {
	readonly contributions: readonly {
		readonly name: string;
		readonly source: string;
		readonly commands: readonly { readonly name: string; readonly description: string }[];
	}[];
	readonly ordinaryOnly: readonly string[];
}

/** One command that agent controls invoke by name. */
export interface DurableCommand {
	readonly name: string;
	readonly description: string;
	run(call: DurableCommandCall): Promise<string>;
}

/** One invocation of a contribution command. */
export interface DurableCommandCall {
	readonly args: string;
	readonly conversation: Durable.Conversation;
	readonly context: Context;
	readonly host: DurableContributionHost;
	/** Unique per invocation; stable when the caller retries the same invocation. */
	readonly invocationId: string;
}

export interface EvoContributionOptions {
	/** Absolute path of the entrypoint that emits this contribution. */
	readonly source: string;
}

/**
 * Build the Durable form of `/evo`. The ordinary factory emits it; nothing runs
 * until an agent session host installs the extension and an agent control
 * invokes the command.
 */
export function createEvoContribution(options: EvoContributionOptions): DurableContribution {
	const command: DurableCommand = {
		name: "evo",
		description: EVO_COMMAND_DESCRIPTION,
		async run(call) {
			const invocation = parseEvoInvocation(call.args);
			if (!invocation.ok) throw new Error(invocation.error);
			const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
			const kickoff = buildEvoKickoff({
				harnessRoot: HARNESS_ROOT,
				invocationCwd: call.host.cwd,
				direction: invocation.direction,
				release,
			});
			// The invocation ID is the durable dedup key: a retry of the same invocation
			// finds its submission, and two identical invocations stay two requests.
			const submission = await call.conversation.submit(
				{ type: "input", content: kickoff, whenBusy: "followUp", requestId: `evo:${call.invocationId}` },
				call.context,
			);
			return `Admitted the evo kickoff as submission ${String(submission.id)}.`;
		},
	};
	return {
		name: "evo",
		source: options.source,
		create(host) {
			return host.durable.defineExtension({ name: "evo" });
		},
		commands: [command],
	};
}
