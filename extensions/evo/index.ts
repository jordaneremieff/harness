/** Pi adapter for the autonomous `/evo [direction]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sessionNameFromInput } from "../../session-name/index.ts";
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

/**
 * Give an unnamed session a name from the operator's direction. An RPC-mode
 * command leaves the name to the RPC client, as ordinary RPC input does; the
 * client names a session with Pi's `set_session_name` RPC command.
 */
function nameSessionFromDirection(pi: ExtensionAPI, ctx: ExtensionCommandContext, direction: string | undefined): void {
	if (direction === undefined || ctx.mode === "rpc" || pi.getSessionName() !== undefined) return;
	const name = sessionNameFromInput(direction);
	if (name !== undefined) pi.setSessionName(name);
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
			nameSessionFromDirection(pi, ctx, invocation.direction);
			pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
		},
	});
}
