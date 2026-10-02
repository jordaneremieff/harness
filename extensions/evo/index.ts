/** Pi adapter for the autonomous `/evo [direction]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseEvoInvocation } from "./command.ts";
import { createEvoContribution, EVO_COMMAND_DESCRIPTION } from "./durable.ts";
import { buildEvoKickoff } from "./kickoff.ts";
import { readPiReleaseIntake } from "./release.ts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ENTRYPOINT = fileURLToPath(import.meta.url);

function reportInvalidInvocation(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
	else throw new Error(message);
}

export default function registerEvo(pi: ExtensionAPI): void {
	pi.events.emit("durable:contribution", createEvoContribution({ source: ENTRYPOINT }));
	pi.registerCommand("evo", {
		description: EVO_COMMAND_DESCRIPTION,
		handler: async (rawArgs, ctx) => {
			const invocation = parseEvoInvocation(rawArgs);
			if (!invocation.ok) {
				reportInvalidInvocation(ctx, invocation.error);
				return;
			}
			const release = await readPiReleaseIntake({ harnessRoot: HARNESS_ROOT });
			const kickoff = buildEvoKickoff({
				harnessRoot: HARNESS_ROOT,
				invocationCwd: ctx.cwd,
				direction: invocation.direction,
				release,
			});
			pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
		},
	});
}
