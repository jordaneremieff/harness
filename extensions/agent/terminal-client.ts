import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
	DefaultResourceLoader,
	ModelRuntime,
	ProjectTrustStore,
	SettingsManager,
	getAgentDir,
	getPackageDir,
	hasTrustRequiringProjectResources,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { KeybindingsManager, ProcessTerminal, TuiAltScreen, TUI_KEYBINDINGS, setKeybindings, type Component, type ProgramStatus, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { JsonValue } from "@earendil-works/chord/json";
import { type Action, type Choice, Form, plainLine, type ViewHost } from "../../operator-ui/index.ts";
import { AgentManager, type AgentCaller } from "./manager.ts";
import { createAgentObservationSource, type AgentObservationSource } from "./agent-observation.ts";
import { AgentDashboard, type DashboardOperations, type DashboardResult, type NewAgentDefaults, type NewAgentInput } from "./dashboard.ts";
import { agentState, createDashboardState, notifyAgentState, updateDraft, type DashboardState } from "./dashboard-state.ts";
import type { AgentModelInfo } from "./agent-footer.ts";
import { TerminalProgramStatus } from "./terminal-status.ts";
import { ModelChoicesSchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { loadDisplayModules, noDisplayModules, type DisplayModules } from "./display-modules.ts";
import { loadPanelModules, noPanelModules, panelDestinations, type PanelModules } from "./panel-modules.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { readAgentBranch } from "./agent-git.ts";
import { admittedResult } from "./result-reference.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { presetChoices, readAgentPreferences, type PreferenceCatalog } from "./agent-preferences.ts";
import { isThinkingLevel, type ConfigurationPatch } from "./configuration.ts";
import { cancelAgentTimer, readAgentTimerRows, resetAgentContext, scheduleAgentInput, type ResetTimerDeps } from "./durable-reset-timers.ts";
import type { ActionResult, AgentFormHost } from "./agent-forms.ts";
import type { ProfileDraft } from "./profile-dialog.ts";

/** The placement that a receipt states: whether the input is in the recipient's context. Empty when the receipt states none. */
export function placementText(receipt: unknown): string {
	const placement = (receipt as { placement?: unknown } | null)?.placement;
	return placement === "placed" ? "placed" : placement === "unplaced" ? "unplaced, the agent reads it at its next tool boundary" : "";
}

export function terminalAdmission(receipt: unknown, id: string, mode: "steer" | "followUp"): string {
	const reference = admittedResult(id, receipt);
	const deduped = (receipt as { deduped?: boolean }).deduped === true;
	const placement = placementText(receipt);
	return `Input ${deduped ? "already admitted" : "admitted"} for ${reference.sessionId} (submission ${reference.submissionId}; requested ${mode === "followUp" ? "follow-up" : "steer"}${placement ? `; ${placement}` : ""})`;
}

export type TerminalManager = Pick<AgentManager, "resolveTarget" | "control" | "snapshot" | "dashboardPage" | "observeLive" | "subscribeRoster" | "close"> &
	Partial<Pick<AgentManager, "collaborate" | "spawn">>;
export interface UnconfirmedTerminalInput {
	readonly text: string;
	readonly mode: "steer" | "followUp";
}

/** What independent creation needs from this process: a model catalogue and the trust facts for a cwd. */
export interface TerminalCreation {
	readonly catalog: PreferenceCatalog;
	validateModel(model: { provider: string; modelId: string }, level: string): string;
	/** Whether `cwd` needs a trust decision that nothing has made yet. */
	trustUndecided(cwd: string): boolean;
	readonly agentDir: string;
}

export interface TerminalControllerOptions {
	manager: TerminalManager;
	caller: AgentCaller;
	state?: DashboardState;
	remember?(id: string): void;
	/** Test seam for the local display-module import; the default imports the advertised file. */
	importModule?(url: string): Promise<Record<string, unknown>>;
	creation?: TerminalCreation;
}

/**
 * The attached terminal's own jobs. The work view owns presentation and observation; native work,
 * admission and creation belong to the existing manager and host. Selection reads passively:
 * nothing here starts a host except Send, Connect and creation, which are explicit.
 */
export class TerminalController {
	readonly state: DashboardState;
	readonly source: AgentObservationSource;
	readonly manager: TerminalManager;
	readonly caller: AgentCaller;
	readonly creation?: TerminalCreation;
	/** Owner renderers advertised by the selected conversation's live host. Replaced as a unit. */
	display: DisplayModules = noDisplayModules;
	/** Owner views advertised by the selected conversation's live host. Replaced as a unit. */
	panels: PanelModules = noPanelModules;
	private selectedId?: string;
	private generation = 0;
	private closed = false;
	private closing?: Promise<void>;
	private modelCatalog = new Map<string, AgentModelInfo>();
	private readonly failedInputs = new Map<string, UnconfirmedTerminalInput[]>();
	private readonly listeners = new Set<() => void>();
	private readonly remember?: (id: string) => void;
	private readonly importModule?: TerminalControllerOptions["importModule"];
	private loading?: Promise<void>;

	constructor(options: TerminalControllerOptions) {
		this.manager = options.manager;
		this.caller = options.caller;
		this.state = options.state ?? createDashboardState();
		this.remember = options.remember;
		this.importModule = options.importModule;
		this.creation = options.creation;
		this.source = createAgentObservationSource({
			list: (input) => this.manager.dashboardPage(input),
			snapshot: (id, params) => this.manager.snapshot(id, params),
			observeLive: (id, scope, listener, signal) => this.manager.observeLive(id, scope, listener, signal),
			subscribeRoster: (listener) => this.manager.subscribeRoster(listener),
		});
	}

	get selected(): string | undefined {
		return this.selectedId;
	}

	/** Changes with every new selection, including a reconnect of the same target. */
	get revision(): number {
		return this.generation;
	}

	/** Identity changes with the loaded source, so views holding an older lookup rebuild their cards. */
	get toolDisplay() {
		return this.display.lookup;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		if (!this.closed) for (const listener of this.listeners) listener();
	}

	/** A new selection: remember it and read its host's advertised cards, views and models without starting it. */
	select(id: string | undefined): void {
		if (this.closed || id === this.selectedId) return;
		const generation = ++this.generation;
		this.selectedId = id;
		this.display = noDisplayModules;
		this.panels = noPanelModules;
		this.modelCatalog = new Map();
		if (!id) {
			this.notify();
			return;
		}
		this.remember?.(id);
		this.loading = Promise.all([this.loadModules(id), this.loadModels(id)]).then(([modules, models]) => {
			if (this.closed || generation !== this.generation) return;
			this.display = modules.display;
			this.panels = modules.panels;
			this.modelCatalog = models;
			this.notify();
		});
		this.notify();
	}

	/** Resolves when the selected conversation's owner modules are loaded or refused. */
	displaySettled(): Promise<void> {
		return this.loading ?? Promise.resolve();
	}

	modelInfo(provider: string, modelId: string): AgentModelInfo | undefined {
		return this.modelCatalog.get(`${provider}/${modelId}`);
	}

	private async loadModels(id: string): Promise<Map<string, AgentModelInfo>> {
		const catalog = new Map<string, AgentModelInfo>();
		try {
			const read = await this.manager.control("models", { sessionId: id }, this.caller, { launch: false });
			if (!matchesSchema(ModelChoicesSchema, read)) return catalog;
			for (const model of read.models)
				if (model.contextWindow !== undefined) catalog.set(`${model.provider}/${model.modelId}`, { name: model.name ?? model.modelId, reasoning: model.reasoning, contextWindow: model.contextWindow });
		} catch {
			// The status line shows the model identifier without a context window.
		}
		return catalog;
	}

	/** The live host's status carries the admitted inventory. A stored or stopped host has none. */
	private async loadModules(id: string): Promise<{ display: DisplayModules; panels: PanelModules }> {
		try {
			const status = (await this.manager.control("status", { sessionId: id }, this.caller)) as { inventory?: unknown };
			if (status?.inventory === undefined) return { display: { lookup: noDisplayModules.lookup, diagnostics: [] }, panels: noPanelModules };
			const [display, panels] = await Promise.all([loadDisplayModules(status.inventory, this.importModule), loadPanelModules(status.inventory, this.importModule)]);
			return { display, panels };
		} catch (error) {
			return { display: { lookup: noDisplayModules.lookup, diagnostics: [`Owner cards unavailable (${String(error instanceof Error ? error.message : error).slice(0, 120)}); standard tool cards are used.`] }, panels: noPanelModules };
		}
	}

	/** One owner request to the target captured when its view opened; the signal withdraws the wait. */
	async panelRequest(target: string, command: string, data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }> {
		if (this.closed) throw new Error("Terminal is closed");
		if (signal?.aborted) throw new Error("The owner request was withdrawn before it was sent", { cause: signal.reason });
		const answer = (await this.manager.control("command", { sessionId: target, name: command, data, origin: "operator", invocationId: randomUUID() }, this.caller, signal ? { signal } : undefined)) as { text?: unknown; data?: JsonValue };
		if (typeof answer?.text !== "string") throw new Error("The host answered without command text");
		return { text: answer.text, ...(answer.data === undefined ? {} : { data: answer.data }) };
	}

	unconfirmed(id: string): readonly UnconfirmedTerminalInput[] {
		return this.failedInputs.get(id) ?? [];
	}

	failureReceipt(id: string, error: unknown): string {
		return `Delivery not confirmed for ${id}. Your draft is kept and the submitted text is retained; More › Recover input restores it without sending. ${String(error)}`;
	}

	/** Admit operator input whose answer stays in the target conversation itself. */
	async admit(id: string, text: string, mode: "steer" | "followUp"): Promise<{ raw: unknown; text: string }> {
		if (this.closed) throw new Error("Terminal is closed");
		try {
			const raw = await this.manager.control("submit", { sessionId: id, message: text, whenBusy: mode, origin: "operator", replyTo: id }, this.caller);
			return { raw, text: terminalAdmission(raw, id, mode) };
		} catch (error) {
			const inputs = this.failedInputs.get(id) ?? [];
			inputs.push({ text, mode });
			this.failedInputs.set(id, inputs);
			throw error;
		}
	}

	/** Put an unconfirmed input back into the target's draft only while the draft is unchanged. Nothing is sent. */
	restoreUnconfirmed(id: string, input: UnconfirmedTerminalInput, revision: number, mode: "steer" | "followUp"): void {
		const state = agentState(this.state, id);
		if (this.closed || state.pending || state.draftRevision !== revision || state.mode !== mode || !this.unconfirmed(id).includes(input)) throw new Error("The target draft changed. Inspect again before restoring.");
		state.mode = input.mode;
		updateDraft(state, input.text);
		this.notify();
	}

	discardUnconfirmed(id: string, input: UnconfirmedTerminalInput): void {
		this.failedInputs.set(id, this.unconfirmed(id).filter((item) => item !== input));
	}

	/** Explicitly connect: start the host if needed; retained unfinished work resumes. */
	async connect(id: string): Promise<void> {
		await this.manager.control("attach", { sessionId: id }, this.caller);
		const selected = this.selectedId;
		if (selected === id) {
			this.selectedId = undefined;
			this.select(id);
		}
	}

	/**
	 * Create an independent operator conversation: idle creation through the existing manager with
	 * the machine presets and this process's model catalogue, then the first message through the
	 * normal operator admission, whose answer the new conversation owns. One request identity per
	 * form keeps a retry from creating a second conversation.
	 */
	async create(input: NewAgentInput & { requestId: string; trust?: boolean }): Promise<DashboardResult> {
		const creation = this.creation;
		const spawn = this.manager.spawn?.bind(this.manager);
		if (!creation || !spawn) throw new Error("Creation needs the configured model catalogue; it is unavailable in this terminal.");
		const creator: AgentCaller = { ...this.caller, preferenceCatalog: creation.catalog, validateModel: (model, level) => creation.validateModel(model, level) };
		const created = (await spawn(
			{ ...(input.preset ? { preset: input.preset } : {}), ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.trust === undefined ? {} : { trust: input.trust }), origin: "operator", requestId: input.requestId },
			creator,
			input.onCreated,
		)) as { sessionId: string; cwd?: string };
		const id = created.sessionId;
		const place = basename(created.cwd ?? this.caller.cwd);
		const prompt = input.prompt?.trim() ? input.prompt : undefined;
		if (!prompt) return { text: `Created an idle conversation in ${place}`, sessionId: id };
		try {
			const receipt = await this.admit(id, prompt, "followUp");
			return { text: `Started a conversation in ${place}. ${receipt.text}`, receipt: receipt.text, sessionId: id };
		} catch (error) {
			// The conversation exists. Keep it, and keep the purpose as its draft; never create another.
			const state = agentState(this.state, id);
			updateDraft(state, prompt);
			state.receipt = this.failureReceipt(id, error);
			notifyAgentState(state);
			return { text: `Created the conversation in ${place}, but its first message was not confirmed. The text is in its message field; check the conversation before sending again.`, sessionId: id };
		}
	}

	async close(): Promise<void> {
		if (this.closed) return this.closing;
		this.closed = true;
		this.generation++;
		this.source.select(undefined);
		this.source.releaseTasks();
		this.listeners.clear();
		this.closing = this.manager.close();
		await this.closing;
	}
}

export function terminalTargetFile(root: string): { read(): string | undefined; write(id: string): void } {
	const file = join(root, "terminal-target.json");
	return {
		read() {
			try {
				const value: unknown = JSON.parse(readFileSync(file, "utf8"));
				return typeof value === "string" ? value : undefined;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		write(id) {
			const temporary = `${file}.${randomUUID()}`;
			writeFileSync(temporary, JSON.stringify(id), { mode: 0o600 });
			renameSync(temporary, file);
		},
	};
}

export function terminalKeys(): KeybindingsManager {
	return new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape" },
		"app.exit": { defaultKeys: "ctrl+d" },
		"app.clipboard.pasteImage": { defaultKeys: [] },
		// The focused screen owns paging, not the outer fullscreen viewport.
		"tui.altScreen.pageUp": { defaultKeys: [] },
		"tui.altScreen.pageDown": { defaultKeys: [] },
		"app.tools.expand": { defaultKeys: "ctrl+o" },
		"app.thinking.toggle": { defaultKeys: "ctrl+t" },
	});
}

const failure = (value: unknown) => {
	const reason = (value as { reason?: unknown; error?: unknown } | null)?.reason ?? (value as { error?: unknown } | null)?.error;
	return typeof reason === "string" && reason ? `: ${reason.slice(0, 200)}` : "";
};

/** Forms for one captured target through the terminal's own caller. */
export function terminalForms(controller: TerminalController, drafts: Map<string, ProfileDraft>, target: AgentConversationSummary): AgentFormHost {
	const label = agentDisplayName(target);
	const control = (method: string, input: Record<string, unknown> = {}) => controller.manager.control(method, { sessionId: target.id, ...input }, controller.caller);
	const deps: ResetTimerDeps = { control: (method, input) => controller.manager.control(method, input, controller.caller), label: async () => label };
	const outcome = (text: string, sessionId = target.id) => ({ text, sessionId });
	const runners: Record<string, (args: string[]) => Promise<ActionResult>> = {
		fork: async (args) => {
			const forked = (await control("fork", args[0] ? { entryId: args[0] } : {})) as { identity?: string; status?: { name?: string } };
			return outcome(`Created branch “${forked.status?.name ?? label}”`, forked.identity ?? target.id);
		},
		rewind: async (args) => {
			const result = (await control("rewind", { entryId: args[0], correction: args[1], origin: "operator", selfOwned: true })) as { identity?: string };
			return outcome(`Rewound “${label}” before the selected entry`, result.identity ?? target.id);
		},
		reset: (args) => resetAgentContext(deps, { sessionId: target.id, ...(args[0] ? { handoff: args[0] } : {}) }),
		compact: async (args) => {
			const result = (await control("compact", args[0] ? { instructions: args[0] } : {})) as { status?: string };
			return outcome(result?.status === "completed" ? `Compacted “${label}”` : `Compaction ${result?.status ?? "requested"} for “${label}”`);
		},
		command: async (args) => {
			const result = (await control("command", { name: args[0], args: args[1] ?? "", origin: "operator", invocationId: randomUUID() })) as { reloaded?: boolean; text?: string };
			return outcome(result?.reloaded ? `Reloaded host registrations for “${label}”` : `Ran command ${args[0]} on “${label}”${result?.text ? `: ${result.text}` : ""}`);
		},
		"timer-cancel": (args) => cancelAgentTimer(deps, { sessionId: target.id, timerId: Number(args[0]) }),
		abort: async () => {
			await control("abort");
			return outcome(`Requested stop for “${label}”`);
		},
		release: async () => {
			await control("release");
			return outcome(`Requested release for “${label}”`);
		},
		attach: async () => {
			await controller.connect(target.id);
			return outcome(`Connected to “${label}”`);
		},
	};
	return {
		row: target,
		state: controller.state,
		source: controller.source,
		run: async (name, args) => {
			const runner = runners[name];
			if (!runner) throw new Error(`Unsupported terminal action: ${name}`);
			return runner(args);
		},
		timers: () => readAgentTimerRows(deps, target.id),
		schedule: (input) => scheduleAgentInput(deps, { sessionId: target.id, ...input, selfOwned: true }),
		models: async () => {
			let read: unknown;
			try {
				read = await control("models");
			} catch (error) {
				throw new Error(`Model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (!matchesSchema(ModelChoicesSchema, read)) throw new Error("Model list unavailable: the host answered with an unreadable list");
			return read.models.map((model) => ({ identity: `${model.provider}/${model.modelId}`, ...(model.name ? { name: model.name } : {}) }));
		},
		configure: async (patch: ConfigurationPatch) => {
			// The native request takes the model as an object; the form stores the exact identity string.
			const { model: identity, ...rest } = patch;
			const split = identity?.indexOf("/") ?? -1;
			const result = (await control("configure", { ...rest, ...(identity === undefined ? {} : { model: { provider: identity.slice(0, split), modelId: identity.slice(split + 1) } }) })) as { outcome?: string };
			if (result?.outcome === "failed") throw new Error(`Configuration failed for “${label}”${failure(result)}`);
			return outcome(`Updated configuration for “${label}”`);
		},
		commands: async () => {
			const status = (await control("status")) as { inventory?: { contributions?: Array<{ commands?: Array<{ name: string; description: string }> }> } };
			if (!status.inventory) return undefined;
			const commands = status.inventory.contributions?.flatMap((contribution) => contribution.commands ?? []) ?? [];
			return [...commands.map((command) => ({ value: command.name, label: command.name, description: command.description })), { value: "reload", label: "reload", description: "Reload host registrations (needs an idle storage)" }];
		},
		profile: (method, input) => controller.manager.control(method, input, controller.caller),
		profileDrafts: drafts,
		status: (signal) => controller.manager.control("status", { sessionId: target.id }, controller.caller, signal ? { signal } : undefined),
		inspect: (params, signal) => controller.manager.control("inspect", params, controller.caller, signal ? { signal } : undefined),
		outcome: () => {},
	};
}

/** Review and restore unconfirmed input for one target. Recovery never sends anything. */
function recoverView(controller: TerminalController, id: string, host: ViewHost) {
	const inputs = controller.unconfirmed(id);
	const state = agentState(controller.state, id);
	const revision = state.draftRevision;
	const mode = state.mode;
	const choices: Choice[] = inputs.map((input, index) => ({ value: String(index), label: `requested ${input.mode} · ${plainLine(input.text).slice(0, 80)}` }));
	return new Form({
		title: "Recover input",
		heading: `Unconfirmed input for ${id}`,
		intro: "A transport error does not prove that admission failed: read the conversation before sending again. Restore replaces the current draft and sends nothing.",
		fields: [{ kind: "choice", id: "input", label: "Input", choices, rows: 6 }],
		action: { label: "Restore to the draft" },
		host,
		submit: async (values) => {
			const input = inputs[Number(values.input)];
			if (!input) throw new Error("Choose an input");
			controller.restoreUnconfirmed(id, input, revision, mode);
			return { close: true, notice: { text: "Restored to the draft; nothing was sent", kind: "success" } };
		},
	});
}

/** The attached terminal: the agent work view filling the window, plus program status and title. */
export class TerminalScreen implements Component {
	readonly view: AgentDashboard;
	private readonly programStatus?: TerminalProgramStatus;
	private readonly off: () => void;
	private readonly controller: TerminalController;
	private readonly drafts = new Map<string, ProfileDraft>();
	private creationId = randomUUID();
	private disposed = false;
	private readonly keys: KeybindingsManager;

	constructor(tui: TUI, theme: import("@earendil-works/pi-coding-agent").Theme, keys: KeybindingsManager, controller: TerminalController, done: () => void, publishStatus?: (status: ProgramStatus) => void, publishTitle?: (title: string) => void) {
		this.controller = controller;
		this.keys = keys;
		if (publishStatus) this.programStatus = new TerminalProgramStatus(publishStatus, publishTitle);
		const manager = controller.manager;
		const collaborate = manager.collaborate?.bind(manager);
		const operations: DashboardOperations = {
			toolDisplay: controller.toolDisplay,
			branch: readAgentBranch,
			readLineage: (id) => manager.control("status", { sessionId: id }, controller.caller),
			collaborate: collaborate
				? (input) => {
						const id = controller.selected;
						if (!["list", "read"].includes(String(input.action)) && !id) return Promise.reject(new Error("Select a conversation before posting to a thread."));
						return collaborate({ ...input, origin: "operator" }, { ...controller.caller, id: id ?? controller.caller.id });
					}
				: undefined,
			modelInfo: (provider, modelId) => controller.modelInfo(provider, modelId),
			submit: async (input) => {
				const receipt = await controller.admit(input.id, input.text, input.mode);
				return { text: receipt.text, receipt: receipt.text };
			},
			submissionFailure: (input, error) => controller.failureReceipt(input.id, error),
			newAgent: controller.creation && manager.spawn ? (input) => this.create(input) : undefined,
			newDefaults: () => this.newDefaults(),
			newUnavailable: "Creation needs the configured model catalogue, which this terminal could not load.",
			forms: (target) => terminalForms(controller, this.drafts, target),
			panels: async (target) => {
				if (controller.selected !== target.id) controller.select(target.id);
				await controller.displaySettled();
				return panelDestinations(controller.panels, target.id, (command, data, signal) => controller.panelRequest(target.id, command, data, signal));
			},
			observed: (row) => {
				controller.select(row?.id);
				this.projectStatus(row);
			},
			command: (text) => this.command(text),
			extraActions: (target) => this.extraActions(target),
			exitLabel: "Detach",
		};
		this.view = new AgentDashboard(tui, theme, keys, done, controller.state, controller.source, operations);
		const offController = controller.subscribe(() => this.changed());
		// Live observation changes, including its loss, move the program status without a new selection.
		const offSource = controller.source.subscribe(() => this.projectStatus(this.view.selectedRow));
		this.off = () => {
			offController();
			offSource();
		};
		this.done = done;
	}

	private readonly done: () => void;

	private newDefaults(): NewAgentDefaults {
		const creation = this.controller.creation;
		const { defaultPreset, choices } = presetChoices(readAgentPreferences(creation?.agentDir, creation?.catalog));
		return {
			cwd: this.controller.caller.cwd,
			presets: choices,
			...(defaultPreset === undefined ? {} : { preset: defaultPreset }),
			ownership: "The new conversation owns the answer to its first message; closing this terminal never strands it.",
		};
	}

	private async create(input: NewAgentInput): Promise<DashboardResult> {
		const cwd = resolve(this.controller.caller.cwd, input.cwd ?? ".");
		if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
		if (this.controller.creation?.trustUndecided(cwd)) throw new Error(`${cwd} has project resources and no saved trust decision. Decide in an ordinary Pi window opened there, or start in another directory.`);
		const result = await this.controller.create({ ...input, cwd, requestId: this.creationId });
		this.creationId = randomUUID();
		return result;
	}

	/** The terminal's own composer routes; other slash and bang text stays a literal message. */
	private async command(text: string): Promise<boolean> {
		const words = text.trim().split(/\s+/);
		if (text.trim() === "/quit") {
			this.done();
			return true;
		}
		if (words[0] !== "/agent") return false;
		if (words[1] === "enter" && words[2]) {
			const id = await this.controller.manager.resolveTarget(words[2]);
			this.view.selectIdentity(id);
		} else if (words[1] === "browse") this.view.openNamedAction("browse");
		else if (words[1] === "new") this.view.openNamedAction("new");
		else if (words[1] === "recover") this.recover(this.controller.selected);
		return true;
	}

	/** Review unconfirmed input of one target; recovery restores a draft and sends nothing. */
	private recover(id: string | undefined): void {
		if (id && this.controller.unconfirmed(id).length) this.view.openViewAction("Recover input", (host) => recoverView(this.controller, id, host));
		else this.view.notify("This conversation has no unconfirmed input", "info");
	}

	private extraActions(target: AgentConversationSummary): Action[] {
		const inputs = this.controller.unconfirmed(target.id);
		if (!inputs.length) return [];
		return [{ id: "recover", label: `Recover input (${inputs.length})`, key: "u", short: `recover input (${inputs.length})`, primary: true, description: "Restore an unconfirmed input to the draft without sending", run: () => this.recover(target.id) }];
	}

	private changed(): void {
		if (this.disposed) return;
		this.view.setToolDisplay(this.controller.toolDisplay);
		this.projectStatus(this.view.selectedRow);
	}

	/** Program status and title follow the selected conversation as last observed. */
	private projectStatus(row: AgentConversationSummary | undefined): void {
		const id = this.controller.selected;
		const live = id !== undefined && this.controller.source.availability(id)?.state === "live";
		this.programStatus?.update({ target: id, revision: this.controller.revision, live, busy: row?.id === id ? row?.state === "working" : undefined, name: row?.name, cwd: row?.cwd });
	}

	render(width: number): string[] {
		return this.view.render(width);
	}
	handleInput(data: string): void {
		// The exit key in an empty message field closes this terminal, as in a shell; native work continues.
		if (this.keys.matches(data, "app.exit") && this.emptyMessage()) {
			this.done();
			return;
		}
		this.view.handleInput(data);
	}

	private emptyMessage(): boolean {
		const { region, surface } = this.view.focus;
		const id = this.controller.selected;
		return surface === "work" && region === "composer" && id !== undefined && !agentState(this.controller.state, id).draft;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.view.handleMouse(event);
	}
	invalidate(): void {
		this.view.invalidate();
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.programStatus?.dispose();
		this.off();
		this.view.dispose();
	}
}

export function parseTerminalArgs(args: string[]): { session?: string; selectedTheme: "dark" | "light" } {
	let session: string | undefined;
	let selectedTheme = "dark";
	for (let i = 0; i < args.length; i++) {
		const name = args[i];
		const value = args[++i];
		if (!value || !["--session", "--theme"].includes(name)) throw new Error(`Unknown or incomplete terminal argument: ${name}`);
		if (name === "--session") session = value;
		else selectedTheme = value;
	}
	if (selectedTheme !== "dark" && selectedTheme !== "light") throw new Error("Theme must be dark or light; automatic/system theme is not supported.");
	return { session, selectedTheme };
}

/** The public services creation needs in this process: the configured catalogue and trust facts. */
async function creationServices(agentDir: string): Promise<TerminalCreation | undefined> {
	try {
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
		const trust = new ProjectTrustStore(agentDir);
		return {
			agentDir,
			catalog: runtime,
			validateModel: (model, level) => {
				const selected = runtime.getModel(model.provider, model.modelId);
				if (!selected) throw new Error(`Model is not in the configured catalog: ${model.provider}/${model.modelId}`);
				if (!isThinkingLevel(level)) throw new Error("Unknown reasoning level");
				return clampThinkingLevel(selected, level);
			},
			trustUndecided: (cwd) => {
				if (!hasTrustRequiringProjectResources(cwd) || trust.get(cwd) !== null) return false;
				const fallback = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust();
				return fallback !== "always" && fallback !== "never";
			},
		};
	} catch {
		return undefined;
	}
}

/**
 * Drop Node process warnings until the returned restore runs. Node prints each warning straight to
 * stderr, which is the screen the TUI owns: a lazily loaded built-in such as `node:sqlite` would
 * otherwise paint its ExperimentalWarning over the work view and the message field. Pi's own
 * interactive CLI drops process warnings for the same reason.
 */
export function suppressProcessWarnings(): () => void {
	const emitWarning = process.emitWarning;
	process.emitWarning = () => {};
	return () => { process.emitWarning = emitWarning; };
}

export async function runTerminal(args: string[]): Promise<void> {
	const { session, selectedTheme } = parseTerminalArgs(args);
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("This attachment requires an interactive terminal");
	const agentDir = process.env.PI_AGENT_DIR ?? getAgentDir();
	const root = resolve(process.env.PI_AGENT_SESSIONS_DIR ?? join(agentDir, "agent-sessions"));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const remembered = terminalTargetFile(root);
	const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, additionalThemePaths: [join(getPackageDir(), "dist", "modes", "interactive", "theme", `${selectedTheme}.json`)] });
	await loader.reload();
	const theme = loader.getThemes().themes.find((item) => item.name === selectedTheme);
	if (!theme) throw new Error(`Shipped ${selectedTheme} theme did not load`);
	initTheme(selectedTheme, false);
	const keys = terminalKeys();
	setKeybindings(keys);
	const manager = new AgentManager({ root: realpathSync(root), agentDir, packageDir: getPackageDir() });
	const controller = new TerminalController({ manager, caller: { id: `terminal:${randomUUID()}`, cwd: process.cwd() }, remember: (id) => remembered.write(id), creation: await creationServices(agentDir) });
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let finish!: () => void;
	const finished = new Promise<void>((resolveDone) => {
		finish = resolveDone;
	});
	const screen = new TerminalScreen(tui, theme, keys, controller, finish, (status) => terminal.setProgramStatus(status), (title) => terminal.setTitle(title));
	const close = () => finish();
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	const restoreWarnings = suppressProcessWarnings();
	try {
		try {
			const target = session ?? remembered.read();
			if (target) screen.view.selectIdentity(await manager.resolveTarget(target));
			else screen.view.openNamedAction("new");
			tui.addChild(screen);
			tui.setFocus(screen);
			tui.start();
			await finished;
		} finally {
			process.off("SIGINT", close);
			process.off("SIGTERM", close);
			screen.dispose();
			try {
				await controller.close();
			} finally {
				tui.stop();
			}
		}
	} finally {
		restoreWarnings();
	}
}
