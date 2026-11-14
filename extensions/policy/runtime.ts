/** One event interpreter for approved plans, corrections, observations, and guidance. */
import { randomUUID } from "node:crypto";
import { ActionApprovals, actionAuthority, type ActionBinding, type ActionControl, sameActionInput, sealActionInput } from "./action-approval.ts";
import type {
	ContextWithSystemEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { captureFor, ruleScopeMatches as scopeMatches } from "./classify.ts";
import { isOwnedInput, ownInput, prepareSchema, snapshotData, UNKNOWN } from "./data.ts";
import {
	GUIDANCE_ENTRY,
	GUIDANCE_HISTORY_LIMITS,
	GUIDANCE_RETIREMENT_ENTRY,
	guidanceHistory,
	type GuidanceEpochs,
	type GuidanceHistory,
	type GuidancePlan,
	type GuidanceRecord,
	type GuidanceSource,
	type GuidanceStatus,
	guidanceText,
	parseGuidanceRecord,
	parseGuidanceRetirement,
	prepareGuidanceSelection,
	planGuidance,
} from "./guidance-history.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import { type PreparedPolicy, attachedPreparedPolicy, preparedPolicyFor } from "./prepared.ts";
import type { PolicyMode } from "./mode.ts";
import { createObservationClock, type ObservationClock } from "./observation-clock.ts";
import { readRecentActivity, terminalSafe } from "./panel.ts";
import {
	type Condition,
	captureProgramEvidence,
	createEvaluationFrame,
	type EvaluationContext,
	evaluatePrograms,
	GUIDANCE_BYTES,
	GUIDANCE_PREFIX,
	type InputPlan,
	observationSelected,
	type ProgramEvaluation,
	type ProgramRule,
	planInput,
	programSteps,
} from "./program.ts";
import {
	type CallEffects,
	type CallOutcome,
	type ContentLike,
	finishCall,
	type PendingCall,
	type SessionFacts,
	startCall,
	textContentBytes,
	trackPending,
} from "./record.ts";
import { contentRevision, type RuleRecord, effectiveEffect, effectiveState, ruleGuidance } from "./rule.ts";
import { shellContractCard } from "./shell-card.ts";
import { ObservationState, type StatePin } from "./state.ts";
import { PolicyWriter, TelemetryNotices } from "./store.ts";
import { DEFAULT_TELEMETRY_RETENTION, type TelemetryHealth, type TelemetryRetention } from "./telemetry-files.ts";

const MAX_CATALOG_TOOLS = 1024;
const MAX_FINAL_IDS = 8192;
const PROJECT_CONTEXT_MARKER = "<project_context>";

type Result = { content?: ContentLike[]; isError?: boolean; details?: unknown; usage?: unknown };
type Catalog = ReturnType<ExtensionAPI["getAllTools"]>;
interface ObservedCall extends PendingCall {
	sessionFacts: SessionFacts;
	requested?: Record<string, unknown>;
	input?: Record<string, unknown>;
	rules: ProgramRule[];
	pins: Map<string, StatePin>;
	context: EvaluationContext;
	matches: Set<string>;
	evaluations: ProgramEvaluation[];
	corrections: Array<{ id: string; stage: string; path: string[] }>;
	effects: CallEffects;
	generation: number;
	turn: number;
	prepared: boolean;
	executionStarted: boolean;
	resultSeen: boolean;
	abortRequested?: boolean;
	outputBytes?: number;
	preGuidanceBytes?: number;
	decision?: string;
	complete: boolean;
}

function sessionScope(ctx: ExtensionContext) {
	return {
		provider: ctx.model?.provider,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		cwd: ctx.cwd,
	};
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function inputSnapshot(value: unknown): Record<string, unknown> | undefined {
	const source = object(value);
	if (!source) return undefined;
	try {
		return ownInput({ ...source });
	} catch {
		return undefined;
	}
}
export function samePin(left: StatePin | undefined, right: StatePin | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.revision === right.revision &&
		left.generation === right.generation
	);
}
export function metadata(evaluations: ProgramEvaluation[]): unknown[] {
	return evaluations.map(
		({ id, revision, phase, inputView, applicable, truth, action, unavailable, unavailableReasons, deny }) => ({
			id,
			revision,
			phase,
			applicable,
			...(inputView ? { inputView } : {}),
			truth,
			action: action.kind,
			unavailable,
			...(unavailableReasons ? { unavailableReasons } : {}),
			deny,
		}),
	);
}
/** Inspection omits false evaluations without changing execution. */
export function relevantEvaluations<T extends { id: string; truth: unknown; unavailable?: boolean; deny?: boolean }>(
	evaluations: readonly T[],
): T[] {
	return evaluations.filter((entry) => entry.truth !== false || entry.unavailable || entry.deny);
}

export function boundedRows(
	rows: readonly unknown[],
	maxBytes = 32768,
): { rows: unknown[]; total: number; omitted: number } {
	const retained: unknown[] = [];
	let bytes = 2;
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row), "utf8") + (retained.length > 0 ? 1 : 0);
		if (bytes + size > maxBytes) break;
		retained.push(row);
		bytes += size;
	}
	return { rows: retained, total: rows.length, omitted: rows.length - retained.length };
}

/** Retain decision facts, not the non-matching rule inventory, in both hosts. */
export function telemetryDecisionRows(
	evaluations: readonly unknown[],
	pins: readonly StatePin[],
	classes: readonly string[],
	corrections: readonly { id: string }[],
) {
	const ids = new Set([...classes, ...corrections.map((entry) => entry.id)]);
	const relevant = evaluations.filter((value) => {
		const entry = value as { id: string; truth: unknown; unavailable?: boolean; deny?: boolean };
		return ids.has(entry.id) || entry.truth !== false || entry.unavailable || entry.deny;
	});
	const retained = boundedRows(relevant);
	for (const value of retained.rows) ids.add((value as { id: string }).id);
	return {
		evaluations: {
			...retained,
			total: evaluations.length,
			irrelevant: evaluations.length - relevant.length,
		},
		generations: {
			...boundedRows(pins.filter((pin) => ids.has(pin.id))),
			total: pins.length,
			irrelevant: pins.filter((pin) => !ids.has(pin.id)).length,
		},
	};
}

interface RowBundle {
	rows: unknown[];
	total: number;
	omitted: number;
}

/** Convert one missing-input evaluation into its unavailable form, honoring deny decisions. */
export function markUnavailable(rules: ProgramRule[]): (evaluation: ProgramEvaluation) => ProgramEvaluation {
	return (evaluation) => {
		if (evaluation.applicable !== true || evaluation.truth === false || evaluation.action.kind === "deny")
			return evaluation;
		const rule = rules.find((candidate) => candidate.id === evaluation.id);
		return {
			...evaluation,
			truth: "unknown" as const,
			unavailable: true,
			deny: rule?.program.onUnavailable === "deny",
		};
	};
}
export function publicState(views: ReturnType<ObservationState["snapshot"]>): unknown[] {
	return views.map((view) =>
		Object.fromEntries(Object.entries(view).map(([key, value]) => [key, value === UNKNOWN ? "unavailable" : value])),
	);
}
/** Pi supplies mutable plain argument objects. Refuse exotic descriptors before a single synchronous commit. */
function commitInput(target: Record<string, unknown>, candidate: Record<string, unknown>): boolean {
	const proto = Object.getPrototypeOf(target);
	if ((proto !== Object.prototype && proto !== null) || !Object.isExtensible(target)) return false;
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(target))) {
		if (!("value" in descriptor) || !descriptor.writable || !descriptor.configurable) return false;
	}
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, candidate);
	return true;
}

