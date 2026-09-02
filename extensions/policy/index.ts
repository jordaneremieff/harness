/**
 * Policy: records paired tool calls and their outcomes against declarative
 * rules, and runs the one mechanism the active mode selects.
 *
 * Every mode records. `observe` acts on nothing. `notice` shows the operator a
 * flag in the terminal and adds no model-visible text. `annotate` appends one
 * capped line of guidance to a flagged result, at most once per rule id per
 * session. `enforce` blocks built-ins and in-scope promoted agent classes;
 * in-scope active agent classes receive annotation guidance, while scoped-out
 * agent classes only record. No mode changes a tool input,
 * because no rewrite is provably semantics-preserving and Pi does not
 * re-validate a mutated input.
 *
 * Duration is measured here because no event carries it: `tool_call` and
 * `tool_result` are paired by call id and stamped on arrival.
 *
 * The slice sits in the path of every tool call, so a defect in it must never
 * reach that call. Every handler body runs inside a boundary that reports the
 * first failure once and then stops acting for the rest of the session.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	copyToClipboard,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	agentClass,
	type AgentMatch,
	AgentRules,
	appendLine,
	countFires,
	type AgentRule,
	type AgentScope,
	type AgentState,
	type AgentSuggestion,
	isAgentClass,
	MAX_NOTE_BYTES,
	needsOperatorConfirm,
	readStateLines,
	scanWarrantEvidence,
	validateMatch,
	validateNote,
	validateScope,
	validateSlug,
	validateSuggestion,
} from "./agent-rules.ts";
import { bindAgentRules, notesFor } from "./classify.ts";
import { POLICY_MODES, resolvePolicyMode, resolvePolicyModeValue, type PolicyMode } from "./mode.ts";
import {
	draftRuleMessage,
	formatPolicyHistory,
	formatPolicyList,
	formatPolicyShow,
	PolicyPanel,
	readRecentActivity,
	terminalSafe,
	type BuiltinGroup,
	type BuiltinRuleInfo,
	type PolicyPanelData,
	type PolicyPanelResult,
	type PolicyView,
} from "./panel.ts";
import {
	MIN_WARRANT_FIRES,
	PROMOTION_CRITERIA_VERSION,
	PROMOTION_MODES,
	describeEvidence,
	emptyEvidence,
	evaluateWarrant,
	formatPromotionCriteria,
	resolvePromotionMode,
	resolvePromotionModeValue,
	type PromotionMode,
	type PromotionWarrant,
	type WarrantEvidence,
} from "./promotion.ts";
import {
	finishCall,
	startCall,
	trackPending,
	type CallEffects,
	type ContentLike,
	type PendingCall,
	type ResultFacts,
	type SessionFacts,
} from "./record.ts";
import { RULES } from "./shell-rules.ts";
import { PolicyWriter, resolvePolicyDir } from "./store.ts";

/** Per-session override for the policy mechanism. */
const POLICY_MODE_FLAG = "policy-mode";

/** Per-session override for who may promote through the agent tool. */
const PROMOTION_MODE_FLAG = "policy-promotion-mode";

/** Marker Pi writes into the system prompt when project context files are loaded. */
const PROJECT_CONTEXT_MARKER = "<project_context>";

/** Prefix that marks harness guidance so it is not read as tool output. */
const POLICY_PREFIX = "[policy]";

/** Upper bound on one appended or returned guidance line. */
const MAX_GUIDANCE_BYTES = 512;

/** Sessions whose annotated rule ids are still tracked. */
const MAX_ANNOTATED_SESSIONS = 16;

/** Maximum model-visible output from a rule registry listing. */
const MAX_RULE_LIST_BYTES = 50 * 1024;

const POLICY_USAGE = [
	"Usage:",
	"  /policy                         Open the Rules and Activity panel (TUI only)",
	"  /policy list                    Print agent rules and built-in groups",
	"  /policy show <slug-or-id>       Print full rule detail and fires by model",
	"  /policy history <slug>          Print state-transition history",
	"  /policy state <slug> <state>    Set active, promoted, disabled, or discarded",
	"  /policy capture <hint...>       Capture an in-session rule-authoring request",
	"  /policy criteria                Print the promotion criteria",
	"  /policy mode                    Report this session's policy mode",
	"  /policy help                    Show this usage",
].join("\n");

const POLICY_VERBS: AutocompleteItem[] = [
	{ value: "list", label: "list", description: "Print agent rules and built-in groups" },
	{ value: "show", label: "show", description: "Show one rule with fires by model" },
	{ value: "history", label: "history", description: "Show an agent rule's state history" },
	{ value: "state", label: "state", description: "Change an agent rule state" },
	{ value: "capture", label: "capture", description: "Capture a rule-authoring request" },
	{ value: "criteria", label: "criteria", description: "Print the promotion criteria" },
	{ value: "mode", label: "mode", description: "Report the active session mode" },
	{ value: "help", label: "help", description: "Show /policy usage" },
];

