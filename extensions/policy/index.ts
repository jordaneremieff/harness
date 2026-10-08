/** Policy registration and operator controls over the shared event interpreter. */
import { fileURLToPath } from "node:url";
import { publishSettings, readSettings } from "./settings.ts";
import { toolDisplayPublisher } from "./tool-display.ts";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createPolicyDurableExtension, type PolicyDurableContribution } from "./durable.ts";
import {
	candidatePermitsEffectChoice,
	makeRuleAudit,
	type PendingProposal,
	proposalRevision,
	RuleRegistry,
	targetIdentity,
	type RuleSnapshot,
} from "./local-rules.ts";
import { POLICY_MODES, type PolicyMode, resolvePolicyModeValue } from "./mode.ts";
import {
	capText,
	formatPolicyList,
	formatPolicyShow,
	PolicyApprovalPanel,
	PolicyPanel,
	type PolicyPanelResult,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
} from "./panel.ts";
import { effectiveState, permitsEffectChoice, type RuleRecord } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";
import { formatTelemetry, readTelemetry } from "./telemetry.ts";
import {
	formatCatalog,
	policyDataCommand,
	policyImportCommand,
	registerRuleTools,
	validateInspectionParams,
} from "./tools.ts";

const POLICY_MODE_FLAG = "policy-mode";
const POLICY_USAGE = [
	"Usage:",
	"  /policy                                      Open the policy panel (TUI only)",
	"  /policy list                                 Print rules, proposals, and authority health",
	"  /policy show <id-or-proposal-id>              Show a rule or proposal",
	"  /policy approve [rule-name|proposal-id]      Select and review a pending proposal (TUI)",
	"  /policy approve <target> <steer|block|exact> <revision> Exact approval; completion fills revision",
	"  /policy reject [rule-name|proposal-id] [revision] Reject a pending proposal; TUI selects if omitted",
	"  /policy disable <id> <reason...>              Disable a rule",
	"  /policy enable <id> <reason...>               Enable a rule",
	"  /policy effect <id> <steer|block> <reason...>  Select an authorized steer/block effect",
	"  /policy retire <id> <reason...>               Retire a definition",
	"  /policy catalog [id]                         Inspect bundled starter definitions",
	"  /policy import <id|--all> [exact REV]         Approve selected bundled definitions",
	"  /policy capabilities | state | health       Inspect the runtime",
	"  /policy explain <rule-id|call:call-id>        Explain a rule or recorded call",
	"  /policy preview <JSON>                       Preview without simulated execution or state changes",
	"  /policy reset <id|--all> <reason...>          Start a new observation period",
	"  /policy data list|show <name>|set <JSON>|remove <name> <revision>",
	"  /policy data set-file <JSON>                 Review and import one complete local data file",
	"  /policy telemetry <from> <to>                Summarize local day files (YYYY-MM-DD, inclusive)",
	"  /policy mode                                Report the session mode",
	"  /policy help                                Show this usage",
].join("\n");
const VERBS = [
	"list",
	"show",
	"catalog",
	"import",
	"approve",
	"reject",
	"disable",
	"enable",
	"effect",
	"retire",
	"capabilities",
	"state",
	"health",
	"explain",
	"preview",
	"reset",
	"data",
	"mode",
	"telemetry",
	"help",
];
const MODE_EFFECT: Readonly<Record<PolicyMode, string>> = {
	observe: "Records every tool call and applies no mechanism.",
	notice: "Records tool outcomes and shows candidate effects through terminal notices.",
	annotate: "Records tool outcomes and adds eligible model guidance without input or error changes.",
	enforce: "Applies approved denials, corrections, and guidance; records final tool outcomes.",
};
function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function scope(ctx: ExtensionContext) {
	return {
		...(ctx.model ? { provider: ctx.model.provider, model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
		cwd: ctx.cwd,
	};
}

/** Whether one action verb accepts this record at the current position. */
function selectableForAction(record: RuleRecord, verb: string): boolean {
	if (verb === "disable") return effectiveState(record) === "active";
	if (verb === "enable") return effectiveState(record) === "disabled";
	if (verb === "retire") return record.definition.state === "active";
	return effectiveState(record) !== "retired" && (verb !== "effect" || permitsEffectChoice(record));
}

const SELECTABLE_VERBS = new Set(["disable", "enable", "effect", "retire"]);

function primaryChoices(verb: string, snapshot: RuleSnapshot | undefined, registry: RuleRegistry): string[] {
	const records = [...(snapshot?.records.values() ?? [])];
	const proposals = snapshot?.pending ?? [];
	if (verb === "show" || verb === "explain")
		return [
			...records.map((record) => record.id),
			...(verb === "show" ? proposals.map((proposal) => proposal.id) : []),
		];
	if (verb === "approve" || verb === "reject") return proposals.map((proposal) => proposal.id);
	if (SELECTABLE_VERBS.has(verb))
		return records.filter((record) => selectableForAction(record, verb)).map((record) => record.id);
	if (verb === "reset")
		return [
			...records
				.filter((record) => effectiveState(record) === "active" && record.matcherAvailable)
				.map((record) => record.id),
			"--all",
		];
	if (verb === "catalog" || verb === "import")
		return [...registry.catalogRows().map((row) => row.id), ...(verb === "import" ? ["--all"] : [])];
	if (verb === "data") return ["list", "show", "set", "set-file", "remove"];
	return [];
}

function secondChoices(verb: string, parts: string[], snapshot: RuleSnapshot | undefined): string[] {
	if (verb === "data" && (parts[1] === "show" || parts[1] === "remove"))
		return [...(snapshot?.data.keys() ?? [])];
	if (verb === "import") return ["exact"];
	if (verb === "effect") return ["steer", "block"];
	if (verb === "approve") {
		const proposal = snapshot?.pending.find((entry) => entry.id === parts[1]);
		if (proposal && (proposal.operation === "add" || proposal.operation === "replace"))
			return candidatePermitsEffectChoice(proposal.candidate) ? ["steer", "block"] : ["exact"];
	}
	return [];
}

function thirdChoices(verb: string, parts: string[], snapshot: RuleSnapshot | undefined): string[] {
	if (verb === "data" && parts[1] === "remove") {
		const binding = snapshot?.data.get(parts[2]);
		return binding ? [binding.revision] : [];
	}
	if (verb === "approve") {
		const proposal = snapshot?.pending.find((entry) => entry.id === parts[1]);
		return proposal ? [proposalRevision(proposal)] : [];
	}
	return [];
}

function fourthChoices(verb: string, parts: string[], snapshot: RuleSnapshot | undefined): string[] {
	if (verb !== "data" || parts[1] !== "remove") return [];
	const binding = snapshot?.data.get(parts[2]);
	return binding?.revision === parts[3] ? ["exact"] : [];
}

function primaryCompletions(verb: string, partial: string, snapshot: RuleSnapshot, registry: RuleRegistry): AutocompleteItem[] {
	if (verb === "show") return showCompletions(partial, snapshot);
	if (verb === "approve" || verb === "reject") return proposalCompletions(verb, partial, snapshot);
	return primaryChoices(verb, snapshot, registry).filter((value) => value.startsWith(partial)).map((value) => ({ value: `${verb} ${value}`, label: value }));
}

function showCompletions(partial: string, snapshot: RuleSnapshot): AutocompleteItem[] {
	const records = [...snapshot.records.values()].filter((record) => record.id.startsWith(partial)).map((record) => ({ value: `show ${record.id}`, label: record.id, description: choiceText(record.definition.purpose) }));
	const pending = snapshot.pending.filter((proposal) => proposal.id.startsWith(partial) || proposal.ruleId.startsWith(partial)).map((proposal) => ({ value: `show ${proposal.id}`, label: `${proposal.ruleId} · pending ${proposal.operation}`, description: choiceText(proposal.candidate?.purpose ?? proposal.reason) }));
	return [...records, ...pending];
}

function proposalCompletions(verb: string, partial: string, snapshot: RuleSnapshot): AutocompleteItem[] {
	return snapshot.pending
		.filter((p) => p.id.startsWith(partial) || p.ruleId.startsWith(partial))
		.flatMap((p) => {
			const effects =
				verb === "reject" ? [""] : candidatePermitsEffectChoice(p.candidate) ? ["steer", "block"] : ["exact"];
			return effects.map((effect) => ({
				value: `${verb} ${p.id} ${effect ? `${effect} ` : ""}${proposalRevision(p)}`,
				label: `${p.ruleId}${effect ? ` · ${effect}` : ""}`,
				description: `${p.operation}: ${choiceText(p.candidate?.purpose ?? p.reason)}`,
			}));
		});
}

function effectCompletions(target: string, partial: string, snapshot: RuleSnapshot): AutocompleteItem[] {
	const p = snapshot.pending.find((p) => p.id === target || p.ruleId === target);
	if (!p) return [];
	return (candidatePermitsEffectChoice(p.candidate) ? ["steer", "block"] : ["exact"])
		.filter((effect) => effect.startsWith(partial))
		.map((effect) => ({
			value: `approve ${p.id} ${effect} ${proposalRevision(p)}`,
			label: effect,
			description: p.ruleId,
		}));
}

async function importCompletion(registry: RuleRegistry, selection: string): Promise<AutocompleteItem[]> {
	try {
		const plan = await registry.planImport(selection);
		return [
			{
				value: `import ${selection} exact ${plan.revision}`,
				label: "exact",
				description: "Import the reviewed definitions; preserve overrides",
			},
		];
	} catch {
		return [];
	}
}

function completionChoicesForPosition(
	verb: string,
	parts: string[],
	position: number,
	snapshot: RuleSnapshot | undefined,
	registry: RuleRegistry,
): string[] {
	if (position === 1) return primaryChoices(verb, snapshot, registry);
	if (position === 2) return secondChoices(verb, parts, snapshot);
	if (position === 3) return thirdChoices(verb, parts, snapshot);
	if (position === 4) return fourthChoices(verb, parts, snapshot);
	return [];
}

interface PolicyCommandEnv {
	output: (ctx: ExtensionContext, text: string, error?: boolean) => void;
	loadRegistry: (ctx?: ExtensionContext) => Promise<RuleSnapshot>;
	registry: RuleRegistry;
	runtime: PolicyRuntime;
	dir: string;
	modeText: () => { mode: PolicyMode; source: string };
	reviewArtifact: (ctx: ExtensionContext, title: string, artifact: string) => Promise<boolean>;
}

type PolicyVerbHandler = (
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	parts: string[],
	trimmed: string,
	snapshot: RuleSnapshot,
) => void | Promise<void>;

async function policyTelemetryVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	parts: string[],
): Promise<void> {
	if (parts.length !== 2) {
		env.output(ctx, "Usage: /policy telemetry <from YYYY-MM-DD> <to YYYY-MM-DD> (inclusive, at most 31 days)", true);
		return;
	}
	env.output(ctx, formatTelemetry(await readTelemetry(env.dir, parts[0], parts[1])));
}

function policyHelpVerb(env: PolicyCommandEnv, ctx: ExtensionCommandContext): void {
	env.output(ctx, POLICY_USAGE);
}

function policyModeVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): void {
	if (parts.length) {
		env.output(ctx, "Usage: /policy mode", true);
		return;
	}
	const { mode, source } = env.modeText();
	env.output(
		ctx,
		`${mode} (${source})\n${MODE_EFFECT[mode]}\n${
			snapshot.health.status === "degraded" ? "Rule-store degradation caps mechanisms at notice." : "Rule store healthy."
		}`,
	);
}

