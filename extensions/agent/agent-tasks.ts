/**
 * agent/agent-tasks: the Tasks view for one storage's live task graph.
 *
 * The view renders only the live graph the host publishes: task kind, state and
 * phase, background boundary, abort request, and owned conversations with their
 * labels. Selecting a row names the conversation, so the dashboard can open
 * its transcript. Terminal tasks are absent by construction; their results stay
 * in the conversation history.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TaskGraphRow, TaskLabel, TasksFrame } from "./live-frames.ts";

/** Live task source the view consumes; frames arrive from the agent observation source. */
export interface AgentTasksSource {
	tasks(id: string): Promise<TasksFrame>;
	subscribe?(listener: () => void): () => void;
}

export interface AgentTasksOptions {
	theme: Theme;
	source: AgentTasksSource;
	/** Agent identity whose storage graph is read and re-read on subscription changes. */
	id: string;
	/** Open the agent named by one selected conversation identity. */
	onSelectConversation?: (identity: string, label: TaskLabel) => void;
	onNotice?: (text: string) => void;
	onChooseConversations?: (labels: readonly TaskLabel[]) => void;
}

interface OrderedRow {
	readonly row: TaskGraphRow;
	readonly depth: number;
}

/** Root-first depth ordering; a task whose owner is not live shows as a root. */
export function orderTaskRows(rows: readonly TaskGraphRow[]): OrderedRow[] {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const children = new Map<number | undefined, TaskGraphRow[]>();
	for (const row of rows) {
		const parent = row.owner !== undefined && byId.has(row.owner) ? row.owner : undefined;
		const list = children.get(parent);
		if (list === undefined) children.set(parent, [row]);
		else list.push(row);
	}
	const ordered: OrderedRow[] = [];
	const walk = (parent: number | undefined, depth: number, ancestry: Set<number>): void => {
		for (const row of children.get(parent) ?? []) {
			if (ancestry.has(row.id)) continue;
			ordered.push({ row, depth });
			ancestry.add(row.id);
			walk(row.id, depth + 1, ancestry);
			ancestry.delete(row.id);
		}
	};
	walk(undefined, 0, new Set());
	return ordered;
}

function labelText(label: TaskLabel | undefined, id: number): string {
	if (label === undefined) return `#${id}`;
	const name = label.name?.trim() || label.firstMessage?.trim();
	return name === undefined || name === "" ? `#${id}` : `${name} · #${id}`;
}

