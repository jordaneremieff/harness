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
	"agent_send",
	"agent_steer",
	"agent_abort",
	"agent_fork",
	"agent_rewind",
	"agent_reset",
	"agent_configure",
	"agent_profile",
	"agent_intent",
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

/**
 * How the model reaches a control. `direct` tools are declared while active;
 * `deferred` tools start undeclared and are loaded through public tool discovery;
 * `model-only` tools are declared while active and never callable from a script.
 */
export type AgentControlExposure = "direct" | "deferred" | "model-only";

/** The Agent slice owns the exposure of every control it registers. */
export const AGENT_CONTROL_EXPOSURE: Readonly<Record<AgentControlToolName, AgentControlExposure>> = {
	agent_abort: "direct",
	agent_attach: "deferred",
	agent_collaborate: "direct",
	agent_command: "deferred",
	agent_compact: "model-only",
	agent_configure: "deferred",
	agent_fork: "deferred",
	agent_inspect: "deferred",
	agent_intent: "direct",
	agent_list: "deferred",
	agent_place: "deferred",
	agent_profile: "deferred",
	agent_reset: "deferred",
	agent_rewind: "deferred",
	agent_send: "direct",
	agent_spawn: "direct",
	agent_status: "direct",
	agent_steer: "direct",
};

export interface AgentToolGuidance {
	/** Short model-facing phrase for delegation menus. */
	readonly snippet?: string;
	/** Longer model-facing instructions for the tool. */
	readonly guidelines?: readonly string[];
}

/** Selection is a current task decision, not a fixed provider roster. */
const EXECUTION_PRESET_GUIDANCE = "Delegate with preset. Omit model and preset to use the machine defaultPreset on creation. Name model only when a direction or the task requires an override; receipts record explicit overrides. Explicit fields win over preset fields. Creation never inherits parent execution settings; absent thinking defaults to off. Configure retains the target's own values and never uses defaultPreset. Exclusions are advisory unless the operator sets enforceRoster true for creation. Preset role applies only to handle creation.";
export const MODEL_SELECTION_GUIDANCE = "For an explicit model override, use an exact provider/model identity. Apply current task directions and the operator's route, budget, and role preferences before choosing the override. Verify its exact model and supported thinking level. The resolver owns preset and default identity selection. Configured access is not operator use; past use is not preference.";

/** A follow-up places at a tool boundary of a running recipient, not at the run end. */
export const FOLLOW_UP_DELIVERY_BOUNDARY = "A followUp to a running agent is placed at the recipient's next tool boundary, the end of its current round of tool calls, not at the end of its run. It does not interrupt a running tool. It joins the current work, so both inputs may share one answer.";

/** A report places at a tool boundary of a running recipient and starts no task. */
export const REPORT_DELIVERY_BOUNDARY = "A report to a running agent is placed at the recipient's next tool boundary, not at the end of its run. It does not interrupt a running tool, and it starts no answer-bearing task. A report is an event for the recipient: it reads the report and continues. Use steer when the recipient must change its current work.";

/** Each placed input carries its class; the class tells the recipient what to do with it. */
export const INPUT_CLASS_GUIDANCE = "Read each placed input by its class. A steer corrects the current work: apply it now. A followUp and operator input are new work: finish the current step, then do them in this run. A report, result, check-in, and thread notice are events: read them and continue. Name in the answer each request that it covers.";

/** Open delegated work is declared, the run ends with a state note, and each arriving result starts the next run. */
export const OPEN_WORK_GUIDANCE = "After you send work, do the useful work that remains for you. When none remains, declare the open work with agent_work continue (the request and its exact result references), then end the run with a short state note. Do ready independent work before the run ends. A routed task that stays blocked or deferred gets its own record: agent_work continue with its request and an empty results list. Each result, report, or message starts your next run. Never hold a run open for agent output: no sleep, no repeated status or inspection call, no long foreground command. An input reaches you at your next tool boundary, the end of your current round of tool calls, so run a command that can take more than about two minutes as a background job; its completion arrives as an event. Creation records, reports, timers, names, and latest answers are not result references. Preserve known request IDs.";