async function policyListVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length) {
		env.output(ctx, "Usage: /policy list", true);
		return;
	}
	env.output(ctx, formatPolicyList({ snapshot, fireSummary: await readFireSummary(env.dir) }));
}

async function policyShowVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length !== 1) {
		env.output(ctx, "Usage: /policy show <id-or-proposal-id>", true);
		return;
	}
	const shown = formatPolicyShow({ snapshot, fireSummary: await readFireSummary(env.dir) }, parts[0], scope(ctx));
	if (shown) env.output(ctx, shown);
	else env.output(ctx, `No rule or pending proposal named "${parts[0]}".`, true);
}

async function policyInspectVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length) {
		env.output(ctx, `Usage: /policy ${verb}`, true);
		return;
	}
	env.output(ctx, JSON.stringify(await env.runtime.inspect(verb, {}, ctx), null, 2));
}

async function policyExplainVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length !== 1) {
		env.output(ctx, "Usage: /policy explain <rule-id|call:call-id>", true);
		return;
	}
	env.output(ctx, JSON.stringify(await env.runtime.inspect("explain", { id: parts[0] }, ctx), null, 2));
}

async function policyPreviewVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	_parts: string[],
	trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	const text = trimmed.slice(verb.length).trim();
	if (Buffer.byteLength(text) > 262144) throw new Error("Preview exceeds the input bound");
	const params = JSON.parse(text);
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Preview requires an inspection object");
	if (params.view !== undefined && params.view !== "preview")
		throw new Error("The preview command requires view preview");
	validateInspectionParams({ ...params, view: "preview" });
	env.output(ctx, JSON.stringify(await env.runtime.inspect("preview", params, ctx), null, 2));
}

