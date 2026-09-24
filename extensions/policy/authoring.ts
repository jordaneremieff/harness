/** Read-only draft checks use isolated instances of the production runtime. */
import { readFile, stat } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { ruleScopeMatches } from "./classify.ts";
import { snapshotData } from "./data.ts";
import {
	assertProposalTransition,
	type LocalRuleCandidate,
	type ProposalEvent,
	type RuleSnapshot,
	validateRuleEvent,
} from "./local-rules.ts";
import type { PolicyRecord } from "./record.ts";
import { actionEffect, declaredAction, ruleDefinitionRevision, type RuleRecord } from "./rule.ts";
import { PolicyRuntime, relevantEvaluations } from "./runtime.ts";
import { hasCodeMatcher } from "./shell-rules.ts";

export const AUTHORING_LIMITS = {
	cases: 16,
	steps: 64,
	milliseconds: 86400000,
	turns: 64,
	guideBytes: 24576,
	outputBytes: 24576,
};
const ResultSchema = Type.Object(
	{
		isError: Type.Boolean(),
		details: Type.Optional(Type.Unknown()),
		content: Type.Optional(
			Type.Array(
				Type.Object(
					{ type: Type.Literal("text"), text: Type.String({ maxLength: 65536 }) },
					{ additionalProperties: false },
				),
				{ maxItems: 64 },
			),
		),
	},
	{ additionalProperties: false },
);
const ExpectedSchema = Type.Object(
	{
		denied: Type.Optional(Type.Boolean()),
		correctedInput: Type.Optional(Type.Boolean()),
		resultError: Type.Optional(Type.Boolean()),
		guidance: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const StepFields = {
	at: Type.Integer({ minimum: 0, maximum: AUTHORING_LIMITS.milliseconds }),
	turn: Type.Integer({ minimum: 0, maximum: AUTHORING_LIMITS.turns }),
	expect: Type.Optional(ExpectedSchema),
};
export const DraftCasesSchema = Type.Array(
	Type.Object(
		{
			name: Type.String({ minLength: 1, maxLength: 100 }),
			scope: Type.Optional(
				Type.Object(
					{
						provider: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
						model: Type.Optional(Type.String({ minLength: 3, maxLength: 200, pattern: "^[^/]+/.+" })),
						cwd: Type.String({ minLength: 1, maxLength: 500, pattern: "^(?:/|[A-Za-z]:[\\\\/])" }),
					},
					{ additionalProperties: false },
				),
			),
			steps: Type.Array(
				Type.Union([
					Type.Object(
						{
							kind: Type.Literal("call"),
							...StepFields,
							tool: Type.String({ minLength: 1, maxLength: 200 }),
							input: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 128 }),
							result: Type.Optional(ResultSchema),
						},
						{ additionalProperties: false },
					),
					Type.Object({ kind: Type.Literal("context"), ...StepFields }, { additionalProperties: false }),
				]),
				{ minItems: 1, maxItems: AUTHORING_LIMITS.steps },
			),
		},
		{ additionalProperties: false },
	),
	{ maxItems: AUTHORING_LIMITS.cases },
);
export type DraftCase = Static<typeof DraftCasesSchema>[number];
type DraftStep = DraftCase["steps"][number];
export interface ParsedDraft {
	candidate: LocalRuleCandidate;
	operation: "add" | "replace";
	reason: string;
	expectedRevision?: string;
}
export type ParseDraft = (value: unknown) => ParsedDraft;
const casesValidator = Compile(DraftCasesSchema);

function validateCaseSequence(entry: DraftCase): void {
	if (entry.scope?.provider && !entry.scope.model)
		throw new Error("simulated provider requires a provider/model identity");
	if (entry.scope?.model && entry.scope.provider && !entry.scope.model.startsWith(`${entry.scope.provider}/`))
		throw new Error("simulated model must belong to the simulated provider");
	let at = 0;
	let turn = 0;
	for (const step of entry.steps) {
		if (step.at < at || step.turn < turn) throw new Error("check time and turn must not decrease within a case");
		at = step.at;
		turn = step.turn;
		if (step.kind === "context" && step.expect && Object.keys(step.expect).some((key) => key !== "guidance"))
			throw new Error("context expectations support guidance only");
	}
}

