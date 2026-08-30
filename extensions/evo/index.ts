/** Pi adapter for the autonomous `/evo [hint]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseEvoInvocation } from "./command.ts";
import { buildEvoKickoff } from "./kickoff.ts";

const HARNESS_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function reportInvalidInvocation(ctx: ExtensionCommandContext, message: string): void {
	ctx.ui.notify(message, "error");
}

export default function registerEvo(pi: ExtensionAPI): void {
	pi.registerCommand("evo", {
		description:
			"Run one autonomous harness evolution and audit pass in TUI or RPC; optional trailing text is an exploration hint",
		handler: async (rawArgs, ctx) => {
			if (ctx.mode === "print" || ctx.mode === "json") {
				throw new Error("The evo command requires TUI or RPC mode.");
			}
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