async function policyResetVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	const revisions = new Map(
		primaryChoices("reset", snapshot, env.registry).map((id) => [id, env.runtime.resetRevision(id)]),
	);
	let revision: string | undefined;
	const completed = await controlArguments(ctx, "reset", parts, snapshot, env.registry, (id) => {
		revision = revisions.get(id);
		if (revision === undefined) throw new Error(`No admitted observation period for ${id}`);
	});
	if (!completed) return env.output(ctx, "Policy reset canceled. No observation periods changed.");
	parts = completed;
	if (parts.length < 2) {
		env.output(ctx, "Usage: /policy reset <id|--all> <reason...>", true);
		return;
	}
	await env.loadRegistry(ctx);
	env.runtime.reset(parts[0] === "--all" ? undefined : [parts[0]], parts.slice(1).join(" "), revision);
	env.output(ctx, "Started a new policy observation period.");
}

function policyCatalogVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): void {
	if (parts.length > 1) {
		env.output(ctx, "Usage: /policy catalog [id]", true);
		return;
	}
	env.output(ctx, formatCatalog(env.registry, parts[0]));
}

async function policyImportVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	_parts: string[],
	trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	let args = trimmed.slice(verb.length).trim();
	if (!args && ctx.mode === "tui" && ctx.hasUI) {
		const selection = await ctx.ui.select("Import which bundled definitions?", [
			...env.registry.catalogRows().map((row) => row.id),
			"--all",
		]);
		if (!selection) return env.output(ctx, "Policy import canceled. No rules changed.");
		args = selection;
	}
	const text = await policyImportCommand(env.registry, args, makeRuleAudit(ctx, "command"), (title, artifact) =>
		env.reviewArtifact(ctx, title, artifact),
	);
	await env.loadRegistry(ctx);
	env.output(ctx, text);
}