export function validateDraftCases(value: unknown): asserts value is DraftCase[] {
	if (!casesValidator.Check(value))
		throw new Error("check cases require bounded names, scope, steps, times, turns, and text-only results");
	let total = 0;
	const names = new Set<string>();
	for (const entry of value as DraftCase[]) {
		if (names.has(entry.name)) throw new Error("check case names must be unique");
		names.add(entry.name);
		total += entry.steps.length;
		if (total > AUTHORING_LIMITS.steps) throw new Error("check exceeds the total step bound");
		validateCaseSequence(entry);
	}
}

export async function authoringGuide(): Promise<string> {
	const path = new URL("./AUTHORING.md", import.meta.url);
	if ((await stat(path)).size > AUTHORING_LIMITS.guideBytes) throw new Error("authoring guide exceeds its byte bound");
	const guide = await readFile(path, "utf8");
	if (Buffer.byteLength(guide, "utf8") > AUTHORING_LIMITS.guideBytes)
		throw new Error("authoring guide exceeds its byte bound");
	return guide;
}

function draftRecord(draft: ParsedDraft, effect: unknown, snapshot: RuleSnapshot): RuleRecord {
	const candidate = draft.candidate;
	const selectable = candidate.authority === "steer-or-block";
	if (selectable ? effect !== "steer" && effect !== "block" : effect !== undefined)
		throw new Error(
			selectable
				? "selectable drafts require simulated effect steer or block"
				: "exact drafts do not accept a simulated effect",
		);
	const resolved = selectable
		? (effect as "steer" | "block")
		: actionEffect(declaredAction({ matcher: candidate.matcher, definition: candidate }));
	const { id, matcher, ...definition } = candidate;
	const existing = snapshot.records.get(id);
	return {
		id,
		// This record exists only in the isolated execution snapshot; no provenance is published.
		source: { kind: "package" },
		matcher: structuredClone(matcher),
		definition: {
			...structuredClone(definition),
			effect: resolved,
			state: "active",
			revision: ruleDefinitionRevision({ ...candidate, effect: resolved }),
		},
		...(existing?.override ? { override: structuredClone(existing.override) } : {}),
		matcherAvailable: true,
		staleOverride: !!existing?.override,
	};
}

function admission(draft: ParsedDraft, snapshot: RuleSnapshot): void {
	const { id, ...candidate } = draft.candidate;
	const event = validateRuleEvent({
		kind: "proposal",
		id: "00000000-0000-4000-8000-000000000000",
		operation: draft.operation,
		ruleId: id,
		reason: draft.reason,
		candidate,
		...(draft.expectedRevision ? { expectedRevision: draft.expectedRevision } : {}),
		audit: { surface: "agent-tool", at: "2000-01-01T00:00:00.000Z", session: "draft-check", model: null },
	}) as ProposalEvent;
	if (candidate.matcher.kind === "code" && !hasCodeMatcher(candidate.matcher.key))
		throw new Error("draft references an unavailable installed predicate");
	assertProposalTransition(event, snapshot);
}

function caseContext(ctx: ExtensionContext, scope: DraftCase["scope"]): ExtensionContext {
	const provider = scope?.provider ?? scope?.model?.slice(0, scope.model.indexOf("/"));
	const id = scope?.model?.slice((scope.model?.indexOf("/") ?? -1) + 1);
	return {
		...ctx,
		hasUI: false,
		mode: "print",
		signal: undefined,
		getSystemPrompt: () => "",
		sessionManager: { getSessionId: () => "draft-check" },
		...(scope ? { cwd: scope.cwd, model: provider && id ? { provider, id } : undefined } : {}),
	} as ExtensionContext;
}

function caseScope(ctx: ExtensionContext) {
	return {
		provider: ctx.model?.provider,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		cwd: ctx.cwd,
	};
}
function expectations(step: DraftStep, actual: Record<string, unknown>): string[] {
	return Object.entries(step.expect ?? {}).flatMap(([key, expected]) =>
		actual[key] === expected ? [] : [`${key}: expected ${expected}, received ${JSON.stringify(actual[key])}`],
	);
}

