/**
 * agent/control-guidance: model-facing delegation guidance for the agent controls.
 *
 * The ordinary agent registration and the native Durable contribution render the
 * same guidance. This module owns the text; each consumer maps it onto its own
 * tool registration or prompt section. Native answers follow each request's
 * reply route, independent of the creating owner.
 */

/** Control names in prompt order. */
export const AGENT_CONTROL_TOOL_NAMES = [
	"agent_spawn",
	"agent_await",
	"agent_send",
	"agent_steer",
	"agent_abort",
	"agent_fork",
	"agent_rewind",
	"agent_reset",
	"agent_configure",
	"agent_profile",
	"agent_compact",
	"agent_command",
	"agent_status",
	"agent_list",
	"agent_inspect",
	"agent_attach",
	"agent_place",
	"agent_collaborate",
] as const;

export type AgentControlToolName = (typeof AGENT_CONTROL_TOOL_NAMES)[number];

export interface AgentToolGuidance {
	/** Short model-facing phrase for delegation menus. */
	readonly snippet?: string;
	/** Longer model-facing instructions for the tool. */
	readonly guidelines?: readonly string[];
}

/** Selection is a current task decision, not a fixed provider roster. */
export const MODEL_SELECTION_GUIDANCE = "Use an exact provider/model identity. Apply current task directions and the operator's route, budget, and role preferences before selection. Verify the exact model and its supported thinking level. Configured access is not operator use; past use is not preference.";

/** Admission is not model consumption; reports keep the follow-up delivery mode. */
export const REPORT_DELIVERY_BOUNDARY = "If the recipient is a busy Durable agent, this report waits for its current run to end. Model-origin reports to ordinary primaries use steer. Use steer to change a busy agent's work at its next tool boundary; steer does not interrupt a running tool.";