function refusalEvidence(entry: ProgramEvaluation, corrected: boolean): string | undefined {
	if (entry.truth === "unknown") {
		const reasons = entry.unavailableReasons?.join(", ") || "evidence-unavailable";
		if (entry.unavailableReasons !== undefined)
			return `Policy could not determine whether this command matches the rule. Evidence unavailable: ${reasons}. The rule denies unavailable evidence. No matching command was established. Use plain literal commands joined with && or ; when that preserves the task.`;
		return `Policy could not determine whether this call matches the rule. Evidence unavailable: ${reasons}. The rule denies unavailable evidence. No matching command was established.`;
	}
	if (entry.matchedSegment) return `Matched command: ${corrected ? "[corrected input omitted]" : entry.matchedSegment}`;
	return undefined;
}

function denialDiagnostic(id: string, record: RuleRecord | undefined, entries: ProgramEvaluation[], correctedInput: boolean) {
	const evidence = new Set<string>();
	const suggestions = new Set<string>();
	for (const entry of entries) {
		const corrected = entry.inputView === "effective" && correctedInput;
		const proof = refusalEvidence(entry, corrected);
		if (proof) evidence.add(proof);
		if (!corrected) for (const suggestion of entry.commandSuggestions ?? []) suggestions.add(suggestion);
	}
	const note = record ? ruleGuidance(record) : "The rule denies this call.";
	const parts = entries.some((entry) => entry.truth === "unknown")
		? [`Rule ${id}:`, ...evidence, `Rule note: ${note}`]
		: [`Rule ${id}: ${note}`, ...evidence];
	const text = guidanceText([parts.join(" ")]);
	return { text, suggestions, priorityParts: [`Rule ${id}:`, ...evidence, `Rule note: ${note}`] };
}

function firstDenialText(parts: readonly string[], reserve: string): string {
	const limit = GUIDANCE_BYTES - Buffer.byteLength(`${GUIDANCE_PREFIX} …${reserve}`, "utf8");
	let text = "";
	let bytes = 0;
	for (const char of parts.join(" ")) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > limit) break;
		text += char;
	}
	return guidanceText([`${text}…`]) ?? GUIDANCE_PREFIX;
}

function omittedDenials(count: number): string {
	return count > 0 ? `\n[policy] Omitted ${count} rule diagnostics.` : "";
}

function remainingRefusal(text: string, parts: readonly string[], remaining: number): string {
	if (text) return text + omittedDenials(remaining + 1);
	const reserve = omittedDenials(remaining);
	return firstDenialText(parts, reserve) + reserve;
}

function appendRefusalSuggestions(text: string, suggestions: ReadonlySet<string>, reserve: string): string {
	for (const suggestion of suggestions) {
		const extra = `\nFor this command: ${suggestion}`;
		if (Buffer.byteLength(text + extra + reserve, "utf8") > GUIDANCE_BYTES) break;
		text += extra;
	}
	return text;
}

/** Preserve stored guidance and append bounded evidence for both policy runtimes. */
export function refusalText(plan: InputPlan, records: ReadonlyMap<string, RuleRecord>, fallbackIds: readonly string[]): string | undefined {
	const denials = plan.evaluations.filter((evaluation) => evaluation.deny);
	const ids = [...new Set(denials.length ? denials.map((evaluation) => evaluation.id) : fallbackIds)];
	let text = "";
	for (const [index, id] of ids.entries()) {
		const remaining = ids.length - index - 1;
		const reserve = omittedDenials(remaining);
		const diagnostic = denialDiagnostic(id, records.get(id), denials.filter((entry) => entry.id === id), plan.corrections.length > 0);
		const candidate = diagnostic.text ? (text ? `${text}\n${diagnostic.text}` : diagnostic.text) : undefined;
		if (!candidate || Buffer.byteLength(candidate + reserve, "utf8") > GUIDANCE_BYTES)
			return remainingRefusal(text, diagnostic.priorityParts, remaining);
		text = appendRefusalSuggestions(candidate, diagnostic.suggestions, reserve);
	}
	return text || undefined;
}