/** An ordinary session ends its turn instead of declaring native open work. */
const ORDINARY_OPEN_WORK_GUIDANCE = "After you send work, do the useful independent work that remains for you. When only delegated work remains, end your turn with a short state note that names the open work and its exact result references. Results arrive as events; read them and continue the work. Never hold a turn open for agent output: no sleep, no repeated status or inspection call, no long foreground command. Run a long command as a background job; its completion arrives as an event. Creation records, reports, timers, names, and latest answers are not result references. Preserve known request IDs.";
const NATIVE_SEND_GUIDANCE = "Send informational reports and blocking questions with agent_send mode: report to the current request's reply recipient. The creating owner is provenance, not every task's requester. Specify a recipient explicitly; several requests can share a run. Reports start no answer-bearing task or check-in. A terminal answer settles the current request: give the substantive result or exact blocker. While declared work is open, end the run with a state note whose first words say that it is not the result; only agent_work complete sends the final report, to the original reply recipient. Use followUp for unrelated new work on a reused expert.";
const ORDINARY_SEND_GUIDANCE = "Send informational reports and blocking questions with agent_send mode: report to the current request's reply recipient. The creating owner is provenance, not every task's requester. Specify a recipient explicitly. Reports start no answer-bearing task or check-in. Give the substantive result or exact blocker when the work is complete. While only delegated work remains, end your turn with a short state note that says it is not the final result. Results arrive as events. Never poll for them. Use followUp for unrelated new work on a reused expert.";

/**
 * What only the model can carry across a compaction or reset. The host keeps request routes and
 * delivers results itself, so the seed does not ask for them.
 */
export const CONTINUITY_SEED = "Preserve the current purpose; consequential operator corrections and what they changed; qualified evidence; unresolved questions. Results of requests routed to this session keep arriving here.";
/** The native host lists the conversation's own outgoing requests after each context head, so a native summary need not repeat them. */
export const NATIVE_COMPACTION_SEED = `${CONTINUITY_SEED} After the summary, the Agent continuity note lists the requests that this session sent and that have no delivered result here.`;
const RESET_HANDOFF_GUIDANCE = "A handoff states the current purpose; consequential operator corrections and what they changed; qualified evidence; unresolved questions; and the newest handover or checkpoint identifier.";

