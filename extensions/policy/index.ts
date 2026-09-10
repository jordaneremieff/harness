/** Policy registration and operator controls over the shared event interpreter. */
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { RuleRegistry, makeRuleAudit, proposalRevision, type RuleSnapshot } from "./local-rules.ts";
import { POLICY_MODES, resolvePolicyMode, resolvePolicyModeValue, type PolicyMode } from "./mode.ts";
import {
	capText,
	formatPolicyList,
	formatPolicyShow,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type PolicyPanelResult,
} from "./panel.ts";
import { effectiveState } from "./rule.ts";
import { PolicyRuntime } from "./runtime.ts";
import { resolvePolicyDir } from "./store.ts";
import { policyDataCommand, registerRuleTools } from "./tools.ts";

const POLICY_MODE_FLAG = "policy-mode";
const POLICY_USAGE = [
	"Usage:",
	"  /policy                                      Open the policy panel (TUI only)",
	"  /policy list                                 Print rules, proposals, and authority health",
	"  /policy show <id-or-proposal-id>              Show a rule or proposal",
	"  /policy approve <proposal-id> <steer|block>   Approve a command add proposal",
	"  /policy approve <proposal-id> exact <revision> Approve exact facts behavior",
	"  /policy approve <proposal-id> <steer|block> <revision> Approve exact command replacement behavior",
	"  /policy approve <proposal-id>                Approve a retire or disable proposal",
	"  /policy reject <proposal-id>                 Reject a proposal",
	"  /policy disable <id> <reason...>              Disable a rule",
	"  /policy enable <id> <reason...>               Enable a rule",
	"  /policy effect <id> <steer|block> <reason...>  Override a command rule effect",
	"  /policy retire <local-id> <reason...>         Retire a local definition",
	"  /policy capabilities | state | health       Inspect the runtime",
	"  /policy explain <rule-id|call:call-id>        Explain a rule or recorded call",
	"  /policy preview <JSON>                       Preview without simulated execution or state changes",
	"  /policy reset <id|--all> <reason...>          Start a new observation period",
	"  /policy data list|show <name>|set <JSON>|remove <name> <revision>",
	"  /policy mode                                Report the session mode",
	"  /policy help                                Show this usage",
].join("\n");
const VERBS = [
	"list",
	"show",
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
						confirm: (title, message) => prompt(() => ctx.ui.confirm(title, message)),
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
			const records = [...(completionSnapshot?.records.values() ?? [])];
			const proposals = completionSnapshot?.pending ?? [];
			let choices: string[] = [];
			if (position === 1 && ["show", "explain"].includes(verb))
				choices = [...records.map((r) => r.id), ...(verb === "show" ? proposals.map((p) => p.id) : [])];
			if (position === 1 && ["approve", "reject"].includes(verb)) choices = proposals.map((p) => p.id);
			if (position === 1 && ["disable", "enable", "effect", "retire", "reset"].includes(verb))
				choices = records
					.filter((r) =>
						verb === "disable"
							? effectiveState(r) === "active"
							: verb === "enable"
								? effectiveState(r) === "disabled"
								: verb === "retire"
									? r.source.kind === "local" && r.definition.state === "active"
									: effectiveState(r) !== "retired",
					)
					.map((r) => r.id);
			if (position === 2 && verb === "effect") choices = ["steer", "block"];
			if (position === 2 && verb === "approve") {
				const proposal = proposals.find((p) => p.id === parts[1]);
				if (proposal?.operation === "add")
					choices = proposal.candidate?.matcher.language === "facts/v1" ? ["exact"] : ["steer", "block"];
				if (proposal?.operation === "replace")
					choices = proposal.candidate?.matcher.language === "facts/v1" ? ["exact"] : ["steer", "block"];
			}
			if (position === 3 && verb === "approve") {
				const proposal = proposals.find((p) => p.id === parts[1]);
				if (proposal) choices = [proposalRevision(proposal)];
			}
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
				if (verb === "help") return output(ctx, POLICY_USAGE);
				if (verb === "mode") {
					if (parts.length) return output(ctx, "Usage: /policy mode", true);
					return output(
						ctx,
						`${mode} (${modeSource})\n${MODE_EFFECT[mode]}\n${snapshot.health.status === "degraded" ? "Rule-store degradation caps mechanisms at notice." : "Rule store healthy."}`,
					);
				}
				if (verb === "list") {
					if (parts.length) return output(ctx, "Usage: /policy list", true);
					return output(ctx, formatPolicyList({ snapshot, fireSummary: await readFireSummary(dir) }));
				}
				if (verb === "show") {
					if (parts.length !== 1) return output(ctx, "Usage: /policy show <id-or-proposal-id>", true);
					const shown = formatPolicyShow({ snapshot, fireSummary: await readFireSummary(dir) }, parts[0], scope(ctx));
					return shown ? output(ctx, shown) : output(ctx, `No rule or pending proposal named "${parts[0]}".`, true);
				}
				if (["capabilities", "state", "health"].includes(verb)) {
					if (parts.length) return output(ctx, `Usage: /policy ${verb}`, true);
					return output(ctx, JSON.stringify(await runtime.inspect(verb, {}, ctx), null, 2));
				}
				if (verb === "explain") {
					if (parts.length !== 1) return output(ctx, "Usage: /policy explain <rule-id|call:call-id>", true);
					return output(ctx, JSON.stringify(await runtime.inspect(verb, { id: parts[0] }, ctx), null, 2));
				}
				if (verb === "preview") {
					const text = trimmed.slice(verb.length).trim();
					if (Buffer.byteLength(text) > 262144) throw new Error("Preview exceeds the input bound");
					return output(ctx, JSON.stringify(await runtime.inspect(verb, JSON.parse(text), ctx), null, 2));
				}
				if (verb === "reset") {
					if (parts.length < 2) return output(ctx, "Usage: /policy reset <id|--all> <reason...>", true);
					runtime.reset(parts[0] === "--all" ? undefined : [parts[0]], parts.slice(1).join(" "));
					return output(ctx, "Started a new policy observation period.");
				}
				if (verb === "data") {
					const text = await policyDataCommand(
						registry,
						trimmed.slice(verb.length).trim(),
						makeRuleAudit(ctx, "command"),
						(title, message) => (ctx.hasUI ? ctx.ui.confirm(title, message) : Promise.resolve(false)),
					);
					await loadRegistry(ctx);
					return output(ctx, text);
				}
				if (verb === "approve") {
					if (parts.length < 1 || parts.length > 3)
						return output(ctx, "Usage: /policy approve <proposal-id> [steer|block|exact <revision>]", true);
					const proposal = snapshot.pending.find((p) => p.id === parts[0]);
					if (!proposal) return output(ctx, `No pending proposal with id "${parts[0]}".`, true);
					const exact = proposal.candidate?.matcher.language === "facts/v1";
					let effect: "steer" | "block" | undefined;
					let revision: string | undefined;
					if (exact) {
						if (parts.length !== 3 || parts[1] !== "exact")
							return output(ctx, "Exact approval requires: /policy approve <proposal-id> exact <revision>", true);
						revision = parts[2];
					} else if (proposal.operation === "replace") {
						if (parts.length !== 3 || (parts[1] !== "steer" && parts[1] !== "block"))
							return output(
								ctx,
								"Command replacement approval requires: /policy approve <proposal-id> <steer|block> <revision>",
								true,
							);
						effect = parts[1];
						revision = parts[2];
					} else if (proposal.operation === "add") {
						if (parts.length !== 2 || (parts[1] !== "steer" && parts[1] !== "block"))
							return output(
								ctx,
								"Approving an add proposal requires: /policy approve <proposal-id> <steer|block>",
								true,
							);
						effect = parts[1];
					} else if (parts.length !== 1)
						return output(
							ctx,
							`Approving a ${proposal.operation} proposal forbids an effect: /policy approve <proposal-id>`,
							true,
						);
					await registry.decide(proposal.id, "approved", effect, makeRuleAudit(ctx, "command"), revision);
					await loadRegistry(ctx);
					return output(ctx, `Approved ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}.`);
				}
				if (verb === "reject") {
					if (parts.length !== 1) return output(ctx, "Usage: /policy reject <proposal-id>", true);
					await registry.decide(parts[0], "rejected", undefined, makeRuleAudit(ctx, "command"));
					await loadRegistry(ctx);
					return output(ctx, `Rejected proposal ${parts[0]}.`);
				}
				if (["disable", "enable", "retire"].includes(verb)) {
					if (parts.length < 2) return output(ctx, `Usage: /policy ${verb} <id> <reason...>`, true);
					const [id, ...reasons] = parts;
					const reason = reasons.join(" ");
					const audit = makeRuleAudit(ctx, "command");
					if (verb === "disable") await registry.disable(id, reason, audit);
					else if (verb === "enable") await registry.enable(id, reason, audit);
					else await registry.retire(id, reason, audit);
					await loadRegistry(ctx);
					return output(ctx, `${verb === "retire" ? "Retired" : verb === "disable" ? "Disabled" : "Enabled"} ${id}.`);
				}
				if (verb === "effect") {
					if (parts.length < 3 || (parts[1] !== "steer" && parts[1] !== "block"))
						return output(ctx, "Usage: /policy effect <id> <steer|block> <reason...>", true);
					await registry.setEffect(parts[0], parts[1], parts.slice(2).join(" "), makeRuleAudit(ctx, "command"));
					await loadRegistry(ctx);
					return output(ctx, `Set ${parts[0]} effect to ${parts[1]}.`);
				}
				return output(ctx, `Unknown /policy action "${verb}". Use /policy help.`, true);
			} catch (error) {
				return output(ctx, `Policy registry action failed: ${failureText(error)}`, true);
			}
		},
	});
}