const POLICY_STATES: readonly AgentState[] = ["active", "promoted", "disabled", "discarded"];

const MODE_EFFECT: Readonly<Record<PolicyMode, string>> = {
	observe: "Records every tool call and applies no mechanism.",
	notice: "Records every tool call and shows a terminal warning for each flagged call in TUI mode.",
	annotate: "Records every tool call and appends bounded guidance to eligible flagged results.",
	enforce: "Records every tool call, blocks built-ins and in-scope promoted agent rules, and steers with active rules.",
};

const BUILTIN_RULE_INFOS: BuiltinRuleInfo[] = RULES.map(({ id, note }) => ({ id, note }));

const NonEmptyString = Type.String({ minLength: 1 });
const StringChoice = Type.Union([NonEmptyString, Type.Array(NonEmptyString, { minItems: 1 })]);
const OperandsMatchSchema = Type.Object(
	{
		min: Type.Optional(Type.Integer({ minimum: 0 })),
		max: Type.Optional(Type.Integer({ minimum: 0 })),
		any: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		at: Type.Optional(Type.Record(Type.String({ pattern: "^\\d+$" }), StringChoice, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
const PipeMatchSchema = Type.Object(
	{
		from: Type.Optional(Type.Boolean()),
		to: Type.Optional(Type.Boolean()),
		fromRedirect: Type.Optional(Type.Boolean()),
		toRedirect: Type.Optional(Type.Boolean()),
		next: Type.Optional(StringChoice),
		later: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
	},
	{ additionalProperties: false },
);
const MatchSchema = Type.Object(
	{
		tool: Type.Literal("bash"),
		command: StringChoice,
		flags: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		absentFlags: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		operands: Type.Optional(OperandsMatchSchema),
		pipe: Type.Optional(PipeMatchSchema),
	},
	{ additionalProperties: false },
);
const SuggestionSchema = Type.Object(
	{
		command: NonEmptyString,
		flags: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
	},
	{ additionalProperties: false },
);
const ScopeSchema = Type.Object(
	{
		exclude: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		providers: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
		models: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
	},
	{ additionalProperties: false },
);
/**
 * States the agent tool sets. Promotion is a mechanism action on measured
 * evidence, and lowering a promoted rule stays with the operator, so neither
 * reaches the model-facing surface.
 */
const ToolStateSchema = StringEnum(["active", "disabled", "discarded"] as const);

function readTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const truncation = (details as { truncation?: unknown }).truncation;
	if (!truncation || typeof truncation !== "object") return false;
	return (truncation as { truncated?: unknown }).truncated === true;
}

function readTokens(usage: unknown): number | null {
	if (!usage || typeof usage !== "object") return null;
	const total = (usage as { totalTokens?: unknown }).totalTokens;
	return typeof total === "number" ? total : null;
}

function modelName(ctx: ExtensionContext): string | null {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : null;
}

function toolText(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function toolFailure(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown policy rule tool failure";
	}
}

function rulesText(entries: readonly AgentRule[], fires: ReadonlyMap<string, number>, partial: boolean): string {
	const partialMarker = partial ? "\n\nfiring counts partial: store scan exceeded the byte bound" : "";
	if (entries.length === 0) return `No agent rules.${partialMarker}`;
	const truncatedMarker = "\n\n[agent rule list truncated]";
	let text = "";
	for (const rule of entries) {
		const block = [
			`slug: ${rule.slug}`,
			`state: ${rule.state}`,
			`note: ${rule.note}`,
			`match: ${JSON.stringify(rule.match)}`,
			`suggest: ${rule.suggest === undefined ? "none" : JSON.stringify(rule.suggest)}`,
			`scope: ${rule.scope === undefined ? "everywhere" : JSON.stringify(rule.scope)}`,
			`model: ${rule.model}`,
			`session: ${rule.session}`,
			`at: ${rule.at}`,
			`fires: ${fires.get(agentClass(rule.slug)) ?? 0}`,
		].join("\n");
		const candidate = text.length === 0 ? block : `${text}\n\n${block}`;
		if (Buffer.byteLength(`${candidate}${truncatedMarker}${partialMarker}`, "utf8") > MAX_RULE_LIST_BYTES) {
			return `${text}${truncatedMarker}${partialMarker}`;
		}
		text = candidate;
	}
	return `${text}${partialMarker}`;
}

interface ObservedCall extends PendingCall {
	sessionFacts: SessionFacts;
	/** The call was blocked at the tool boundary. */
	blocked?: boolean;
	/** The reason returned with the block, used to confirm Pi applied it. */
	blockReason?: string;
}

interface Annotation {
	text: string;
	/** Rule ids whose guidance this text carries. */
	ids: string[];
}

export default function registerPolicy(pi: ExtensionAPI) {
	pi.registerFlag(POLICY_MODE_FLAG, {
		type: "string",
		description: `Policy mode (${POLICY_MODES.join(", ")}); overrides PI_POLICY_MODE`,
	});
	pi.registerFlag(PROMOTION_MODE_FLAG, {
		type: "string",
		description: `Policy promotion mode (${PROMOTION_MODES.join(", ")}); overrides PI_POLICY_PROMOTION_MODE`,
	});

	const pending = new Map<string, ObservedCall>();
	let stopped = false;
	let failureReported = false;
	let writer: PolicyWriter | null = null;
	let mode: PolicyMode = "observe";
	let promotionMode: PromotionMode = "agent";
	let modeResolved = false;
	let modeSource = "PI_POLICY_MODE is unset; observe is the default";
	let promotionModeSource = "PI_POLICY_PROMOTION_MODE is unset; agent is the default";

	/** Rule ids already annotated, per session, so history survives a session round-trip. */
	const annotatedBySession = new Map<string, Set<string>>();

	/**
	 * One guidance line for the rule ids a call matched: the prefix plus the
	 * rules' notes in match order, deduplicated and byte-capped. The same text
	 * serves the annotation and the enforcement block reason, so the model sees
	 * one consistent instruction from both mechanisms.
	 */
	const guidanceFor = (tool: string, classes: readonly string[], model: string | null): string => {
		let text = POLICY_PREFIX;
		const included = new Set<string>();
		for (const id of classes) {
			const [note] = notesFor(tool, [id], model);
			if (note === undefined || included.has(note)) continue;
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
		}
		if (text === POLICY_PREFIX) {
			throw new Error("policy rules matched but no guidance exists for the matched classes");
		}
		return text;
	};

	/** Bind mutable context facts to the call that observed them. */
	const sessionFacts = (ctx: ExtensionContext): SessionFacts => {
		const model = ctx.model;
		return {
			session: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: ctx.thinkingLevel ?? null,
			projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
		};
	};

	/**
	 * Stop recording and report once. This runs inside the handler's own catch,
	 * so it must not throw: a thrown value can carry a failing `message` getter
	 * or primitive conversion, and a throw out of a `tool_call` handler makes Pi
	 * replace the call with an error result instead of running the tool.
	 */
	const stop = (error: unknown): void => {
		stopped = true;
		pending.clear();
		if (failureReported) return;
		failureReported = true;
		let reason = "reason unavailable";
		try {
			reason = error instanceof Error ? error.message : String(error);
		} catch {
			// A thrown value that cannot describe itself still stops recording.
		}
		try {
			console.warn(`[policy] recording stopped for this session: ${reason}`);
		} catch {
			// A failing console leaves no channel to report through.
		}
	};

	const ensureMode = (): boolean => {
		if (modeResolved || stopped) return !stopped;
		modeResolved = true;
		try {
			const flagValue = pi.getFlag(POLICY_MODE_FLAG);
			if (flagValue !== undefined) {
				const setting = typeof flagValue === "string" ? flagValue : String(flagValue);
				mode = resolvePolicyModeValue(setting, `--${POLICY_MODE_FLAG}`);
				modeSource = `--${POLICY_MODE_FLAG}=${setting.trim()}`;
			} else {
				mode = resolvePolicyMode(process.env);
				const setting = process.env.PI_POLICY_MODE?.trim() ?? "";
				modeSource = setting ? `PI_POLICY_MODE=${setting}` : "PI_POLICY_MODE is unset; observe is the default";
			}
			const promotionFlagValue = pi.getFlag(PROMOTION_MODE_FLAG);
			if (promotionFlagValue !== undefined) {
				const setting = typeof promotionFlagValue === "string" ? promotionFlagValue : String(promotionFlagValue);
				promotionMode = resolvePromotionModeValue(setting, `--${PROMOTION_MODE_FLAG}`);
				promotionModeSource = `--${PROMOTION_MODE_FLAG}=${setting.trim()}`;
			} else {
				promotionMode = resolvePromotionMode(process.env);
				const setting = process.env.PI_POLICY_PROMOTION_MODE?.trim() ?? "";
				promotionModeSource = setting
					? `PI_POLICY_PROMOTION_MODE=${setting}`
					: "PI_POLICY_PROMOTION_MODE is unset; agent is the default";
			}
		} catch (error) {
			stop(error);
		}
		return !stopped;
	};

	const rulesDir = resolvePolicyDir(process.env, getAgentDir());
	const rules = AgentRules.load(rulesDir);
	bindAgentRules(rules);

	/** Measured evidence for one rule, or empty evidence when the scan omits it. */
	const evidenceFor = async (slug: string): Promise<WarrantEvidence> =>
		(await scanWarrantEvidence(rulesDir, [slug])).get(slug) ?? emptyEvidence();

	/**
	 * Apply the promotion criteria to every active rule from one bounded scan and
	 * report the outcome. The mechanism promotes without a decision in the loop;
	 * a rule that crosses the threshold mid-session promotes at the next start.
	 */
	const applyPromotionCriteria = async (ctx: ExtensionContext): Promise<void> => {
		const active = rules.list().filter((rule) => rule.state === "active");
		if (active.length === 0) return;
		const model = modelName(ctx);
		if (model === null) return;
		const session = ctx.sessionManager.getSessionId();
		const measured = await scanWarrantEvidence(
			rulesDir,
			active.map((rule) => rule.slug),
		);
		const promoted: string[] = [];
		const passedInOperatorMode: string[] = [];
		const near: string[] = [];
		for (const rule of active) {
			const evidence = measured.get(rule.slug) ?? emptyEvidence();
			const verdict = evaluateWarrant(evidence);
			if (!verdict.pass) {
				// At the threshold: the harmful majority holds and only volume is missing.
				if (evidence.fires > 0 && evidence.harmful > evidence.fires - evidence.harmful && !evidence.partial) {
					near.push(
						`${agentClass(rule.slug)} (${evidence.fires} of ${MIN_WARRANT_FIRES} calls, ${evidence.harmful} harmful)`,
					);
				}
				continue;
			}
			if (promotionMode === "operator") {
				passedInOperatorMode.push(`${agentClass(rule.slug)} (${describeEvidence(evidence)})`);
				continue;
			}
			const warrant: PromotionWarrant = { criteria: PROMOTION_CRITERIA_VERSION, ...evidence, pass: true };
			const failure = await rules.setState(
				rule.slug,
				"promoted",
				model,
				session,
				new Date().toISOString(),
				"mechanism",
				warrant,
			);
			if (failure) {
				near.push(`${agentClass(rule.slug)} (promotion refused: ${failure})`);
				continue;
			}
			promoted.push(`${agentClass(rule.slug)} (${describeEvidence(evidence)})`);
		}
		const report: string[] = [];
		if (promoted.length > 0) report.push(`Promoted on recorded evidence: ${promoted.join("; ")}.`);
		if (passedInOperatorMode.length > 0) {
			report.push(
				`Evidence passes for: ${passedInOperatorMode.join("; ")}. Promotion mode operator holds them; promote with /policy state <slug> promoted.`,
			);
		}
		if (near.length > 0) report.push(`At the threshold: ${near.join("; ")}.`);
		if (report.length === 0) return;
		pi.sendMessage(
			{
				customType: "policy-promotion",
				content: [`${POLICY_PREFIX} promotion criteria v${PROMOTION_CRITERIA_VERSION}`, ...report].join("\n"),
				display: true,
				details: { promoted, passedInOperatorMode, near, criteria: PROMOTION_CRITERIA_VERSION },
			},
			{ deliverAs: "nextTurn" },
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ensureMode()) return;
		try {
			await applyPromotionCriteria(ctx);
		} catch (error) {
			stop(error);
		}
	});

	const commandText = (ctx: ExtensionCommandContext, text: string): void => {
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
			return;
		}
		if (ctx.mode === "json") {
			pi.appendEntry("policy_command", { text });
			return;
		}
		process.stdout.write(`${text}\n`);
	};

	const commandFailure = (ctx: ExtensionCommandContext, message: string): void => {
		const safe = terminalSafe(message);
		if (ctx.hasUI) {
			ctx.ui.notify(safe, "error");
			return;
		}
		throw new Error(safe);
	};

	const confirmationFor = (
		current: AgentRule,
		requested: AgentState,
	): { title: string; message: string } | undefined => {
		if (requested === "discarded") {
			return {
				title: `Discard policy rule ${current.slug}?`,
				message: `Rule "${current.slug}" would change from ${current.state} to discarded and cannot be restored.\n\nNote: ${current.note}`,
			};
		}
		if (!needsOperatorConfirm(current.state, requested)) return undefined;
		return {
			title:
				requested === "active"
					? `Demote promoted policy rule ${current.slug}?`
					: `Lower promoted policy rule ${current.slug}?`,
			message: `Rule "${current.slug}" would change from ${current.state} to ${requested}.\n\nNote: ${current.note}`,
		};
	};

	const changeAgentState = async (
		slug: string,
		requested: AgentState,
		ctx: ExtensionCommandContext,
	): Promise<{ text: string; failed: boolean }> => {
		const current = rules.get(slug);
		if (!current) return { text: `unknown agent rule "${slug}"`, failed: true };
		if (current.state === requested) {
			return { text: `Policy class ${agentClass(current.slug)} is already ${requested}.`, failed: false };
		}
		const confirmation = confirmationFor(current, requested);
		if (confirmation) {
			if (!ctx.hasUI) {
				return {
					text: `cannot change rule "${current.slug}" from ${current.state} to ${requested} without operator confirmation`,
					failed: true,
				};
			}
			if (!(await ctx.ui.confirm(confirmation.title, confirmation.message))) {
				return { text: "state change declined by the operator", failed: false };
			}
		}
		const author = modelName(ctx);
		if (author === null) return { text: "cannot attribute a rule state change without a model", failed: true };
		let warrant: PromotionWarrant | undefined;
		if (requested === "promoted") {
			const evidence = await evidenceFor(current.slug);
			const verdict = evaluateWarrant(evidence);
			warrant = { criteria: PROMOTION_CRITERIA_VERSION, ...evidence, pass: verdict.pass };
		}
		const failure = await rules.setState(
			current.slug,
			requested,
			author,
			ctx.sessionManager.getSessionId(),
			new Date().toISOString(),
			"command",
			warrant,
		);
		return failure
			? { text: failure, failed: true }
			: { text: `Set policy class ${agentClass(current.slug)} to ${requested}.`, failed: false };
	};

	const loadRuleData = async (): Promise<Pick<PolicyPanelData, "agentRules" | "builtins" | "fireSummary">> => {
		const counts = await countFires(rulesDir);
		return {
			agentRules: rules.list(),
			builtins: BUILTIN_RULE_INFOS,
			fireSummary: {
				fires: counts.allFires,
				firesByModel: counts.firesByModel,
				partial: counts.partial,
			},
		};
	};

	const loadPanelData = async (): Promise<PolicyPanelData> => {
		const [ruleData, activity] = await Promise.all([loadRuleData(), readRecentActivity(rulesDir)]);
		return { ...ruleData, activity };
	};

	const agentSlugCandidates = (verb: "show" | "history"): AutocompleteItem[] =>
		rules.list().map((rule) => ({
			value: `${verb} ${rule.slug}`,
			label: rule.slug,
			description: `${rule.state} · ${terminalSafe(rule.note)}`,
		}));

	const argumentCompletions = (text: string): AutocompleteItem[] | null => {
		if (!text.includes(" ")) {
			const matches = POLICY_VERBS.filter((verb) => verb.value.startsWith(text));
			return matches.length > 0 ? matches : null;
		}
		const firstSpace = text.indexOf(" ");
		const verb = text.slice(0, firstSpace);
		const tail = text.slice(firstSpace + 1);
		if ((verb === "show" || verb === "history") && !tail.includes(" ")) {
			const candidates: AutocompleteItem[] = [
				...agentSlugCandidates(verb),
				...(verb === "show"
					? BUILTIN_RULE_INFOS.map((rule) => ({
							value: `show ${rule.id}`,
							label: rule.id,
							description: terminalSafe(rule.note),
						}))
					: []),
			];
			const matches = candidates.filter((item) => item.label?.startsWith(tail));
			return matches.length > 0 ? matches : null;
		}
		if (verb === "capture" || verb === "criteria") return null;
		if (verb !== "state") return null;
		const stateMatch = tail.match(/^(\S*)(?:\s+(\S*))?$/);
		if (!stateMatch) return null;
		const slug = stateMatch[1];
		const statePrefix = stateMatch[2];
		if (statePrefix === undefined) {
			const matches = rules
				.list()
				.filter((rule) => rule.slug.startsWith(slug))
				.map((rule) => ({
					value: `state ${rule.slug}`,
					label: rule.slug,
					description: `${rule.state} · ${terminalSafe(rule.note)}`,
				}));
			return matches.length > 0 ? matches : null;
		}
		if (!rules.get(slug)) return null;
		const matches = POLICY_STATES.filter((state) => state.startsWith(statePrefix)).map((state) => ({
			value: `state ${slug} ${state}`,
			label: state,
			description: `Set ${slug} to ${state}`,
		}));
		return matches.length > 0 ? matches : null;
	};

	const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
		let data: PolicyPanelData;
		try {
			data = await loadPanelData();
		} catch (error) {
			commandFailure(ctx, `Could not load policy data: ${toolFailure(error)}`);
			return;
		}
		let view: PolicyView = "rules";
		let filter = "";
		let expandedGroups: BuiltinGroup[] = [];
		let selectedRuleKey: string | undefined;
		let selectedActivityKey: string | undefined;
		for (;;) {
			data = { ...data, agentRules: rules.list() };
			let result: PolicyPanelResult | undefined;
			try {
				result = await ctx.ui.custom<PolicyPanelResult>(
					(tui, theme, _keybindings, done) =>
						new PolicyPanel({
							data,
							theme,
							tui,
							getMaxRows: () => Math.max(1, tui.terminal.rows - 6),
							initialView: view,
							initialFilter: filter,
							initialExpandedGroups: expandedGroups,
							initialSelectedRuleKey: selectedRuleKey,
							initialSelectedActivityKey: selectedActivityKey,
							copyRule: async (rule) => copyToClipboard(JSON.stringify(rule, null, 2)),
							done,
						}),
					{
						overlay: true,
						overlayOptions: { width: "94%", minWidth: 112, maxHeight: "92%", anchor: "center", margin: 1 },
					},
				);
			} catch (error) {
				commandFailure(ctx, `Policy panel failed: ${toolFailure(error)}`);
				return;
			}
			if (!result) return;
			view = result.view;
			filter = result.filter;
			expandedGroups = result.expandedGroups;
			selectedRuleKey = result.selectedRuleKey;
			selectedActivityKey = result.selectedActivityKey;
			if (!result.action) return;
			if (result.action.kind === "state") {
				try {
					const changed = await changeAgentState(result.action.slug, result.action.state, ctx);
					ctx.ui.notify(changed.text, changed.failed ? "error" : "info");
				} catch (error) {
					commandFailure(ctx, `Policy state change failed: ${toolFailure(error)}`);
				}
				continue;
			}
			const message = draftRuleMessage(result.action.record);
			try {
				if (ctx.isIdle()) pi.sendUserMessage(message);
				else {
					pi.sendUserMessage(message, { deliverAs: "followUp" });
					ctx.ui.notify("Queued the policy-rule draft request after the current turn.", "info");
				}
			} catch (error) {
				commandFailure(ctx, `Could not send the policy-rule draft request: ${toolFailure(error)}`);
			}
			return;
		}
	};

	const recordWriter = (): PolicyWriter => {
		writer ??= new PolicyWriter(resolvePolicyDir(process.env, getAgentDir()), stop);
		return writer;
	};

	const takeCall = (callId: string): ObservedCall | undefined => {
		const call = pending.get(callId);
		if (call) pending.delete(callId);
		return call;
	};

	const writeRecord = (
		call: ObservedCall,
		content: ContentLike[] | undefined,
		isError: boolean | undefined,
		details: unknown,
		usage: unknown,
		effects: CallEffects,
	): boolean => {
		const result: ResultFacts = {
			content,
			isError,
			truncated: readTruncated(details),
			tokens: readTokens(usage),
		};
		return recordWriter().enqueue(finishCall(call, result, call.sessionFacts, mode, effects), call.blocked === true);
	};

	/** Rule ids already annotated in one session, created on first use. */
	const annotatedIdsFor = (session: string): Set<string> => {
		let ids = annotatedBySession.get(session);
		if (ids) return ids;
		if (annotatedBySession.size >= MAX_ANNOTATED_SESSIONS) {
			const oldest = annotatedBySession.keys().next();
			if (!oldest.done) annotatedBySession.delete(oldest.value);
		}
		ids = new Set();
		annotatedBySession.set(session, ids);
		return ids;
	};

	/**
	 * Build guidance for the rule ids this session has not annotated yet.
	 *
	 * One rule id reaches the model once per session, so a repeated command
	 * class costs nothing after its first flag. Rules that share wording
	 * contribute one line. The byte cap stops the text, and any id left outside
	 * the cap stays unmarked for a later call.
	 */
	const annotationFor = (
		tool: string,
		classes: string[],
		session: string,
		model: string | null,
	): Annotation | undefined => {
		const annotated = annotatedIdsFor(session);
		let text = POLICY_PREFIX;
		const ids: string[] = [];
		const included = new Set<string>();
		for (const id of classes) {
			if (annotated.has(id)) continue;
			const [note] = notesFor(tool, [id], model);
			if (note === undefined) continue;
			if (included.has(note)) {
				ids.push(id);
				continue;
			}
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
			ids.push(id);
		}
		if (included.size === 0) return undefined;
		return { text, ids };
	};

	pi.registerTool({
		name: "policy_rule_add",
		label: "Add Policy Rule",
		description: "Add an active agent-authored shell policy rule with an optional checked suggested form.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				slug: Type.String(),
				note: Type.String(),
				match: MatchSchema,
				suggest: Type.Optional(SuggestionSchema),
				scope: Type.Optional(ScopeSchema),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const validation =
					validateSlug(params.slug) ??
					validateNote(params.note) ??
					validateMatch(params.match) ??
					validateSuggestion(params.suggest) ??
					validateScope(params.scope);
				if (validation) return toolText(validation);
				const model = modelName(ctx);
				if (model === null) return toolText("cannot attribute a rule without a model");
				const rule: Omit<AgentRule, "version"> = {
					slug: params.slug,
					note: params.note,
					match: params.match as AgentMatch,
					state: "active",
					model,
					session: ctx.sessionManager.getSessionId(),
					at: new Date().toISOString(),
				};
				if (params.suggest !== undefined) rule.suggest = params.suggest as AgentSuggestion;
				if (params.scope !== undefined) rule.scope = params.scope as AgentScope;
				const failure = await rules.add(rule);
				return toolText(failure ?? `Added policy class ${agentClass(rule.slug)} in active state.`);
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.registerTool({
		name: "policy_rule_list",
		label: "List Policy Rules",
		description:
			"List non-discarded agent-authored policy rules and their match, suggested form, scope, posture, and attribution.",
		executionMode: "sequential",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			try {
				const counts = await countFires(rulesDir);
				return toolText(rulesText(rules.list(), counts.fires, counts.partial));
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.registerTool({
		name: "policy_rule_set_state",
		label: "Set Policy Rule State",
		description:
			"Set an agent-authored policy rule to active, disabled, or discarded. Promotion follows recorded evidence, and lowering a promoted rule is operator-only.",
		executionMode: "sequential",
		parameters: Type.Object(
			{
				slug: Type.String(),
				state: ToolStateSchema,
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				ensureMode();
				const current = rules.get(params.slug);
				if (!current) return toolText(`unknown agent rule "${params.slug}"`);
				const requested = params.state as AgentState;
				if (requested === "promoted") {
					return toolText(
						`promotion of policy rule "${current.slug}" is not a tool action: the mechanism promotes a rule whose recorded evidence passes criteria v${PROMOTION_CRITERIA_VERSION}. Run /policy criteria for the criteria source.`,
					);
				}
				if (needsOperatorConfirm(current.state, requested)) {
					return toolText(
						`lowering promoted policy rule "${current.slug}" is operator-only; the operator runs /policy state ${current.slug} ${requested}`,
					);
				}
				const model = modelName(ctx);
				if (model === null) return toolText("cannot attribute a rule state change without a model");
				const failure = await rules.setState(
					current.slug,
					requested,
					model,
					ctx.sessionManager.getSessionId(),
					new Date().toISOString(),
					"tool",
				);
				return toolText(failure ?? `Set policy class ${agentClass(current.slug)} to ${requested}.`);
			} catch (error) {
				return toolText(toolFailure(error));
			}
		},
	});

	pi.registerCommand("policy", {
		description: "Browse policy rules and activity, capture requests, inspect evidence, or change state",
		getArgumentCompletions: argumentCompletions,
		handler: async (args, ctx) => {
			ensureMode();
			const raw = args.trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const verb = parts[0];

			if (!verb) {
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					commandFailure(
						ctx,
						"The interactive policy panel requires TUI mode. Use /policy list, /policy show <slug-or-id>, /policy history <slug>, /policy state <slug> <state>, /policy capture <hint...>, /policy criteria, /policy mode, or /policy help.",
					);
					return;
				}
				await openPanel(ctx);
				return;
			}

			if (verb === "help") {
				if (parts.length !== 1) {
					commandFailure(ctx, "Usage: /policy help");
					return;
				}
				commandText(ctx, POLICY_USAGE);
				return;
			}

			if (verb === "mode") {
				if (parts.length !== 1) {
					commandFailure(ctx, "Usage: /policy mode");
					return;
				}
				commandText(
					ctx,
					[
						`active mode: ${mode}`,
						`source: ${terminalSafe(modeSource)}`,
						`promotion mode: ${promotionMode}`,
						`promotion source: ${terminalSafe(promotionModeSource)}`,
						`effect: ${MODE_EFFECT[mode]}`,
						"A session keeps its original mode after --policy-mode or PI_POLICY_MODE changes.",
					].join("\n"),
				);
				return;
			}

			if (verb === "criteria") {
				if (parts.length !== 1) {
					commandFailure(ctx, "Usage: /policy criteria");
					return;
				}
				commandText(ctx, formatPromotionCriteria());
				return;
			}

			if (verb === "list") {
				if (parts.length !== 1) {
					commandFailure(ctx, "Usage: /policy list");
					return;
				}
				commandText(ctx, formatPolicyList(await loadRuleData()));
				return;
			}

			if (verb === "show") {
				if (parts.length !== 2) {
					commandFailure(ctx, "Usage: /policy show <slug-or-id>");
					return;
				}
				let data = await loadRuleData();
				const requested = parts[1];
				const slug = requested.startsWith("agent.") ? requested.slice("agent.".length) : requested;
				const direct = rules.get(slug);
				if (direct && !data.agentRules.some((rule) => rule.slug === direct.slug)) {
					data = { ...data, agentRules: [...data.agentRules, direct] };
				}
				const shown = formatPolicyShow(data, requested);
				if (shown === undefined) {
					commandFailure(ctx, `unknown policy rule "${requested}"`);
					return;
				}
				commandText(ctx, shown);
				return;
			}

			if (verb === "history") {
				if (parts.length !== 2) {
					commandFailure(ctx, "Usage: /policy history <slug>");
					return;
				}
				const requested = parts[1];
				const slug = requested.startsWith("agent.") ? requested.slice("agent.".length) : requested;
				const lines = readStateLines(rulesDir).filter((line) => line.slug === slug);
				if (lines.length === 0) {
					commandFailure(ctx, `no state transitions recorded for ${slug}`);
					return;
				}
				commandText(ctx, formatPolicyHistory(lines));
				return;
			}

			if (verb === "capture") {
				const hint = parts.slice(1).join(" ");
				if (parts.length < 2 || hint.length === 0) {
					commandFailure(ctx, "Usage: /policy capture <hint...>");
					return;
				}
				if (/[\r\n]/.test(args)) {
					commandFailure(ctx, "capture hint must not contain a newline");
					return;
				}
				if (Buffer.byteLength(hint, "utf8") > MAX_NOTE_BYTES) {
					commandFailure(ctx, `capture hint exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
					return;
				}
				const session = ctx.sessionManager.getSessionId();
				const at = new Date().toISOString();
				const failure = await appendLine(rulesDir, JSON.stringify({ kind: "capture", hint, session, at }));
				if (failure) {
					commandFailure(ctx, failure);
					return;
				}
				commandText(ctx, `captured: ${terminalSafe(hint)}\nsession: ${terminalSafe(session)} · timestamp: ${at}`);
				if (ctx.hasUI) {
					pi.sendMessage(
						{
							customType: "policy-capture",
							content: [
								"A policy capture was recorded.",
								`Session: ${session}`,
								`Timestamp: ${at}`,
								`Hint: ${hint}`,
								"The current agent must now orchestrate rule authoring: package a bounded, redacted excerpt of the session context at the invocation point, dispatch authoring to a separate clean-context worker using the authoring contract in the Capture section of the policy README, apply the returned rule with policy_rule_add, and report the applied rule.",
								"The authoring agent is never the current session agent. Promotion follows the warrant mechanism.",
							].join("\n"),
							display: true,
							details: { hint, session, at },
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
				}
				return;
			}

			if (verb === "state") {
				if (parts.length !== 3 || !POLICY_STATES.includes(parts[2] as AgentState)) {
					commandFailure(ctx, "Usage: /policy state <slug> <active|promoted|disabled|discarded>");
					return;
				}
				let changed: Awaited<ReturnType<typeof changeAgentState>>;
				try {
					changed = await changeAgentState(parts[1], parts[2] as AgentState, ctx);
				} catch (error) {
					commandFailure(ctx, `Policy state change failed: ${toolFailure(error)}`);
					return;
				}
				if (changed.failed) commandFailure(ctx, changed.text);
				else commandText(ctx, changed.text);
				return;
			}

			commandFailure(ctx, `Unknown /policy action "${terminalSafe(verb)}". Use /policy help.`);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ensureMode()) return;
		try {
			const facts = sessionFacts(ctx);
			const call: ObservedCall = {
				...startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
				sessionFacts: facts,
			};
			trackPending(pending, call);
			const blocking = call.classes.filter((id) => !isAgentClass(id) || rules.isBlocking(id, facts.model));
			if (mode === "enforce" && blocking.length > 0) {
				const reason = guidanceFor(call.tool, blocking, facts.model);
				// A block is never returned without capacity for its record.
				if (!recordWriter().tryReserve()) {
					stop(new Error("policy writer cannot admit a block record"));
					return;
				}
				call.blocked = true;
				call.blockReason = reason;
				return { block: true, reason };
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const effects: CallEffects = {};
			let annotation: Annotation | undefined;
			if (call.classes.length > 0) {
				if (mode === "notice" && ctx.mode === "tui") effects.notified = true;
				if ((mode === "annotate" || mode === "enforce") && call.blocked !== true && event.isError !== true) {
					annotation = annotationFor(call.tool, call.classes, call.sessionFacts.session, call.sessionFacts.model);
					if (annotation) effects.annotationBytes = Buffer.byteLength(annotation.text, "utf8");
				}
			}
			// Admission gates the visible effects: no notice or annotation without its record.
			if (
				!writeRecord(
					call,
					event.content as ContentLike[] | undefined,
					event.isError,
					(event as { details?: unknown }).details,
					event.usage,
					effects,
				)
			)
				return;
			if (effects.notified === true) {
				ctx.ui.notify(`${POLICY_PREFIX} ${call.classes.join(", ")}`, "warning");
			}
			if (annotation) {
				const annotated = annotatedIdsFor(call.sessionFacts.session);
				for (const id of annotation.ids) annotated.add(id);
				return {
					content: [...(event.content ?? []), { type: "text", text: annotation.text }],
				};
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const outcome =
				event.result && typeof event.result === "object"
					? (event.result as { content?: ContentLike[]; details?: unknown; usage?: unknown })
					: {};
			// A block is recorded only when Pi applied it: the finalized result
			// text is the exact reason. An abort that pre-empted the block leaves
			// the call recorded as an error without the blocked flag.
			const outcomeText = (outcome.content ?? []).map((part) => part.text ?? "").join("");
			writeRecord(call, outcome.content, event.isError, outcome.details, outcome.usage, {
				blocked: call.blocked === true && call.blockReason !== undefined && outcomeText === call.blockReason,
			});
		} catch (error) {
			stop(error);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			stopped = true;
			pending.clear();
			await writer?.close();
		} catch (error) {
			stop(error);
		}
	});
}