export class PolicyRuntime {
	private readonly actions = new ActionApprovals();
	private readonly state: ObservationState;
	private readonly pending = new Map<string, ObservedCall>();
	private readonly ended = new Set<string>();
	private readonly retainedGuidance = new Map<string, { pin: StatePin; evaluation: ProgramEvaluation }>();
	private guidanceLedger: GuidanceHistory = { records: [], retainedBytes: 0 };
	private guidanceEpoch: string | undefined;
	private guidanceDirty = true;
	/** Failed retirement writes remain pending even if the source digest returns. */
	private guidanceRetirements: string[] = [];
	private guidanceStatus: GuidanceStatus = "ok";
	private guidanceNotice?: string;
	private snapshot?: RuleSnapshot;
	private policy?: PreparedPolicy;
	private ownedPolicy = false;
	private effectiveActions = new Map<string, ReturnType<typeof effectiveEffect>>();
	private generation = 0;
	private turn = 0;
	private closed = false;
	private shellCardSent = false;
	private incomplete = 0;
	private stale = 0;
	private readonly writer: Pick<PolicyWriter, "enqueue" | "health" | "close">;
	private readonly telemetryNotices = new TelemetryNotices();
	/** The latest event context; telemetry health changes arrive outside any handler. */
	private noticeContext: ExtensionContext | undefined;
	private readonly dir: string;
	private readonly pi: ExtensionAPI;
	private readonly load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>;
	private readonly mode: () => PolicyMode;
	private readonly enabled: () => boolean;
	private readonly now: () => number;
	private readonly createActionState: boolean;
	constructor(
		pi: ExtensionAPI,
		load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>,
		mode: () => PolicyMode,
		dir: string,
		enabled: () => boolean = () => true,
		writer?: Pick<PolicyWriter, "enqueue" | "health" | "close">,
		now: () => number = () => Date.now(),
		observationClock: ObservationClock = createObservationClock(),
		createActionState = true,
		retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	) {
		this.dir = dir;
		this.pi = pi;
		this.load = async (ctx) => {
			if (ctx) this.noticeContext = ctx;
			try { return await load(ctx); }
			catch (error) { this.actions.clear(); throw error; }
		};
		this.mode = mode;
		this.enabled = enabled;
		this.now = now;
		this.state = new ObservationState(observationClock);
		this.createActionState = createActionState;
		this.writer = writer ?? new PolicyWriter(dir, (health) => this.recordingChanged(health), undefined, retention);
	}
	/**
	 * A TUI owns the terminal, so a direct stderr write would paint over the editor at the
	 * hardware cursor. Health notices go through the session UI; a session without UI has no
	 * terminal renderer to damage and receives them on stderr.
	 */
	private recordingChanged(health: TelemetryHealth): void {
		try {
			const notice = this.telemetryNotices.next(health);
			const ctx = this.noticeContext;
			if (!notice || !ctx) return;
			const text = terminalSafe(notice.text);
			if (ctx.hasUI) ctx.ui.notify(text, notice.level);
			else process.stderr.write(`${text}\n`);
		} catch {
			/* Reporting has no policy authority. */
		}
	}
	sync(snapshot: RuleSnapshot): void {
		const policy = preparedPolicyFor(snapshot);
		const prior = this.effectiveActions;
		this.effectiveActions = new Map(
			[...policy.records].map(([id, record]) => [id, effectiveEffect(record)]),
		);
		this.policy = policy;
		this.ownedPolicy = attachedPreparedPolicy(snapshot) !== undefined;
		this.snapshot = snapshot;
		if (this.effectiveMode() !== "enforce") this.actions.clear();
		this.state.sync(policy.rules, this.now());
		for (const record of policy.records.values()) {
			const previous = prior.get(record.id);
			if (previous !== undefined && previous !== effectiveEffect(record))
				this.state.reset("effective-action-change", this.now(), record.id);
		}
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") this.retainedGuidance.clear();
		for (const [id, notice] of this.retainedGuidance)
			if (!samePin(notice.pin, this.state.pin(id))) this.retainedGuidance.delete(id);
	}
	private prepared(): PreparedPolicy {
		if (this.ownedPolicy && this.policy) return this.policy;
		if (!this.snapshot) throw new Error("Policy evaluation requires a loaded rule snapshot");
		return preparedPolicyFor(this.snapshot);
	}
	private readonly resetIdentity = randomUUID();
	resetRevision(id: string): string {
		const periods = this.state
			.snapshot(this.now(), this.turn)
			.filter((period) => id === "--all" || period.id === id)
			.map(({ id, revision, generation }) => ({ id, revision, generation }))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (id !== "--all" && !periods.length) throw new Error(`No active rule named ${id}`);
		return contentRevision({ instance: this.resetIdentity, selector: id, generation: this.generation, periods });
	}
	private assertResetRevision(ids: string[] | undefined, expectedRevision: string | undefined): void {
		if (expectedRevision === undefined) return;
		if ((ids && ids.length !== 1) || this.resetRevision(ids?.[0] ?? "--all") !== expectedRevision)
			throw new Error("Observation period revision changed; inspect the current reset target");
	}
	reset(ids: string[] | undefined, reason: string, expectedRevision?: string): void {
		this.assertResetRevision(ids, expectedRevision);
		if (!reason.trim() || reason.length > 1000) throw new Error("A bounded reset reason is required");
		if (ids)
			for (const id of ids) {
				if (!this.state.pin(id)) throw new Error(`No active rule named ${id}`);
			}
		if (ids)
			for (const id of ids) {
				this.state.reset(reason, this.now(), id);
				this.retainedGuidance.delete(id);
			}
		else {
			this.retainedGuidance.clear();
			this.generation++;
			for (const call of this.pending.values()) call.complete = false;
			this.state.reset(reason, this.now());
		}
	}
	private live(generation: number): boolean {
		return !this.closed && generation === this.generation;
	}
	private resetSession(reason: string): void {
		this.actions.clear();
		this.retainedGuidance.clear();
		this.generation++;
		this.turn = 0;
		this.guidanceLedger = { records: [], retainedBytes: 0 };
		this.guidanceEpoch = undefined;
		this.guidanceDirty = true;
		this.guidanceRetirements = [];
		this.guidanceStatus = "ok";
		this.guidanceNotice = undefined;
		this.state.reset(reason, this.now());
		for (const call of this.pending.values()) call.complete = false;
		this.ended.clear();
	}
	private actionBinding(ctx: ExtensionContext, snapshot: RuleSnapshot): ActionBinding {
		const catalog = this.catalog();
		if (!catalog.available) { this.actions.clear(); throw new Error("Exact-action tool schemas are unavailable"); }
		const scope = sessionScope(ctx);
		return { session: ctx.sessionManager.getSessionId(), scope: { cwd: scope.cwd, provider: scope.provider ?? null, model: scope.model ?? null },
			authority: actionAuthority(snapshot, catalog.tools), mode: this.effectiveMode() };
	}
	async actionControl(params: ActionControl, ctx: ExtensionContext): Promise<unknown> {
		const snapshot = await this.load(ctx);
		return this.actions.control(params, this.actionBinding(ctx, snapshot));
	}
	private effectiveMode(): PolicyMode {
		return this.snapshot?.health.status === "degraded" && this.mode() !== "observe" ? "notice" : this.mode();
	}
	private states() {
		return Object.fromEntries(this.state.snapshot(this.now(), this.turn).map((view) => [view.id, view]));
	}
	private catalog(): { tools: Catalog; active: string[]; available: boolean } {
		try {
			const tools = this.pi.getAllTools();
			const active = this.pi.getActiveTools();
			if (tools.length > MAX_CATALOG_TOOLS || active.length > MAX_CATALOG_TOOLS)
				return { tools: [], active: [], available: false };
			return { tools, active, available: true };
		} catch {
			return { tools: [], active: [], available: false };
		}
	}
	private publicContext(catalog = this.catalog()): Record<string, unknown> {
		if (!catalog.available) return { turn: this.turn, catalogAvailable: false, tools: UNKNOWN };
		const names = new Set(catalog.tools.map((tool) => tool.name));
		const gather = (condition: Condition): void => {
			if ("all" in condition) for (const child of condition.all) gather(child);
			else if ("any" in condition) for (const child of condition.any) gather(child);
			else if ("not" in condition) gather(condition.not);
			else if (condition.path[0] === "context" && condition.path[1] === "tools" && condition.path[2])
				names.add(condition.path[2]);
		};
		const policy = this.prepared();
		for (const record of policy.records.values()) {
			if (effectiveState(record) !== "active") continue;
			const compiled = policy.compiled.get(record.id);
			if (!compiled) continue;
			const spec = compiled.program;
			if (compiled.applicability) gather(compiled.applicability);
			gather(spec.when);
			if (spec.state) {
				gather(spec.state.observe);
				if (spec.state.resetWhen) gather(spec.state.resetWhen);
			}
			if (names.size > MAX_CATALOG_TOOLS) return { turn: this.turn, catalogAvailable: false, tools: UNKNOWN };
		}
		const configured = new Set(catalog.tools.map((tool) => tool.name));
		const active = new Set(catalog.active);
		return {
			turn: this.turn,
			catalogAvailable: true,
			tools: Object.fromEntries(
				[...names].map((name) => [name, { configured: configured.has(name), active: active.has(name) }]),
			),
		};
	}
	private evaluationContext(
		tool: string,
		input: Record<string, unknown> | undefined,
	): EvaluationContext {
		const catalog = this.catalog();
		const schema = catalog.tools.find((t) => t.name === tool)?.parameters;
		const now = this.now();
		const policy = this.prepared();
		return {
			tool,
			facts: { input, context: this.publicContext(catalog) },
			states: this.states(),
			schema,
			preparedSchema: prepareSchema(schema),
			schemaTruth: new Map(),
			namedData: policy.data,
			data: policy.data.snapshot(now),
			now,
		};
	}
	private currentRules(call: ObservedCall): ProgramRule[] {
		if (call.generation !== this.generation) return [];
		return call.rules.filter((rule) => samePin(call.pins.get(rule.id), this.state.pin(rule.id)));
	}
	private inputPlan(call: ObservedCall, applyCorrections = true): InputPlan {
		const current = new Set(this.currentRules(call).map((rule) => rule.id));
		return planInput(call.rules, call.input ?? {}, {
			...this.contextFor(call),
			applyCorrections,
			staleRules: new Set(call.rules.filter((rule) => !current.has(rule.id)).map((rule) => rule.id)),
		});
	}
	private facts(call: ObservedCall, result?: Result, outcome?: CallOutcome): Record<string, unknown> {
		return {
			input: call.input,
			original: call.requested,
			context: call.context.facts?.context,
			result: result
				? {
						tool: call.tool,
						isError: result.isError === true,
						...(result.content !== undefined ? { content: result.content } : {}),
						...(result.details !== undefined ? { details: result.details } : {}),
						...(result.usage !== undefined ? { usage: result.usage } : {}),
					}
				: undefined,
			outcome: outcome
				? {
						kind: outcome,
						isError: result?.isError === true,
						outputBytes: call.outputBytes ?? UNKNOWN,
						preGuidanceBytes: call.preGuidanceBytes ?? UNKNOWN,
						executed: call.resultSeen,
						denied: outcome === "denied",
						abortRequested: call.abortRequested === true,
						complete: call.complete,
					}
				: undefined,
		};
	}
	private contextFor(call: ObservedCall, result?: Result, outcome?: CallOutcome): EvaluationContext {
		const now = this.now();
		const data = call.context.namedData
			? call.context.namedData.snapshot(now)
			: snapshotData(Object.values(call.context.data ?? {}).flatMap((source) => (source.data ? [source.data] : [])), now);
		return {
			...call.context,
			data,
			facts: this.facts(call, result, outcome),
			states: this.states(),
			matched: call.matches,
			mode: this.effectiveMode(),
			now,
		};
	}
	private makeCall(
		tool: string,
		id: string,
		args: unknown,
		ctx: ExtensionContext,
		snapshot: RuleSnapshot,
	): ObservedCall {
		const input = isOwnedInput(args) ? args : inputSnapshot(args);
		const captured = input ? captureFor(tool, input) : undefined;
		const scope = sessionScope(ctx);
		const policy = this.prepared();
		const active = [...policy.records.values()].filter(
			(r) => effectiveState(r) === "active" && r.matcherAvailable && scopeMatches(r.definition.scope, scope),
		);
		const rules = active.flatMap((record) => {
			const compiled = policy.compiled.get(record.id);
			return compiled ? [compiled] : [];
		});
		const context = { ...this.evaluationContext(tool, input), scope };
		const matches = new Set(
			[...captureProgramEvidence(rules, context, input)].filter(([, truth]) => truth === true).map(([id]) => id),
		);
		return {
			...startCall(tool, id, input ?? {}, new Date(this.now()), performance.now(), captured ?? null),
			classes: [...matches],
			requested: input,
			input,
			rules,
			matches,
			pins: new Map(
				active.flatMap((rule) => {
					const pin = this.state.pin(rule.id);
					return pin ? [[rule.id, pin] as const] : [];
				}),
			),
			context,
			generation: this.generation,
			turn: this.turn,
			prepared: false,
			executionStarted: false,
			resultSeen: false,
			complete: input !== undefined,
			evaluations: [],
			corrections: [],
			effects: {},
			sessionFacts: {
				session: ctx.sessionManager.getSessionId(),
				mode: ctx.mode,
				cwd: ctx.cwd,
				model: scope.model ?? null,
				thinkingLevel: ctx.thinkingLevel ?? null,
				projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
				ruleStoreDegraded: snapshot.health.status === "degraded",
			},
		};
	}
	/** Pi starts each execution once, so a start under an ended call ID is a new execution that reuses the provider's ID. */
	private track(call: ObservedCall): void {
		this.ended.delete(call.callId);
		if (!trackPending(this.pending, call)) this.incomplete++;
	}
	private notice(call: ObservedCall, ctx: ExtensionContext): void {
		if (this.effectiveMode() !== "notice" || ctx.mode !== "tui" || !call.classes.length || call.effects.notified)
			return;
		try {
			ctx.ui.notify(`[policy] ${call.classes.join(", ")}`, "warning");
			call.effects.notified = true;
		} catch {
			/* Notice failure does not cancel a decision. */
		}
	}
	private collect(call: ObservedCall, evaluations: ProgramEvaluation[]): void {
		call.evaluations.push(...evaluations);
		call.classes = [...new Set([...call.classes, ...evaluations.filter((e) => e.truth === true).map((e) => e.id)])];
	}
	async toolStart(
		event: { toolName: string; toolCallId: string; args: unknown },
		ctx: ExtensionContext,
	): Promise<void> {
		if (this.closed || !this.enabled() || this.pending.has(event.toolCallId)) return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		const call = this.makeCall(event.toolName, event.toolCallId, event.args, ctx, snapshot);
		call.executionStarted = true;
		this.track(call);
	}
	private prepareCall(event: ToolCallEvent, ctx: ExtensionContext, snapshot: RuleSnapshot): ObservedCall {
		let call = this.pending.get(event.toolCallId);
		if (!call) {
			call = this.makeCall(event.toolName, event.toolCallId, event.input, ctx, snapshot);
			this.track(call);
		} else {
			const approvalRules =
				[...this.prepared().compiled.values()].some(
					(rule) => rule.program.action.kind === "require-approval",
				) || call.rules.some((rule) => rule.program.action.kind === "require-approval");
			if (approvalRules) {
				const fresh = this.makeCall(event.toolName, event.toolCallId, event.input, ctx, snapshot);
				fresh.requested = call.requested;
				fresh.executionStarted = call.executionStarted;
				this.pending.set(event.toolCallId, fresh);
				call = fresh;
			} else call.input = inputSnapshot(event.input);
		}
		call.prepared = true;
		return call;
	}
	private approvalReason(call: ObservedCall, event: ToolCallEvent, ctx: ExtensionContext, snapshot: RuleSnapshot, plan: InputPlan): string | undefined {
		if (this.effectiveMode() !== "enforce" || !plan.evaluations.some((entry) => entry.action.kind === "require-approval" && entry.deny)) return undefined;
		if (!this.createActionState) return "[policy] Simulation requires exact-action approval; no permission state was created.";
		if (!call.executionStarted || !sameActionInput(call.requested, event.input) || !sameActionInput(event.input, plan.candidate))
			return "[policy] Exact execution arguments are unproved: start, hook and final input must agree. Retry with the exact final payload without input correction.";
		return this.actions.gate(plan, event.toolName, this.actionBinding(ctx, snapshot), () => sealActionInput(event.input as Record<string, unknown>));
	}
	async toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		const call = this.prepareCall(event, ctx, snapshot);
		const refused = this.refuseUnavailableInput(call, ctx);
		if (refused) return refused;
		const plan = this.inputPlan(call, this.effectiveMode() === "enforce");
		for (const id of plan.matches) {
			call.matches.add(id);
			if (!call.classes.includes(id)) call.classes.push(id);
		}
		const activeMode = this.effectiveMode();
		const approvalReason = this.approvalReason(call, event, ctx, snapshot, plan);
		this.collect(call, plan.evaluations);
		call.corrections = plan.corrections;
		const denied = this.applyInputCorrections(call, event, plan, approvalReason !== undefined || plan.denied || !plan.valid);
		if (activeMode === "enforce" && denied) {
			call.decision = approvalReason ??
				refusalText(plan, this.prepared().records, call.classes) ??
				"[policy] The approved input checks refused this call.";
			this.notice(call, ctx);
			return { block: true, reason: call.decision };
		}
		this.notice(call, ctx);
	}

	/** Refuse missing input after one evaluation pass, or leave the call for normal planning. */
	private refuseUnavailableInput(
		call: ObservedCall,
		ctx: ExtensionContext,
	): { block: true; reason: string } | undefined {
		if (call.input) return undefined;
		call.complete = false;
		this.incomplete++;
		const rules = this.currentRules(call);
		const context = this.contextFor(call);
		const evidence = captureProgramEvidence(rules, context);
		const evaluations = evaluatePrograms(rules, "input", { ...context, evidence }).map(markUnavailable(rules));
		this.collect(call, evaluations);
		this.notice(call, ctx);
		if (this.effectiveMode() !== "enforce" || !evaluations.some((evaluation) => evaluation.deny)) return undefined;
		call.decision = "[policy] An approved input check refused unavailable input.";
		return { block: true, reason: call.decision };
	}

	/** Commit approved corrections into the live input, or report the call as denied. */
	private applyInputCorrections(call: ObservedCall, event: ToolCallEvent, plan: InputPlan, denied: boolean): boolean {
		if (this.effectiveMode() !== "enforce" || denied || !plan.changed) return denied;
		if (commitInput(event.input as Record<string, unknown>, plan.candidate)) {
			call.input = plan.candidate;
			call.effects.policy = { inputCorrected: true };
			return false;
		}
		return true;
	}

	private resultPlan(call: ObservedCall, result: Result) {
		const rules = this.currentRules(call);
		const semantic = evaluatePrograms(rules, "result", this.contextFor(call, result)).filter(
			(e) => e.action.kind !== "guide",
		);
		const correction =
			this.effectiveMode() === "enforce" &&
			result.isError !== true &&
			semantic.some((e) => e.truth === true && e.action.kind === "assert-error");
		const effective = correction ? { ...result, isError: true } : result;
		const guides = evaluatePrograms(rules, "result", this.contextFor(call, effective)).filter(
			(e) => e.action.kind === "guide",
		);
		return { correction, semantic, guides };
	}
	async toolResult(
		event: ToolResultEvent,
		ctx: ExtensionContext,
	): Promise<
		| { isError?: true; content?: ToolResultEvent["content"]; structuredContent?: ToolResultEvent["structuredContent"] }
		| undefined
	> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		await this.load(ctx);
		if (!this.live(generation)) return;
		const call = this.pending.get(event.toolCallId);
		if (!call) return;
		this.recordResult(call, event);
		const { correction, semantic, guides } = this.resultPlan(call, {
			content: event.content,
			details: event.details,
			isError: event.isError,
			usage: event.usage,
		});
		this.collect(call, [...semantic, ...guides]);
		if (correction) call.effects.policy = { ...call.effects.policy, resultCorrected: true };
		const text = this.guidance(guides);
		this.notice(call, ctx);
		if (text) {
			call.effects.annotationBytes = Buffer.byteLength(text, "utf8");
			if (event.parentToolCallId !== undefined) {
				this.pi.sendMessage(
					{ customType: "policy_result_guidance", content: text, display: false },
					{ triggerTurn: false },
				);
			}
			return this.annotatedResult(text, event, correction);
		}
		if (correction) return { isError: true };
	}

	/** Record the observed result before result-phase evaluations run. */
	private recordResult(call: ObservedCall, event: ToolResultEvent): void {
		call.resultSeen = true;
		call.preGuidanceBytes = textContentBytes(event.content);
		const actual = inputSnapshot(event.input);
		if (actual) call.input = actual;
		else call.complete = false;
	}

	private annotatedResult(
		text: string,
		event: ToolResultEvent,
		correction: boolean,
	): { isError?: true; content: ToolResultEvent["content"]; structuredContent?: ToolResultEvent["structuredContent"] } {
		return {
			...(correction ? { isError: true as const } : {}),
			content: [...event.content, { type: "text", text }],
			structuredContent: event.structuredContent,
		};
	}
	private guidance(evaluations: ProgramEvaluation[]): string | undefined {
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") return;
		const prepared = prepareGuidanceSelection(evaluations, this.state, this.now(), this.turn);
		if (!prepared) return;
		for (const id of prepared.ids) this.state.project(id, this.now(), this.turn);
		return prepared.text;
	}
	async toolEnd(
		event: { toolName: string; toolCallId: string; result: unknown; isError: boolean },
		ctx: ExtensionContext,
	): Promise<void> {
		if (this.closed || !this.enabled() || this.ended.has(event.toolCallId)) return;
		const generation = this.generation;
		await this.load(ctx);
		if (!this.live(generation)) return;
		const call = this.pending.get(event.toolCallId);
		if (!call) return;
		this.pending.delete(event.toolCallId);
		this.evictEndedId();
		this.ended.add(event.toolCallId);
		const result = { ...object(event.result), isError: event.isError } as Result;
		const outcome = this.finishOutcome(call, result, event, ctx);
		const completion = this.completeCall(call, result, outcome);
		this.notice(call, ctx);
		const details = object(result.details);
		const truncation = object(details?.truncation);
		const usage = object(result.usage);
		const rows = this.finishRows(call, completion);
		const effects = this.finishEffects(call, outcome, rows);
		this.writer.enqueue(
			finishCall(
				call,
				{
					content: result.content,
					isError: event.isError,
					truncated: truncation?.truncated === true,
					tokens: typeof usage?.totalTokens === "number" ? usage.totalTokens : null,
				},
				call.sessionFacts,
				this.mode(),
				effects,
			),
		);
	}

	private evictEndedId(): void {
		if (this.ended.size < MAX_FINAL_IDS) return;
		const oldest = this.ended.values().next().value;
		if (oldest !== undefined) this.ended.delete(oldest);
	}

	/** Record the final call shape and classify the outcome from observed evidence. */
	private finishOutcome(
		call: ObservedCall,
		result: Result,
		event: { isError: boolean },
		ctx: ExtensionContext,
	): CallOutcome {
		const text = (result.content ?? []).map((part) => part.text ?? "").join("");
		call.abortRequested = ctx.signal?.aborted === true;
		call.outputBytes = textContentBytes(result.content);
		return call.resultSeen
			? event.isError
				? "execution-error"
				: "success"
			: call.decision && text === call.decision
				? "denied"
				: "unexecuted";
	}

	/** Run completion-phase evaluations and observation completion once. */
	private completeCall(call: ObservedCall, result: Result, outcome: CallOutcome): ProgramEvaluation[] {
		const rules = this.currentRules(call);
		const completionContext = this.contextFor(call, result, outcome);
		const completionFrame = createEvaluationFrame(completionContext);
		const completion = evaluatePrograms(rules, "completion", completionContext, completionFrame).filter(
			(entry) => entry.action.kind !== "guide",
		);
		this.stale += call.rules.length - rules.length;
		for (const rule of rules) {
			const selected = observationSelected(rule, completionContext, completionFrame);
			const pin = call.pins.get(rule.id);
			if (
				pin &&
				selected === true &&
				!this.state.complete(pin, completionFrame.factsFor(rule), call.turn, this.now())
			)
				this.stale++;
		}
		const guides = evaluatePrograms(rules, "completion", this.contextFor(call, result, outcome)).filter(
			(entry) => entry.action.kind === "guide",
		);
		completion.push(...guides);
		this.collect(call, completion);
		if (this.effectiveMode() === "annotate" || this.effectiveMode() === "enforce")
			for (const evaluation of guides) {
				const pin = this.state.pin(evaluation.id);
				if (pin && evaluation.truth === true && this.state.eligible(evaluation.id, this.now(), this.turn))
					this.retainedGuidance.set(evaluation.id, { pin, evaluation });
			}
		return completion;
	}

	private dataSnapshotRows(call: ObservedCall): RowBundle {
		const dataNames = new Set([
			...Object.keys(call.context.data ?? {}),
			...call.rules.flatMap(programSteps).flatMap((rule) => rule.program.data ?? []),
		]);
		return boundedRows(
			[...dataNames].sort().map((name) => {
				const binding = call.context.data?.[name];
				return {
					name,
					status: binding?.status ?? "missing",
					...(binding?.revision !== undefined ? { revision: binding.revision } : {}),
					...(binding?.capturedAt !== undefined ? { capturedAt: binding.capturedAt } : {}),
					...(binding?.ageMs !== undefined ? { ageMs: binding.ageMs } : {}),
					...(binding?.data?.maxAgeMs !== undefined ? { maxAgeMs: binding.data.maxAgeMs } : {}),
					...(call.context.now !== undefined ? { snapshotAt: call.context.now } : {}),
				};
			}),
		);
	}

	private metadataRows(completion: ProgramEvaluation[]): RowBundle {
		return boundedRows(
			completion
				.filter((e) => e.truth === true && e.action.kind === "observe")
				.map((e) => ({ id: e.id, label: e.action.kind === "observe" ? e.action.label : "" })),
		);
	}

	private finishRows(
		call: ObservedCall,
		completion: ProgramEvaluation[],
	): {
		evaluations: RowBundle & { irrelevant: number };
		corrections: RowBundle;
		generations: RowBundle & { irrelevant: number };
		dataSnapshots: RowBundle;
		metadata: RowBundle;
	} {
		return {
			...telemetryDecisionRows(metadata(call.evaluations), [...call.pins.values()], call.classes, call.corrections),
			corrections: boundedRows(call.corrections),
			dataSnapshots: this.dataSnapshotRows(call),
			metadata: this.metadataRows(completion),
		};
	}

	/** Build the recorded effect summary with bounded coverage accounts. */
	private finishEffects(
		call: ObservedCall,
		outcome: CallOutcome,
		rows: ReturnType<PolicyRuntime["finishRows"]>,
	): CallEffects {
		return {
			...call.effects,
			outcome,
			abortRequested: call.abortRequested,
			blocked: outcome === "denied",
			observationComplete: call.complete && outcome !== "unexecuted",
			policy: {
				...call.effects.policy,
				decision: call.decision ? "deny" : "none",
				...(call.preGuidanceBytes !== undefined ? { preGuidanceBytes: call.preGuidanceBytes } : {}),
				evaluations: rows.evaluations.rows,
				corrections: rows.corrections.rows,
				generations: rows.generations.rows,
				dataSnapshots: rows.dataSnapshots.rows,
				metadata: rows.metadata.rows,
				coverage: {
					evaluations: { total: rows.evaluations.total, omitted: rows.evaluations.omitted, irrelevant: rows.evaluations.irrelevant },
					corrections: { total: rows.corrections.total, omitted: rows.corrections.omitted },
					generations: { total: rows.generations.total, omitted: rows.generations.omitted, irrelevant: rows.generations.irrelevant },
					dataSnapshots: { total: rows.dataSnapshots.total, omitted: rows.dataSnapshots.omitted },
					metadata: { total: rows.metadata.total, omitted: rows.metadata.omitted },
				},
			},
		};
	}
	async beforeAgentStart(ctx: ExtensionContext): Promise<string | undefined> {
		if (this.closed || !this.enabled() || this.shellCardSent) return;
		if (this.mode() !== "annotate" && this.mode() !== "enforce") return;
		const generation = this.generation;
		await this.load(ctx);
		if (!this.live(generation) || this.shellCardSent) return;
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") return;
		const catalog = this.catalog();
		if (!catalog.available || !catalog.active.includes("bash")) return;
		const text = shellContractCard(this.prepared().records.values(), sessionScope(ctx), this.publicContext(catalog));
		if (text) this.shellCardSent = true;
		return text;
	}
	/** The newest compaction, branch-summary or context-edit entry on the active branch bounds the context epoch. */
	private guidanceEpochFor(ctx: ExtensionContext): string {
		const boundary = ctx.sessionManager
			.getBranch()
			.findLast(
				(entry) => entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "context_edit",
			);
		return `${ctx.sessionManager.getSessionId()}:${boundary?.id ?? "root"}`;
	}

	/**
	 * Read the active branch: its context epoch, the model-visible contributions
	 * that guidance can anchor to, and, after a reset, the stored records.
	 */
	private syncGuidance(ctx: ExtensionContext): { epochs: GuidanceEpochs; sources: GuidanceSource[] } {
		const projection = ctx.sessionManager.buildSessionProjection();
		const epoch = this.guidanceEpochFor(ctx);
		const restore = this.guidanceDirty;
		const epochs: GuidanceEpochs = { epoch, validatedEpoch: restore ? undefined : this.guidanceEpoch };
		if (restore || epoch !== this.guidanceEpoch) this.guidanceNotice = undefined;
		const sources: GuidanceSource[] = [];
		for (const { sourceEntry, messages } of projection.entries)
			for (let contribution = 0; contribution < messages.length; contribution++)
				sources.push({ entryId: sourceEntry.id, contribution, message: messages[contribution] });
		if (restore) this.restoreGuidance(ctx);
		return { epochs, sources };
	}

	private restoreGuidance(ctx: ExtensionContext): void {
		const records = new Map<string, GuidanceRecord>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === GUIDANCE_ENTRY) {
				const record = parseGuidanceRecord(entry.data);
				if (record && !records.has(record.id)) records.set(record.id, record);
			} else if (entry.customType === GUIDANCE_RETIREMENT_ENTRY) {
				for (const id of parseGuidanceRetirement(entry.data)) records.delete(id);
			}
		}
		for (const id of this.guidanceRetirements) records.delete(id);
		this.guidanceDirty = false;
		this.guidanceStatus = "ok";
		this.guidanceLedger = guidanceHistory([...records.values()]);
	}

	private notifyGuidance(status: GuidanceStatus, epoch: string, ctx: ExtensionContext): void {
		const key = `${epoch}:${status}`;
		if (status === "ok" || this.guidanceNotice === key) return;
		this.guidanceNotice = key;
		if (ctx.mode !== "tui") return;
		const text =
			status === "capacity"
				? this.guidanceLedger.records.length > GUIDANCE_HISTORY_LIMITS.records ||
					this.guidanceLedger.retainedBytes > GUIDANCE_HISTORY_LIMITS.bytes
					? "Guidance history exceeds its limits; guidance projection is paused without discarding records."
					: "Guidance history is full; earlier guidance keeps its place and new context guidance is refused."
				: status === "anchor-mismatch"
					? "Guidance history cannot place an earlier notice; new context guidance is paused."
					: "Guidance history could not persist a notice; its allowance is unchanged.";
		try {
			ctx.ui.notify(`[policy] ${text}`, "warning");
		} catch {
			/* Reporting guidance health does not change policy decisions. */
		}
	}

	private contextRules(ctx: ExtensionContext): ProgramRule[] {
		const policy = this.prepared();
		return [...policy.records.values()]
			.filter(
				(r) =>
					effectiveState(r) === "active" &&
					r.matcherAvailable &&
					scopeMatches(r.definition.scope, sessionScope(ctx)),
			)
			.flatMap((record) => {
				const compiled = policy.compiled.get(record.id);
				return compiled ? [compiled] : [];
			});
	}

	private noticeContextRules(evaluation: readonly ProgramEvaluation[], ctx: ExtensionContext): void {
		if (this.effectiveMode() !== "notice" || ctx.mode !== "tui") return;
		const ids = evaluation
			.filter((entry) => entry.truth === true && this.state.eligible(entry.id, this.now(), this.turn))
			.map((entry) => entry.id);
		if (!ids.length) return;
		try {
			ctx.ui.notify(`[policy] ${ids.join(", ")}`, "warning");
		} catch {
			/* Notice does not change guidance state. */
		}
	}

	/** Persist one planned record, then consume its allowance. False means nothing changed. */
	private persistGuidance(record: GuidanceRecord, ids: readonly string[], now: number): boolean {
		try {
			this.pi.appendEntry(GUIDANCE_ENTRY, record);
		} catch {
			return false;
		}
		for (const id of ids) if (this.state.project(id, now, this.turn)) this.retainedGuidance.delete(id);
		return true;
	}

	/** Retirement must reach storage before any replacement consumes its allowance. */
	private persistGuidancePlan<M>(
		plan: GuidancePlan<M>,
		now: number,
	): Pick<GuidancePlan<M>, "history" | "messages" | "status"> & { emitted?: string } {
		const { history, messages, status } = plan;
		const retained = new Set(history.records.map((record) => record.id));
		this.guidanceRetirements.push(
			...this.guidanceLedger.records.filter((record) => !retained.has(record.id)).map((record) => record.id),
		);
		if (this.guidanceRetirements.length) {
			try {
				this.pi.appendEntry(GUIDANCE_RETIREMENT_ENTRY, { ids: this.guidanceRetirements });
				this.guidanceRetirements = [];
			} catch {
				return { history, messages, status: "persistence-failed" };
			}
		}
		const addition = plan.addition;
		if (!addition) return { history, messages, status };
		if (!this.persistGuidance(addition.record, addition.prepared.ids, now))
			return { history, messages, status: "persistence-failed" };
		return { history: addition.history, messages: addition.messages, status, emitted: addition.record.text };
	}

	/**
	 * Project persisted context guidance after its original anchor in the full
	 * transcript. A new record is persisted before its allowance is consumed, so
	 * a failed write changes no eligibility and adds no message.
	 */
	async contextWithSystem(
		event: ContextWithSystemEvent,
		ctx: ExtensionContext,
	): Promise<{ messages: ContextWithSystemEvent["messages"]; emitted?: string } | undefined> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		await this.load(ctx);
		if (!this.live(generation)) return;
		const policy = this.prepared();
		const rules = this.contextRules(ctx);
		const now = this.now();
		const mode = this.effectiveMode();
		const { epochs, sources } = this.syncGuidance(ctx);
		const epoch = epochs.epoch;
		const evaluation = evaluatePrograms(rules, "context", {
			tool: "",
			facts: { context: this.publicContext() },
			states: this.states(),
			namedData: policy.data,
			data: policy.data.snapshot(now),
			now,
			mode,
		});
		this.noticeContextRules(evaluation, ctx);
		for (const [id, notice] of this.retainedGuidance)
			if (!rules.some((rule) => rule.id === id) || !samePin(notice.pin, this.state.pin(id)))
				this.retainedGuidance.delete(id);
		const projecting = mode === "annotate" || mode === "enforce";
		const plan = planGuidance(
			event.messages,
			sources,
			this.guidanceLedger,
			epochs,
			projecting
				? () =>
						prepareGuidanceSelection(
							[...[...this.retainedGuidance.values()].map(({ evaluation: entry }) => entry), ...evaluation],
							this.state,
							now,
							this.turn,
						)
				: undefined,
			now,
		);
		const { history, messages, status, emitted } = this.persistGuidancePlan(plan, now);
		this.guidanceLedger = history;
		this.guidanceEpoch = epoch;
		this.guidanceStatus = status;
		this.notifyGuidance(status, epoch, ctx);
		if (messages.length === event.messages.length) return;
		return { messages, ...(emitted !== undefined ? { emitted } : {}) };
	}
	async inspect(view: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
		const snapshot = view === "preview" && this.snapshot ? this.snapshot : await this.load(ctx);
		if (view === "state") return this.inspectState();
		if (view === "health") return this.inspectHealth(snapshot);
		if (view === "capabilities") return this.inspectCapabilities();
		if (view === "explain") return this.inspectExplain(params, ctx, snapshot);
		if (view === "preview") return this.inspectPreview(params, ctx, snapshot);
		throw new Error(`Unknown policy view: ${view}`);
	}

	private inspectState(): unknown {
		return {
			observationPeriods: publicState(this.state.snapshot(this.now(), this.turn)),
			turn: this.turn,
			incomplete: this.incomplete,
			staleCompletions: this.stale,
			retainedGuidance: [...this.retainedGuidance.values()].map(({ pin }) => pin),
			guidanceRecords: this.guidanceLedger.records.map((record) => ({
				id: record.id,
				epoch: record.anchor.epoch,
				entryId: record.anchor.entryId,
				contribution: record.anchor.contribution,
				timestamp: record.timestamp,
			})),
		};
	}

	private inspectHealth(snapshot: RuleSnapshot): unknown {
		return {
			authority: snapshot.health,
			telemetry: this.writer.health(),
			observations: { incomplete: this.incomplete, pending: this.pending.size, recentCompletedIds: this.ended.size },
			guidance: {
				status: this.guidanceStatus,
				epoch: this.guidanceEpoch,
				records: this.guidanceLedger.records.length,
				retainedBytes: this.guidanceLedger.retainedBytes,
				limits: GUIDANCE_HISTORY_LIMITS,
			},
		};
	}

	private inspectCapabilities(): unknown {
		const catalog = this.catalog();
		return {
			phases: ["input", "result", "completion", "context"],
			actions: ["deny", "require-approval", "rename-key", "substitute", "assert-error", "guide", "observe"],
			mode: this.mode(),
			effectiveMode: this.effectiveMode(),
			schemas: {
				available: catalog.available,
				tools: catalog.tools.map((t) => ({
					name: t.name,
					active: catalog.active.includes(t.name),
					configured: true,
				})),
			},
			innerSchemas: "Unavailable; decoded argument corrections are unsupported",
			dataKinds: ["table"],
			observationStorage: "memory",
			projection: "full transcript with retained guidance, no new turn",
		};
	}

	private async inspectExplain(
		params: Record<string, unknown>,
		ctx: ExtensionContext,
		snapshot: RuleSnapshot,
	): Promise<unknown> {
		if (typeof params.id === "string" && params.id.startsWith("call:")) {
			const callId = params.id.slice(5);
			if (!callId || callId.length > 256) throw new Error("A bounded call identifier is required");
			const activity = await readRecentActivity(this.dir, undefined, 1, {
				session: ctx.sessionManager.getSessionId(),
				callId,
				includeUnmatched: true,
			});
			return {
				callId,
				scope: "current-session",
				evidence: "untrusted recorded policy observations",
				...activity,
				boundary:
					"A missing record may be outside this bounded read or not yet persisted. It does not prove no decision occurred.",
			};
		}
		const record = typeof params.id === "string" ? snapshot.records.get(params.id) : undefined;
		if (!record) throw new Error("An existing rule id is required");
		const compiled = this.prepared().compiled.get(record.id);
		if (!compiled) throw new Error("The selected rule has no compiled program");
		const period = this.state.view(record.id, this.now(), this.turn);
		return {
			id: record.id,
			revision: record.definition.revision,
			active: effectiveState(record),
			programs: programSteps(compiled).map((rule) => rule.program),
			scope: record.definition.scope,
			observationPeriod: period ? publicState([period])[0] : undefined,
		};
	}

	private inspectPreview(params: Record<string, unknown>, ctx: ExtensionContext, snapshot: RuleSnapshot): unknown {
		if (typeof params.tool !== "string" || !params.tool || params.tool.length > 200)
			throw new Error("A bounded preview tool name is required");
		const input = inputSnapshot(params.input);
		if (!input) throw new Error("Preview input must be bounded JSON");
		const call = this.makeCall(params.tool, "preview", input, ctx, snapshot);
		const plan = this.inputPlan(call, this.effectiveMode() === "enforce");
		for (const id of plan.matches) call.matches.add(id);
		if (this.effectiveMode() === "enforce" && plan.valid && !plan.denied) call.input = plan.candidate;
		const result = object(params.result);
		const results = result
			? this.resultPlan(call, {
					content: Array.isArray(result.content) ? result.content : undefined,
					details: result.details,
					isError: result.isError === true,
				})
			: undefined;
		const inputEvaluations = relevantEvaluations(plan.evaluations);
		const allResults = results ? [...results.semantic, ...results.guides] : [];
		const resultEvaluations = relevantEvaluations(allResults);
		const relevantIds = new Set([
			...plan.matches,
			...inputEvaluations.map((e) => e.id),
			...resultEvaluations.map((e) => e.id),
		]);
		const evaluatedIds = new Set([...plan.evaluations, ...allResults].map((e) => e.id));
		const wouldCorrectInput = this.effectiveMode() === "enforce" && plan.valid && !plan.denied && plan.changed;
		return {
			decision: {
				denied: this.effectiveMode() === "enforce" && (plan.denied || !plan.valid),
				correctedInput: wouldCorrectInput,
				resultCorrected: results?.correction ?? false,
			},
			preview: true,
			stateAdvanced: false,
			mode: this.effectiveMode(),
			nonMatchingRules: [...evaluatedIds].filter((id) => !relevantIds.has(id)).length,
			executionInput: call.input,
			wouldCorrectInput,
			input: { ...plan, evaluations: inputEvaluations },
			results: resultEvaluations,
			resultCorrected: results?.correction ?? false,
			boundary: "No simulated tool executes. The actual inspection call retains ordinary telemetry.",
		};
	}
	attach(): void {
		this.pi.on("session_start", (event) => {
			this.closed = false;
			this.shellCardSent = false;
			this.resetSession(event.reason ?? "startup");
			this.enabled();
		});
		this.pi.on("before_agent_start", async (_event, ctx) => {
			const content = await this.beforeAgentStart(ctx);
			if (content) return { message: { customType: "policy_shell_contract", content, display: false } };
		});
		this.pi.on("session_tree", () => this.resetSession("tree"));
		this.pi.on("session_compact", () => {
			this.guidanceDirty = true;
		});
		this.pi.on("turn_start", () => {
			this.turn++;
		});
		this.pi.on("tool_execution_start", (event, ctx) => this.toolStart(event, ctx));
		this.pi.on("tool_call", (event, ctx) => this.toolCall(event, ctx));
		this.pi.on("tool_result", (event, ctx) => this.toolResult(event, ctx));
		this.pi.on("tool_execution_end", (event, ctx) => this.toolEnd(event, ctx));
		this.pi.on("context_with_system", async (event, ctx) => {
			const projected = await this.contextWithSystem(event, ctx);
			if (projected) return projected;
		});
		this.pi.on("session_shutdown", async () => {
			this.closed = true;
			this.incomplete += this.pending.size;
			this.pending.clear();
			this.resetSession("shutdown");
			await this.writer.close();
		});
	}
}
