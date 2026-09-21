/** Agent proposal and read-only unified rule tools. */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { ruleScopeVisibility } from "./classify.ts";
import { snapshotData } from "./data.ts";
import { dataFileApprovalText, dataReview, normalizeDataArtifact, readDataArtifact, safeJson } from "./data-import.ts";
import {
	MAX_COMMAND_LENGTH,
	MAX_CWD_PREFIX_LENGTH,
	MAX_LIST_ENTRIES,
	MAX_LIST_ENTRY_LENGTH,
	MAX_NOTE_LENGTH,
	MAX_PURPOSE_LENGTH,
	MAX_REASON_LENGTH,
	MAX_RULE_EVENT_BYTES,
	MAX_RULE_ID_LENGTH,
	makeRuleAudit,
	type LocalRuleCandidate,
	type ProposalEvent,
	proposalRevision,
	type RuleRegistry,
	type RuleSnapshot,
	ruleStoreHealthLine,
	validateLocalCandidate,
} from "./local-rules.ts";
import { capText, terminalSafe } from "./panel.ts";
import { ProposalConditionSchema, ProposalProgramSchema } from "./program.ts";
import {
	contentRevision,
	declaredAction,
	effectiveEffect,
	effectiveState,
	factsProgram,
	type AgentRuleAudit,
	type OperatorRuleAudit,
	permitsEffectChoice,
	type RuleRecord,
} from "./rule.ts";

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
		anyFlags: Type.Optional(StringList),
		absentFlags: Type.Optional(StringList),
		operands: Type.Optional(OperandsSchema),
		pipe: Type.Optional(PipeSchema),
	},
	{ additionalProperties: false },
);

