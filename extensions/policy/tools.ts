/** Agent proposal and read-only unified rule tools. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ruleScopeVisibility } from "./classify.ts";
import { effectiveEffect, effectiveState } from "./rule.ts";
import {
	makeRuleAudit,
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

export const PolicyProposeParams = Type.Union(
	[
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

export const PolicyRulesParams = Type.Object({}, { additionalProperties: false });

interface ToolDeps {
	registry: RuleRegistry;
	loadRegistry(ctx: ExtensionContext): Promise<RuleSnapshot>;
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
			lines.push(`${proposal.id} | ${proposal.operation} | ${line(proposal.ruleId)} | ${line(proposal.reason)}`);
		}
	}
	lines.push("", line(ruleStoreHealthLine(snapshot.health)));
	return capText(lines.join("\n"));
}

export function registerRuleTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool<typeof PolicyProposeParams, Record<string, unknown>>({
		name: "policy_propose",
		label: "Policy propose",
		description:
			"Submit one inert policy-rule proposal for operator review. add requires id, reason, note, and match; retire and disable permit only id and reason. Match grammar: command exact; flags all present; absentFlags none present; operands min/max count non-flag args, any accepts one listed operand, at maps zero-based operand indexes to allowed values; pipe from/to/fromRedirect/toRedirect are exact booleans, next lists the immediate next command, later lists any later command. Optional suggestion has command and flags. Optional scope restricts session context: modelProviders holds exact provider identifiers; models holds exact provider/id strings; cwdPrefixes holds absolute directory prefixes. Call policy_rules before authoring scope. The tool cannot choose an effect or exercise an operator gate.",
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
			const event =
				params.operation === "add"
					? await deps.registry.proposeAdd(
							{
								id: params.id,
								domain: "tool-call",
								matcher: { kind: "declarative", language: "command-shape/v1", spec: params.match },
								note: params.note,
								suggestion: params.suggestion,
								scope: params.scope,
							},
							params.reason,
							operatorIndependentAudit,
						)
					: params.operation === "retire"
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
				details: { proposalId: event.id, state: "pending", operation: event.operation, ruleId: event.ruleId },
			};
		},
	});

	pi.registerTool<typeof PolicyRulesParams, Record<string, unknown>>({
		name: "policy_rules",
		label: "Policy rules",
		description:
			"Read the current session context, every package and local rule record, inert pending proposals, and rule-store health. Rows report provenance, matcher, effective state/effect, override reason, staleness, and matcher availability. This tool is read-only.",
		promptSnippet: "Inspect unified policy rules, pending proposals, and health",
		parameters: PolicyRulesParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_rules cancelled");
			const snapshot = await deps.loadRegistry(ctx);
			return {
				content: [{ type: "text" as const, text: formatRulesTool(snapshot, ctx) }],
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
