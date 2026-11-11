/** Pi adapter for the autonomous `/evo [direction]` harness evolution command. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { offerSessionName } from "../../session-name/lifecycle.ts";
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

/** Correlate the original direction with its own generated input, not a later prompt. */
function offerDirection(pi: ExtensionAPI, ctx: ExtensionCommandContext, direction: string | undefined, kickoff: string): () => void {
	if (direction === undefined || ctx.mode === "rpc") return () => {};
	let removeInput = () => {};
	let removeShutdown = () => {};
	const stop = () => { removeInput(); removeShutdown(); };
	removeInput = pi.on("input", (event, inputContext) => {
		stop();
		if (event.source !== "extension" || event.text !== kickoff) return;
		try {
			offerSessionName(pi, inputContext, { source: "evo", text: direction });
		} catch {
			// An optional name must not suppress the authorised kickoff.
		}
	});
	removeShutdown = pi.on("session_shutdown", stop);
	return stop;
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
			const stopOffer = offerDirection(pi, ctx, invocation.direction, kickoff);
			try {
				pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
			} catch (error) {
				stopOffer();
				throw error;
			}
		},
	});
}
