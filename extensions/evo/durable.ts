/** Pi Durable entrypoint for the autonomous `/evo [direction]` harness evolution command. */

import { createHash } from "node:crypto";
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
	run(
		args: string,
		conversation: Durable.Conversation,
		context: Context,
		host: DurableContributionHost,
	): Promise<string>;
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
		async run(rawArgs, conversation, context, host) {
			const invocation = parseEvoInvocation(rawArgs);
			if (!invocation.ok) throw new Error(invocation.error);
			const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
			const kickoff = buildEvoKickoff({
				harnessRoot: HARNESS_ROOT,
				invocationCwd: host.cwd,
				direction: invocation.direction,
				release,
			});
			// The kickoff digest is the durable dedup key: a repeated command after
			// process loss constructs the same text and finds its submission.
			const requestId = `evo:${createHash("sha256").update(kickoff, "utf8").digest("hex")}`;
			const submission = await conversation.submit(
				{ type: "input", content: kickoff, whenBusy: "followUp", requestId },
				context,
			);
			return `Admitted the evo kickoff as submission ${String(submission.id)}; a repeated command with the same kickoff reuses it.`;
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
