/** Policy registration and operator controls over the shared event interpreter. */
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	candidatePermitsEffectChoice,
	makeRuleAudit,
	type PendingProposal,
	proposalRevision,
	RuleRegistry,
	type RuleSnapshot,
} from "./local-rules.ts";
import { POLICY_MODES, type PolicyMode, resolvePolicyMode, resolvePolicyModeValue } from "./mode.ts";
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
import { resolvePolicyDir } from "./store.ts";
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
	"  /policy approve <proposal-id> <steer|block>   Approve a selectable add action",
	"  /policy approve <proposal-id> exact <revision> Approve an exact action",
	"  /policy approve <proposal-id> <steer|block> <revision> Approve a selectable replacement action",
	"  /policy approve <proposal-id>                Approve a retire or disable proposal",
	"  /policy reject <proposal-id>                 Reject a proposal",
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
		return [...records.map((record) => record.id), ...(verb === "show" ? proposals.map((proposal) => proposal.id) : [])];
	if (verb === "approve" || verb === "reject") return proposals.map((proposal) => proposal.id);
	if (SELECTABLE_VERBS.has(verb))
		return records.filter((record) => selectableForAction(record, verb)).map((record) => record.id);
	if (verb === "reset")
		return [...records.filter((record) => selectableForAction(record, verb)).map((record) => record.id), "--all"];
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
	output: (ctx: ExtensionCommandContext, text: string, error?: boolean) => void;
	loadRegistry: (ctx?: ExtensionContext) => Promise<RuleSnapshot>;
	registry: RuleRegistry;
	runtime: PolicyRuntime;
	dir: string;
	modeText: () => { mode: PolicyMode; source: string };
	reviewArtifact: (ctx: ExtensionCommandContext, title: string, artifact: string) => Promise<boolean>;
	openPanel: (ctx: ExtensionCommandContext) => Promise<void>;
}

type PolicyVerbHandler = (
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	parts: string[],
	trimmed: string,
	snapshot: RuleSnapshot,
) => void | Promise<void>;

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

function policyResetVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): void {
	if (parts.length < 2) {
		env.output(ctx, "Usage: /policy reset <id|--all> <reason...>", true);
		return;
	}
	env.runtime.reset(parts[0] === "--all" ? undefined : [parts[0]], parts.slice(1).join(" "));
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
	const text = await policyImportCommand(
		env.registry,
		trimmed.slice(verb.length).trim(),
		makeRuleAudit(ctx, "command"),
		(title, artifact) => env.reviewArtifact(ctx, title, artifact),
	);
	await env.loadRegistry(ctx);
	env.output(ctx, text);
}

async function policyDataVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	_parts: string[],
	trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	const text = await policyDataCommand(
		env.registry,
		trimmed.slice(verb.length).trim(),
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
): { effect: "steer" | "block" } | string {
	if (parts.length !== 2 || choice === undefined)
		return "Approving an add proposal requires: /policy approve <proposal-id> <steer|block>";
	return { effect: choice };
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
	if (parts.length !== 1)
		return `Approving a ${proposal.operation} proposal forbids an effect: /policy approve <proposal-id>`;
	return {};
}

async function policyApproveVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length < 1 || parts.length > 3) {
		env.output(ctx, "Usage: /policy approve <proposal-id> [steer|block|exact <revision>]", true);
		return;
	}
	const proposal = snapshot.pending.find((entry) => entry.id === parts[0]);
	if (!proposal) {
		env.output(ctx, `No pending proposal with id "${parts[0]}".`, true);
		return;
	}
	const decision = approveArguments(parts, proposal);
	if (typeof decision === "string") {
		env.output(ctx, decision, true);
		return;
	}
	await env.registry.decide(proposal.id, "approved", decision.effect, makeRuleAudit(ctx, "command"), decision.revision);
	await env.loadRegistry(ctx);
	env.output(ctx, `Approved ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}.`);
}

async function policyRejectVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length !== 1) {
		env.output(ctx, "Usage: /policy reject <proposal-id>", true);
		return;
	}
	await env.registry.decide(parts[0], "rejected", undefined, makeRuleAudit(ctx, "command"));
	await env.loadRegistry(ctx);
	env.output(ctx, `Rejected proposal ${parts[0]}.`);
}