function supplyDataRevision(json: string, snapshot: RuleSnapshot): string {
	const supplied: unknown = JSON.parse(json);
	if (
		!supplied ||
		typeof supplied !== "object" ||
		Array.isArray(supplied) ||
		Object.hasOwn(supplied, "expectedRevision")
	)
		return json;
	const value = supplied as Record<string, unknown>;
	const data = value.data as { name?: unknown } | undefined;
	if (!data || typeof data.name !== "string") return json;
	return JSON.stringify({ ...value, expectedRevision: snapshot.data.get(data.name)?.revision ?? null });
}

async function dataEditor(
	ctx: ExtensionCommandContext,
	action: string,
	snapshot: RuleSnapshot,
): Promise<string | undefined> {
	const json = await ctx.ui.editor(
		action === "set" ? "Data JSON: data (current target revision is supplied)" : "Data file JSON: path",
		"",
	);
	if (!json?.trim()) return undefined;
	return `${action} ${action === "set" ? supplyDataRevision(json, snapshot) : json}`;
}

async function dataArguments(
	ctx: ExtensionCommandContext,
	supplied: string,
	snapshot: RuleSnapshot,
): Promise<string | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) return supplied;
	const args = supplied || (await ctx.ui.select("Policy data action", ["list", "show", "set", "set-file", "remove"]));
	if (!args) return undefined;
	if (args === "set" || args === "set-file") return dataEditor(ctx, args, snapshot);
	const tokens = args.split(/\s+/);
	if (tokens[0] !== "show" && tokens[0] !== "remove") return args;
	if (!tokens[1]) {
		const name = await ctx.ui.select("Select policy data", [...snapshot.data.keys()]);
		if (!name) return undefined;
		tokens.push(name);
	}
	if (tokens[0] === "remove" && tokens.length === 2) {
		const binding = snapshot.data.get(tokens[1]);
		if (!binding) throw new Error(`No policy data named ${tokens[1]}.`);
		tokens.push(binding.revision);
	}
	return tokens.join(" ");
}

async function policyDataVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	_parts: string[],
	trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	const args = await dataArguments(ctx, trimmed.slice(verb.length).trim(), _snapshot);
	if (args === undefined) return env.output(ctx, "Policy data action canceled.");
	const text = await policyDataCommand(
		env.registry,
		args,
		makeRuleAudit(ctx, "command"),
		(title, message) => env.reviewArtifact(ctx, title, message),
		ctx.cwd,
	);
	await env.loadRegistry(ctx);
	env.output(ctx, text);
}

function exactApprovalArguments(parts: string[]): { revision: string } | string {
	if (parts.length !== 3 || parts[1] !== "exact")
		return "Exact approval requires: /policy approve <proposal-id> exact <revision>";
	return { revision: parts[2] };
}

function replaceApprovalArguments(
	parts: string[],
	choice: "steer" | "block" | undefined,
): { effect: "steer" | "block"; revision: string } | string {
	if (parts.length !== 3 || choice === undefined)
		return "Selectable replacement approval requires: /policy approve <proposal-id> <steer|block> <revision>";
	return { effect: choice, revision: parts[2] };
}

function addApprovalArguments(
	parts: string[],
	choice: "steer" | "block" | undefined,
): { effect: "steer" | "block"; revision?: string } | string {
	if ((parts.length !== 2 && parts.length !== 3) || choice === undefined)
		return "Approving an add proposal requires: /policy approve <proposal-id> <steer|block> [revision]";
	return { effect: choice, ...(parts[2] ? { revision: parts[2] } : {}) };
}

/** Validate one approve invocation; a string result is the error to report. */
function approveArguments(
	parts: string[],
	proposal: PendingProposal,
): { effect?: "steer" | "block"; revision?: string } | string {
	const exact = proposal.candidate !== undefined && !candidatePermitsEffectChoice(proposal.candidate);
	if (exact) return exactApprovalArguments(parts);
	const choice = parts[1] === "steer" || parts[1] === "block" ? parts[1] : undefined;
	if (proposal.operation === "replace") return replaceApprovalArguments(parts, choice);
	if (proposal.operation === "add") return addApprovalArguments(parts, choice);
	if (parts.length === 3 && parts[1] === "exact") return { revision: parts[2] };
	if (parts.length !== 1)
		return `Approving a ${proposal.operation} proposal uses: /policy approve <target> exact <revision>`;
	return {};
}

