/** Agent proposal and read-only local-rule tools. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	makeRuleAudit,
	MAX_COMMAND_LENGTH,
	MAX_CWD_PREFIX_LENGTH,
	MAX_LIST_ENTRIES,
	MAX_LIST_ENTRY_LENGTH,
	MAX_NOTE_LENGTH,
	MAX_REASON_LENGTH,
	MAX_SLUG_LENGTH,
	type LocalRuleRegistry,
	type LocalRuleSnapshot,
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

const SuggestSchema = Type.Object(
	{
		command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_LENGTH }),
		flags: Type.Optional(StringList),
	},
	{ additionalProperties: false },
);

const ScopeSchema = Type.Object(
	{
		providers: Type.Optional(StringList),
		models: Type.Optional(ModelList),
		cwdPrefixes: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: MAX_CWD_PREFIX_LENGTH, pattern: "^(?:/|[A-Za-z]:[\\\\/])" }), {
				maxItems: MAX_LIST_ENTRIES,
			}),
		),
	},
	{ additionalProperties: false },
);

const SlugSchema = Type.String({
	minLength: 1,
	maxLength: MAX_SLUG_LENGTH,
	pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
});
const ReasonSchema = Type.String({ minLength: 1, maxLength: MAX_REASON_LENGTH });

export const PolicyProposeParams = Type.Union([
	Type.Object(
		{
			operation: Type.Literal("upsert"),
			slug: SlugSchema,
			reason: ReasonSchema,
			note: Type.String({ minLength: 1, maxLength: MAX_NOTE_LENGTH }),
			match: MatchSchema,
			suggest: Type.Optional(SuggestSchema),
			scope: Type.Optional(ScopeSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			operation: Type.Literal("discard"),
			slug: SlugSchema,
			reason: ReasonSchema,
		},
		{ additionalProperties: false },
	),
]);

export const PolicyRulesParams = Type.Object({}, { additionalProperties: false });

interface ToolDeps {
	registry: LocalRuleRegistry;
	/** Loads through the session failure boundary before a tool writes. */
	loadRegistry(): Promise<LocalRuleSnapshot>;
	readRegistry(): Promise<{ snapshot: LocalRuleSnapshot; error?: string }>;
	refreshAfterWrite(): void;
}

function line(value: string): string {
	return terminalSafe(value).replace(/[\r\n]+/g, "↵").replace(/\s+/g, " ").trim();
}

export function formatLocalRulesTool(snapshot: LocalRuleSnapshot, error?: string): string {
	const lines = ["LOCAL RULES"];
	if (snapshot.rules.length === 0) lines.push("(none)");
	else for (const rule of snapshot.rules) lines.push(`${line(rule.slug)} | ${rule.state} | ${rule.effect} | ${line(rule.note)}`);
	lines.push("", "PENDING PROPOSALS");
	if (snapshot.pending.length === 0) lines.push("(none)");
	else {
		for (const proposal of snapshot.pending) {
			lines.push(`${proposal.id} | ${proposal.operation} | ${line(proposal.slug)} | ${line(proposal.reason)}`);
		}
	}
	lines.push("", `registry health: ${error ? `unreadable: ${line(error)}` : "ok"}`);
	return capText(lines.join("\n"));
}

export function registerLocalRuleTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool<typeof PolicyProposeParams, Record<string, unknown>>({
		name: "policy_propose",
		label: "Policy propose",
		description:
			"Submit one inert local-rule proposal for operator review. upsert requires slug, reason, note, and match; discard permits only slug and reason. Match grammar: command exact; flags all present; absentFlags none present; operands min/max count non-flag args, any accepts one listed operand, at maps zero-based operand indexes to allowed values; pipe from/to/fromRedirect/toRedirect are exact booleans, next lists the immediate next command, later lists any later command. Optional suggest has command and flags. Optional scope has exact providers, exact provider/id models, and absolute cwdPrefixes. This tool cannot approve, reject, set state, or set effect.",
		promptSnippet: "Propose an inert local policy rule for operator review",
		promptGuidelines: [
			"Use policy_propose only when the operator asks for a local policy rule. A proposal is inert until the operator approves it.",
			"Use policy_rules to inspect retained rules and pending proposals before proposing a change.",
		],
		parameters: PolicyProposeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_propose cancelled");
			await deps.loadRegistry();
			const audit = makeRuleAudit(ctx, "agent-tool");
			const event =
				params.operation === "upsert"
					? await deps.registry.proposeUpsert(
							{
								slug: params.slug,
								note: params.note,
								match: params.match,
								suggest: params.suggest,
								scope: params.scope,
							},
							params.reason,
							audit,
						)
					: await deps.registry.proposeDiscard(params.slug, params.reason, audit);
			deps.refreshAfterWrite();
			return {
				content: [
					{
						type: "text" as const,
						text: capText(
							terminalSafe(`Pending proposal ${event.id}: ${event.operation} ${event.slug}. It is inert until operator approval.`),
							2048,
						),
					},
				],
				details: { proposalId: event.id, state: "pending", operation: event.operation, slug: event.slug },
			};
		},
	});

	pi.registerTool<typeof PolicyRulesParams, Record<string, unknown>>({
		name: "policy_rules",
		label: "Policy rules",
		description:
			"Read retained local rules and inert pending proposals. Rows include rule state/effect/note or proposal id/operation/slug/reason, followed by registry health. This tool is read-only and has no operator-gate parameters.",
		promptSnippet: "Inspect local policy rules and pending proposals",
		parameters: PolicyRulesParams,
		async execute(_toolCallId, _params, signal) {
			if (signal?.aborted) throw new Error("policy_rules cancelled");
			const loaded = await deps.readRegistry();
			return {
				content: [{ type: "text" as const, text: formatLocalRulesTool(loaded.snapshot, loaded.error) }],
				details: {
					rules: loaded.snapshot.rules.length,
					pending: loaded.snapshot.pending.length,
					registryError: loaded.error,
				},
			};
		},
	});
}