async function policyLifecycleVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length < 2) {
		env.output(ctx, `Usage: /policy ${verb} <id> <reason...>`, true);
		return;
	}
	const [id, ...reasons] = parts;
	const reason = reasons.join(" ");
	const audit = makeRuleAudit(ctx, "command");
	if (verb === "disable") await env.registry.disable(id, reason, audit);
	else if (verb === "enable") await env.registry.enable(id, reason, audit);
	else await env.registry.retire(id, reason, audit);
	await env.loadRegistry(ctx);
	env.output(ctx, `${verb === "retire" ? "Retired" : verb === "disable" ? "Disabled" : "Enabled"} ${id}.`);
}

async function policyEffectVerb(
	env: PolicyCommandEnv,
	ctx: ExtensionCommandContext,
	_verb: string,
	parts: string[],
	_trimmed: string,
	_snapshot: RuleSnapshot,
): Promise<void> {
	if (parts.length < 3 || (parts[1] !== "steer" && parts[1] !== "block")) {
		env.output(ctx, "Usage: /policy effect <id> <steer|block> <reason...>", true);
		return;
	}
	await env.registry.setEffect(parts[0], parts[1], parts.slice(2).join(" "), makeRuleAudit(ctx, "command"));
	await env.loadRegistry(ctx);
	env.output(ctx, `Set ${parts[0]} effect to ${parts[1]}.`);
}

export default function registerPolicy(pi: ExtensionAPI): void {
	pi.registerFlag(POLICY_MODE_FLAG, {
		type: "string",
		description: `Policy mode (${POLICY_MODES.join(", ")}); overrides PI_POLICY_MODE`,
	});
	const dir = resolvePolicyDir(process.env, getAgentDir());
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
	let mode: PolicyMode = "observe";
	let resolved = false;
	let valid = true;
	let modeSource = "PI_POLICY_MODE is unset; observe is the default";
	const ensureMode = (): boolean => {
		if (resolved) return valid;
		resolved = true;
		try {
			const flag = pi.getFlag(POLICY_MODE_FLAG);
			if (typeof flag === "string") {
				mode = resolvePolicyModeValue(flag, `--${POLICY_MODE_FLAG}`);
				modeSource = `--${POLICY_MODE_FLAG}`;
			} else {
				mode = resolvePolicyMode();
				if (process.env.PI_POLICY_MODE?.trim()) modeSource = "PI_POLICY_MODE";
			}
		} catch (error) {
			valid = false;
			console.warn(`[policy] Invalid mode configuration: ${failureText(error)}`);
		}
		return valid;
	};
	runtime = new PolicyRuntime(pi, loadRegistry, () => mode, dir, ensureMode);
	registerRuleTools(pi, { registry, loadRegistry, inspect: (view, params, ctx) => runtime.inspect(view, params, ctx) });
	runtime.attach();
	let panelState: PolicyPanelResult = { view: "rules", filter: "" };
	const output = (ctx: ExtensionCommandContext, text: string, error = false): void => {
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
	const reviewArtifact = (ctx: ExtensionCommandContext, title: string, artifact: string): Promise<boolean> =>
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
	const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
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
	const commandEnv: PolicyCommandEnv = {
		output,
		loadRegistry,
		registry,
		runtime,
		dir,
		modeText: () => ({ mode, source: modeSource }),
		reviewArtifact,
		openPanel,
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
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const parts = prefix.trimStart().split(/\s+/);
			const position = parts.length - 1;
			const partial = parts[position] ?? "";
			const verb = parts[0];
			const complete = (value: string): AutocompleteItem => ({
				value: [...parts.slice(0, position), value].join(" "),
				label: value,
			});
			if (position === 0) return VERBS.filter((v) => v.startsWith(partial)).map((value) => ({ value, label: value }));
			const choices = completionChoicesForPosition(verb, parts, position, completionSnapshot, registry);
			return choices.filter((v) => v.startsWith(partial)).map(complete);
		},
		async handler(args, ctx) {
			if (!ensureMode()) return output(ctx, "Policy is stopped because its mode configuration is invalid.", true);
			try {
				const snapshot = await loadRegistry(ctx);
				const trimmed = args.trim();
				if (!trimmed) {
					if (ctx.mode !== "tui") return output(ctx, "The policy panel requires TUI mode. Run: /policy list", true);
					return await openPanel(ctx);
				}
				const [verb = "", ...parts] = trimmed.split(/\s+/);
				const run = POLICY_VERB_HANDLERS[verb];
				if (run) return await run(commandEnv, ctx, verb, parts, trimmed, snapshot);
				return output(ctx, `Unknown /policy action "${verb}". Use /policy help.`, true);
			} catch (error) {
				return output(ctx, `Policy registry action failed: ${failureText(error)}`, true);
			}
		},
	});
}
