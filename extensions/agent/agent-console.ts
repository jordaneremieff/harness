import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentConversationEntry } from "./dashboard-types.ts";
import type { AgentDraftState } from "./dashboard-state.ts";
import { AgentComposer } from "./agent-composer.ts";
import { ConversationView } from "./conversation-view.ts";
import { fitLine } from "./dashboard-layout.ts";
import { footerText } from "./agent-footer.ts";
import { agentDisplayName } from "./action-outcome.ts";
export class AgentConsole {
	readonly composer: AgentComposer;
	readonly conversation: ConversationView;
	row: AgentConversationSummary;
	status = "Loading conversation…";
	readonly state: AgentDraftState;
	constructor(
		row: AgentConversationSummary,
		state: AgentDraftState,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		submit: (text: string) => void,
		onBack: () => void,
	) {
		this.state = state;
		this.row = row;
		this.composer = new AgentComposer({
			tui,
			theme,
			keys,
			onSubmit: submit,
			onChange: (text) => {
				state.draft = text;
			},
			onEscape: onBack,
		});
		this.composer.setText(state.draft);
		for (const text of state.history) this.composer.addToHistory(text);
		this.conversation = new ConversationView(tui, state.view);
	}
	setContent(entries: readonly AgentConversationEntry[], live: readonly AgentConversationEntry[] = []): void {
		this.conversation.setContent(entries, live, this.row.cwd);
	}
	messageLabel(focused: boolean, width: number): string {
		const target = `Message to ${agentDisplayName(this.row)}`;
		if (!focused) return `${target} · Tab or m to write`;
		const mode =
			this.row.state === "working"
				? this.state.mode === "steer"
					? "Steer at next step · Tab follow-up"
					: "Follow-up after answer · Tab steer"
				: "Send · starts a turn";
		return `${truncateToWidth(target, Math.max(12, width - visibleWidth(mode) - 3))} · ${mode}`;
	}
	footer(width: number): string {
		return fitLine(footerText(this.row, width), width);
	}
	save(): void {
		this.state.draft = this.composer.getText();
		this.conversation.save();
	}
}
