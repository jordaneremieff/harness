/**
 * Proof: runs the prose meter on the final assistant reply of a run and returns
 * the findings to the agent once, so the agent repairs the reply before it
 * settles. The extension never rewrites text.
 */
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkReply, finalReplyText } from "./check.ts";
import { proofDurableContribution } from "./durable.ts";
import { publishSettings, readSettings } from "./settings.ts";

const FINDINGS_TYPE = "proof-findings";
const NOTICE_TYPE = "proof-notice";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const disposeSettings = publishSettings(pi.events, { agentDir });
	let repaired = false;
	let noticed = false;
	pi.on("session_shutdown", () => disposeSettings());
	pi.events.emit("durable:contribution", proofDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings));

	// A new user-initiated or custom-message run starts here; the continuation
	// that carries a repair does not pass through this event.
	pi.on("before_agent_start", () => {
		repaired = false;
	});

	pi.on("agent_before_settle", async (event) => {
		const config = readSettings({ agentDir }).values;
		if (!config.enabled || repaired || event.outcome !== "completed") return undefined;
		const text = finalReplyText(event.context.llmMessages);
		const outcome = await checkReply(text, config);
		if (outcome.kind === "unavailable") {
			if (noticed) return undefined;
			noticed = true;
			return { entries: [{ type: "custom_message", customType: NOTICE_TYPE, content: outcome.text, display: true }] };
		}
		if (outcome.kind === "skip") return undefined;
		noticed = false;
		if (outcome.kind === "clean") return undefined;
		repaired = true;
		return {
			entries: [{ type: "custom_message", customType: FINDINGS_TYPE, content: outcome.text, display: false }],
			continue: true,
		};
	});
}
