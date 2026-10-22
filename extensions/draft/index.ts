/**
 * Draft: runs the prose meter on the final assistant reply of a run and returns
 * the findings to the agent once, so the agent repairs the reply before it
 * settles. The extension never rewrites text.
 */
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkReply, finalReplyText } from "./check.ts";
import { draftDurableContribution } from "./durable.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { checkDraft, description, parameters, promptGuidelines, promptSnippet } from "./tool.ts";

const FINDINGS_TYPE = "draft-findings";
const NOTICE_TYPE = "draft-notice";

export default function (pi: ExtensionAPI, checker = checkReply) {
	pi.registerTool({
		name: "draft",
		label: "Draft",
		description,
		parameters,
		promptSnippet,
		promptGuidelines,
		async execute(_id, input, signal, _update, ctx) {
			const result = await checkDraft(input, ctx.cwd, signal);
			return { content: [{ type: "text", text: result.text }], details: result.report };
		},
	});
	pi.on("resources_discover", () => ({ skillPaths: [fileURLToPath(new URL(".", import.meta.url))] }));
	const agentDir = getAgentDir();
	const disposeSettings = publishSettings(pi.events, { agentDir });
	let repaired = false;
	let noticed = false;
	pi.on("session_shutdown", () => disposeSettings());
	pi.events.emit(
		"durable:contribution",
		draftDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);

	// A new user-initiated or custom-message run starts here; the continuation
	// that carries a repair does not pass through this event.
	pi.on("before_agent_start", () => {
		repaired = false;
	});

	pi.on("agent_before_settle", async (event) => {
		const config = readSettings({ agentDir }).values;
		if (!config.enabled || repaired || event.outcome !== "completed") return undefined;
		const text = finalReplyText(event.context.llmMessages);
		const outcome = await checker(text, config);
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