function capturedCatalog(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
): Pick<ExtensionAPI, "getAllTools" | "getActiveTools"> {
	try {
		const tools = structuredClone(pi.getAllTools().map(({ name, parameters }) => ({ name, parameters })));
		const active = [...pi.getActiveTools()];
		return { getAllTools: () => tools, getActiveTools: () => active } as Pick<
			ExtensionAPI,
			"getAllTools" | "getActiveTools"
		>;
	} catch {
		return {
			getAllTools: () => {
				throw new Error("captured public tool catalog unavailable");
			},
			getActiveTools: () => [],
		};
	}
}

async function runCase(
	entry: DraftCase,
	snapshot: RuleSnapshot,
	record: RuleRecord,
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
	ctx: ExtensionContext,
	capturedAt: number,
) {
	const context = caseContext(ctx, entry.scope);
	let now = capturedAt;
	let turn = 0;
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	const records: PolicyRecord[] = [];
	const catalog = capturedCatalog(pi);
	const isolatedPi = {
		...catalog,
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			hooks.set(name, handler);
			return () => hooks.delete(name);
		},
	} as unknown as ExtensionAPI;
	const runtime = new PolicyRuntime(
		isolatedPi,
		async () => snapshot,
		() => "enforce",
		"",
		() => true,
		{
			enqueue: (row: PolicyRecord) => {
				records.push(row);
				return true;
			},
			close: async () => {},
		},
		() => now,
	);
	runtime.sync(snapshot);
	runtime.attach();
	const rows: unknown[] = [];
	for (const [index, step] of entry.steps.entries()) {
		now = capturedAt + step.at;
		while (turn < step.turn) {
			await hooks.get("turn_start")?.({ type: "turn_start" }, context);
			turn++;
		}
		if (step.kind === "context") {
			const text = await runtime.context(context);
			const actual = { guidance: !!text };
			rows.push({
				kind: step.kind,
				at: step.at,
				turn: step.turn,
				...actual,
				text,
				mismatches: expectations(step, actual),
			});
			continue;
		}
		const input = structuredClone(step.input);
		const identity = { toolName: step.tool, toolCallId: `check-${index}` };
		await runtime.toolStart({ ...identity, args: input }, context);
		const denied = await runtime.toolCall(
			{ type: "tool_call", ...identity, input } as Parameters<PolicyRuntime["toolCall"]>[0],
			context,
		);
		let result: { isError: boolean; content: Array<{ type: "text"; text: string }>; details?: unknown } = {
			isError: true,
			content: [],
		};
		if (denied) {
			result.content = [{ type: "text", text: denied.reason }];
		} else if (step.result) {
			result = { ...structuredClone(step.result), content: structuredClone(step.result.content ?? []) };
			const patch = await runtime.toolResult(
				{ type: "tool_result", ...identity, input, ...result } as Parameters<PolicyRuntime["toolResult"]>[0],
				context,
			);
			result = { ...result, ...patch } as typeof result;
		}
		// An omitted result describes an unexecuted call, never an invented successful execution.
		await runtime.toolEnd({ ...identity, result, isError: result.isError }, context);
		const latest = records.at(-1);
		const actual = {
			denied: !!denied,
			correctedInput: latest?.policy?.inputCorrected === true,
			resultError: result.isError,
			guidance: latest?.annotated === true,
		};
		const evaluations = (latest?.policy?.evaluations ?? []) as Array<{
			id: string; phase: string; truth: unknown; unavailable: boolean; deny: boolean;
		}>;
		const relevant = relevantEvaluations(evaluations);
		const relevantIds = new Set(relevant.map((entry) => entry.id));
		rows.push({
			kind: step.kind,
			at: step.at,
			turn: step.turn,
			...actual,
			input,
			inputEvaluations: relevant.filter((entry) => entry.phase === "input"),
			resultEvaluations: relevant.filter((entry) => entry.phase === "result"),
			completionEvaluations: relevant.filter((entry) => entry.phase === "completion"),
			nonMatchingRules: new Set(evaluations.filter((entry) => !relevantIds.has(entry.id)).map((entry) => entry.id)).size,
			coverage: latest?.policy?.coverage,
			corrections: latest?.policy?.corrections,
			metadata: latest?.policy?.metadata,
			outcome: latest?.outcome,
			mismatches: expectations(step, actual),
		});
	}
	const state = await runtime.inspect("state", {}, context) as {
		observationPeriods: Array<{ id: string }>;
		retainedGuidance: Array<{ id: string }>;
	};
	await hooks.get("session_shutdown")?.({}, context);
	return {
		name: entry.name,
		scope: caseScope(context),
		scopeMatches: ruleScopeMatches(record.definition.scope, caseScope(context)),
		rows,
		state: {
			observationPeriods: state.observationPeriods.filter((entry) => entry.id === record.id),
			retainedGuidance: state.retainedGuidance.filter((entry) => entry.id === record.id),
		},
	};
}

