/** Pi adapter for the autonomous `/evo [hint]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseEvoInvocation } from "./command.ts";
import { buildEvoKickoff } from "./kickoff.ts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function reportInvalidInvocation(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
	else throw new Error(message);
}

export default function registerEvo(pi: ExtensionAPI): void {
	pi.registerCommand("evo", {
		description:
			"Coordinate autonomous harness improvement through full Pi sessions; optional trailing text is an exploration hint",
		handler: async (rawArgs, ctx) => {
			const invocation = parseEvoInvocation(rawArgs);
			if (!invocation.ok) {
				reportInvalidInvocation(ctx, invocation.error);
				return;
			}
			const kickoff = buildEvoKickoff({
				harnessRoot: HARNESS_ROOT,
				invocationCwd: ctx.cwd,
				hint: invocation.hint,
			});
			pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
		},
	});
}