/** Per-tool snippets and guidelines for the current controls. */
export const AGENT_CONTROL_GUIDANCE: Readonly<Record<AgentControlToolName, AgentToolGuidance>> = {
	agent_spawn: {
		snippet: "Spawn a background full agent session",
		guidelines: [
			MODEL_SELECTION_GUIDANCE,
			EXECUTION_PRESET_GUIDANCE,
			"Before creating an agent for a recurring concern, look for an existing @handle whose role covers it. Reuse it with a short task; use a fresh agent for unrelated or independent work. Spawn with handle resolves or creates one independent root and never reapplies creation defaults on reuse. Display names may repeat; targets accept @handle or canonical identity, not bare names.",
			"An explicit creation role is saved on the new agent's profile with or without a handle. Inside a Durable agent, spawning without a handle in the same cwd creates a conversation in your storage; a different cwd creates a storage with its own host. The receipt states placement. Created conversations use the resolved machine preset or explicit execution values, not your model or thinking level; their selected controls permit further delegation. Created agents remain addressable to the operator and eligible for the bounded /agent roster.",
			'Write each agent task as a contract: objective, output format, source guidance, and boundaries. Include purpose, acceptance, and an end condition. Apply the universal AGENTS.md "Intent authority" section to assignments, corrections, and relayed decisions; preserve operator restrictions and distinguish them from agent choices.',
			"Results arrive without supervision turns. Set checkInMinutes only when a task needs a watchdog; the configured agent.checkInMinutes default is 0, so no automatic owner check-ins run otherwise. A check-in is not a finished result. Assess progress, let work continue, steer a wrap-up, or abort a hung tool. Steering waits for the tool boundary.",
			"Agent work runs in the background. Each task's answer reports to its request's reply recipient automatically. Settlement is execution evidence, not task acceptance. Integrate the delegated results required by this request before claiming completion; a spawn or send receipt is not that result. Resolve live work for this request: continue useful work, redirect changed work, or abort superseded work. Do not stop unrelated, standing, or background agents merely to finish this request.",
			OPEN_WORK_GUIDANCE,
		],
	},
	agent_send: {
		snippet: "Send a task to an agent session",
		guidelines: [
			NATIVE_SEND_GUIDANCE,
			FOLLOW_UP_DELIVERY_BOUNDARY,
			REPORT_DELIVERY_BOUNDARY,
			INPUT_CLASS_GUIDANCE,
			OPEN_WORK_GUIDANCE,
			"Owner check-ins run only when checkInMinutes, or the configured agent.checkInMinutes setting, names an interval; the default is 0. Check-ins wake a model owner, not an operator owner; delivered reports and check-ins do not start another check-in task. Assess the unfinished task rather than treat the notice as an answer.",
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
			"With release: true, abort the target and request host retirement. Other work and timers stay; blockers are reported. Do not combine release with timerId or background: true; abort with background first, then release.",
		],
	},
	agent_fork: { snippet: "Fork an agent session for side work" },
	agent_rewind: { snippet: "Rewind an agent session to an entry and re-derive the work" },
	agent_reset: {
		snippet: "Reset an agent's active context with an optional handoff",
		guidelines: [
			"History, identity, files, settings, and scheduled inputs stay; the reset places at the next native boundary while the agent is busy and starts no model turn.",
			RESET_HANDOFF_GUIDANCE,
		],
	},
	agent_configure: { snippet: "Configure an idle session without starting work", guidelines: [MODEL_SELECTION_GUIDANCE, EXECUTION_PRESET_GUIDANCE] },
	agent_profile: { snippet: "Read or update a durable agent profile", guidelines: ["Read saved expertise after context loss and before relying on past findings. Update role or a bounded sourced synthesis with expectedRevision from a current read. Profile edits work at a busy tool boundary; model/name changes remain agent_configure. Current evidence and task restrictions outrank stale expertise."] },
	agent_intent: { snippet: "Publish or clear your integration intent", guidelines: ["Intent is your claim, not verified authority or a machine lock. Independent work needs no claim. Before a shared act (an activation switch, a host-operation or stored-format change, removal of another session's worktrees or snapshots) or possible overlap with another effort, use bounded discovery; current context can already supply it. Publish your purpose, shared acts, scope and carried operator direction only where an actual dependency needs coordination. Declare a need for a quiet machine with scope.fullGate true, then clear or update the claim on release. Native conversations publish only their own claim. Current updated readers discover native claims through bounded catalogue projections; unchanged readers do not gain that support."] },
	agent_compact: { snippet: "Compact an agent while preserving its continuity", guidelines: [`In a summary or in instructions: ${CONTINUITY_SEED}`] },
	agent_command: { snippet: "Run a command through an agent's owner" },
	agent_status: {
		snippet: "Show agent session status",
		guidelines: [
			"Use agent_status for orientation and agent_inspect for concrete transcript or result evidence, not as waiting tools. Never poll with sleeps or repeated status/inspection calls. Settlement notices arrive automatically; do independent work while useful agent work continues.",
			"A selected Durable session lists bounded pending scheduled inputs. Ordinary primaries return presence and bounded raw latest-retained ancestry; live idle state, selected branch and native task/timer state remain unknown. Reads do not contact or wake the primary.",
			"A full suite needs no claim and no prior status read. When a related effort declares scope.fullGate true, hold your own full suite until that claim clears. Declare your own need for a quiet machine in your integration intent with scope.fullGate true; clear the claim on release. Notify only efforts that requested release. Declarations are not locks.",
			"Inside a Durable agent, no-target status is a compact overview of this storage's conversations with explicit coverage. It names what it omits: host inventory, effort awareness and created-agent detail. Select one conversation with sessionId for its status.",
			"Use view: fleet for sampled machine-local model costs, current selections, and attributed failures. Missing evidence is unknown, not zero; conversation warnings do not prove provider faults.",
		],
	},
	agent_list: { snippet: "Find retained agent sessions" },
	agent_inspect: { snippet: "Read an agent's retained entries, activity, or results" },
	agent_attach: { snippet: "Attach to a stored agent session" },
	agent_place: { snippet: "Work in the session bound to an area", guidelines: [MODEL_SELECTION_GUIDANCE, EXECUTION_PRESET_GUIDANCE, "A preset supplies creation defaults, not changes to a reused place owner. Configure an idle owner explicitly to change its model."] },
	agent_collaborate: { snippet: "Find peers and exchange work in a shared purpose thread", guidelines: ["List threads before asking the primary to relay identities. Read the governing frame, join relevant work, and develop or challenge peer contributions. Choose and revise arrangements together; no fixed roles or agreement vote is required.", "Use the shared frame for governing purpose and each member's contribution for its current hold, release or continuing condition. Rejoin to replace your contribution and cite the source exchange. Contributions are declarations, not consensus or permission.", "Keep participation within 256 characters and message within 8,000 characters. Write longer content to a file and post its path.", "A thread preserves purpose, carried authority and source, restrictions, acceptance, and integrator. Agent labels do not prove operator authority. Keep the original decision and its scope distinct from interpretations and proposals.", "Joining opts into bounded passive notices for new thread events at existing conversation boundaries. These notices start no model turn. Posts retain shared evidence without waking a model. Name notify recipients only when their attention matters. Notices do not request automatic replies or check-ins. Inspect the thread or peer evidence rather than poll while useful work continues."] },
};

/** Select instructions for the controls available on the recipient's execution surface. */
export function agentControlGuidance(name: AgentControlToolName, surface: "ordinary" | "native"): AgentToolGuidance {
	const guidance = AGENT_CONTROL_GUIDANCE[name];
	if (surface === "native" || (name !== "agent_spawn" && name !== "agent_send")) return guidance;
	return { ...guidance, guidelines: guidance.guidelines?.map((line) => line === OPEN_WORK_GUIDANCE ? ORDINARY_OPEN_WORK_GUIDANCE : line === NATIVE_SEND_GUIDANCE ? ORDINARY_SEND_GUIDANCE : line) };
}

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