function proposalCommands(proposal: PendingProposal): string {
	const effects = candidatePermitsEffectChoice(proposal.candidate) ? ["steer", "block"] : ["exact"];
	const commands = effects
		.map((effect) => `/policy approve ${proposal.id} ${effect} ${proposalRevision(proposal)}`)
		.join("\n");
	const artifact = JSON.stringify(proposal, null, 2);
	if (Buffer.byteLength(terminalSafe(artifact)) > 28 * 1024)
		return `Proposal ${proposal.ruleId} is too large for complete command display. This is not a complete review. Use policy_rules with id ${proposal.id} to inspect the complete artifact. After that review, select only the authorized effect:\n${commands}`;
	return `${artifact}\nExact approval commands (select only the authorized effect):\n${commands}`;
}

function choiceText(text: string): string {
	return capText(terminalSafe(text).replace(/[\r\n]+/g, " "), 240);
}

function pendingSelectionText(snapshot: RuleSnapshot, target?: string): string {
	return `${target ? `No unique pending proposal named "${target}".` : "Select a pending proposal by rule name."}\n${snapshot.pending.map((p) => `${p.ruleId}: ${p.operation}`).join("\n") || "No pending proposals."}`;
}

async function selectProposal(
	ctx: ExtensionCommandContext,
	snapshot: RuleSnapshot,
	target: string | undefined,
	action: string,
): Promise<PendingProposal | undefined> {
	if (target) {
		const matches = snapshot.pending.filter((p) => p.id === target || p.ruleId === target);
		return matches.length === 1 ? matches[0] : undefined;
	}
	if (ctx.mode !== "tui" || !ctx.hasUI || !snapshot.pending.length) return undefined;
	const choices = snapshot.pending.map(
		(p) => `${p.ruleId} · ${p.operation} · ${choiceText(p.candidate?.purpose ?? p.reason)}`,
	);
	const selected = await ctx.ui.select(`${action} which policy proposal?`, choices);
	return selected === undefined ? undefined : snapshot.pending[choices.indexOf(selected)];
}

async function approvalParts(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	proposal: PendingProposal,
	parts: string[],
): Promise<string[] | undefined> {
	const choices = candidatePermitsEffectChoice(proposal.candidate) ? ["steer", "block"] : ["exact"];
	const missingRevision =
		parts.length === 2 && choices.includes(parts[1]) && (proposal.operation !== "add" || choices[0] === "exact");
	const interactive = ctx.mode === "tui" && ctx.hasUI;
	if (parts.length > 1 && !(missingRevision && interactive)) return parts;
	if (!interactive) {
		env.output(ctx, proposalCommands(proposal));
		return undefined;
	}
	const effect =
		parts[1] ?? (choices.length === 1 ? choices[0] : await ctx.ui.select(`Effect for ${proposal.ruleId}`, choices));
	if (
		effect &&
		(await env.reviewArtifact(ctx, `Approve ${proposal.ruleId} as ${effect}`, JSON.stringify(proposal, null, 2)))
	)
		return [proposal.id, effect, proposalRevision(proposal)];
	env.output(ctx, "Policy approval canceled. No rules changed.");
	return undefined;
}

async function policyApproveVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length > 3) {
		env.output(ctx, "Usage: /policy approve <proposal-id> [steer|block|exact <revision>]", true);
		return;
	}
	const proposal = await selectProposal(ctx, snapshot, parts[0], "Approve");
	if (!proposal) return env.output(ctx, pendingSelectionText(snapshot, parts[0]));
	const resolvedParts = await approvalParts(env, ctx, proposal, parts);
	if (!resolvedParts) return;
	const decision = approveArguments(resolvedParts, proposal);
	if (typeof decision === "string") {
		env.output(ctx, decision, true);
		return;
	}
	await env.registry.decide(
		proposal.id,
		"approved",
		decision.effect,
		makeRuleAudit(ctx, "command"),
		decision.revision ?? proposalRevision(proposal),
	);
	await env.loadRegistry(ctx);
	env.output(ctx, `Approved ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}.`);
}

async function policyRejectVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length > 2) return env.output(ctx, "Usage: /policy reject [rule-name|proposal-id] [revision]", true);
	const proposal = await selectProposal(ctx, snapshot, parts[0], "Reject");
	if (!proposal) return env.output(ctx, pendingSelectionText(snapshot, parts[0]));
	await env.registry.decide(
		proposal.id,
		"rejected",
		undefined,
		makeRuleAudit(ctx, "command"),
		parts[1] ?? proposalRevision(proposal),
	);
	await env.loadRegistry(ctx);
	env.output(ctx, `Rejected ${proposal.operation} proposal for ${proposal.ruleId}.`);
}

