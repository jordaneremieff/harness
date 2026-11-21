import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentConversationEntry } from "./dashboard-types.ts";
import { updateDraft, subscribeAgentState, type AgentDraftState } from "./dashboard-state.ts";
import { AgentComposer } from "./agent-composer.ts";
import { ConversationView } from "./conversation-view.ts";
import type { AgentCardLookup } from "./tool-cards.ts";
import { agentFactsLine, type AgentModelInfo } from "./agent-footer.ts";
import type { UsageState } from "@earendil-works/pi-durable";
import { contextTokens } from "./agent-usage.ts";
export class AgentConsole {
	readonly composer: AgentComposer;
	readonly conversation: ConversationView;
	row: AgentConversationSummary;
	status = "Loading conversation…";
	warning?: string;
	context?: number;
	usage?: UsageState;
	observeUsage(entries: readonly AgentConversationEntry[], usage?: UsageState): void {
		this.context = contextTokens(entries);
		this.usage = usage;
	}
	readonly state: AgentDraftState;
	private readonly unsubscribe: () => void;
	private historyCount: number;
	private readonly theme: Theme;
	constructor(
		row: AgentConversationSummary,
		state: AgentDraftState,
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		submit: (text: string) => void,
		onBack: () => void,
		rows?: AgentCardLookup,
	) {
		this.theme = theme;
		this.state = state;
		this.row = row;
		this.composer = new AgentComposer({
			tui,
			theme,
			keys,
			onSubmit: submit,
			onChange: (text) => {
				updateDraft(state, text);
			},
			onEscape: onBack,
		});
		this.composer.setText(state.draft);
		for (const text of state.history) this.composer.addToHistory(text);
		this.historyCount = state.history.length;
		this.conversation = new ConversationView(tui, state.view, rows);
		this.unsubscribe = subscribeAgentState(state, () => {
			if (this.composer.getText() !== state.draft) this.composer.setText(state.draft);
			for (const text of state.history.slice(this.historyCount)) this.composer.addToHistory(text);
			this.historyCount = state.history.length;
			tui.requestRender();
		});
	}
	setContent(entries: readonly AgentConversationEntry[], live: readonly AgentConversationEntry[] = []): void {
		this.conversation.setContent(entries, live, this.row.cwd);
	}
	/** The status facts on one row: model, context, cost and cache, then the directory and branch. */
	factsLine(width: number, info?: AgentModelInfo, branch?: string): string {
		return agentFactsLine(this.row, width, this.theme, this.context, info, this.usage, branch);
	}
	save(): void {
		updateDraft(this.state, this.composer.getText());
		this.conversation.save();
	}
	dispose(): void {
		this.unsubscribe();
		this.conversation.dispose();
	}
}
