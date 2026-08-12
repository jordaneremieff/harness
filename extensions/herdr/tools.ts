/**
 * Agent-facing herdr tools.
 *
 * The tools let the model see and drive the surrounding herd: which panes and
 * agents exist, what they printed, and how to start or prompt a sibling.
 *
 * Safety here is structural, not procedural. Methods that destroy state are
 * absent from the tool layer and rejected by `callHerdr`, every pane target is
 * re-resolved against a fresh `pane.list` before a write, and writes to one
 * pane are serialized so two tool calls cannot interleave keystrokes.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { HerdrError, type HerdrClient } from "./socket.ts";

/** Agent kinds herdr can start, as reported by `herdr agent start --help`. */
const AGENT_KINDS = [
	"pi",
	"claude",
	"codex",
	"gemini",
	"cursor",
	"devin",
	"agy",
	"cline",
	"omp",
	"mastracode",
	"opencode",
	"copilot",
	"kimi",
	"kiro",
	"droid",
	"amp",
	"grok",
	"hermes",
	"kilo",
	"qodercli",
	"maki",
] as const;

const AGENT_STATES = ["idle", "working", "blocked", "done", "unknown"] as const;
const READ_SOURCES = ["visible", "recent", "recent_unwrapped"] as const;

/**
 * Methods the tool layer refuses to send.
 *
 * The list covers the destructive surface — methods that close, stop, reset,
 * remove, attach, or hand off state the model did not create — plus herdr's
 * own integration and plugin channels. Rearrangement and rename methods are
 * absent from this list because the tools never send them; adding such a tool
 * requires adding the method here deliberately.
 */
export const FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
	"agent.attach",
	"agent.view.clear",
	"agent.view.set",
	"client.window_title.clear",
	"client.window_title.set",
	"integration.install",
	"integration.uninstall",
	"layout.apply",
	"pane.clear_agent_authority",
	"pane.close",
	"pane.graphics.clear",
	"pane.graphics.info",
	"pane.graphics.set",
	"pane.release_agent",
	"pane.report_agent",
	"pane.report_agent_session",
	"plugin.action.invoke",
	"plugin.action.list",
	"plugin.disable",
	"plugin.enable",
	"plugin.link",
	"plugin.list",
	"plugin.log.list",
	"plugin.pane.close",
	"plugin.pane.focus",
	"plugin.pane.open",
	"plugin.unlink",
	"popup.close",
	"server.live_handoff",
	"server.reload_agent_manifests",
	"server.reload_config",
	"server.stop",
	"tab.close",
	"workspace.close",
	"worktree.remove",
]);

/** Longest text a tool returns to the model. */
const MAX_OUTPUT_CHARS = 8000;
/** Deadline for a plain inspection call. */
const READ_TIMEOUT_MS = 3000;
/** Deadline for a write that herdr executes immediately. */
const WRITE_TIMEOUT_MS = 5000;
/** Ceiling for a caller-supplied wait. */
const MAX_WAIT_MS = 600000;
const DEFAULT_WAIT_MS = 60000;

export interface ToolDeps {
	client: HerdrClient;
	/** The pane pi runs in; the default target of every pane-scoped tool. */
	paneId: string;
	tabId: string | undefined;
	workspaceId: string | undefined;
}

interface PaneRecord {
	pane_id: string;
	workspace_id?: string;
	tab_id?: string;
	agent?: string | null;
	agent_status?: string;
	label?: string | null;
	title?: string | null;
	cwd?: string | null;
	focused?: boolean;
}

interface AgentRecord extends PaneRecord {
	name?: string | null;
	display_agent?: string | null;
	interactive_ready?: boolean;
}

/** Send one herdr request, refusing any method the tool layer must not reach. */
export async function callHerdr(
	deps: ToolDeps,
	method: string,
	params: Record<string, unknown>,
	options: { timeoutMs?: number; signal?: AbortSignal; idempotent?: boolean } = {},
): Promise<unknown> {
	if (FORBIDDEN_METHODS.has(method)) {
		throw new Error(`herdr method ${method} is not available to tools`);
	}
	try {
		return await deps.client.request(method, params, {
			timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
			signal: options.signal,
			idempotent: options.idempotent,
		});
	} catch (err) {
		if (err instanceof HerdrError) throw new Error(`herdr ${method} failed (${err.code}): ${err.message}`);
		throw err;
	}
}

