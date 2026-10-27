/**
 * Draft: puts the hard prose rules in the system prompt, runs the prose meter
 * on the final reply to operator input, and returns the findings to the agent
 * once, so the agent repairs the reply as text before it settles. The
 * extension never rewrites text.
 */
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { checkReply, finalReplyText, REPAIR_BLOCK, RULES_SECTION, replyRulesText } from "./check.ts";
import { draftDurableContribution } from "./durable.ts";
import { publishSettings, readSettings } from "./settings.ts";
import { checkDraft, description, parameters, promptGuidelines, promptSnippet } from "./tool.ts";

const FINDINGS_TYPE = "draft-findings";
const NOTICE_TYPE = "draft-notice";

export default function (pi: ExtensionAPI, checker = checkReply) {
	const agentDir = getAgentDir();
	pi.registerTool({
		name: "draft",
		label: "Draft",
		description,
		parameters,
		promptSnippet,
		promptGuidelines,
		async execute(_id, input, signal, _update, ctx) {
			const { notifyBand } = readSettings({ agentDir }).values;
			const result = await checkDraft(input, ctx.cwd, { notifyBand, signal });
			return { content: [{ type: "text", text: result.text }], details: result.report };
		},
	});
	pi.on("resources_discover", () => ({ skillPaths: [fileURLToPath(new URL(".", import.meta.url))] }));
	const disposeSettings = publishSettings(pi.events, { agentDir });
	/** The current run started from operator input rather than a custom message. */
	let operatorRun = false;
	/** The current run already received its one repair pass. */
	let repaired = false;
	/** The agent owes a repaired reply; tool calls are blocked until it settles. */
	let repairing = false;
	let noticed = false;
	pi.on("session_shutdown", () => disposeSettings());
	pi.events.emit(
		"durable:contribution",
		draftDurableContribution(fileURLToPath(import.meta.url), pi.events, disposeSettings),
	);

	// Every operator prompt and custom-message run starts here; the continuation
	// that carries a repair does not pass through this event.
	pi.on("before_agent_start", (event) => {
		repaired = false;
		repairing = false;
		operatorRun = event.messageType === "user";
		const { sections } = event.systemPromptOptions;
		if (!readSettings({ agentDir }).values.enabled) {
			delete sections[RULES_SECTION];
			return;
		}
		try {
			sections[RULES_SECTION] = replyRulesText();
		} catch {
			delete sections[RULES_SECTION];
		}
	});

	pi.on("tool_call", () => (repairing ? { block: true, reason: REPAIR_BLOCK } : undefined));

	pi.on("agent_before_settle", async (event) => {
		repairing = false;
		const config = readSettings({ agentDir }).values;
		if (!config.enabled || !operatorRun || repaired || event.outcome !== "completed") return undefined;
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
		repairing = true;
		return {
			entries: [
				{
					type: "custom_message",
					customType: FINDINGS_TYPE,
					content: outcome.text,
					display: false,
					details: outcome.record,
				},
			],
			continue: true,
		};
	});
}
