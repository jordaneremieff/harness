/** Agent proposal and read-only unified rule tools. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ruleScopeVisibility } from "./classify.ts";
import { contentRevision, effectiveEffect, effectiveState, factsProgram, type OperatorRuleAudit } from "./rule.ts";
import { FactsProgramSchema } from "./program.ts";
import { snapshotData, validateNamedData, type NamedData } from "./data.ts";
import {
	makeRuleAudit,
	namedDataRevision,
	proposalRevision,
	validateLocalCandidate,
	MAX_RULE_EVENT_BYTES,
	MAX_COMMAND_LENGTH,
	MAX_CWD_PREFIX_LENGTH,
	MAX_LIST_ENTRIES,
	MAX_LIST_ENTRY_LENGTH,
	MAX_NOTE_LENGTH,
	MAX_REASON_LENGTH,
	MAX_RULE_ID_LENGTH,
	ruleStoreHealthLine,
	type RuleRegistry,
	type RuleSnapshot,
	type ProposalEvent,
} from "./local-rules.ts";
import { capText, terminalSafe } from "./panel.ts";

const StringEntry = Type.String({ minLength: 1, maxLength: MAX_LIST_ENTRY_LENGTH });
const StringList = Type.Array(StringEntry, { maxItems: MAX_LIST_ENTRIES });
const CommandList = Type.Array(Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }), {
	maxItems: MAX_LIST_ENTRIES,
});
const ModelList = Type.Array(Type.String({ minLength: 3, maxLength: MAX_LIST_ENTRY_LENGTH, pattern: "^[^/]+/.+" }), {
	maxItems: MAX_LIST_ENTRIES,
});
const IndexChoices = Type.Record(Type.String({ pattern: "^(0|[1-9][0-9]*)$" }), StringList);

const OperandsSchema = Type.Object(
	{
		min: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
		max: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
		any: Type.Optional(StringList),
		at: Type.Optional(IndexChoices),
	},
	{ additionalProperties: false },
);

const PipeSchema = Type.Object(
	{
		from: Type.Optional(Type.Boolean()),
		to: Type.Optional(Type.Boolean()),
		fromRedirect: Type.Optional(Type.Boolean()),
		toRedirect: Type.Optional(Type.Boolean()),
		next: Type.Optional(CommandList),
		later: Type.Optional(CommandList),
	},
	{ additionalProperties: false },
);

const MatchSchema = Type.Object(
	{
		command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
		flags: Type.Optional(StringList),
		absentFlags: Type.Optional(StringList),
		operands: Type.Optional(OperandsSchema),
		pipe: Type.Optional(PipeSchema),
	},
	{ additionalProperties: false },
);

const SuggestionSchema = Type.Object(
	{
		command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
		flags: Type.Optional(StringList),
	},
	{ additionalProperties: false },
);

const ScopeSchema = Type.Object(
	{
		modelProviders: Type.Optional(StringList),
		models: Type.Optional(ModelList),
		cwdPrefixes: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: MAX_CWD_PREFIX_LENGTH, pattern: "^(?:/|[A-Za-z]:[\\\\/])" }), {
				maxItems: MAX_LIST_ENTRIES,
			}),
		),
	},
	{ additionalProperties: false },
);

const RuleIdSchema = Type.String({
	minLength: 1,
	maxLength: MAX_RULE_ID_LENGTH,
	pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
});
const ReasonSchema = Type.String({ minLength: 1, maxLength: MAX_REASON_LENGTH });
const RevisionSchema = Type.String({ pattern: "^[a-f0-9]{12}$" });
const NoteSchema = Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH });
const FactsProposal = {
	id: RuleIdSchema,
	reason: ReasonSchema,
	note: NoteSchema,
	language: Type.Literal("facts/v1"),
	program: FactsProgramSchema,
	scope: Type.Optional(ScopeSchema),
};

export const PolicyProposeParams = Type.Union(
	[
		Type.Object({ operation: Type.Literal("add"), ...FactsProposal }, { additionalProperties: false }),
		Type.Object(
			{ operation: Type.Literal("replace"), ...FactsProposal, expectedRevision: RevisionSchema },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("replace"),
				id: RuleIdSchema,
				reason: ReasonSchema,
				note: NoteSchema,
				match: MatchSchema,
				suggestion: Type.Optional(SuggestionSchema),
				scope: Type.Optional(ScopeSchema),
				expectedRevision: RevisionSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("add"),
				id: RuleIdSchema,
				reason: ReasonSchema,
				note: Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH }),
				match: MatchSchema,
				suggestion: Type.Optional(SuggestionSchema),
				scope: Type.Optional(ScopeSchema),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("retire"),
				id: RuleIdSchema,
				reason: ReasonSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				operation: Type.Literal("disable"),
				id: RuleIdSchema,
				reason: ReasonSchema,
			},
			{ additionalProperties: false },
		),
	],
	{ type: "object" },
);

export const PolicyRulesParams = Type.Object(
	{
		view: Type.Optional(
			Type.Union(
				["rules", "capabilities", "state", "health", "explain", "preview", "data"].map((value) => Type.Literal(value)),
			),
		),
		id: Type.Optional(Type.String({ minLength: 1, maxLength: 261 })),
		tool: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 128 })),
		result: Type.Optional(
			Type.Object({ isError: Type.Boolean(), details: Type.Optional(Type.Unknown()) }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);

export type PolicyInspectionView = "capabilities" | "state" | "health" | "explain" | "preview" | "data";
export interface ToolDeps {
	registry: RuleRegistry;
	loadRegistry(ctx: ExtensionContext): Promise<RuleSnapshot>;
	inspect?(view: PolicyInspectionView, params: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown>;
}

function line(value: string): string {
	return terminalSafe(value)
		.replace(/[\r\n]+/g, "↵")
		.replace(/\s+/g, " ")
		.trim();
}

function audit(value: { at: string; session: string; model: string | null; surface: string }): string {
	return `${value.surface} ${value.at} session=${value.session} model=${value.model ?? "(none)"}`;
}

export function formatRulesTool(snapshot: RuleSnapshot, context: Pick<ExtensionContext, "cwd" | "model">): string {
	const model = context.model;
	const lines = [
		"SESSION CONTEXT",
		`model provider: ${model ? line(model.provider) : "(none)"}`,
		`model: ${model ? line(`${model.provider}/${model.id}`) : "(none)"}`,
		`cwd: ${line(context.cwd)}`,
		line(ruleStoreHealthLine(snapshot.health)),
		`record count: ${snapshot.records.size} | pending proposal count: ${snapshot.pending.length}`,
		"",
		"RULES",
	];
	if (snapshot.records.size === 0) lines.push("(none)");
	for (const record of snapshot.records.values()) {
		const source = record.source.kind === "package" ? "package" : `local proposal=${record.source.proposalId}`;
		const matcher =
			record.matcher.kind === "code" ? `code:${record.matcher.key}` : `declarative:${record.matcher.language}`;
		lines.push(
			[
				line(record.id),
				`source=${source}`,
				`domain=${record.domain}`,
				`matcher=${matcher}`,
				`state=${effectiveState(record)}`,
				`effect=${effectiveEffect(record)}`,
				`override reason=${record.override ? line(record.override.reason) : "(none)"}`,
				`stale=${record.staleOverride}`,
				`available=${record.matcherAvailable}`,
				`note=${line(record.definition.note)}`,
			].join(" | "),
		);
		lines.push(
			`  definition: revision=${record.definition.revision} state=${record.definition.state} effect=${record.definition.effect}`,
			`  suggestion: ${record.definition.suggestion ? line(JSON.stringify(record.definition.suggestion)) : "(none)"}`,
			`  scope: ${record.definition.scope ? line(JSON.stringify(record.definition.scope)) : "(none)"}`,
			`  ${ruleScopeVisibility(record, {
				cwd: context.cwd,
				...(model ? { provider: model.provider, model: `${model.provider}/${model.id}` } : {}),
			})}`,
		);
		const program = factsProgram(record);
		if (program)
			lines.push(
				`  program: ${line(JSON.stringify(program))}`,
				"  action authority: exact definition; steer/block overrides do not change facts actions",
			);
		if (record.source.kind === "local") lines.push(`  approved audit: ${line(audit(record.source.approvedAudit))}`);
		if (record.override) {
			lines.push(
				`  override audit: ${line(audit(record.override.audit))}`,
				`  override against revision: ${record.override.againstDefinitionRevision}`,
			);
		}
	}
	lines.push("", "PENDING PROPOSALS");
	if (snapshot.pending.length === 0) lines.push("(none)");
	else {
		for (const proposal of snapshot.pending) {
			lines.push(
				`${proposal.id} | ${proposal.operation} | ${line(proposal.ruleId)} | revision=${proposalRevision(proposal)} | ${line(proposal.reason)}`,
			);
			if (proposal.candidate) lines.push(`  candidate: ${line(JSON.stringify(proposal.candidate))}`);
			if (proposal.expectedRevision) lines.push(`  expected definition revision: ${proposal.expectedRevision}`);
		}
	}
	lines.push("", line(ruleStoreHealthLine(snapshot.health)));
	return capText(lines.join("\n"));
}

function validateBoundedJson(value: unknown): void {
	let nodes = 0;
	const visit = (entry: unknown, depth: number): void => {
		if (++nodes > 4096 || depth > 16) throw new Error("policy inspection exceeds JSON structural bounds");
		if (entry === null || typeof entry === "boolean" || typeof entry === "string") return;
		if (typeof entry === "number" && Number.isFinite(entry)) return;
		if (Array.isArray(entry)) {
			for (const child of entry) visit(child, depth + 1);
			return;
		}
		if (entry && typeof entry === "object") {
			for (const child of Object.values(entry)) visit(child, depth + 1);
			return;
		}
		throw new Error("policy inspection requires finite JSON data");
	};
	visit(value, 0);
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RULE_EVENT_BYTES)
		throw new Error("policy inspection exceeds JSON byte bound");
}

export function validateInspectionParams(params: Record<string, unknown>): void {
	validateBoundedJson(params);
	const view = params.view ?? "rules";
	const views = ["rules", "capabilities", "state", "health", "explain", "preview", "data"];
	if (typeof view !== "string" || !views.includes(view)) throw new Error("unknown policy inspection view");
	const allowed = view === "preview" ? ["view", "tool", "input", "result"] : ["view", "id"];
	for (const key of Object.keys(params))
		if (!allowed.includes(key)) throw new Error(`field "${key}" is not valid for ${view}`);
	const idLimit = view === "explain" && typeof params.id === "string" && params.id.startsWith("call:") ? 261 : 80;
	if (params.id !== undefined && (typeof params.id !== "string" || params.id.length < 1 || params.id.length > idLimit))
		throw new Error(`inspection id must contain 1 to ${idLimit} characters`);
	if (view === "explain" && !params.id) throw new Error("explain requires id");
	if (view === "preview") {
		if (typeof params.tool !== "string" || params.tool.length < 1 || params.tool.length > 200)
			throw new Error("preview requires a bounded tool name");
		if (!params.input || typeof params.input !== "object" || Array.isArray(params.input))
			throw new Error("preview requires input object");
		if (params.result !== undefined) {
			const result = params.result as Record<string, unknown>;
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				typeof result.isError !== "boolean" ||
				Object.keys(result).some((key) => key !== "isError" && key !== "details")
			)
				throw new Error("preview result requires isError and optional details only");
		}
	}
}

function boundedInspection(value: unknown): string {
	return capText(terminalSafe(typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "(none)")));
}

export function formatDataView(snapshot: RuleSnapshot, name?: string): string {
	const bindings = name
		? [...snapshot.data.values()].filter((data) => data.name === name)
		: [...snapshot.data.values()];
	const snapshots = Object.values(snapshotData(bindings, Date.now()));
	return boundedInspection({
		health: snapshot.health,
		count: snapshot.data.size,
		bindings: name && snapshots.length === 0 ? [{ name, status: "missing" }] : snapshots,
	});
}

/** Commands supply operator authority; model tools never call this mutation surface. */
export async function policyDataCommand(
	registry: RuleRegistry,
	args: string,
	auditValue: OperatorRuleAudit,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<string> {
	if (auditValue.surface !== "command" && auditValue.surface !== "panel")
		throw new Error("data controls require an operator surface");
	if (Buffer.byteLength(args, "utf8") > MAX_RULE_EVENT_BYTES) throw new Error("data command exceeds byte bound");
	const command = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	const verb = command?.[1] ?? "list";
	const tail = command?.[2]?.trim() ?? "";
	if (verb === "list" || verb === "show") {
		if (verb === "list" && tail) throw new Error("data list does not accept arguments");
		if (verb === "show" && (!tail || /\s/.test(tail))) throw new Error("data show requires one name");
		return formatDataView(await registry.snapshot(), verb === "show" ? tail : undefined);
	}
	if (verb === "set") {
		const value: unknown = JSON.parse(tail);
		validateBoundedJson(value);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("data set requires an object");
		const request = value as Record<string, unknown>;
		if (
			Object.keys(request).some((key) => key !== "data" && key !== "expectedRevision" && key !== "approveRevision") ||
			!("expectedRevision" in request) ||
			!request.data ||
			typeof request.data !== "object" ||
			Array.isArray(request.data)
		)
			throw new Error("data set requires data, expectedRevision, and optional approveRevision only");
		if (
			request.expectedRevision !== null &&
			(typeof request.expectedRevision !== "string" || !/^[a-f0-9]{12}$/.test(request.expectedRevision))
		)
			throw new Error("expectedRevision must be null for a new binding or its current revision");
		const supplied = request.data as Record<string, unknown>;
		const raw = {
			...supplied,
			...(!Object.hasOwn(supplied, "capturedAt") ? { capturedAt: Date.parse(auditValue.at) } : {}),
			...(!Object.hasOwn(supplied, "source") ? { source: "operator" } : {}),
		} as NamedData;
		const revision = namedDataRevision(raw);
		if (raw.revision !== undefined && raw.revision !== revision)
			throw new Error("data revision does not describe its contract");
		const data = structuredClone({ ...raw, revision }) as NamedData;
		const error = validateNamedData(data);
		if (error) throw new Error(error);
		const artifact = { data, expectedRevision: request.expectedRevision };
		const approveRevision = contentRevision(artifact);
		const approvalCommand = `/policy data set ${JSON.stringify({ ...artifact, approveRevision })}`;
		if (Buffer.byteLength(terminalSafe(approvalCommand), "utf8") > 24 * 1024)
			throw new Error("data approval artifact exceeds the command presentation bound");
		if (request.approveRevision !== undefined && request.approveRevision !== approveRevision)
			throw new Error("data approval requires the exact complete artifact revision");
		const approved =
			request.approveRevision === approveRevision ||
			(await confirm("Approve policy data", JSON.stringify(artifact, null, 2)));
		if (!approved) return `Policy data change canceled. No data changed.\nExact approval command:\n${approvalCommand}`;
		await registry.setData(data, request.expectedRevision as string | null, auditValue);
		return `Policy data ${data.name} uses revision ${revision}.`;
	}
	if (verb === "remove") {
		const parts = tail.split(/\s+/);
		if ((parts.length !== 2 && (parts.length !== 3 || parts[2] !== "exact")) || !/^[a-f0-9]{12}$/.test(parts[1]))
			throw new Error("data remove requires name, current revision, and optional exact");
		const snapshot = await registry.snapshot();
		const data = snapshot.data.get(parts[0]);
		if (!data || data.revision !== parts[1]) throw new Error("data binding absent or revision changed");
		if (parts[2] !== "exact" && !(await confirm("Remove policy data", JSON.stringify(data, null, 2))))
			return `Policy data change canceled. No data changed.\nExact approval command: /policy data remove ${parts[0]} ${parts[1]} exact`;
		await registry.removeData(parts[0], parts[1], auditValue);
		return `Policy data ${parts[0]} was removed.`;
	}
	throw new Error("Use /policy data list|show <name>|set <JSON>|remove <name> <revision>.");
}

export function registerRuleTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool<typeof PolicyProposeParams, Record<string, unknown>>({
		name: "policy_propose",
		label: "Policy propose",
		description:
			"Submit one inert policy rule proposal. add and replace require id, reason, note, and either match (command-shape/v1) or language=facts/v1 with a complete program. replace also requires the current expectedRevision. Command matching uses exact command, flags, operands, and pipe shape; the operator selects steer or block. Facts programs declare phases, bounded conditions, exact action parameters, unavailable behavior, optional data names and observation state. The operator approves the exact proposal revision. retire and disable accept only id and reason. Scope uses exact provider/model identities and absolute cwd prefixes. Inspect policy_rules before authoring scope or data-dependent rules. Proposals cannot approve actions, write data, reset state, or invoke tools.",
		promptSnippet: "Propose an inert local policy rule for operator review",
		promptGuidelines: [
			"Use policy_propose only when the operator asks for a local policy rule. A proposal is inert until operator approval.",
			"Use policy_rules to inspect all rules, pending proposals, health, and exact session scope values before proposing a change.",
		],
		parameters: PolicyProposeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_propose cancelled");
			await deps.loadRegistry(ctx);
			const operatorIndependentAudit = makeRuleAudit(ctx, "agent-tool");
			let event: ProposalEvent;
			if (params.operation === "add" || params.operation === "replace") {
				const candidate = validateLocalCandidate({
					id: params.id,
					domain: "program" in params ? "facts" : "tool-call",
					matcher:
						"program" in params
							? { kind: "declarative", language: "facts/v1", spec: params.program }
							: { kind: "declarative", language: "command-shape/v1", spec: params.match },
					note: params.note,
					...("suggestion" in params && params.suggestion ? { suggestion: params.suggestion } : {}),
					...(params.scope ? { scope: params.scope } : {}),
				});
				event =
					params.operation === "replace"
						? await deps.registry.proposeReplace(
								candidate,
								params.expectedRevision,
								params.reason,
								operatorIndependentAudit,
							)
						: await deps.registry.proposeAdd(candidate, params.reason, operatorIndependentAudit);
			} else
				event =
					params.operation === "retire"
						? await deps.registry.proposeRetire(params.id, params.reason, operatorIndependentAudit)
						: await deps.registry.proposeDisable(params.id, params.reason, operatorIndependentAudit);
			await deps.loadRegistry(ctx);
			return {
				content: [
					{
						type: "text" as const,
						text: capText(
							terminalSafe(
								`Pending proposal ${event.id}: ${event.operation} ${event.ruleId}. It is inert until operator approval.`,
							),
							2048,
						),
					},
				],
				details: {
					proposalId: event.id,
					proposalRevision: proposalRevision(event),
					state: "pending",
					operation: event.operation,
					ruleId: event.ruleId,
				},
			};
		},
	});

	pi.registerTool<typeof PolicyRulesParams, Record<string, unknown>>({
		name: "policy_rules",
		label: "Policy rules",
		description:
			"Inspect policy rules (default), capabilities, state, health, named data, explain, or preview. id selects a rule or data name; explain also accepts call:<callId> for bounded current-session decision evidence. Preview requires tool and bounded input, with optional result; it never executes a simulated tool or changes simulated/live policy state or data. The real inspection call retains ordinary telemetry. Views report exact revisions, authority, availability, and unavailable boundaries. This tool has no control mutation action.",
		promptSnippet: "Inspect unified policy rules, pending proposals, and health",
		parameters: PolicyRulesParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_rules cancelled");
			validateInspectionParams(params);
			const snapshot = await deps.loadRegistry(ctx);
			const view = params.view ?? "rules";
			let output: string;
			if (view === "rules") {
				if (params.id) {
					const record = snapshot.records.get(params.id);
					output = record
						? formatRulesTool(
								{
									...snapshot,
									records: new Map([[record.id, record]]),
									pending: snapshot.pending.filter((entry) => entry.ruleId === params.id),
								},
								ctx,
							)
						: `No rule named ${line(params.id)}.`;
				} else output = formatRulesTool(snapshot, ctx);
			} else if (view === "data") output = formatDataView(snapshot, params.id);
			else {
				if (!deps.inspect) throw new Error(`policy ${view} inspection is unavailable: runtime callback absent`);
				output = boundedInspection(await deps.inspect(view as PolicyInspectionView, params, ctx));
			}
			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					rules: snapshot.records.size,
					pending: snapshot.pending.length,
					ruleStoreDegraded: snapshot.health.status === "degraded",
					ruleStorePath: snapshot.health.path,
				},
			};
		},
	});
}