function cap(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated`;
}

function result(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: cap(text) || "(empty)" }], details: undefined };
}

function boundedWait(value: number | undefined): number {
	if (value === undefined) return DEFAULT_WAIT_MS;
	return Math.min(Math.max(Math.trunc(value), 1), MAX_WAIT_MS);
}

/** Read the panes of the pane's own workspace. */
async function listPanes(deps: ToolDeps, signal: AbortSignal | undefined): Promise<PaneRecord[]> {
	const response = (await callHerdr(
		deps,
		"pane.list",
		deps.workspaceId ? { workspace_id: deps.workspaceId } : {},
		{ signal, idempotent: true },
	)) as { panes?: PaneRecord[] };
	return response.panes ?? [];
}

/**
 * Resolve a pane target against live state.
 *
 * The check runs immediately before every write, so a pane that closed or moved
 * between two tool calls fails loudly instead of receiving another pane's keys.
 */
async function resolvePane(deps: ToolDeps, paneId: string | undefined, signal: AbortSignal | undefined): Promise<string> {
	const wanted = paneId ?? deps.paneId;
	const panes = await listPanes(deps, signal);
	const match = panes.find((pane) => pane.pane_id === wanted);
	if (!match) {
		const known = panes.map((pane) => pane.pane_id).join(", ");
		throw new Error(`no pane ${wanted} in this workspace; current panes: ${known || "none"}`);
	}
	return match.pane_id;
}

function describePane(pane: PaneRecord, selfPaneId: string): string {
	const parts = [pane.pane_id];
	if (pane.pane_id === selfPaneId) parts.push("(this pane)");
	if (pane.tab_id) parts.push(`tab=${pane.tab_id}`);
	if (pane.agent) parts.push(`agent=${pane.agent}`);
	if (pane.agent_status) parts.push(`status=${pane.agent_status}`);
	if (pane.focused) parts.push("focused");
	if (pane.cwd) parts.push(`cwd=${pane.cwd}`);
	const label = pane.label ?? pane.title;
	if (label) parts.push(`label=${label}`);
	return parts.join(" ");
}

function describeAgent(agent: AgentRecord): string {
	const parts = [agent.name ?? agent.pane_id];
	parts.push(`pane=${agent.pane_id}`);
	if (agent.agent) parts.push(`kind=${agent.agent}`);
	parts.push(`status=${agent.agent_status ?? "unknown"}`);
	if (agent.interactive_ready === false) parts.push("starting");
	if (agent.cwd) parts.push(`cwd=${agent.cwd}`);
	return parts.join(" ");
}

/** Serialize writes per pane so two tool calls never interleave input. */
function paneQueue(): (paneId: string, job: () => Promise<string>) => Promise<string> {
	const chains = new Map<string, Promise<unknown>>();
	return (paneId, job) => {
		const previous = chains.get(paneId) ?? Promise.resolve();
		const next = previous.then(job, job);
		chains.set(
			paneId,
			next.catch(() => undefined),
		);
		return next;
	};
}

/** Build the herdr tool set for one pane. */
export function createHerdrTools(deps: ToolDeps): ToolDefinition[] {
	const serialize = paneQueue();

	const snapshot = defineTool({
		name: "herdr_snapshot",
		label: "herdr snapshot",
		description: "Overview of the herdr session: workspaces, tabs, panes, and the agent running in each pane.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			const response = (await callHerdr(deps, "session.snapshot", {}, { signal, idempotent: true })) as {
				snapshot?: {
					workspaces?: { workspace_id?: string; label?: string }[];
					tabs?: { tab_id?: string; label?: string; workspace_id?: string }[];
					panes?: PaneRecord[];
					focused_pane_id?: string;
				};
			};
			const snap = response.snapshot ?? {};
			const lines: string[] = [];
			for (const workspace of snap.workspaces ?? []) {
				lines.push(`workspace ${workspace.workspace_id} ${workspace.label ?? ""}`.trimEnd());
				for (const tab of (snap.tabs ?? []).filter((entry) => entry.workspace_id === workspace.workspace_id)) {
					lines.push(`  tab ${tab.tab_id} ${tab.label ?? ""}`.trimEnd());
					for (const pane of (snap.panes ?? []).filter((entry) => entry.tab_id === tab.tab_id)) {
						lines.push(`    ${describePane(pane, deps.paneId)}`);
					}
				}
			}
			return result(lines.join("\n"));
		},
	});

	const panes = defineTool({
		name: "herdr_panes",
		label: "herdr panes",
		description: "List the panes of this workspace with their agent and status.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			const list = await listPanes(deps, signal);
			return result(list.map((pane) => describePane(pane, deps.paneId)).join("\n"));
		},
	});

	const agents = defineTool({
		name: "herdr_agents",
		label: "herdr agents",
		description: "List the agents herdr tracks, with pane, kind, and lifecycle status.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			const response = (await callHerdr(deps, "agent.list", {}, { signal, idempotent: true })) as {
				agents?: AgentRecord[];
			};
			return result((response.agents ?? []).map(describeAgent).join("\n"));
		},
	});

	const current = defineTool({
		name: "herdr_current",
		label: "herdr current pane",
		description: "Describe the pane this session runs in.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			const response = (await callHerdr(deps, "pane.current", { caller_pane_id: deps.paneId }, { signal, idempotent: true })) as {
				pane?: PaneRecord;
			};
			return result(response.pane ? describePane(response.pane, deps.paneId) : "no current pane");
		},
	});

	const layout = defineTool({
		name: "herdr_layout",
		label: "herdr layout",
		description: "Geometry of the panes in a tab: position and size of each pane.",
		parameters: Type.Object(
			{ pane_id: Type.Optional(Type.String({ description: "Pane in the tab to describe. Defaults to this pane." })) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const response = await callHerdr(deps, "pane.layout", { pane_id: params.pane_id ?? deps.paneId }, { signal, idempotent: true });
			return result(JSON.stringify(response, null, 1));
		},
	});

	const processInfo = defineTool({
		name: "herdr_process_info",
		label: "herdr pane process",
		description: "Processes running in a pane.",
		parameters: Type.Object(
			{ pane_id: Type.Optional(Type.String({ description: "Pane to inspect. Defaults to this pane." })) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const response = await callHerdr(
				deps,
				"pane.process_info",
				{ pane_id: params.pane_id ?? deps.paneId },
				{ signal, idempotent: true },
			);
			return result(JSON.stringify(response, null, 1));
		},
	});

	const explain = defineTool({
		name: "herdr_explain",
		label: "herdr explain agent",
		description: "Explain why herdr reports an agent's current detection state.",
		parameters: Type.Object(
			{ target: Type.String({ description: "Agent name or pane id." }) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const response = await callHerdr(deps, "agent.explain", { target: params.target }, { signal, idempotent: true });
			return result(JSON.stringify(response, null, 1));
		},
	});

	const read = defineTool({
		name: "herdr_read",
		label: "herdr read pane",
		description: "Read the output of a pane. Use recent_unwrapped for log-like text and visible for what is on screen.",
		parameters: Type.Object(
			{
				pane_id: Type.String({ description: "Pane to read." }),
				source: Type.Optional(StringEnum(READ_SOURCES, { description: "Which text to read (default recent)." })),
				lines: Type.Optional(Type.Integer({ description: "Maximum lines to return.", minimum: 1, maximum: 2000 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const paneId = await resolvePane(deps, params.pane_id, signal);
			const response = (await callHerdr(
				deps,
				"pane.read",
				{ pane_id: paneId, source: params.source ?? "recent", lines: params.lines ?? 200, strip_ansi: true },
				{ signal, idempotent: true },
			)) as { read?: { text?: string; truncated?: boolean } };
			const text = response.read?.text ?? "";
			return result(response.read?.truncated ? `${text}\n… herdr truncated this read` : text);
		},
	});

	const split = defineTool({
		name: "herdr_split",
		label: "herdr split pane",
		description: "Split this pane and return the new pane id. The new pane starts a shell and does not take focus.",
		parameters: Type.Object(
			{
				direction: StringEnum(["right", "down"] as const, { description: "Where the new pane goes." }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the new pane." })),
				focus: Type.Optional(Type.Boolean({ description: "Move focus to the new pane (default false).", default: false })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const response = (await callHerdr(
				deps,
				"pane.split",
				{
					direction: params.direction,
					target_pane_id: deps.paneId,
					cwd: params.cwd ?? null,
					focus: params.focus ?? false,
				},
				{ signal, timeoutMs: WRITE_TIMEOUT_MS },
			)) as { pane?: PaneRecord };
			if (!response.pane) throw new Error("herdr pane.split returned no pane");
			return result(describePane(response.pane, deps.paneId));
		},
	});

	const sendText = defineTool({
		name: "herdr_send_text",
		label: "herdr send text",
		description: "Type text into a pane without pressing enter.",
		parameters: Type.Object(
			{
				pane_id: Type.String({ description: "Target pane." }),
				text: Type.String({ description: "Text to type." }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const paneId = await resolvePane(deps, params.pane_id, signal);
			return result(
				await serialize(paneId, async () => {
					await callHerdr(deps, "pane.send_text", { pane_id: paneId, text: params.text }, { signal, timeoutMs: WRITE_TIMEOUT_MS });
					return `sent ${params.text.length} characters to ${paneId}`;
				}),
			);
		},
	});

	const sendKeys = defineTool({
		name: "herdr_send_keys",
		label: "herdr send keys",
		description: "Send key presses to a pane, for example enter, escape, or ctrl+c.",
		parameters: Type.Object(
			{
				pane_id: Type.String({ description: "Target pane." }),
				keys: Type.Array(Type.String({ description: "Key name, for example enter or ctrl+c." }), {
					minItems: 1,
					maxItems: 32,
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const paneId = await resolvePane(deps, params.pane_id, signal);
			return result(
				await serialize(paneId, async () => {
					await callHerdr(deps, "pane.send_keys", { pane_id: paneId, keys: params.keys }, { signal, timeoutMs: WRITE_TIMEOUT_MS });
					return `sent ${params.keys.join(" ")} to ${paneId}`;
				}),
			);
		},
	});

	const run = defineTool({
		name: "herdr_run",
		label: "herdr run command",
		description:
			"Open a pane beside this one, run a shell command in it, and return its output. The pane stays open for follow-up reads.",
		parameters: Type.Object(
			{
				command: Type.String({ description: "Shell command to run." }),
				direction: Type.Optional(StringEnum(["right", "down"] as const, { description: "Where the pane goes (default down)." })),
				cwd: Type.Optional(Type.String({ description: "Working directory for the command." })),
				wait_for: Type.Optional(Type.String({ description: "Text to wait for in the output before returning." })),
				timeout_ms: Type.Optional(
					Type.Integer({ description: "How long to wait for that text.", minimum: 1, maximum: MAX_WAIT_MS }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const created = (await callHerdr(
				deps,
				"pane.split",
				{
					direction: params.direction ?? "down",
					target_pane_id: deps.paneId,
					cwd: params.cwd ?? null,
					focus: false,
				},
				{ signal, timeoutMs: WRITE_TIMEOUT_MS },
			)) as { pane?: PaneRecord };
			const paneId = created.pane?.pane_id;
			if (!paneId) throw new Error("herdr pane.split returned no pane");

			return result(
				await serialize(paneId, async () => {
					await callHerdr(
						deps,
						"pane.send_input",
						{ pane_id: paneId, text: params.command, keys: ["enter"] },
						{ signal, timeoutMs: WRITE_TIMEOUT_MS },
					);
					if (!params.wait_for) return `started in ${paneId}: ${params.command}`;
					const timeoutMs = boundedWait(params.timeout_ms);
					const matched = (await callHerdr(
						deps,
						"pane.wait_for_output",
						{
							pane_id: paneId,
							source: "recent_unwrapped",
							match: { type: "substring", value: params.wait_for },
							timeout_ms: timeoutMs,
							strip_ansi: true,
						},
						{ signal, timeoutMs: timeoutMs + WRITE_TIMEOUT_MS, idempotent: true },
					)) as { read?: { text?: string }; matched_line?: string | null };
					return `pane ${paneId}\n${matched.read?.text ?? matched.matched_line ?? ""}`;
				}),
			);
		},
	});

	const agentStart = defineTool({
		name: "herdr_agent_start",
		label: "herdr start agent",
		description: "Start a coding agent in a pane that sits at a shell prompt.",
		parameters: Type.Object(
			{
				name: Type.String({
					description: "Agent name: lowercase letters, digits, dash, underscore.",
					pattern: "^[a-z][a-z0-9_-]{0,31}$",
				}),
				kind: StringEnum(AGENT_KINDS, { description: "Agent program to start." }),
				pane_id: Type.String({ description: "Pane at a shell prompt." }),
				timeout_ms: Type.Optional(
					Type.Integer({ description: "How long to wait for readiness.", minimum: 3001, maximum: 300000 }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const paneId = await resolvePane(deps, params.pane_id, signal);
			return result(
				await serialize(paneId, async () => {
					const timeoutMs = params.timeout_ms ?? 30000;
					const response = (await callHerdr(
						deps,
						"agent.start",
						{ name: params.name, kind: params.kind, pane_id: paneId, timeout_ms: timeoutMs },
						{ signal, timeoutMs: timeoutMs + WRITE_TIMEOUT_MS },
					)) as { agent?: AgentRecord };
					return response.agent ? describeAgent(response.agent) : `started ${params.name} in ${paneId}`;
				}),
			);
		},
	});

	const agentPrompt = defineTool({
		name: "herdr_agent_prompt",
		label: "herdr prompt agent",
		description: "Send a prompt to another agent and optionally wait until it reaches a state.",
		parameters: Type.Object(
			{
				target: Type.String({ description: "Agent name or pane id." }),
				text: Type.String({ description: "Prompt text." }),
				wait_until: Type.Optional(
					Type.Array(StringEnum(AGENT_STATES, { description: "State to wait for." }), { minItems: 1, maxItems: 5 }),
				),
				timeout_ms: Type.Optional(Type.Integer({ description: "Wait budget.", minimum: 1, maximum: MAX_WAIT_MS })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const timeoutMs = boundedWait(params.timeout_ms);
			const wait = params.wait_until ? { until: params.wait_until, timeout_ms: timeoutMs } : null;
			return result(
				await serialize(params.target, async () => {
					const response = (await callHerdr(
						deps,
						"agent.prompt",
						{ target: params.target, text: params.text, wait },
						{ signal, timeoutMs: (wait ? timeoutMs : 0) + WRITE_TIMEOUT_MS },
					)) as { agent?: AgentRecord };
					return response.agent ? describeAgent(response.agent) : `prompted ${params.target}`;
				}),
			);
		},
	});

	const agentWait = defineTool({
		name: "herdr_agent_wait",
		label: "herdr wait for agent",
		description: "Wait until another agent reaches one of the given states.",
		parameters: Type.Object(
			{
				target: Type.String({ description: "Agent name or pane id." }),
				until: Type.Array(StringEnum(AGENT_STATES, { description: "State to wait for." }), { minItems: 1, maxItems: 5 }),
				timeout_ms: Type.Optional(Type.Integer({ description: "Wait budget.", minimum: 1, maximum: MAX_WAIT_MS })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const timeoutMs = boundedWait(params.timeout_ms);
			const response = (await callHerdr(
				deps,
				"agent.wait",
				{ target: params.target, until: params.until, timeout_ms: timeoutMs },
				{ signal, timeoutMs: timeoutMs + WRITE_TIMEOUT_MS, idempotent: true },
			)) as { agent?: AgentRecord; event?: unknown };
			return result(response.agent ? describeAgent(response.agent) : JSON.stringify(response, null, 1));
		},
	});

	const notify = defineTool({
		name: "herdr_notify",
		label: "herdr notify",
		description: "Show a notification in the herdr window.",
		parameters: Type.Object(
			{
				title: Type.String({ description: "Notification title.", minLength: 1, maxLength: 120 }),
				body: Type.Optional(Type.String({ description: "Notification body.", maxLength: 500 })),
				sound: Type.Optional(StringEnum(["none", "done", "request"] as const, { description: "Sound to play (default none)." })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			await callHerdr(
				deps,
				"notification.show",
				{ title: params.title, body: params.body ?? null, sound: params.sound ?? "none" },
				{ signal, timeoutMs: WRITE_TIMEOUT_MS },
			);
			return result(`notified: ${params.title}`);
		},
	});

	return [
		snapshot,
		panes,
		agents,
		current,
		layout,
		processInfo,
		explain,
		read,
		split,
		run,
		sendText,
		sendKeys,
		agentStart,
		agentPrompt,
		agentWait,
		notify,
	];
}
