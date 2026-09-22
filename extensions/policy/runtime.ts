/** One event interpreter for approved plans, corrections, observations, and guidance. */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { captureFor, ruleScopeMatches as scopeMatches } from "./classify.ts";
import { compileRule } from "./compiler.ts";
import { cloneJson, snapshotData, UNKNOWN } from "./data.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import { readRecentActivity } from "./panel.ts";
import {
	type Condition,
	captureProgramEvidence,
	type EvaluationContext,
	evaluatePrograms,
	GUIDANCE_BYTES,
	GUIDANCE_PREFIX,
	type InputPlan,
	observationSelected,
	type ProgramEvaluation,
	type ProgramRule,
	planInput,
	programFacts,
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
import { effectiveEffect, effectiveState, type RuleRecord, ruleGuidance } from "./rule.ts";
import { ObservationState, type StatePin } from "./state.ts";
import { PolicyWriter } from "./store.ts";

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
		return cloneJson({ ...source });
	} catch {
		return undefined;
	}
}
function samePin(left: StatePin | undefined, right: StatePin | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.revision === right.revision &&
		left.generation === right.generation
	);
}
function metadata(evaluations: ProgramEvaluation[]): unknown[] {
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
function boundedRows(rows: readonly unknown[], maxBytes = 32768): { rows: unknown[]; total: number; omitted: number } {
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

interface RowBundle {
	rows: unknown[];
	total: number;
	omitted: number;
}

/** Convert one missing-input evaluation into its unavailable form, honoring deny decisions. */
function markUnavailable(rules: ProgramRule[]): (evaluation: ProgramEvaluation) => ProgramEvaluation {
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
function publicState(views: ReturnType<ObservationState["snapshot"]>): unknown[] {
	return views.map((view) =>
		Object.fromEntries(Object.entries(view).map(([key, value]) => [key, value === UNKNOWN ? "unavailable" : value])),
	);
}
function guidanceText(lines: readonly string[]): string | undefined {
	let text = GUIDANCE_PREFIX;
	for (const line of new Set(lines)) {
		const safe = line
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!safe) continue;
		if (Buffer.byteLength(`${text} ${safe}`, "utf8") > GUIDANCE_BYTES) break;
		text += ` ${safe}`;
	}
	return text === GUIDANCE_PREFIX ? undefined : text;
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

export class PolicyRuntime {
	private readonly state = new ObservationState();
	private readonly pending = new Map<string, ObservedCall>();
	private readonly ended = new Set<string>();
	private readonly retainedGuidance = new Map<string, { pin: StatePin; evaluation: ProgramEvaluation }>();
	private snapshot?: RuleSnapshot;
	private effectiveActions = new Map<string, ReturnType<typeof effectiveEffect>>();
	private generation = 0;
	private turn = 0;
	private closed = false;
	private telemetryFailure?: string;
	private incomplete = 0;
	private stale = 0;
	private readonly writer: Pick<PolicyWriter, "enqueue" | "close">;
	private readonly dir: string;
	private readonly pi: ExtensionAPI;
	private readonly load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>;
	private readonly mode: () => PolicyMode;
	private readonly enabled: () => boolean;
	private readonly now: () => number;
	constructor(
		pi: ExtensionAPI,
		load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>,
		mode: () => PolicyMode,
		dir: string,
		enabled: () => boolean = () => true,
		writer?: Pick<PolicyWriter, "enqueue" | "close">,
		now: () => number = () => Date.now(),
	) {
		this.dir = dir;
		this.pi = pi;
		this.load = load;
		this.mode = mode;
		this.enabled = enabled;
		this.now = now;
		this.writer = writer ?? new PolicyWriter(dir, (reason) => this.recordingFailed(reason));
	}
	private recordingFailed(reason: string): void {
		this.telemetryFailure = reason;
		try {
			console.warn(`[policy] telemetry persistence stopped: ${reason}`);
		} catch {
			/* Reporting has no policy authority. */
		}
	}
	sync(snapshot: RuleSnapshot): void {
		const prior = this.effectiveActions;
		this.effectiveActions = new Map(
			[...snapshot.records.values()].map((record) => [record.id, effectiveEffect(record)]),
		);
		this.snapshot = snapshot;
		this.state.sync(
			[...snapshot.records.values()]
				.filter((r) => effectiveState(r) === "active" && r.matcherAvailable)
				.map(compileRule),
			this.now(),
		);
		for (const record of snapshot.records.values()) {
			const previous = prior.get(record.id);
			if (previous !== undefined && previous !== effectiveEffect(record))
				this.state.reset("effective-action-change", this.now(), record.id);
		}
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") this.retainedGuidance.clear();
		for (const [id, notice] of this.retainedGuidance)
			if (!samePin(notice.pin, this.state.pin(id))) this.retainedGuidance.delete(id);
	}
	reset(ids: string[] | undefined, reason: string): void {
		if (!reason.trim() || reason.length > 1000) throw new Error("A bounded reset reason is required");
		if (ids)
			for (const id of ids) {
				if (!this.state.pin(id)) throw new Error(`No active rule named ${id}`);
			}
		if (ids) for (const id of ids) {
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
		this.retainedGuidance.clear();
		this.generation++;
		this.turn = 0;
		this.state.reset(reason, this.now());
		for (const call of this.pending.values()) call.complete = false;
		this.ended.clear();
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
	private publicContext(snapshot: RuleSnapshot, catalog = this.catalog()): Record<string, unknown> {
		if (!catalog.available) return { turn: this.turn, catalogAvailable: false, tools: UNKNOWN };
		const names = new Set(catalog.tools.map((tool) => tool.name));
		const gather = (condition: Condition): void => {
			if ("all" in condition) for (const child of condition.all) gather(child);
			else if ("any" in condition) for (const child of condition.any) gather(child);
			else if ("not" in condition) gather(condition.not);
			else if (condition.path[0] === "context" && condition.path[1] === "tools" && condition.path[2])
				names.add(condition.path[2]);
		};
		for (const record of snapshot.records.values()) {
			if (effectiveState(record) !== "active") continue;
			const compiled = compileRule(record);
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
		snapshot: RuleSnapshot,
	): EvaluationContext {
		const catalog = this.catalog();
		return {
			tool,
			facts: { input, context: this.publicContext(snapshot, catalog) },
			states: this.states(),
			schema: catalog.tools.find((t) => t.name === tool)?.parameters,
			data: snapshotData([...snapshot.data.values()], this.now()),
			now: this.now(),
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
		const data = snapshotData(
			Object.values(call.context.data ?? {}).flatMap((source) => (source.data ? [source.data] : [])),
			now,
		);
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
		const input = inputSnapshot(args);
		const captured = input ? captureFor(tool, input) : undefined;
		const scope = sessionScope(ctx);
		const active = [...snapshot.records.values()].filter(
			(r) => effectiveState(r) === "active" && r.matcherAvailable && scopeMatches(r.definition.scope, scope),
		);
		const rules = active.map(compileRule);
		const context = { ...this.evaluationContext(tool, input, snapshot), scope };
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
	private track(call: ObservedCall): void {
		if (this.ended.has(call.callId) || !trackPending(this.pending, call)) this.incomplete++;
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
		if (this.closed || !this.enabled() || this.pending.has(event.toolCallId) || this.ended.has(event.toolCallId))
			return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		this.track(this.makeCall(event.toolName, event.toolCallId, event.args, ctx, snapshot));
	}
	async toolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		let call = this.pending.get(event.toolCallId);
		if (!call) {
			call = this.makeCall(event.toolName, event.toolCallId, event.input, ctx, snapshot);
			this.track(call);
		} else call.input = inputSnapshot(event.input);
		call.prepared = true;
		const refused = this.refuseUnavailableInput(call, ctx);
		if (refused) return refused;
		const plan = this.inputPlan(call, this.effectiveMode() === "enforce");
		for (const id of plan.matches) {
			call.matches.add(id);
			if (!call.classes.includes(id)) call.classes.push(id);
		}
		this.collect(call, plan.evaluations);
		call.corrections = plan.corrections;
		const activeMode = this.effectiveMode();
		const denied = this.applyInputCorrections(call, event, plan, plan.denied || !plan.valid);
		if (activeMode === "enforce" && denied) {
			call.decision =
				guidanceText(this.refusalNotes(call, plan, snapshot)) ??
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
	private applyInputCorrections(
		call: ObservedCall,
		event: ToolCallEvent,
		plan: InputPlan,
		denied: boolean,
	): boolean {
		if (this.effectiveMode() !== "enforce" || denied || !plan.changed) return denied;
		if (commitInput(event.input as Record<string, unknown>, plan.candidate)) {
			call.input = plan.candidate;
			call.effects.policy = { inputCorrected: true };
			return false;
		}
		return true;
	}

	/** Guidance lines for the rules behind one denied input plan, deduplicated in class order. */
	private refusalNotes(call: ObservedCall, plan: InputPlan, snapshot: RuleSnapshot): string[] {
		const ids = new Set([
			...call.classes,
			...plan.evaluations.filter((evaluation) => evaluation.deny).map((evaluation) => evaluation.id),
		]);
		return [...ids]
			.map((id) => snapshot.records.get(id))
			.filter((record): record is RuleRecord => record !== undefined)
			.map(ruleGuidance);
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
	): Promise<{ isError?: true; content?: ToolResultEvent["content"] } | undefined> {
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
		const text = this.guidance(guides);
		this.notice(call, ctx);
		if (text) {
			call.effects.annotationBytes = Buffer.byteLength(text, "utf8");
			return this.annotatedResult(text, event.content, correction);
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
		content: ToolResultEvent["content"],
		correction: boolean,
	): { isError?: true; content: ToolResultEvent["content"] } {
		return { ...(correction ? { isError: true as const } : {}), content: [...content, { type: "text", text }] };
	}
	private guidance(evaluations: ProgramEvaluation[], projected?: (id: string) => void): string | undefined {
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") return;
		const eligible = evaluations.filter(
			(e) => e.truth === true && e.action.kind === "guide" && this.state.eligible(e.id, this.now(), this.turn),
		);
		const selected: ProgramEvaluation[] = [];
		const lines: string[] = [];
		for (const entry of eligible) {
			if (entry.action.kind !== "guide") continue;
			const next = guidanceText([...lines, entry.action.text]);
			if (next === guidanceText(lines)) continue;
			lines.push(entry.action.text);
			selected.push(entry);
		}
		const text = guidanceText(lines);
		if (text) for (const entry of selected) {
			this.state.project(entry.id, this.now(), this.turn);
			projected?.(entry.id);
		}
		return text;
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
	private finishOutcome(call: ObservedCall, result: Result, event: { isError: boolean }, ctx: ExtensionContext): CallOutcome {
		const text = (result.content ?? [])
			.map((part) => part.text ?? "")
			.join("");
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
		const completion = evaluatePrograms(rules, "completion", this.contextFor(call, result, outcome))
			.filter((entry) => entry.action.kind !== "guide");
		const completionContext = this.contextFor(call, result, outcome);
		this.stale += call.rules.length - rules.length;
		for (const rule of rules) {
			const selected = observationSelected(rule, completionContext);
			const pin = call.pins.get(rule.id);
			if (pin && selected === true && !this.state.complete(pin, programFacts(rule, completionContext), call.turn, this.now()))
				this.stale++;
		}
		const guides = evaluatePrograms(rules, "completion", this.contextFor(call, result, outcome))
			.filter((entry) => entry.action.kind === "guide");
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
		evaluations: RowBundle;
		corrections: RowBundle;
		generations: RowBundle;
		dataSnapshots: RowBundle;
		metadata: RowBundle;
	} {
		return {
			evaluations: boundedRows(metadata(call.evaluations)),
			corrections: boundedRows(call.corrections),
			generations: boundedRows([...call.pins.values()]),
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
					evaluations: { total: rows.evaluations.total, omitted: rows.evaluations.omitted },
					corrections: { total: rows.corrections.total, omitted: rows.corrections.omitted },
					generations: { total: rows.generations.total, omitted: rows.generations.omitted },
					dataSnapshots: { total: rows.dataSnapshots.total, omitted: rows.dataSnapshots.omitted },
					metadata: { total: rows.metadata.total, omitted: rows.metadata.omitted },
				},
			},
		};
	}
	async context(ctx: ExtensionContext): Promise<string | undefined> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		const rules = [...snapshot.records.values()]
			.filter(
				(r) =>
					effectiveState(r) === "active" && r.matcherAvailable && scopeMatches(r.definition.scope, sessionScope(ctx)),
			)
			.map(compileRule);
		const evaluation = evaluatePrograms(rules, "context", {
			tool: "",
			facts: { context: this.publicContext(snapshot) },
			states: this.states(),
			data: snapshotData([...snapshot.data.values()], this.now()),
			now: this.now(),
			mode: this.effectiveMode(),
		});
		if (this.effectiveMode() === "notice" && ctx.mode === "tui") {
			const ids = evaluation
				.filter((e) => e.truth === true && this.state.eligible(e.id, this.now(), this.turn))
				.map((e) => e.id);
			if (ids.length)
				try {
					ctx.ui.notify(`[policy] ${ids.join(", ")}`, "warning");
				} catch {
					/* Notice does not change guidance state. */
				}
		}
		for (const [id, notice] of this.retainedGuidance)
			if (!rules.some((rule) => rule.id === id) || !samePin(notice.pin, this.state.pin(id)))
				this.retainedGuidance.delete(id);
		const retained = [...this.retainedGuidance.values()].map(({ evaluation: entry }) => entry);
		return this.guidance([...retained, ...evaluation], (id) => this.retainedGuidance.delete(id));
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
		};
	}

	private inspectHealth(snapshot: RuleSnapshot): unknown {
		return {
			authority: snapshot.health,
			telemetry: this.telemetryFailure ? { status: "failed", reason: this.telemetryFailure } : { status: "ready" },
			observations: { incomplete: this.incomplete, pending: this.pending.size, recentCompletedIds: this.ended.size },
		};
	}

	private inspectCapabilities(): unknown {
		const catalog = this.catalog();
		return {
			phases: ["input", "result", "completion", "context"],
			actions: ["deny", "rename-key", "substitute", "assert-error", "guide", "observe"],
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
			projection: "context, no new turn",
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
		const period = this.state.view(record.id, this.now(), this.turn);
		return {
			id: record.id,
			revision: record.definition.revision,
			active: effectiveState(record),
			programs: programSteps(compileRule(record)).map((rule) => rule.program),
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
		return {
			preview: true,
			stateAdvanced: false,
			mode: this.effectiveMode(),
			executionInput: call.input,
			wouldCorrectInput: this.effectiveMode() === "enforce" && plan.valid && !plan.denied && plan.changed,
			input: plan,
			results: results ? [...results.semantic, ...results.guides] : [],
			resultCorrected: results?.correction ?? false,
			boundary: "No simulated tool executes. The actual inspection call retains ordinary telemetry.",
		};
	}
	attach(): void {
		this.pi.on("session_start", (event) => {
			this.closed = false;
			this.resetSession(event.reason ?? "startup");
			this.enabled();
		});
		this.pi.on("session_tree", () => this.resetSession("tree"));
		this.pi.on("turn_start", () => {
			this.turn++;
		});
		this.pi.on("tool_execution_start", (event, ctx) => this.toolStart(event, ctx));
		this.pi.on("tool_call", (event, ctx) => this.toolCall(event, ctx));
		this.pi.on("tool_result", (event, ctx) => this.toolResult(event, ctx));
		this.pi.on("tool_execution_end", (event, ctx) => this.toolEnd(event, ctx));
		this.pi.on("context", async (event, ctx) => {
			const text = await this.context(ctx);
			if (text)
				return {
					messages: [
						...event.messages,
						{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: this.now() },
					],
				};
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