function validateControlTarget(
	verb: string,
	id: string | undefined,
	snapshot: RuleSnapshot,
	onTarget?: (id: string) => void,
): void {
	if (!id) return;
	if (verb === "reset" && id === "--all") {
		onTarget?.(id);
		return;
	}
	const record = snapshot.records.get(id);
	if (!record) throw new Error(`No rule named ${id} existed at command admission`);
	if (verb === "reset" && (effectiveState(record) !== "active" || !record.matcherAvailable))
		throw new Error(`No active available observation period for ${id}`);
	onTarget?.(id);
}

async function selectControlTarget(
	ctx: ExtensionCommandContext,
	verb: string,
	snapshot: RuleSnapshot,
	registry: RuleRegistry,
): Promise<string | undefined> {
	const choices = primaryChoices(verb, snapshot, registry);
	if (!choices.length) return undefined;
	const labels = choices.map((id) =>
		id === "--all"
			? "All active observation periods"
			: `${id} · ${choiceText(snapshot.records.get(id)?.definition.purpose ?? "")}`,
	);
	const selected = await ctx.ui.select(`Select policy ${verb} target`, labels);
	if (selected === undefined) return undefined;
	const id = choices[labels.indexOf(selected)];
	if (!id) return undefined;
	return id;
}

async function controlArguments(
	ctx: ExtensionCommandContext,
	verb: string,
	supplied: string[],
	snapshot: RuleSnapshot,
	registry: RuleRegistry,
	onTarget?: (id: string) => void,
): Promise<string[] | undefined> {
	const parts = [...supplied];
	const validateTarget = () => validateControlTarget(verb, parts[0], snapshot, onTarget);
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		validateTarget();
		return parts;
	}
	if (!parts[0]) {
		const id = await selectControlTarget(ctx, verb, snapshot, registry);
		if (!id) return undefined;
		parts.push(id);
	}
	validateTarget();
	if (verb === "effect" && !parts[1]) {
		const effect = await ctx.ui.select(`Effect for ${parts[0]}`, ["steer", "block"]);
		if (!effect) return undefined;
		parts.push(effect);
	}
	const reasonAt = verb === "effect" ? 2 : 1;
	if (parts.length === reasonAt) {
		const reason = await ctx.ui.input(`Reason to ${verb} ${parts[0]}`);
		if (!reason?.trim()) return undefined;
		parts.push(reason);
	}
	return parts;
}

async function policyLifecycleVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	const completed = await controlArguments(ctx, verb, parts, snapshot, env.registry);
	if (!completed) return env.output(ctx, "Policy control canceled. No rules changed.");
	parts = completed;
	if (parts.length < 2) {
		env.output(ctx, `Usage: /policy ${verb} <id> <reason...>`, true);
		return;
	}
	const [id, ...reasons] = parts;
	const reason = reasons.join(" ");
	const audit = makeRuleAudit(ctx, "command");
	const expectedIdentity = targetIdentity(snapshot.records.get(id)) ?? undefined;
	if (verb === "disable") await env.registry.disable(id, reason, audit, expectedIdentity);
	else if (verb === "enable") await env.registry.enable(id, reason, audit, expectedIdentity);
	else await env.registry.retire(id, reason, audit, expectedIdentity);
	await env.loadRegistry(ctx);
	env.output(ctx, `${verb === "retire" ? "Retired" : verb === "disable" ? "Disabled" : "Enabled"} ${id}.`);
}

async function policyEffectVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	const completed = await controlArguments(ctx, "effect", parts, snapshot, env.registry);
	if (!completed) return env.output(ctx, "Policy control canceled. No rules changed.");
	parts = completed;
	if (parts.length < 3 || (parts[1] !== "steer" && parts[1] !== "block")) {
		env.output(ctx, "Usage: /policy effect <id> <steer|block> <reason...>", true);
		return;
	}
	await env.registry.setEffect(
		parts[0],
		parts[1],
		parts.slice(2).join(" "),
		makeRuleAudit(ctx, "command"),
		targetIdentity(snapshot.records.get(parts[0])) ?? undefined,
	);
	await env.loadRegistry(ctx);
	env.output(ctx, `Set ${parts[0]} effect to ${parts[1]}.`);
}

