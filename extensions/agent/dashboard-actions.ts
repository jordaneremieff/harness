import type { AgentConversationSummary } from "./dashboard-types.ts";
import { needsAttention } from "./dashboard-roster.ts";
export interface DashboardActionChoice {
	name: string;
	label: string;
	description: string;
	disabled?: string;
}
export function dashboardActions(row: AgentConversationSummary): DashboardActionChoice[] {
	return [
		{
			name: "abort",
			label: "Stop current work",
			description: "Stop this conversation; history stays.",
			disabled: row.state === "working" ? undefined : "No current work",
		},
		{
			name: "configure",
			label: "Configure",
			description: "Change name, model, and reasoning.",
			disabled: row.state === "working" ? "Stop current work first" : undefined,
		},
		{ name: "tasks", label: "Tasks", description: "Read the live tasks in this storage." },
		{ name: "fork", label: "Fork", description: "Create an idle branch from a committed message." },
		{ name: "rewind", label: "Rewind", description: "Create a branch before a mistake; files stay current." },
		{ name: "reset", label: "Reset context", description: "Start a new context; history and timers stay." },
		{ name: "schedule", label: "Schedule message", description: "Send a message at an exact deadline." },
		{ name: "timers", label: "Scheduled messages", description: "Read or cancel a scheduled message." },
		{ name: "compact", label: "Compact", description: "Stop active work and compact without resuming." },
		{
			name: "attach",
			label: "Reconnect",
			description: "Start the host; unfinished work resumes.",
			disabled: needsAttention(row) ? undefined : "No host error",
		},
		{ name: "command", label: "Run agent command", description: "Run a command with this agent's authority." },
		{ name: "status", label: "Details", description: "Read full identity, path, model, and host state." },
	];
}