const CliMatchSchema = Type.Object(
	{
		...MatchSchema.properties,
		command: Type.Literal("git"),
		cli: Type.Object(
			{
				profile: Type.Literal("git"),
				subcommand: Type.Array(Type.Literal("push"), { minItems: 1, maxItems: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const UnavailableSchema = Type.Union([Type.Literal("skip"), Type.Literal("deny")]);

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
const PurposeSchema = Type.String({ minLength: 1, maxLength: MAX_PURPOSE_LENGTH });
const AuthoritySchema = Type.Union([Type.Literal("exact"), Type.Literal("steer-or-block")]);
const FactsProposal = {
	purpose: PurposeSchema,
	authority: AuthoritySchema,
	applicability: Type.Optional(ProposalConditionSchema),
	id: RuleIdSchema,
	reason: ReasonSchema,
	note: NoteSchema,
	language: Type.Literal("facts/v1"),
	program: ProposalProgramSchema,
	scope: Type.Optional(ScopeSchema),
};

const PredicateProposal = {
	id: RuleIdSchema,
	purpose: PurposeSchema,
	authority: AuthoritySchema,
	applicability: Type.Optional(ProposalConditionSchema),
	reason: ReasonSchema,
	note: NoteSchema,
	predicate: RuleIdSchema,
	suggestion: Type.Optional(SuggestionSchema),
	scope: Type.Optional(ScopeSchema),
};

const CommandProposal = {
	purpose: PurposeSchema,
	authority: AuthoritySchema,
	applicability: Type.Optional(ProposalConditionSchema),
	id: RuleIdSchema,
	reason: ReasonSchema,
	note: NoteSchema,
	match: MatchSchema,
	onUnavailable: Type.Optional(UnavailableSchema),
	suggestion: Type.Optional(SuggestionSchema),
	scope: Type.Optional(ScopeSchema),
};
const CliProposal = { ...CommandProposal, match: CliMatchSchema, onUnavailable: UnavailableSchema };

export const PolicyProposeParams = Type.Union(
	[
		Type.Object({ operation: Type.Literal("add"), ...PredicateProposal }, { additionalProperties: false }),
		Type.Object(
			{ operation: Type.Literal("replace"), ...PredicateProposal, expectedRevision: RevisionSchema },
			{ additionalProperties: false },
		),
		Type.Object({ operation: Type.Literal("add"), ...FactsProposal }, { additionalProperties: false }),
		Type.Object(
			{ operation: Type.Literal("replace"), ...FactsProposal, expectedRevision: RevisionSchema },
			{ additionalProperties: false },
		),
		Type.Object({ operation: Type.Literal("add"), ...CommandProposal }, { additionalProperties: false }),
		Type.Object(
			{ operation: Type.Literal("replace"), ...CommandProposal, expectedRevision: RevisionSchema },
			{ additionalProperties: false },
		),
		Type.Object({ operation: Type.Literal("add"), ...CliProposal }, { additionalProperties: false }),
		Type.Object(
			{ operation: Type.Literal("replace"), ...CliProposal, expectedRevision: RevisionSchema },
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
	{
		type: "object",
		// Providers that project only object fields still receive the complete authoring vocabulary.
		properties: {
			...FactsProposal,
			...PredicateProposal,
			...CommandProposal,
			operation: Type.Union(["add", "replace", "retire", "disable"].map((value) => Type.Literal(value))),
			match: Type.Union([MatchSchema, CliMatchSchema]),
			expectedRevision: RevisionSchema,
		},
		required: ["operation", "id", "reason"],
	},
);

const MAX_PREVIEW_CONTENT_BLOCKS = 64;
const PreviewContentSchema = Type.Array(
	Type.Object(
		{ type: Type.Literal("text"), text: Type.String({ maxLength: MAX_RULE_EVENT_BYTES }) },
		{ additionalProperties: false },
	),
	{ maxItems: MAX_PREVIEW_CONTENT_BLOCKS },
);

export const PolicyRulesParams = Type.Object(
	{
		view: Type.Optional(
			Type.Union(
				["rules", "catalog", "capabilities", "state", "health", "explain", "preview", "data"].map((value) =>
					Type.Literal(value),
				),
			),
		),
		id: Type.Optional(Type.String({ minLength: 1, maxLength: 261 })),
		tool: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		input: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 128 })),
		result: Type.Optional(
			Type.Object(
				{
					isError: Type.Boolean(),
					details: Type.Optional(Type.Unknown()),
					content: Type.Optional(PreviewContentSchema),
				},
				{ additionalProperties: false },
			),
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

function ruleSourceSummary(record: RuleRecord): string {
	return record.source.kind === "package"
		? "package"
		: record.source.kind === "import"
			? `catalog import=${record.source.importId}`
			: `local proposal=${record.source.proposalId}`;
}

function ruleMatcherSummary(record: RuleRecord): string {
	return record.matcher.kind === "code" ? `code:${record.matcher.key}` : `declarative:${record.matcher.language}`;
}

function ruleSummaryLines(record: RuleRecord, context: Pick<ExtensionContext, "cwd" | "model">): string[] {
	const model = context.model;
	const lines = [
		[
			line(record.id),
			`source=${ruleSourceSummary(record)}`,
			`purpose=${line(record.definition.purpose)}`,
			`authority=${record.definition.authority}`,
			`matcher=${ruleMatcherSummary(record)}`,
			`state=${effectiveState(record)}`,
			`effect=${effectiveEffect(record)}`,
			`override reason=${record.override ? line(record.override.reason) : "(none)"}`,
			`stale=${record.staleOverride}`,
			`available=${record.matcherAvailable}`,
			`note=${line(record.definition.note)}`,
		].join(" | "),
		`  definition: revision=${record.definition.revision} state=${record.definition.state} effect=${record.definition.effect}`,
		`  suggestion: ${record.definition.suggestion ? line(JSON.stringify(record.definition.suggestion)) : "(none)"}`,
		`  applicability: ${record.definition.applicability ? line(JSON.stringify(record.definition.applicability)) : "(always)"}`,
		`  scope: ${record.definition.scope ? line(JSON.stringify(record.definition.scope)) : "(none)"}`,
		`  ${ruleScopeVisibility(record, {
			cwd: context.cwd,
			...(model ? { provider: model.provider, model: `${model.provider}/${model.id}` } : {}),
		})}`,
		`  declared action: ${line(JSON.stringify(declaredAction(record)))}`,
		`  action authority: ${permitsEffectChoice(record) ? "operator selects steer or block; steer never denies; no correction authority" : "exact definition; effect overrides have no authority"}`,
	];
	if (record.matcher.kind === "declarative" && record.matcher.language === "command-shape/v1")
		lines.push(`  matcher contract: ${safeJson(record.matcher)}`);
	const program = factsProgram(record);
	if (program) lines.push(`  program: ${line(JSON.stringify(program))}`);
	if (record.source.kind !== "package") lines.push(`  approved audit: ${line(audit(record.source.approvedAudit))}`);
	if (record.override) {
		lines.push(
			`  override audit: ${line(audit(record.override.audit))}`,
			`  override against revision: ${record.override.againstDefinitionRevision}`,
		);
	}
	return lines;
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
	for (const record of snapshot.records.values()) lines.push(...ruleSummaryLines(record, context));
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Count nodes and depth while confirming every value is finite JSON data. */
function boundedJsonNodes(entry: unknown, depth: number, nodes: { count: number }): void {
	if (++nodes.count > 4096 || depth > 16) throw new Error("policy inspection exceeds JSON structural bounds");
	if (entry === null || typeof entry === "boolean" || typeof entry === "string") return;
	if (typeof entry === "number" && Number.isFinite(entry)) return;
	if (Array.isArray(entry)) {
		for (const child of entry) boundedJsonNodes(child, depth + 1, nodes);
		return;
	}
	if (entry !== null && typeof entry === "object") {
		for (const child of Object.values(entry)) boundedJsonNodes(child, depth + 1, nodes);
		return;
	}
	throw new Error("policy inspection requires finite JSON data");
}

function validateBoundedJson(value: unknown): void {
	boundedJsonNodes(value, 0, { count: 0 });
	if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RULE_EVENT_BYTES)
		throw new Error("policy inspection exceeds JSON byte bound");
}

function previewBlockError(block: unknown): string | undefined {
	if (!isJsonObject(block)) return "preview content blocks require text objects with type/text only";
	if (block.type !== "text" || typeof block.text !== "string" || block.text.length > MAX_RULE_EVENT_BYTES)
		return "preview content blocks require text objects with type/text only";
	for (const key of Object.keys(block)) {
		if (key !== "type" && key !== "text") return "preview content blocks require text objects with type/text only";
	}
	return undefined;
}

function validatePreviewParams(params: Record<string, unknown>): void {
	if (typeof params.tool !== "string" || params.tool.length < 1 || params.tool.length > 200)
		throw new Error("preview requires a bounded tool name");
	if (!isJsonObject(params.input)) throw new Error("preview requires input object");
	if (Object.keys(params.input).length > 128) throw new Error("preview input exceeds the property bound");
	const result = params.result;
	if (result === undefined) return;
	if (!isJsonObject(result) || typeof result.isError !== "boolean")
		throw new Error("preview result requires isError and optional details or text content only");
	for (const key of Object.keys(result)) {
		if (key !== "isError" && key !== "details" && key !== "content")
			throw new Error("preview result requires isError and optional details or text content only");
	}
	const content = result.content;
	if (content === undefined) return;
	if (
		!Array.isArray(content) ||
		content.length > MAX_PREVIEW_CONTENT_BLOCKS ||
		content.some((block: unknown) => previewBlockError(block) !== undefined)
	)
		throw new Error(
			`preview content supports at most ${MAX_PREVIEW_CONTENT_BLOCKS} text blocks with type/text only`,
		);
}

export function validateInspectionParams(params: Record<string, unknown>): void {
	validateBoundedJson(params);
	const view = params.view ?? "rules";
	const views = ["rules", "catalog", "capabilities", "state", "health", "explain", "preview", "data"];
	if (typeof view !== "string" || !views.includes(view)) throw new Error("unknown policy inspection view");
	const allowed = view === "preview" ? ["view", "tool", "input", "result"] : ["view", "id"];
	for (const key of Object.keys(params))
		if (!allowed.includes(key)) throw new Error(`field "${key}" is not valid for ${view}`);
	const idLimit = view === "explain" && typeof params.id === "string" && params.id.startsWith("call:") ? 261 : 80;
	if (params.id !== undefined && (typeof params.id !== "string" || params.id.length < 1 || params.id.length > idLimit))
		throw new Error(`inspection id must contain 1 to ${idLimit} characters`);
	if (view === "explain" && !params.id) throw new Error("explain requires id");
	if (view === "preview") validatePreviewParams(params);
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
	cwd: string = process.cwd(),
): Promise<string> {
	if (auditValue.surface !== "command" && auditValue.surface !== "panel")
		throw new Error("data controls require an operator surface");
	if (Buffer.byteLength(args, "utf8") > MAX_RULE_EVENT_BYTES) throw new Error("data command exceeds byte bound");
	const command = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	const verb = command?.[1] ?? "list";
	const tail = command?.[2]?.trim() ?? "";
	if (verb === "list" || verb === "show") return dataListShow(registry, verb, tail);
	if (verb === "set-file") return dataSetFile(registry, tail, auditValue, confirm, cwd);
	if (verb === "set") return dataSet(registry, tail, auditValue, confirm);
	if (verb === "remove") return dataRemove(registry, tail, auditValue, confirm);
	throw new Error("Use /policy data list|show <name>|set <JSON>|set-file <JSON>|remove <name> <revision>.");
}

async function dataListShow(registry: RuleRegistry, verb: string, tail: string): Promise<string> {
	if (verb === "list" && tail) throw new Error("data list does not accept arguments");
	if (verb === "show" && (!tail || /\s/.test(tail))) throw new Error("data show requires one name");
	return formatDataView(await registry.snapshot(), verb === "show" ? tail : undefined);
}

async function dataSetFile(
	registry: RuleRegistry,
	tail: string,
	auditValue: OperatorRuleAudit,
	confirm: (title: string, message: string) => Promise<boolean>,
	cwd: string,
): Promise<string> {
	const value: unknown = JSON.parse(tail);
	validateBoundedJson(value);
	if (!isJsonObject(value)) throw new Error("set-file requires an object");
	if (
		Object.keys(value).some((key) => key !== "path" && key !== "approveRevision") ||
		typeof value.path !== "string" ||
		!value.path ||
		value.path.length > 4096
	)
		throw new Error("set-file requires path and optional approveRevision only");
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.path)) throw new Error("data source requires a local file path");
	const path = resolve(cwd, value.path);
	const artifact = await readDataArtifact(path);
	const approveRevision = contentRevision(artifact);
	if (value.approveRevision !== undefined && value.approveRevision !== approveRevision)
		throw new Error("data approval requires the exact complete artifact revision");
	const review = dataReview(artifact, approveRevision);
	const approvalText = dataFileApprovalText(path, approveRevision);
	await registry.preflightData(artifact.data, artifact.expectedRevision, auditValue);
	const approved = value.approveRevision === approveRevision || (await confirm("Approve policy data", review));
	if (!approved) return approvalText;
	await registry.setData(artifact.data, artifact.expectedRevision, auditValue);
	return `Policy data ${artifact.data.name} uses revision ${artifact.data.revision}.`;
}

async function dataSet(
	registry: RuleRegistry,
	tail: string,
	auditValue: OperatorRuleAudit,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<string> {
	const value: unknown = JSON.parse(tail);
	validateBoundedJson(value);
	if (!isJsonObject(value)) throw new Error("data set requires an object");
	if (
		Object.keys(value).some((key) => key !== "data" && key !== "expectedRevision" && key !== "approveRevision") ||
		!("expectedRevision" in value) ||
		!value.data ||
		typeof value.data !== "object" ||
		Array.isArray(value.data)
	)
		throw new Error("data set requires data, expectedRevision, and optional approveRevision only");
	if (
		value.expectedRevision !== null &&
		(typeof value.expectedRevision !== "string" || !/^[a-f0-9]{12}$/.test(value.expectedRevision))
	)
		throw new Error("expectedRevision must be null for a new binding or its current revision");
	const artifact = normalizeDataArtifact(
		{ data: value.data, expectedRevision: value.expectedRevision },
		{ source: "operator", capturedAt: Date.parse(auditValue.at) },
	);
	const { data } = artifact;
	const revision = data.revision;
	const approveRevision = contentRevision(artifact);
	// JSON leaves DEL/C1 controls literal; terminal display escapes are not valid JSON.
	const approvalJson = JSON.stringify({ ...artifact, approveRevision }).replace(
		/[\u007f-\u009f]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	const approvalCommand = `/policy data set ${approvalJson}`;
	if (Buffer.byteLength(approvalCommand, "utf8") > 24 * 1024)
		throw new Error("data approval artifact exceeds the command presentation bound");
	if (value.approveRevision !== undefined && value.approveRevision !== approveRevision)
		throw new Error("data approval requires the exact complete artifact revision");
	await registry.preflightData(data, artifact.expectedRevision, auditValue);
	const approved =
		value.approveRevision === approveRevision ||
		(await confirm("Approve policy data", dataReview(artifact, approveRevision)));
	if (!approved) return `Policy data change canceled. No data changed.\nExact approval command:\n${approvalCommand}`;
	await registry.setData(data, value.expectedRevision as string | null, auditValue);
	return `Policy data ${data.name} uses revision ${revision}.`;
}

async function dataRemove(
	registry: RuleRegistry,
	tail: string,
	auditValue: OperatorRuleAudit,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<string> {
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

export function formatCatalog(registry: RuleRegistry, id?: string): string {
	const rows = registry.catalogRows(id);
	return id
		? boundedInspection({ source: "bundled starter catalog", row: rows[0] })
		: boundedInspection({
				source: "bundled starter catalog",
				rules: rows.map((row) => ({
					id: row.id,
					revision: row.revision,
					purpose: row.purpose,
					matcher:
						row.matcher.kind === "code" ? row.matcher : { kind: row.matcher.kind, language: row.matcher.language },
				})),
			});
}

export async function policyImportCommand(
	registry: RuleRegistry,
	args: string,
	auditValue: OperatorRuleAudit,
	confirm: (title: string, message: string) => Promise<boolean>,
): Promise<string> {
	const parts = args.trim().split(/\s+/);
	if (parts.length !== 1 && (parts.length !== 3 || parts[1] !== "exact"))
		throw new Error("Use /policy import <id|--all> [exact REV].");
	const plan = await registry.planImport(parts[0]);
	const approval = `/policy import ${parts[0]} exact ${plan.revision}`;
	const artifact = `Replace selected definitions only. Preserve all override slots. Restore selected retired definitions. Leave all other rules and named data unchanged.\n${JSON.stringify(plan)}`;
	if (parts.length === 3 && parts[2] !== plan.revision)
		throw new Error("import revision changed; inspect a fresh import plan");
	if (parts.length !== 3 && !(await confirm("Import bundled policy definitions", artifact))) {
		const preview = `${artifact}\nNo rules changed. Exact approval command: ${approval}`;
		if (Buffer.byteLength(terminalSafe(preview), "utf8") > 30 * 1024)
			throw new Error(
				"Complete import preview exceeds the display bound. Inspect and import one catalog id at a time.",
			);
		return terminalSafe(preview);
	}
	await registry.importCatalog(parts[0], plan.revision, auditValue);
	return `Imported ${plan.rows.length} bundled policy definitions. Existing overrides remain unchanged.`;
}

type PolicyProposeInput = Static<typeof PolicyProposeParams>;
type PolicyProposeAddOrReplace = Extract<PolicyProposeInput, { operation: "add" | "replace" }>;
type PolicyRulesInput = Static<typeof PolicyRulesParams>;

/** Build one validated local candidate from an add or replace authoring form. */
function proposalCandidate(params: PolicyProposeAddOrReplace): LocalRuleCandidate {
	const matcher =
		"predicate" in params
			? { kind: "code" as const, key: params.predicate }
			: "program" in params
				? { kind: "declarative" as const, language: "facts/v1" as const, spec: params.program }
				: {
						kind: "declarative" as const,
						language: "command-shape/v1" as const,
						spec: params.match,
						...(params.onUnavailable !== undefined ? { onUnavailable: params.onUnavailable } : {}),
					};
	return validateLocalCandidate({
		id: params.id,
		purpose: params.purpose,
		authority: params.authority,
		...(params.applicability !== undefined ? { applicability: params.applicability } : {}),
		matcher,
		note: params.note,
		...("suggestion" in params && params.suggestion ? { suggestion: params.suggestion } : {}),
		...(params.scope ? { scope: params.scope } : {}),
	});
}

/** Submit one proposal through the registry under the agent-tool audit surface. */
async function submitProposal(
	registry: RuleRegistry,
	params: PolicyProposeInput,
	auditValue: AgentRuleAudit,
): Promise<ProposalEvent> {
	if (params.operation === "add" || params.operation === "replace") {
		const candidate = proposalCandidate(params);
		return params.operation === "replace"
			? await registry.proposeReplace(candidate, params.expectedRevision, params.reason, auditValue)
			: await registry.proposeAdd(candidate, params.reason, auditValue);
	}
	return params.operation === "retire"
		? await registry.proposeRetire(params.id, params.reason, auditValue)
		: await registry.proposeDisable(params.id, params.reason, auditValue);
}

/** Render one read-only inspection view as bounded tool text. */
async function rulesToolOutput(
	deps: ToolDeps,
	snapshot: RuleSnapshot,
	params: PolicyRulesInput,
	view: string,
	ctx: ExtensionContext,
): Promise<string> {
	if (view === "rules") {
		if (params.id) {
			const record = snapshot.records.get(params.id);
			return record
				? formatRulesTool(
						{
							...snapshot,
							records: new Map([[record.id, record]]),
							pending: snapshot.pending.filter((entry) => entry.ruleId === params.id),
						},
						ctx,
					)
				: `No rule named ${line(params.id)}.`;
		}
		return formatRulesTool(snapshot, ctx);
	}
	if (view === "catalog") return formatCatalog(deps.registry, params.id);
	if (view === "data") return formatDataView(snapshot, params.id);
	if (!deps.inspect) throw new Error(`policy ${view} inspection is unavailable: runtime callback absent`);
	return boundedInspection(await deps.inspect(view as PolicyInspectionView, params, ctx));
}

export function registerRuleTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool<typeof PolicyProposeParams, Record<string, unknown>>({
		name: "policy_propose",
		label: "Policy propose",
		description:
			"Submit one inert policy rule proposal. add and replace require id, purpose, authority, reason, note, and exactly one authoring form: match (command-shape/v1), predicate (an installed bounded matcher key from policy_rules view=catalog), or language=facts/v1 with a complete program. purpose states the positive outcome. authority is exact or steer-or-block. Compact match authoring supports flags (AND), anyFlags (OR), and absentFlags. match.cli with profile git and subcommand [push] uses command-aware options and requires explicit top-level onUnavailable skip or deny. Literal matching defaults to skip. Compact match authoring declares guidance from note and suggestion; the operator selects steer or block only with steer-or-block authority. Only input guide/deny actions permit steer-or-block authority; it never authorizes correction. Selected steer never denies, including unavailable evidence. Optional applicability is a bounded condition; only true permits rule evaluation, and false or unavailable skips the rule. Exact actions require approval of the complete proposal revision. replace also requires the current expectedRevision and exact proposal revision at approval. Programs declare applicability phase and selector, bounded evidence conditions, action parameters, unavailable behavior, optional data names and observation state. retire and disable accept only id and reason. Scope uses exact provider/model identities and absolute cwd prefixes. Inspect policy_rules before authoring scope or data-dependent rules. Proposals cannot approve actions, write data, reset state, or invoke tools.",
		promptSnippet: "Propose an inert policy rule for operator review",
		promptGuidelines: [
			"Use policy_propose only when the operator asks for a policy rule change. A proposal is inert until operator approval.",
			"Use policy_rules to inspect all rules, pending proposals, health, and exact session scope values before proposing a change.",
		],
		parameters: PolicyProposeParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_propose cancelled");
			await deps.loadRegistry(ctx);
			const auditValue = makeRuleAudit(ctx, "agent-tool");
			const event = await submitProposal(deps.registry, params, auditValue);
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
			"Inspect policy rules (default), bundled starter catalog, capabilities, state, health, named data, explain, or preview. id selects a rule or data name; explain also accepts call:<callId> for bounded current-session decision evidence. Preview requires tool and bounded input, with optional result (isError, details, and text-only content); it never executes a simulated tool or changes simulated/live policy state or data. The real inspection call retains ordinary telemetry. Views report exact revisions, authority, availability, and unavailable boundaries. This tool has no control mutation action.",
		promptSnippet: "Inspect unified policy rules, pending proposals, and health",
		parameters: PolicyRulesParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("policy_rules cancelled");
			validateInspectionParams(params);
			const snapshot = await deps.loadRegistry(ctx);
			const view = params.view ?? "rules";
			const output = await rulesToolOutput(deps, snapshot, params, view, ctx);
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
