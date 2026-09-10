/** One event interpreter for approved plans, corrections, observations, and guidance. */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { captureFor, matchRuleRecords, ruleScopeMatches as scopeMatches } from "./classify.ts";
import { cloneJson, snapshotData, UNKNOWN } from "./data.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { PolicyMode } from "./mode.ts";
import { readRecentActivity } from "./panel.ts";
import {
	evaluatePrograms,
	GUIDANCE_BYTES,
	GUIDANCE_PREFIX,
	planInput,
	programFacts,
	type Condition,
	type EvaluationContext,
	type InputPlan,
	type ProgramEvaluation,
	type ProgramRule,
} from "./program.ts";
import {
	finishCall,
	startCall,
	trackPending,
	textContentBytes,
	type CallEffects,
	type CallOutcome,
	type ContentLike,
	type PendingCall,
	type SessionFacts,
} from "./record.ts";
import { effectiveEffect, effectiveState, ruleGuidance, type RuleRecord } from "./rule.ts";
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
	scope: ReturnType<typeof sessionScope>;
	shell: RuleRecord[];
	shellCandidates: RuleRecord[];
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
	return evaluations.map(({ id, revision, truth, action, unavailable, deny }) => ({
		id,
		revision,
		truth,
		action: action.kind,
		unavailable,
		deny,
	}));
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
function shellProgram(record: RuleRecord, phase: "input" | "result" = "input"): ProgramRule {
	const guide = phase === "result" || effectiveEffect(record) === "steer";
	return {
		id: record.id,
		revision: record.definition.revision,
		program: {
			phase: guide ? "result" : "input",
			...(guide ? {} : { inputView: "original" as const }),
			when: guide ? { op: "eq", path: ["result", "isError"], value: false } : { op: "exists", path: ["input"] },
			action: guide ? { kind: "guide", text: ruleGuidance(record) } : { kind: "deny" },
			onUnavailable: "skip",
			state: { observe: { op: "eq", path: ["outcome", "kind"], value: "success" }, once: "period" },
		},
	};
}
function program(record: RuleRecord): ProgramRule {
	if (record.matcher.kind === "declarative" && record.matcher.language === "facts/v1") {
		return { id: record.id, revision: record.definition.revision, program: record.matcher.spec };
	}
	return shellProgram(record);
}
function isFacts(record: RuleRecord): boolean {
	return record.matcher.kind === "declarative" && record.matcher.language === "facts/v1";
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
	private snapshot?: RuleSnapshot;
	private generation = 0;
	private turn = 0;
	private closed = false;
	private telemetryFailure?: string;
	private incomplete = 0;
	private stale = 0;
	private readonly writer: PolicyWriter;
	private readonly dir: string;
	private readonly pi: ExtensionAPI;
	private readonly load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>;
	private readonly mode: () => PolicyMode;
	private readonly enabled: () => boolean;
	constructor(
		pi: ExtensionAPI,
		load: (ctx?: ExtensionContext) => Promise<RuleSnapshot>,
		mode: () => PolicyMode,
		dir: string,
		enabled: () => boolean = () => true,
		writer?: PolicyWriter,
	) {
		this.dir = dir;
		this.pi = pi;
		this.load = load;
		this.mode = mode;
		this.enabled = enabled;
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
		const prior = this.snapshot;
		this.snapshot = snapshot;
		this.state.sync(
			[...snapshot.records.values()].filter((r) => effectiveState(r) === "active" && r.matcherAvailable).map(program),
			Date.now(),
		);
		for (const record of snapshot.records.values()) {
			const previous = prior?.records.get(record.id);
			if (previous && effectiveEffect(previous) !== effectiveEffect(record))
				this.state.reset("effective-action-change", Date.now(), record.id);
		}
	}
	reset(ids: string[] | undefined, reason: string): void {
		if (!reason.trim() || reason.length > 1000) throw new Error("A bounded reset reason is required");
		if (ids)
			for (const id of ids) {
				if (!this.state.pin(id)) throw new Error(`No active rule named ${id}`);
			}
		if (ids) for (const id of ids) this.state.reset(reason, Date.now(), id);
		else {
			this.generation++;
			for (const call of this.pending.values()) call.complete = false;
			this.state.reset(reason, Date.now());
		}
	}
	private live(generation: number): boolean {
		return !this.closed && generation === this.generation;
	}
	private resetSession(reason: string): void {
		this.generation++;
		this.turn = 0;
		this.state.reset(reason, Date.now());
		for (const call of this.pending.values()) call.complete = false;
		this.ended.clear();
	}
	private effectiveMode(): PolicyMode {
		return this.snapshot?.health.status === "degraded" && this.mode() !== "observe" ? "notice" : this.mode();
	}
	private states() {
		return Object.fromEntries(this.state.snapshot(Date.now(), this.turn).map((view) => [view.id, view]));
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
			if (effectiveState(record) !== "active" || !isFacts(record)) continue;
			const spec = program(record).program;
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
			data: snapshotData([...snapshot.data.values()], Date.now()),
			now: Date.now(),
		};
	}
	private currentRules(call: ObservedCall): ProgramRule[] {
		if (call.generation !== this.generation) return [];
		return call.rules.filter((rule) => samePin(call.pins.get(rule.id), this.state.pin(rule.id)));
	}
	/** Candidate command checks share the same plan and commit boundary as facts checks. */
	private inputPlan(call: ObservedCall, applyCorrections = true): { plan: InputPlan; shell: RuleRecord[] } {
		const input = call.input!;
		const context = { ...this.contextFor(call), applyCorrections };
		const plan = planInput(this.currentRules(call), input, context);
		if (!plan.valid || plan.denied) return { plan, shell: [] };
		if (
			applyCorrections &&
			plan.changed &&
			call.shellCandidates.some((record) => !samePin(call.pins.get(record.id), this.state.pin(record.id)))
		) {
			plan.valid = false;
			plan.changed = false;
			plan.candidate = cloneJson(input);
			plan.problems.push("Command rule observation periods changed before candidate validation");
			return { plan, shell: [] };
		}
		const effectiveInput = applyCorrections ? plan.candidate : input;
		const captured = captureFor(call.tool, effectiveInput);
		const eligible =
			call.generation === this.generation
				? call.shellCandidates.filter((record) => samePin(call.pins.get(record.id), this.state.pin(record.id)))
				: [];
		const shell = captured === undefined ? [] : matchRuleRecords(call.tool, captured, eligible, call.scope);
		const gates = shell
			.filter((record) => effectiveEffect(record) === "block")
			.map((record) => {
				const gate = shellProgram(record);
				return { ...gate, program: { ...gate.program, inputView: "effective" as const } };
			});
		const evaluations = evaluatePrograms(gates, "input", {
			...context,
			facts: { ...context.facts, input: effectiveInput },
		});
		plan.evaluations.push(...evaluations);
		if (evaluations.some((evaluation) => evaluation.deny)) {
			plan.denied = true;
			plan.changed = false;
			plan.candidate = cloneJson(input);
		}
		return { plan, shell };
	}
	private facts(call: ObservedCall, result?: Result, outcome?: CallOutcome): Record<string, unknown> {
		return {
			input: call.input,
			original: call.requested,
			context: call.context.facts?.context,
			result: result ? { ...result, isError: result.isError === true } : undefined,
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
		const now = Date.now();
		const data = snapshotData(
			Object.values(call.context.data ?? {}).flatMap((source) => (source.data ? [source.data] : [])),
			now,
		);
		return { ...call.context, data, facts: this.facts(call, result, outcome), states: this.states(), now };
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
		const shellCandidates = active.filter((record) => !isFacts(record)).map((record) => structuredClone(record));
		const shell = captured === undefined ? [] : matchRuleRecords(tool, captured, shellCandidates, scope);
		const rules = [...active.filter(isFacts).map(program), ...shell.map((r) => shellProgram(r))];
		return {
			...startCall(tool, id, input ?? {}, new Date(), performance.now(), captured ?? null),
			classes: shell.map((record) => record.id),
			requested: input,
			input,
			rules,
			shell,
			shellCandidates,
			pins: new Map(
				active.flatMap((rule) => {
					const pin = this.state.pin(rule.id);
					return pin ? [[rule.id, pin] as const] : [];
				}),
			),
			context: this.evaluationContext(tool, input, snapshot),
			scope,
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
		call.classes = [
			...new Set([...call.classes, ...evaluations.filter((e) => e.truth === true || e.unavailable).map((e) => e.id)]),
		];
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
		if (!call.input) {
			call.complete = false;
			this.incomplete++;
			const rules = this.currentRules(call);
			const evaluations = evaluatePrograms(rules, "input", this.contextFor(call)).map((e) => {
				if (e.truth === false || e.action.kind === "deny") return e;
				const rule = rules.find((rule) => rule.id === e.id)!;
				return { ...e, truth: "unknown" as const, unavailable: true, deny: rule.program.onUnavailable === "deny" };
			});
			this.collect(call, evaluations);
			this.notice(call, ctx);
			if (this.effectiveMode() === "enforce" && evaluations.some((e) => e.deny)) {
				call.decision = "[policy] An approved input check refused unavailable input.";
				return { block: true, reason: call.decision };
			}
			return;
		}
		const { plan, shell } = this.inputPlan(call, this.effectiveMode() === "enforce");
		for (const record of shell) {
			if (!call.shell.some((matched) => matched.id === record.id)) {
				call.shell.push(record);
				call.rules.push(shellProgram(record));
			}
			if (!call.classes.includes(record.id)) call.classes.push(record.id);
		}
		this.collect(call, plan.evaluations);
		call.corrections = plan.corrections;
		const activeMode = this.effectiveMode();
		let denied = plan.denied || !plan.valid;
		if (activeMode === "enforce" && !denied && plan.changed) {
			if (commitInput(event.input as Record<string, unknown>, plan.candidate)) {
				call.input = plan.candidate;
				call.effects.policy = { inputCorrected: true };
			} else denied = true;
		}
		if (activeMode === "enforce" && denied) {
			const notes = call.classes
				.map((id) => snapshot.records.get(id))
				.filter((r): r is RuleRecord => r !== undefined)
				.map(ruleGuidance);
			call.decision = guidanceText(notes) ?? "[policy] The approved input checks refused this call.";
			this.notice(call, ctx);
			return { block: true, reason: call.decision };
		}
		this.notice(call, ctx);
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
		call.resultSeen = true;
		call.preGuidanceBytes = textContentBytes(event.content);
		const actual = inputSnapshot(event.input);
		if (actual) call.input = actual;
		else call.complete = false;
		const rules = this.currentRules(call);
		let result: Result = { content: event.content, details: event.details, isError: event.isError, usage: event.usage };
		const semantic = evaluatePrograms(rules, "result", this.contextFor(call, result)).filter(
			(e) => e.action.kind !== "guide",
		);
		this.collect(call, semantic);
		const correction =
			this.effectiveMode() === "enforce" &&
			event.isError !== true &&
			semantic.some((e) => e.truth === true && e.action.kind === "assert-error");
		if (correction) result = { ...result, isError: true };
		const shell = call.shell
			.filter(
				(r) => rules.some((rule) => rule.id === r.id) && (this.mode() === "annotate" || effectiveEffect(r) === "steer"),
			)
			.map((r) => shellProgram(r, "result"));
		const guides = evaluatePrograms(
			[...rules.filter((rule) => !call.shell.some((r) => r.id === rule.id)), ...shell],
			"result",
			this.contextFor(call, result),
		).filter((e) => e.action.kind === "guide");
		this.collect(call, guides);
		const text = this.guidance(guides);
		this.notice(call, ctx);
		if (text) {
			call.effects.annotationBytes = Buffer.byteLength(text, "utf8");
			return { ...(correction ? { isError: true as const } : {}), content: [...event.content, { type: "text", text }] };
		}
		if (correction) return { isError: true };
	}
	private guidance(evaluations: ProgramEvaluation[]): string | undefined {
		if (this.effectiveMode() !== "annotate" && this.effectiveMode() !== "enforce") return;
		const eligible = evaluations.filter(
			(e) => e.truth === true && e.action.kind === "guide" && this.state.eligible(e.id, Date.now(), this.turn),
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
		if (text) for (const entry of selected) this.state.project(entry.id, Date.now(), this.turn);
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
		if (this.ended.size >= MAX_FINAL_IDS) {
			const oldest = this.ended.values().next().value;
			if (oldest !== undefined) this.ended.delete(oldest);
		}
		this.ended.add(event.toolCallId);
		const result = { ...object(event.result), isError: event.isError } as Result;
		const text = (result.content ?? []).map((p) => p.text ?? "").join("");
		call.abortRequested = ctx.signal?.aborted === true;
		call.outputBytes = textContentBytes(result.content);
		const outcome: CallOutcome = call.resultSeen
			? event.isError
				? "execution-error"
				: "success"
			: call.decision && text === call.decision
				? "denied"
				: "unexecuted";
		const rules = this.currentRules(call);
		const completion = evaluatePrograms(rules, "completion", this.contextFor(call, result, outcome));
		this.collect(call, completion);
		const completionContext = this.contextFor(call, result, outcome);
		this.stale += call.rules.length - rules.length;
		for (const rule of rules) {
			const selected = evaluatePrograms(
				[{ ...rule, program: { ...rule.program, phase: "completion", when: { op: "exists", path: ["tool"] } } }],
				"completion",
				completionContext,
			)[0];
			const pin = call.pins.get(rule.id);
			if (
				pin &&
				selected?.truth === true &&
				!this.state.complete(pin, programFacts(rule, completionContext), call.turn, Date.now())
			)
				this.stale++;
		}
		this.notice(call, ctx);
		const details = object(result.details);
		const truncation = object(details?.truncation);
		const usage = object(result.usage);
		const evaluations = boundedRows(metadata(call.evaluations));
		const corrections = boundedRows(call.corrections);
		const generations = boundedRows([...call.pins.values()]);
		const dataNames = new Set([
			...Object.keys(call.context.data ?? {}),
			...call.rules.flatMap((rule) => rule.program.data ?? []),
		]);
		const dataSnapshots = boundedRows(
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
		const observed = boundedRows(
			completion
				.filter((e) => e.truth === true && e.action.kind === "observe")
				.map((e) => ({ id: e.id, label: e.action.kind === "observe" ? e.action.label : "" })),
		);
		const effects: CallEffects = {
			...call.effects,
			outcome,
			abortRequested: call.abortRequested,
			blocked: outcome === "denied",
			observationComplete: call.complete && outcome !== "unexecuted",
			policy: {
				...call.effects.policy,
				decision: call.decision ? "deny" : "none",
				...(call.preGuidanceBytes !== undefined ? { preGuidanceBytes: call.preGuidanceBytes } : {}),
				evaluations: evaluations.rows,
				corrections: corrections.rows,
				generations: generations.rows,
				dataSnapshots: dataSnapshots.rows,
				metadata: observed.rows,
				coverage: {
					evaluations: { total: evaluations.total, omitted: evaluations.omitted },
					corrections: { total: corrections.total, omitted: corrections.omitted },
					generations: { total: generations.total, omitted: generations.omitted },
					dataSnapshots: { total: dataSnapshots.total, omitted: dataSnapshots.omitted },
					metadata: { total: observed.total, omitted: observed.omitted },
				},
			},
		};
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
	async context(ctx: ExtensionContext): Promise<string | undefined> {
		if (this.closed || !this.enabled()) return;
		const generation = this.generation;
		const snapshot = await this.load(ctx);
		if (!this.live(generation)) return;
		const rules = [...snapshot.records.values()]
			.filter(
				(r) =>
					isFacts(r) &&
					effectiveState(r) === "active" &&
					r.matcherAvailable &&
					scopeMatches(r.definition.scope, sessionScope(ctx)),
			)
			.map(program);
		const evaluation = evaluatePrograms(rules, "context", {
			tool: "",
			facts: { context: this.publicContext(snapshot) },
			states: this.states(),
			data: snapshotData([...snapshot.data.values()], Date.now()),
			now: Date.now(),
		});
		if (this.effectiveMode() === "notice" && ctx.mode === "tui") {
			const ids = evaluation
				.filter((e) => e.truth === true && this.state.eligible(e.id, Date.now(), this.turn))
				.map((e) => e.id);
			if (ids.length)
				try {
					ctx.ui.notify(`[policy] ${ids.join(", ")}`, "warning");
				} catch {
					/* Notice does not change guidance state. */
				}
		}
		return this.guidance(evaluation);
	}
	async inspect(view: string, params: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
		const snapshot = view === "preview" && this.snapshot ? this.snapshot : await this.load(ctx);
		if (view === "state")
			return {
				observationPeriods: publicState(this.state.snapshot(Date.now(), this.turn)),
				turn: this.turn,
				incomplete: this.incomplete,
				staleCompletions: this.stale,
			};
		if (view === "health")
			return {
				authority: snapshot.health,
				telemetry: this.telemetryFailure ? { status: "failed", reason: this.telemetryFailure } : { status: "ready" },
				observations: { incomplete: this.incomplete, pending: this.pending.size, recentCompletedIds: this.ended.size },
			};
		if (view === "capabilities") {
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
				innerSchemas: "Approved named schema bindings only",
				observationStorage: "memory",
				projection: "context, no new turn",
			};
		}
		if (view === "explain") {
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
			const period = this.state.view(record.id, Date.now(), this.turn);
			return {
				id: record.id,
				revision: record.definition.revision,
				active: effectiveState(record),
				program: program(record).program,
				scope: record.definition.scope,
				observationPeriod: period ? publicState([period])[0] : undefined,
			};
		}
		if (view === "preview") {
			if (typeof params.tool !== "string" || !params.tool || params.tool.length > 200)
				throw new Error("A bounded preview tool name is required");
			const input = inputSnapshot(params.input);
			if (!input) throw new Error("Preview input must be bounded JSON");
			const call = this.makeCall(params.tool, "preview", input, ctx, snapshot);
			const { plan } = this.inputPlan(call);
			const result = object(params.result);
			return {
				preview: true,
				stateAdvanced: false,
				input: plan,
				results: result
					? evaluatePrograms(
							call.rules,
							"result",
							this.contextFor(call, { details: result.details, isError: result.isError === true }),
						)
					: [],
				boundary: "No simulated tool executes. The actual inspection call retains ordinary telemetry.",
			};
		}
		throw new Error(`Unknown policy view: ${view}`);
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
						{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() },
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