type Diagnostic = { severity: "error" | "warning"; message: string };
function draftWarnings(
	record: RuleRecord,
	snapshot: RuleSnapshot,
	ctx: ExtensionContext,
	capturedAt: number,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const data = snapshotData([...snapshot.data.values()], capturedAt);
	const spec =
		record.matcher.kind === "declarative" && record.matcher.language === "facts/v1" ? record.matcher.spec : undefined;
	for (const name of spec?.data ?? []) {
		const status = data[name]?.status ?? "missing";
		if (status !== "ready")
			diagnostics.push({
				severity: "warning",
				message: `Data ${name} is ${status}; simulation does not create bindings.`,
			});
	}
	if (!ruleScopeMatches(record.definition.scope, caseScope(ctx)))
		diagnostics.push({ severity: "warning", message: "Draft scope excludes the current session." });
	if (snapshot.health.status === "degraded" || snapshot.health.incompleteFinalLine)
		diagnostics.push({
			severity: "warning",
			message: "Registry authority is unavailable; a declaration check does not authorize submission or enforcement.",
		});
	if (record.override?.state === "disabled")
		diagnostics.push({ severity: "warning", message: "Replacement preserves the current disabled override." });
	return diagnostics;
}

/** Admission diagnostics never grant authority; examples run with copied state and a captured public catalog. */
export async function checkDraft(
	params: Record<string, unknown>,
	snapshot: RuleSnapshot,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	parse: ParseDraft,
): Promise<unknown> {
	let draft: ParsedDraft;
	let record: RuleRecord;
	try {
		draft = parse(params.draft);
		admission(draft, snapshot);
		record = draftRecord(draft, params.effect, snapshot);
	} catch (error) {
		return {
			check: true,
			admitted: false,
			diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : String(error) }],
			cases: [],
			authorityChanged: false,
		};
	}
	const capturedAt = Date.now();
	const diagnostics = draftWarnings(record, snapshot, ctx, capturedAt);
	const isolated = structuredClone(snapshot);
	isolated.records.set(record.id, record);
	const cases = params.cases ?? [];
	validateDraftCases(cases);
	const results: unknown[] = [];
	const catalog = capturedCatalog(pi);
	let bytes = 0;
	for (const entry of cases) {
		const result = await runCase(entry, isolated, record, catalog, ctx, capturedAt);
		const size = Buffer.byteLength(JSON.stringify(result), "utf8");
		if (bytes + size > AUTHORING_LIMITS.outputBytes) {
			results.push({
				name: entry.name,
				unavailable: "case output exceeds the aggregate byte bound; use fewer rules or shorter examples",
			});
			break;
		}
		results.push(result);
		bytes += size;
	}
	return {
		check: true,
		admitted: true,
		draft: { id: record.id, revision: record.definition.revision, operation: draft.operation },
		diagnostics,
		simulation: {
			mode: "enforce",
			effectiveMode: snapshot.health.status === "degraded" ? "notice" : "enforce",
			effect: record.definition.effect,
			capturedAt,
			authorityChanged: false,
			liveStateAdvanced: false,
		},
		cases: results,
		omittedCases: cases.length - results.length,
		boundary:
			"Synthetic examples use the production runtime without tool execution or stored proposals. Checks do not infer intent, establish host/provider acceptance, or grant approval. The actual inspection call retains ordinary telemetry.",
	};
}