/** Per-tool snippets and guidelines for the current controls. */
export const AGENT_CONTROL_GUIDANCE: Readonly<Record<AgentControlToolName, AgentToolGuidance>> = {
	agent_await: { snippet: "Await exact admitted peer results on the original request", guidelines: ["An ordinary primary routes answer-bearing fan-out through one Durable lead. The lead dispatches workers, awaits exact results natively, and returns one composed answer. Ordinary primaries do not support native await; they stay responsive.", "Dispatch work in the background, retain each result reference, then call agent_await once with the results you need. The native wait keeps this request open without provider calls merely to wait. Explicit input or release returns partial results and unresolved references. Apply the input and await unresolved references again on this same request. A terminal answer settles it once; never answer only to wait.", "Creation records, reports, timers, names, and latest answers are not result references. Preserve known request IDs. Waiting retains a live tool invocation, native records, observers, and the host process. Storage usage is not per-request usage."] },
	agent_spawn: {
		snippet: "Spawn a background full agent session",
		guidelines: [
			MODEL_SELECTION_GUIDANCE,
			"Before creating an agent for a recurring concern, look for an existing @handle whose role covers it. Reuse it with a short task; use a fresh agent for unrelated or independent work. Spawn with handle resolves or creates one independent root and never reapplies creation defaults on reuse. Display names may repeat; targets accept @handle or canonical identity, not bare names.",
			"Inside a Durable agent, spawning without a handle in the same cwd creates a conversation in your storage; a different cwd creates a storage with its own host. The receipt states placement. Created conversations inherit your stored configuration, with explicit model and thinking overrides; their selected controls permit further delegation. Created agents remain addressable to the operator and eligible for the bounded /agent roster.",
			'Write each agent task as a contract: objective, output format, source guidance, and boundaries. Include purpose, acceptance, and an end condition. Apply the universal AGENTS.md "Intent authority" section to assignments, corrections, and relayed decisions; preserve operator restrictions and distinguish them from agent choices.',
			"Model tool tasks get automatic check-ins while unanswered, separate from voluntary worker reports. checkInMinutes overrides PI_AGENT_CHECK_IN_MINUTES (default 30); 0 disables. A check-in is not a finished result. Assess progress, let work continue, steer a wrap-up, or abort a hung tool. Steering waits for the tool boundary.",
			"Agent work runs in the background. Each task's answer reports to its request's reply recipient automatically. Settlement is execution evidence, not task acceptance. Integrate the delegated results required by this request before claiming completion; a spawn or send receipt is not that result. Resolve live work for this request: continue useful work, redirect changed work, or abort superseded work. Do not stop unrelated, standing, or background agents merely to finish this request.",
		],
	},
	agent_send: {
		snippet: "Send a task to an agent session",
		guidelines: [
			"Send informational reports and blocking questions with agent_send mode: report to the current request's reply recipient. The creating owner is provenance, not every task's requester. Specify a recipient explicitly; several requests can share a run. Reports start no answer-bearing task or check-in. Do not replace the terminal result with an interim report. A terminal answer settles the current request: include the substantive result or exact blocker, not a waiting note, closing pleasantry, or promise of a later answer. Use followUp for unrelated new work on a reused expert.",
			REPORT_DELIVERY_BOUNDARY,
			"Unanswered model tool tasks get automatic owner check-ins. checkInMinutes overrides the default and 0 disables. Check-ins wake a model owner, not an operator owner; delivered reports and check-ins do not start another check-in task. Assess the unfinished task rather than treat the notice as an answer.",
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
	agent_configure: { snippet: "Configure an idle session without starting work", guidelines: [MODEL_SELECTION_GUIDANCE] },
	agent_profile: { snippet: "Read or update a durable agent profile", guidelines: ["Read saved expertise after context loss and before relying on past findings. Update role or a bounded sourced synthesis with expectedRevision from a current read. Profile edits work at a busy tool boundary; model/name changes remain agent_configure. Current evidence and task restrictions outrank stale expertise."] },
	agent_compact: { snippet: "Compact an agent while preserving its continuity" },
	agent_command: { snippet: "Run a command through an agent's owner" },
	agent_status: {
		snippet: "Show agent session status",
		guidelines: [
			"Use agent_status for orientation and agent_inspect for concrete transcript or result evidence, not as waiting tools. Never poll with sleeps or repeated status/inspection calls. Settlement notices arrive automatically; do independent work while useful agent work continues.",
			"A selected Durable session lists bounded pending scheduled inputs. Ordinary primaries return presence and bounded raw latest-retained ancestry; live idle state, selected branch and native task/timer state remain unknown. Reads do not contact or wake the primary.",
			"Before a full suite, read untargeted agent_status. Declare full-gate and promotion starts in your own integration intent with scope.fullGate true; clear the claim on release. Notify only efforts that requested release. Declarations are not locks.",
			"Inside a Durable agent with creation records, no-target status includes a bounded Created agents section and structured createdAgents for agents this conversation created, including agents in other storages. Labels reflect creation records, not current activity, result dependency, or task ownership.",
			"Use view: fleet for sampled machine-local model costs, current selections, and attributed failures. Missing evidence is unknown, not zero; conversation warnings do not prove provider faults.",
		],
	},
	agent_list: { snippet: "Find retained agent sessions" },
	agent_inspect: { snippet: "Read an agent's retained entries, activity, or results" },
	agent_attach: { snippet: "Attach to a stored agent session" },
	agent_place: { snippet: "Work in the session bound to an area" },
	agent_collaborate: { snippet: "Find peers and exchange work in a shared purpose thread", guidelines: ["List threads before asking the primary to relay identities. Read the governing frame, join relevant work, and develop or challenge peer contributions. Choose and revise arrangements together; no fixed roles or agreement vote is required.", "Use the shared frame for governing purpose and each member's contribution for its current hold, release or continuing condition. Rejoin to replace your contribution and cite the source exchange. Contributions are declarations, not consensus or permission.", "A thread preserves purpose, carried authority and source, restrictions, acceptance, and integrator. Agent labels do not prove operator authority. Keep the original decision and its scope distinct from interpretations and proposals.", "Joining opts into bounded passive notices for new thread events at existing conversation boundaries. These notices start no model turn. Posts retain shared evidence without waking a model. Name notify recipients only when their attention matters. Notices do not request automatic replies or check-ins. Inspect the thread or peer evidence rather than poll while useful work continues."] },
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
