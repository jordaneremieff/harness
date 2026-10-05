import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentConversationEntry } from "./dashboard-types.ts";
import { updateDraft, subscribeAgentState, type AgentDraftState } from "./dashboard-state.ts";
import { AgentComposer } from "./agent-composer.ts";
import { ConversationView } from "./conversation-view.ts";
import { modelSubheading, formatCost } from "./agent-footer.ts";
import type { UsageState } from "@earendil-works/pi-durable";
import { compactTokens, contextTokens, usageFacts } from "./agent-usage.ts";
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
		this.conversation = new ConversationView(tui, state.view);
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
	messageLabel(width: number, window?: number): string {
		const usage = usageFacts(this.context, window, this.usage);
		const facts: string[] = [];
		if (usage.context !== undefined) {
			const context = compactTokens(usage.context) + (usage.window === undefined ? "" : `/${compactTokens(usage.window)} (${Math.round(usage.context / usage.window * 100)}%)`);
			facts.push(`${context} ctx`);
		}
		if (Number.isFinite(this.row.cost)) facts.push(formatCost(this.row.cost, this.row.partial));
		const tokens = [usage.input === undefined ? "" : `${compactTokens(usage.input)} in`, usage.output === undefined ? "" : `${compactTokens(usage.output)} out`].filter(Boolean).join(" · ");
		if (tokens) facts.push(tokens);
		let label = this.messageMode().toLowerCase();
		// Retain the effect, then capacity, budget, and cumulative traffic as whole groups.
		for (const fact of facts) {
			const next = `${label} · ${fact}`;
			if (visibleWidth(next) > width) break;
			label = next;
		}
		return label;
	}
	messageMode(): string {
		return this.row.state === "working"
			? this.state.mode === "steer" ? "Steer at next step" : "Follow-up after answer"
			: "Send";
	}
	subheading(width: number): string {
		return modelSubheading(this.row, width, this.theme);
	}
	save(): void {
		updateDraft(this.state, this.composer.getText());
		this.conversation.save();
	}
	dispose(): void {
		this.unsubscribe();
	}
}