function stateText(row: TaskGraphRow): string {
	const parts: string[] = [row.status];
	if (row.status === "waiting" && row.waitsOn.length > 0)
		parts.push(`waiting on ${row.waitsOn.map((id) => `#${id}`).join(", ")}`);
	else if (row.status === "completing" && row.outcome !== undefined) parts.push(row.outcome);
	else if (row.phase !== "" && row.phase !== row.status) parts.push(row.phase);
	return parts.join(" ");
}

/**
 * Live task-graph view for one selected agent's storage. The dashboard owns focus
 * and layout; this class owns row order, selection, and text.
 */
export class AgentTasksView {
	private readonly theme: Theme;
	private readonly source: AgentTasksSource;
	private readonly id: string;
	private readonly onSelectConversation: AgentTasksOptions["onSelectConversation"];
	private readonly onNotice: AgentTasksOptions["onNotice"];
	private frame: TasksFrame | undefined;
	private ordered: OrderedRow[] = [];
	private selectedIndex = 0;
	private unsubscribe: (() => void) | undefined;
	private pending: Promise<void> | undefined;
	private error: string | undefined;
	private closed = false;
	private viewportRows = 1;
	private renderedTaskIds: number[] = [];
	private readonly onChooseConversations: AgentTasksOptions["onChooseConversations"];

	constructor(options: AgentTasksOptions) {
		this.theme = options.theme;
		this.source = options.source;
		this.id = options.id;
		this.onSelectConversation = options.onSelectConversation;
		this.onNotice = options.onNotice;
		this.onChooseConversations = options.onChooseConversations;
		queueMicrotask(() => {
			if (!this.closed) void this.refresh();
		});
		this.unsubscribe = this.source.subscribe?.(() => {
			void this.refresh();
		});
	}

	dispose(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Read the storage's live graph again; a call during a read joins it. */
	refresh(): Promise<void> {
		if (this.pending !== undefined) return this.pending;
		const run = (async () => {
			try {
				const frame = await this.source.tasks(this.id);
				if (this.closed) return;
				this.renderedTaskIds = [];
				this.frame = frame;
				this.ordered = orderTaskRows(frame.tasks);
				this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.ordered.length - 1));
				this.error = undefined;
			} catch (caught) {
				this.renderedTaskIds = [];
				this.error = caught instanceof Error ? caught.message : String(caught);
			}
		})();
		this.pending = run.finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	/** Wheel over tasks changes only the selected task, without starting a task. */
	scroll(delta: number): void {
		this.move(delta);
	}
	/** A row click selects a task; a later Enter opens its conversation. */
	clickRow(line: number): boolean {
		const id = this.renderedTaskIds[line - 1];
		if (id === undefined) return false;
		const index = this.ordered.findIndex((item) => item.row.id === id);
		if (index < 0) return false;
		this.selectedIndex = index;
		return true;
	}
	selected(): OrderedRow | undefined {
		return this.ordered[this.selectedIndex];
	}

	/** Select a conversation or move the row cursor; returns true when the key was used. */
	handleInput(data: string): boolean {
		if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.move((matchesKey(data, "pageUp") ? -1 : 1) * this.viewportRows);
			return true;
		}
		if (matchesKey(data, "home")) {
			this.move(-this.ordered.length);
			return true;
		}
		if (matchesKey(data, "end")) {
			this.move(this.ordered.length);
			return true;
		}
		if (matchesKey(data, "up")) {
			this.move(-1);
			return true;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
			return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.selectCurrent();
			return true;
		}
		return false;
	}

	private selectCurrent(): void {
		const selected = this.selected();
		if (selected === undefined) {
			this.onNotice?.("No live task is selected");
			return;
		}
		const ids = [...new Set([selected.row.conversationId, ...selected.row.conversations])];
		const labels = this.frame?.labels.filter((label) => ids.includes(label.conversationId)) ?? [];
		if (labels.length > 1) this.onChooseConversations?.(labels);
		else this.select(labels[0]?.conversationId ?? selected.row.conversationId);
	}
	private move(delta: number): void {
		if (this.ordered.length === 0) return;
		this.selectedIndex = Math.min(this.ordered.length - 1, Math.max(0, this.selectedIndex + delta));
	}

	/** Open the console for the selected task's conversation. */
	private select(conversationId: number): void {
		const label = this.frame?.labels.find((candidate) => candidate.conversationId === conversationId);
		if (!label?.identity) {
			this.onNotice?.("This task has no resolved conversation identity");
			return;
		}
		this.onSelectConversation?.(label.identity, label);
	}

	private labelFor(id: number): string {
		return labelText(
			this.frame?.labels.find((candidate) => candidate.conversationId === id),
			id,
		);
	}

	private fitLine(text: string, width: number): string {
		const clipped = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
		const visible = visibleWidth(clipped);
		return visible < width ? clipped + " ".repeat(width - visible) : clipped;
	}

	private headerLine(width: number): string {
		const frame = this.frame;
		const count = frame?.tasks.length ?? 0;
		const coverage = frame === undefined ? "unread" : frame.coverage.live ? "live" : "no live host";
		return this.fitLine(
			`${this.theme.fg("accent", this.theme.bold("TASKS"))}  ${count} ${count === 1 ? "task" : "tasks"} · ${coverage}`,
			width,
		);
	}

	private emptyLine(width: number): string {
		if (this.error !== undefined) return this.fitLine(this.theme.fg("error", this.error), width);
		const frame = this.frame;
		if (frame !== undefined && frame.tasks.length > 0) return "".padEnd(width);
		const text =
			frame === undefined
				? "Reading the live task graph…"
				: frame.coverage.live
					? "No live tasks · unfinished work only; completed results stay in the conversation"
					: "No live host · stored agents stay cold until a host owns their storage";
		return this.fitLine(this.theme.fg("muted", text), width);
	}

	private rowLine(ordered: OrderedRow, index: number, width: number): string {
		const marker = index === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
		const indent = "  ".repeat(ordered.depth);
		const background = ordered.row.background ? " · background" : "";
		const abort = ordered.row.abortRequested ? " · abort requested" : "";
		const owned =
			ordered.row.conversations.length === 0
				? ""
				: ` · owns ${ordered.row.conversations.map((id) => this.labelFor(id)).join(", ")}`;
		return this.fitLine(
			`${marker} ${indent}${ordered.row.kind} · ${stateText(ordered.row)}${background}${abort}${owned}`,
			width,
		);
	}

	/** Render the view at one width and height; every line fits the width. */
	render(width: number, height: number): string[] {
		width = Math.max(1, Math.floor(width));
		height = Math.max(0, Math.floor(height));
		this.renderedTaskIds = [];
		if (height === 0) return [];
		const lines: string[] = [this.headerLine(width)];
		const count = this.frame?.tasks.length ?? 0;
		if (this.error !== undefined || count === 0) {
			lines.push(this.emptyLine(width));
		} else {
			const truncated = this.ordered.length > height - 1;
			this.viewportRows = Math.max(1, height - 1 - (truncated ? 1 : 0));
			const start = Math.max(
				0,
				Math.min(this.ordered.length - this.viewportRows, this.selectedIndex - Math.floor(this.viewportRows / 2)),
			);
			for (let index = start; index < Math.min(this.ordered.length, start + this.viewportRows); index++) {
				const ordered = this.ordered[index];
				if (ordered !== undefined) {
					this.renderedTaskIds.push(ordered.row.id);
					lines.push(this.rowLine(ordered, index, width));
				}
			}
			if (truncated)
				lines.push(
					this.fitLine(
						`${this.selectedIndex + 1}/${this.ordered.length} tasks · +${this.ordered.length - this.viewportRows} more`,
						width,
					),
				);
		}
		while (lines.length < height) lines.push(" ".repeat(width));
		return lines.slice(0, height);
	}
}
