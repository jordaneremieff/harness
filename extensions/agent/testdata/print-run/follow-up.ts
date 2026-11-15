import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";

export const FOLLOW_UP_TEXT = "The background check finished: 42 files passed.";
export const PEER_TEXT = "The reviewer finished: three findings.";

/** Tools whose work completes later in the same run, as a custom follow-up message. */
export default function register(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "fixture_background",
		label: "Fixture background",
		description: "Start a background check whose completion arrives as a later message.",
		parameters: obj({}),
		async execute() {
			pi.sendMessage({ customType: "fixture.completion", content: FOLLOW_UP_TEXT, display: true }, { deliverAs: "followUp", triggerTurn: true });
			return { content: [{ type: "text", text: "Started the background check." }], details: {} };
		},
	});
	// The message type of the messages that the agent extension delivers from other sessions.
	pi.registerTool({
		name: "fixture_peer",
		label: "Fixture peer",
		description: "Ask a reviewer whose reply arrives as a later message from another session.",
		parameters: obj({}),
		async execute() {
			pi.sendMessage({ customType: "agent.peer", content: PEER_TEXT, display: true }, { deliverAs: "followUp", triggerTurn: true });
			return { content: [{ type: "text", text: "Asked the reviewer." }], details: {} };
		},
	});
}