export default function registerPolicy(pi: ExtensionAPI): void {
	const { registerTool, publish } = toolDisplayPublisher(pi);
	const eventBus = pi.events;
	const agentDir = getAgentDir();
	const configured = readSettings({ agentDir });
	for (const diagnostic of configured.diagnostics) {
		console.warn(`[policy] ${diagnostic.field} (${diagnostic.source}): ${diagnostic.message}`);
	}
	const disposeSettings = publishSettings(eventBus, { agentDir });
	pi.on("session_shutdown", disposeSettings);
	eventBus.emit("durable:contribution", {
		name: "policy",
		source: fileURLToPath(import.meta.url),
		create: (host) => {
			disposeSettings();
			const disposeNativeSettings = publishSettings(eventBus, { agentDir: host.agentDir });
			host.onClose(disposeNativeSettings);
			return createPolicyDurableExtension(host);
		},
	} satisfies PolicyDurableContribution);
	pi.registerFlag(POLICY_MODE_FLAG, {
		type: "string",
		description: `Policy mode (${POLICY_MODES.join(", ")}); overrides configured machine mode`,
	});
	const dir = configured.values.dir;
	let noticeContext: ExtensionContext | undefined;
	const registry = new RuleRegistry(dir, {
		onNotice(message) {
			try {
				const safe = terminalSafe(message);
				if (noticeContext?.mode === "tui") noticeContext.ui.notify(safe, "error");
				else console.warn(safe);
			} catch {
				/* Reporting has no authority. */
			}
		},
	});
	let completionSnapshot: RuleSnapshot | undefined;
	let runtime: PolicyRuntime;
	const loadRegistry = async (ctx?: ExtensionContext): Promise<RuleSnapshot> => {
		if (ctx) noticeContext = ctx;
		const snapshot = await registry.snapshot();
		completionSnapshot = snapshot;
		runtime?.sync(snapshot);
		return snapshot;
	};
	let mode: PolicyMode = configured.values.mode;
	let resolved = false;
	let valid = true;
	const modeRecord = configured.records.find((record) => record.key === "mode");
	if (!modeRecord) throw new Error("Policy mode declaration is missing");
	let modeSource = modeRecord.origin === "env" ? modeRecord.env
		: modeRecord.origin === "file" ? `${configured.source.path}: policy.mode` : "default";
	if (modeRecord.status === "invalid") modeSource += "; invalid configured input, safe default";
	const ensureMode = (): boolean => {
		if (resolved) return valid;
		resolved = true;
		try {
			const flag = pi.getFlag(POLICY_MODE_FLAG);
			if (typeof flag === "string") {
				mode = resolvePolicyModeValue(flag, `--${POLICY_MODE_FLAG}`);
				modeSource = `--${POLICY_MODE_FLAG}`;
			}
		} catch (error) {
			valid = false;
			console.warn(`[policy] Invalid mode configuration: ${failureText(error)}`);
		}
		return valid;
	};
	runtime = new PolicyRuntime(pi, loadRegistry, () => mode, dir, ensureMode);
	registerRuleTools(pi, {
		registry,
		loadRegistry,
		getMode: () => (ensureMode() ? mode : "unavailable"),
		resetRevision: (id) => runtime.resetRevision(id),
		reset: (id, reason, revision) => runtime.reset(id === "--all" ? undefined : [id], reason, revision),
		telemetry: async (from, to) => ({ report: formatTelemetry(await readTelemetry(dir, from, to)) }),
		inspect: (view, params, ctx) => runtime.inspect(view, params, ctx as ExtensionContext),
	}, registerTool);
	publish();
	runtime.attach();
	let panelState: PolicyPanelResult = { view: "rules", filter: "" };
	const output = (ctx: ExtensionContext, text: string, error = false): void => {
		const safe = capText(terminalSafe(text), 32768);
		if (ctx.hasUI) {
			ctx.ui.notify(safe, error ? "error" : "info");
			return;
		}
		if (ctx.mode === "json") {
			pi.appendEntry("policy_command", { text: safe });
			return;
		}
		(error ? process.stderr : process.stdout).write(`${safe}\n`);
	};
	const reviewArtifact = (ctx: ExtensionContext, title: string, artifact: string): Promise<boolean> =>
		ctx.mode === "tui" && ctx.hasUI
			? ctx.ui.custom<boolean>(
					(tui, _theme, _keys, done) =>
						new PolicyApprovalPanel({
							title,
							artifact,
							tui,
							getMaxRows: () => tui.terminal.rows,
							done,
						}),
					{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" } },
				)
			: Promise.resolve(false);
	const showPanel = async (ctx: ExtensionContext): Promise<void> => {
		const [snapshot, fireSummary, activity] = await Promise.all([
			loadRegistry(ctx),
			readFireSummary(dir),
			readRecentActivity(dir),
		]);
		let handle: { setHidden(hidden: boolean): void; focus(): void } | undefined;
		const prompt = async <T>(work: () => Promise<T>): Promise<T> => {
			handle?.setHidden(true);
			try {
				return await work();
			} finally {
				handle?.setHidden(false);
				handle?.focus();
			}
		};
		panelState = await ctx.ui.custom<PolicyPanelResult>(
			(tui, theme, _keys, done) =>
				new PolicyPanel({
					data: { snapshot, fireSummary, activity },
					scopeContext: scope(ctx),
					theme,
					tui,
					getMaxRows: () => Math.max(8, tui.terminal.rows - 4),
					done,
					initialView: panelState.view,
					initialFilter: panelState.filter,
					initialSelectedRuleId: panelState.selectedRuleId,
					initialSelectedProposalId: panelState.selectedProposalId,
					initialSelectedActivityKey: panelState.selectedActivityKey,
					actionHost: {
						confirm: (title, message) => prompt(() => reviewArtifact(ctx, title, message)),
						select: (title, options) => prompt(() => ctx.ui.select(title, options)),
						approve: async (id, effect, revision) => {
							await registry.decide(id, "approved", effect, makeRuleAudit(ctx, "panel"), revision);
							return { snapshot: await loadRegistry(ctx), outcome: `Approved proposal ${id}.` };
						},
						reject: async (id) => {
							await registry.decide(id, "rejected", undefined, makeRuleAudit(ctx, "panel"));
							return { snapshot: await loadRegistry(ctx), outcome: `Rejected proposal ${id}.` };
						},
					},
				}),
			{
				overlay: true,
				overlayOptions: { width: "94%", minWidth: 112, maxHeight: "92%", anchor: "center", margin: 1 },
				onHandle: (value) => {
					handle = value;
				},
			},
		);
	};
	let panelOpen = false;
	const openPanel = async (ctx: ExtensionContext): Promise<void> => {
		if (panelOpen) return;
		panelOpen = true;
		try {
			if (!ensureMode()) return output(ctx, "Policy is stopped because its mode configuration is invalid.", true);
			if (ctx.mode !== "tui" || !ctx.hasUI)
				return output(ctx, "The policy panel requires TUI mode. Run: /policy list", true);
			await showPanel(ctx);
		} catch (error) {
			output(ctx, `Policy registry action failed: ${failureText(error)}`, true);
		} finally {
			panelOpen = false;
		}
	};
	pi.registerShortcut("ctrl+alt+p", {
		description: "Open the policy panel",
		handler: openPanel,
	});
	const commandEnv: PolicyCommandEnv = {
		output,
		loadRegistry,
		registry,
		runtime,
		dir,
		modeText: () => ({ mode, source: modeSource }),
		reviewArtifact,
	};
	const POLICY_VERB_HANDLERS: Readonly<Record<string, PolicyVerbHandler>> = {
		help: policyHelpVerb,
		mode: policyModeVerb,
		list: policyListVerb,
		show: policyShowVerb,
		capabilities: policyInspectVerb,
		state: policyInspectVerb,
		health: policyInspectVerb,
		explain: policyExplainVerb,
		preview: policyPreviewVerb,
		reset: policyResetVerb,
		catalog: policyCatalogVerb,
		import: policyImportVerb,
		data: policyDataVerb,
		approve: policyApproveVerb,
		reject: policyRejectVerb,
		effect: policyEffectVerb,
		disable: policyLifecycleVerb,
		enable: policyLifecycleVerb,
		retire: policyLifecycleVerb,
	};
	pi.registerCommand("policy", {
		description: "Inspect policy behavior, data, observation periods, and operator gates",
		async getArgumentCompletions(prefix: string): Promise<AutocompleteItem[]> {
			try {
				completionSnapshot = await loadRegistry();
			} catch {
				return [];
			}
			const parts = prefix.trimStart().split(/\s+/);
			const position = parts.length - 1;
			const partial = parts[position] ?? "";
			const verb = parts[0];
			const complete = (value: string): AutocompleteItem => ({
				value: [...parts.slice(0, position), value].join(" "),
				label: value,
			});
			if (position === 0) return VERBS.filter((v) => v.startsWith(partial)).map((value) => ({ value, label: value }));
			if (position === 1) return primaryCompletions(verb, partial, completionSnapshot, registry);
			if (position === 2 && verb === "approve") return effectCompletions(parts[1], partial, completionSnapshot);
			if (verb === "import" && position === 2 && "exact".startsWith(partial))
				return importCompletion(registry, parts[1]);
			const choices = completionChoicesForPosition(verb, parts, position, completionSnapshot, registry);
			return choices.filter((v) => v.startsWith(partial)).map(complete);
		},
		async handler(args, ctx) {
			if (!args.trim()) return openPanel(ctx);
			if (!ensureMode()) return output(ctx, "Policy is stopped because its mode configuration is invalid.", true);
			try {
				const trimmed = args.trim();
				const [verb = "", ...parts] = trimmed.split(/\s+/);
				if (verb === "telemetry") return await policyTelemetryVerb(commandEnv, ctx, parts);
				const snapshot = await loadRegistry(ctx);
				const run = POLICY_VERB_HANDLERS[verb];
				if (run) return await run(commandEnv, ctx, verb, parts, trimmed, snapshot);
				return output(ctx, `Unknown /policy action "${verb}". Use /policy help.`, true);
			} catch (error) {
				return output(ctx, `Policy registry action failed: ${failureText(error)}`, true);
			}
		},
	});
}
