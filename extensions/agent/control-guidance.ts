/**
 * agent/control-guidance: model-facing delegation guidance for the agent controls.
 *
 * The ordinary agent registration and the native Durable contribution render the
 * same guidance. This module owns the text; each consumer maps it onto its own
 * tool registration or prompt section. Native answers report to the recorded
 * owner conversation; its identity lives in the conversation instructions.
 */

/** Control names in prompt order. */
export const AGENT_CONTROL_TOOL_NAMES = [
	"agent_spawn",
	"agent_send",
	"agent_steer",
	"agent_abort",
	"agent_fork",
	"agent_rewind",
	"agent_reset",
	"agent_configure",
	"agent_compact",
	"agent_command",
	"agent_status",
	"agent_list",
	"agent_inspect",
	"agent_attach",
	"agent_place",
] as const;

export type AgentControlToolName = (typeof AGENT_CONTROL_TOOL_NAMES)[number];

export interface AgentToolGuidance {
	/** Short model-facing phrase for delegation menus. */
	readonly snippet?: string;
	/** Longer model-facing instructions for the tool. */
	readonly guidelines?: readonly string[];
}

/** Per-tool snippets and guidelines for the current controls. */
export const AGENT_CONTROL_GUIDANCE: Readonly<Record<AgentControlToolName, AgentToolGuidance>> = {
	agent_spawn: {
		snippet: "Spawn a background full agent session",
		guidelines: [
			'Write each agent task as a contract: objective, output format, source guidance, and boundaries. Include purpose, acceptance, and an end condition. Apply the universal AGENTS.md "Intent authority" section to assignments, corrections, and relayed decisions; preserve operator restrictions and distinguish them from agent choices.',
			"Agent work runs in the background. The child's answer reports to the recorded owner conversation automatically. Settlement is execution evidence, not task acceptance. Integrate needed results and resolve live work before a final conclusion: continue useful work, redirect changed work, or abort superseded work.",
		],
	},
	agent_send: {
		snippet: "Send a task to an agent session",
		guidelines: [
			"A child conversation sends interim reports, blocking questions, and corrections with agent_send to the owner identity in its instructions. Do not replace the terminal result with an interim report. Reuse an existing session when its retained context and ownership serve the task; do not duplicate its work.",
			"With deliverAt, the input is scheduled at that absolute time instead of being admitted now; the storage host must run at the deadline.",
		],
	},
	agent_steer: {
		snippet: "Redirect a running agent session",
		guidelines: ["Apply Intent authority to corrections."],
	},
	agent_abort: {
		snippet: "Abort an agent session operation",
		guidelines: [
			"Self-targets refuse.",
			"With timerId from agent_status, cancel only that scheduled input and leave other work running.",
		],
	},
	agent_fork: { snippet: "Fork an agent session for side work" },
	agent_rewind: { snippet: "Rewind an agent session to an entry and re-derive the work" },
	agent_reset: {
		snippet: "Reset an agent's active context with an optional handoff",
		guidelines: [
			"History, identity, files, settings, and scheduled inputs stay; the reset places at the next native boundary while the agent is busy and starts no model turn.",
		],
	},
	agent_configure: { snippet: "Configure an idle session without starting work" },
	agent_compact: { snippet: "Compact an agent while preserving its continuity" },
	agent_command: { snippet: "Run a command through an agent's owner" },
	agent_status: {
		snippet: "Show agent session status",
		guidelines: [
			"Use agent_status for orientation and agent_inspect for concrete transcript or result evidence, not as waiting tools. Never poll with sleeps or repeated status/inspection calls. Settlement notices arrive automatically; do independent work while useful agent work continues.",
			"A selected session's status lists its bounded pending scheduled inputs with timer ID, target, deadline, mode, and overdue flag.",
		],
	},
	agent_list: { snippet: "Find retained agent sessions" },
	agent_inspect: { snippet: "Read an agent's retained entries, activity, or results" },
	agent_attach: { snippet: "Attach to a stored agent session" },
	agent_place: { snippet: "Work in the session bound to an area" },
};

/** Render the guidance lines for the selected controls, in control order. */
export function agentControlGuidanceLines(selected: readonly string[]): string[] {
	const offered = new Set(selected);
	const lines: string[] = [];
	for (const name of AGENT_CONTROL_TOOL_NAMES) {
		if (!offered.has(name)) continue;
		const guidance = AGENT_CONTROL_GUIDANCE[name];
		if (guidance.snippet !== undefined) lines.push(`- ${name}: ${guidance.snippet}`);
		for (const guideline of guidance.guidelines ?? []) lines.push(`  ${guideline}`);
	}
	return lines;
}
