/**
 * Unified policy dispatch.
 *
 * The first policy use synchronizes the installed package catalog into one
 * append-only rules.jsonl log, reduces every source into one RuleRecord map,
 * filters inactive/unavailable/out-of-scope records before matcher dispatch,
 * and computes one effective mechanism for the call. Session startup itself
 * performs no rule-store I/O.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { captureFor, matchRuleRecords } from "./classify.ts";
import { RuleRegistry, makeRuleAudit, type RuleSnapshot } from "./local-rules.ts";
import { POLICY_MODES, resolvePolicyMode, resolvePolicyModeValue, type PolicyMode } from "./mode.ts";
import {
	capText,
	formatPolicyList,
	formatPolicyShow,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type PanelActionResult,
	type PolicyPanelData,
	type PolicyPanelResult,
} from "./panel.ts";
import {
	finishCall,
	startCall,
	trackPending,
	type CallEffects,
	type ContentLike,
	type PendingCall,
	type ResultFacts,
	type SessionFacts,
} from "./record.ts";
import { effectiveEffect, effectiveState, ruleGuidance, type RuleRecord } from "./rule.ts";
import { PolicyWriter, resolvePolicyDir } from "./store.ts";
import { registerRuleTools } from "./tools.ts";

const POLICY_MODE_FLAG = "policy-mode";
const PROJECT_CONTEXT_MARKER = "<project_context>";
const POLICY_PREFIX = "[policy]";
const MAX_GUIDANCE_BYTES = 512;
const MAX_ANNOTATED_SESSIONS = 16;

type Mechanism = "none" | "notice" | "annotate" | "block";

const POLICY_USAGE = [
	"Usage:",
	"  /policy                                             Open the Rules, Proposals, and Activity panel (TUI only)",
	"  /policy list                                        Print all rules, pending proposals, and registry health",
	"  /policy show <id-or-proposal-id>                    Show one rule or pending proposal",
	"  /policy approve <proposal-id> <steer|block>         Approve an add proposal (effect required)",
	"  /policy approve <proposal-id>                       Approve a retire or disable proposal (effect forbidden)",
	"  /policy reject <proposal-id>                        Reject a pending proposal",
	"  /policy disable <id> <reason...>                    Disable any rule through the override slot",
	"  /policy enable <id> <reason...>                     Remove disabled state; preserve an effect override",
	"  /policy effect <id> <steer|block> <reason...>       Override any rule effect",
	"  /policy retire <local-id> <reason...>               Retire a local definition",
	"  /policy mode                                        Report this session's policy mode",
	"  /policy help                                        Show this usage",
].join("\n");

const POLICY_VERBS: AutocompleteItem[] = [
	{ value: "list", label: "list", description: "Print unified rules, proposals, and health" },
	{ value: "show", label: "show", description: "Show one rule or pending proposal" },
	{ value: "approve", label: "approve", description: "Approve a pending proposal" },
	{ value: "reject", label: "reject", description: "Reject a pending proposal" },
	{ value: "disable", label: "disable", description: "Disable any rule (reason required)" },
	{ value: "enable", label: "enable", description: "Remove a disabled override state (reason required)" },
	{ value: "effect", label: "effect", description: "Override a rule effect (reason required)" },
	{ value: "retire", label: "retire", description: "Retire a local definition (reason required)" },
	{ value: "mode", label: "mode", description: "Report active policy mode" },
	{ value: "help", label: "help", description: "Show usage" },
];

const MODE_EFFECT: Readonly<Record<PolicyMode, string>> = {
	observe: "Records every tool call and applies no mechanism.",
	notice: "Records every tool call and shows a terminal warning for each matched call in TUI mode.",
	annotate: "Records every tool call and appends bounded guidance to eligible matched results.",
	enforce: "Records every tool call, blocks effective block rules, and annotates effective steer rules.",
};

function readTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const truncation = (details as { truncation?: unknown }).truncation;
	if (!truncation || typeof truncation !== "object") return false;
	return (truncation as { truncated?: unknown }).truncated === true;
}

function readTokens(usage: unknown): number | null {
	if (!usage || typeof usage !== "object") return null;
	const total = (usage as { totalTokens?: unknown }).totalTokens;
	return typeof total === "number" ? total : null;
}

function failureText(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown policy failure";
	}
}

function sessionScope(ctx: ExtensionContext): { provider?: string; model?: string; cwd: string } {
	return {
		...(ctx.model ? { provider: ctx.model.provider, model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
		cwd: ctx.cwd,
	};
}

interface ObservedCall extends PendingCall {
	sessionFacts: SessionFacts;
	matched: RuleRecord[];
	guidance: Map<string, string>;
	mechanism: Mechanism;
	blocked?: boolean;
	blockReason?: string;
}

interface Annotation {
	text: string;
	ids: string[];
}

function requestedMechanism(mode: PolicyMode, matched: readonly RuleRecord[], degraded: boolean): Mechanism {
	if (mode === "observe" || matched.length === 0) return "none";
	if (degraded) return "notice";
	if (mode === "notice") return "notice";
	if (mode === "annotate") return "annotate";
	return matched.some((record) => effectiveEffect(record) === "block") ? "block" : "annotate";
}

export default function registerPolicy(pi: ExtensionAPI): void {
	pi.registerFlag(POLICY_MODE_FLAG, {
		type: "string",
		description: `Policy mode (${POLICY_MODES.join(", ")}); overrides PI_POLICY_MODE`,
	});

	const rulesDir = resolvePolicyDir(process.env, getAgentDir());
	let noticeContext: ExtensionContext | undefined;
	const registry = new RuleRegistry(rulesDir, {
		onNotice(message) {
			try {
				const safe = terminalSafe(message);
				if (noticeContext?.mode === "tui") noticeContext.ui.notify(safe, "error");
				else console.warn(safe);
			} catch {
				// A broken reporting channel cannot change authority or matching.
			}
		},
	});
	let completionSnapshot: RuleSnapshot | undefined;
	const loadRegistry = async (ctx?: ExtensionContext): Promise<RuleSnapshot> => {
		if (ctx) noticeContext = ctx;
		const snapshot = await registry.snapshot();
		completionSnapshot = snapshot;
		return snapshot;
	};

	registerRuleTools(pi, { registry, loadRegistry });

	const pending = new Map<string, ObservedCall>();
	let stopped = false;
	let failureReported = false;
	let writer: PolicyWriter | undefined;
	let mode: PolicyMode = "observe";
	let modeResolved = false;
	let modeSource = "PI_POLICY_MODE is unset; observe is the default";
	const annotatedBySession = new Map<string, Set<string>>();
	let panelState: PolicyPanelResult = { view: "rules", filter: "" };

	const stop = (error: unknown): void => {
		stopped = true;
		pending.clear();
		if (failureReported) return;
		failureReported = true;
		try {
			console.warn(`[policy] recording stopped for this session: ${failureText(error)}`);
		} catch {
			// A failing console leaves no reporting channel.
		}
	};

	const ensureMode = (): boolean => {
		if (modeResolved) return !stopped;
		modeResolved = true;
		try {
			const flag = pi.getFlag(POLICY_MODE_FLAG);
			if (typeof flag === "string") {
				mode = resolvePolicyModeValue(flag, `--${POLICY_MODE_FLAG}`);
				modeSource = `--${POLICY_MODE_FLAG}`;
			} else {
				mode = resolvePolicyMode();
				if (process.env.PI_POLICY_MODE?.trim()) modeSource = "PI_POLICY_MODE";
			}
			return true;
		} catch (error) {
			stop(error);
			return false;
		}
	};

	const sessionFacts = (ctx: ExtensionContext, snapshot: RuleSnapshot): SessionFacts => {
		const model = ctx.model;
		return {
			session: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: ctx.thinkingLevel ?? null,
			projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
			ruleStoreDegraded: snapshot.health.status === "degraded",
		};
	};

	const recordWriter = (): PolicyWriter => {
		writer ??= new PolicyWriter(rulesDir, stop);
		return writer;
	};

	const writeRecord = (
		call: ObservedCall,
		content: ContentLike[] | undefined,
		isError: boolean | undefined,
		details: unknown,
		usage: unknown,
		effects: CallEffects,
	): boolean => {
		const result: ResultFacts = {
			content,
			isError,
			truncated: readTruncated(details),
			tokens: readTokens(usage),
		};
		return recordWriter().enqueue(finishCall(call, result, call.sessionFacts, mode, effects), call.blocked === true);
	};

	const takeCall = (callId: string): ObservedCall | undefined => {
		const call = pending.get(callId);
		if (call) pending.delete(callId);
		return call;
	};

	const annotatedIdsFor = (session: string): Set<string> => {
		let ids = annotatedBySession.get(session);
		if (ids) return ids;
		if (annotatedBySession.size >= MAX_ANNOTATED_SESSIONS) {
			const oldest = annotatedBySession.keys().next();
			if (!oldest.done) annotatedBySession.delete(oldest.value);
		}
		ids = new Set();
		annotatedBySession.set(session, ids);
		return ids;
	};

	const guidanceLine = (records: readonly RuleRecord[], only?: (record: RuleRecord) => boolean): string => {
		let text = POLICY_PREFIX;
		const included = new Set<string>();
		for (const record of records) {
			if (only && !only(record)) continue;
			const guidance = ruleGuidance(record);
			if (included.has(guidance)) continue;
			const candidate = `${text} ${guidance}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(guidance);
		}
		if (text === POLICY_PREFIX) throw new Error("policy rules matched but their guidance exceeds the configured bound");
		return text;
	};

	const annotationFor = (call: ObservedCall): Annotation | undefined => {
		const annotated = annotatedIdsFor(call.sessionFacts.session);
		let text = POLICY_PREFIX;
		const ids: string[] = [];
		const included = new Set<string>();
		for (const record of call.matched) {
			if (call.mechanism === "annotate" && mode === "enforce" && effectiveEffect(record) !== "steer") continue;
			if (annotated.has(record.id)) continue;
			const guidance = call.guidance.get(record.id);
			if (!guidance) continue;
			if (included.has(guidance)) {
				ids.push(record.id);
				continue;
			}
			const candidate = `${text} ${guidance}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(guidance);
			ids.push(record.id);
		}
		return included.size === 0 ? undefined : { text, ids };
	};

	const commandText = (ctx: ExtensionCommandContext, text: string): void => {
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
			return;
		}
		if (ctx.mode === "json") {
			pi.appendEntry("policy_command", { text });
			return;
		}
		process.stdout.write(`${text}\n`);
	};
	const commandFailure = (ctx: ExtensionCommandContext, text: string): void => {
		const safe = capText(terminalSafe(text), 4096);
		if (ctx.hasUI) {
			ctx.ui.notify(safe, "error");
			return;
		}
		if (ctx.mode === "json") {
			pi.appendEntry("policy_command", { text: safe });
			return;
		}
		process.stderr.write(`${safe}\n`);
	};

	const actionResult = async (ctx: ExtensionContext, outcome: string): Promise<PanelActionResult> => ({
		snapshot: await loadRegistry(ctx),
		outcome,
	});

	const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
		const [snapshot, fireSummary, activity] = await Promise.all([
			loadRegistry(ctx),
			readFireSummary(rulesDir),
			readRecentActivity(rulesDir),
		]);
		const data: PolicyPanelData = { snapshot, fireSummary, activity };
		let panelHandle: { setHidden(hidden: boolean): void; focus(): void } | undefined;
		const withPanelPrompt = async <T>(prompt: () => Promise<T>): Promise<T> => {
			panelHandle?.setHidden(true);
			try {
				return await prompt();
			} finally {
				panelHandle?.setHidden(false);
				panelHandle?.focus();
			}
		};
		panelState = await ctx.ui.custom<PolicyPanelResult>(
			(tui, theme, _keybindings, done) =>
				new PolicyPanel({
					data,
					scopeContext: sessionScope(ctx),
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
						confirm: (title, message) => withPanelPrompt(() => ctx.ui.confirm(title, message)),
						select: (title, options) => withPanelPrompt(() => ctx.ui.select(title, options)),
						approve: async (proposalId, effect) => {
							await registry.decide(proposalId, "approved", effect, makeRuleAudit(ctx, "panel"));
							return actionResult(ctx, `Approved proposal ${proposalId}.`);
						},
						reject: async (proposalId) => {
							await registry.decide(proposalId, "rejected", undefined, makeRuleAudit(ctx, "panel"));
							return actionResult(ctx, `Rejected proposal ${proposalId}.`);
						},
					},
				}),
			{
				overlay: true,
				overlayOptions: { width: "94%", minWidth: 112, maxHeight: "92%", anchor: "center", margin: 1 },
				onHandle: (handle) => {
					panelHandle = handle;
				},
			},
		);
	};

	pi.registerCommand("policy", {
		description: "Browse unified policy rules, inspect health, and exercise operator gates",
		getArgumentCompletions(prefix: string) {
			const parts = prefix.trimStart().split(/\s+/);
			const position = parts.length - 1;
			const partial = parts[position] ?? "";
			if (position === 0) return POLICY_VERBS.filter((item) => item.value.startsWith(partial));
			const verb = parts[0];
			const complete = (value: string, description?: string): AutocompleteItem => ({
				value: [...parts.slice(0, position), value].join(" "),
				label: value,
				...(description ? { description } : {}),
			});
			const records = [...(completionSnapshot?.records.values() ?? [])];
			const proposals = completionSnapshot?.pending ?? [];
			if (position === 1 && verb === "show") {
				return [
					...records.map((record) => complete(record.id, `${record.source.kind} rule`)),
					...proposals.map((proposal) =>
						complete(proposal.id, `${proposal.operation} proposal for ${proposal.ruleId}`),
					),
				].filter((item) => item.label.startsWith(partial));
			}
			if (position === 1 && (verb === "approve" || verb === "reject")) {
				return proposals
					.filter((proposal) => proposal.id.startsWith(partial))
					.map((proposal) => complete(proposal.id, `${proposal.operation} proposal for ${proposal.ruleId}`));
			}
			if (position === 1 && ["disable", "enable", "effect", "retire"].includes(verb)) {
				const eligible = records.filter((record) => {
					if (verb === "disable") return effectiveState(record) === "active";
					if (verb === "enable") return effectiveState(record) === "disabled";
					if (verb === "effect") return effectiveState(record) !== "retired";
					return record.source.kind === "local" && record.definition.state === "active";
				});
				return eligible
					.filter((record) => record.id.startsWith(partial))
					.map((record) => complete(record.id, `${effectiveState(record)} ${effectiveEffect(record)}`));
			}
			if (position === 2 && verb === "effect") {
				return ["steer", "block"].filter((effect) => effect.startsWith(partial)).map((effect) => complete(effect));
			}
			if (position === 2 && verb === "approve") {
				const proposal = proposals.find((entry) => entry.id === parts[1]);
				if (proposal?.operation === "add") {
					return ["steer", "block"].filter((effect) => effect.startsWith(partial)).map((effect) => complete(effect));
				}
			}
			return [];
		},
		async handler(args, ctx) {
			if (!ensureMode()) return commandFailure(ctx, "Policy is stopped because its mode configuration is invalid.");
			const trimmed = args.trim();
			try {
				const snapshot = await loadRegistry(ctx);
				if (!trimmed) {
					if (ctx.mode !== "tui") return commandFailure(ctx, "The policy panel requires TUI mode. Run: /policy list");
					return await openPanel(ctx);
				}
				const [verb = "", ...parts] = trimmed.split(/\s+/);
				if (verb === "help") return commandText(ctx, POLICY_USAGE);
				if (verb === "mode") {
					if (parts.length > 0) return commandFailure(ctx, "Usage: /policy mode");
					return commandText(
						ctx,
						`${mode} (${modeSource})\n${MODE_EFFECT[mode]}\n${snapshot.health.status === "degraded" ? "Rule-store degradation caps mechanisms at notice." : "Rule store healthy."}`,
					);
				}
				if (verb === "list") {
					if (parts.length > 0) return commandFailure(ctx, "Usage: /policy list");
					return commandText(ctx, formatPolicyList({ snapshot, fireSummary: await readFireSummary(rulesDir) }));
				}
				if (verb === "show") {
					if (parts.length !== 1) return commandFailure(ctx, "Usage: /policy show <id-or-proposal-id>");
					const shown = formatPolicyShow(
						{ snapshot, fireSummary: await readFireSummary(rulesDir) },
						parts[0],
						sessionScope(ctx),
					);
					return shown
						? commandText(ctx, shown)
						: commandFailure(ctx, `No rule or pending proposal named "${terminalSafe(parts[0])}".`);
				}
				if (verb === "approve") {
					if (parts.length < 1 || parts.length > 2)
						return commandFailure(ctx, "Usage: /policy approve <proposal-id> [steer|block]");
					const proposal = snapshot.pending.find((entry) => entry.id === parts[0]);
					if (!proposal) return commandFailure(ctx, `No pending proposal with id "${terminalSafe(parts[0])}".`);
					let effect: "steer" | "block" | undefined;
					if (proposal.operation === "add") {
						if (parts.length !== 2 || (parts[1] !== "steer" && parts[1] !== "block")) {
							return commandFailure(
								ctx,
								"Approving an add proposal requires: /policy approve <proposal-id> <steer|block>",
							);
						}
						effect = parts[1];
					} else if (parts.length !== 1) {
						return commandFailure(
							ctx,
							`Approving a ${proposal.operation} proposal forbids an effect: /policy approve <proposal-id>`,
						);
					}
					await registry.decide(proposal.id, "approved", effect, makeRuleAudit(ctx, "command"));
					await loadRegistry(ctx);
					return commandText(ctx, `Approved ${proposal.operation} proposal ${proposal.id} for ${proposal.ruleId}.`);
				}
				if (verb === "reject") {
					if (parts.length !== 1) return commandFailure(ctx, "Usage: /policy reject <proposal-id>");
					await registry.decide(parts[0], "rejected", undefined, makeRuleAudit(ctx, "command"));
					await loadRegistry(ctx);
					return commandText(ctx, `Rejected proposal ${parts[0]}.`);
				}
				if (verb === "disable" || verb === "enable" || verb === "retire") {
					if (parts.length < 2) return commandFailure(ctx, `Usage: /policy ${verb} <id> <reason...>`);
					const [id, ...reasonParts] = parts;
					const reason = reasonParts.join(" ");
					const audit = makeRuleAudit(ctx, "command");
					if (verb === "disable") await registry.disable(id, reason, audit);
					else if (verb === "enable") await registry.enable(id, reason, audit);
					else await registry.retire(id, reason, audit);
					await loadRegistry(ctx);
					return commandText(
						ctx,
						`${verb === "retire" ? "Retired" : verb === "disable" ? "Disabled" : "Enabled"} ${id}.`,
					);
				}
				if (verb === "effect") {
					if (parts.length < 3 || (parts[1] !== "steer" && parts[1] !== "block")) {
						return commandFailure(ctx, "Usage: /policy effect <id> <steer|block> <reason...>");
					}
					const [id, effect, ...reasonParts] = parts;
					await registry.setEffect(
						id,
						effect as "steer" | "block",
						reasonParts.join(" "),
						makeRuleAudit(ctx, "command"),
					);
					await loadRegistry(ctx);
					return commandText(ctx, `Set ${id} effect to ${effect}.`);
				}
				return commandFailure(ctx, `Unknown /policy action "${terminalSafe(verb)}". Use /policy help.`);
			} catch (error) {
				return commandFailure(ctx, `Policy registry action failed: ${failureText(error)}`);
			}
		},
	});

	pi.on("session_start", () => {
		// Resolve configuration eagerly, but deliberately perform no registry I/O.
		ensureMode();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ensureMode()) return;
		try {
			const snapshot = await loadRegistry(ctx);
			const captured = captureFor(event.toolName, event.input as Record<string, unknown>);
			const base = startCall(
				event.toolName,
				event.toolCallId,
				event.input as Record<string, unknown>,
				new Date(),
				performance.now(),
				captured ?? null,
			);
			const matched =
				captured === undefined
					? []
					: matchRuleRecords(event.toolName, captured, snapshot.records.values(), sessionScope(ctx));
			const guidance = new Map(matched.map((record) => [record.id, ruleGuidance(record)]));
			const mechanism = requestedMechanism(mode, matched, snapshot.health.status === "degraded");
			const call: ObservedCall = {
				...base,
				classes: matched.map((record) => record.id),
				matched,
				guidance,
				mechanism,
				sessionFacts: sessionFacts(ctx, snapshot),
			};
			trackPending(pending, call);
			if (mechanism === "block") {
				const reason = guidanceLine(matched, (record) => effectiveEffect(record) === "block");
				if (!recordWriter().tryReserve()) {
					stop(new Error("policy writer cannot admit a block record"));
					return;
				}
				call.blocked = true;
				call.blockReason = reason;
				return { block: true, reason };
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const effects: CallEffects = {};
			let annotation: Annotation | undefined;
			if (call.mechanism === "notice" && ctx.mode === "tui") effects.notified = true;
			if (call.mechanism === "annotate" && event.isError !== true) {
				annotation = annotationFor(call);
				if (annotation) effects.annotationBytes = Buffer.byteLength(annotation.text, "utf8");
			}
			if (
				!writeRecord(
					call,
					event.content as ContentLike[] | undefined,
					event.isError,
					(event as { details?: unknown }).details,
					event.usage,
					effects,
				)
			)
				return;
			if (effects.notified) ctx.ui.notify(`${POLICY_PREFIX} ${call.classes.join(", ")}`, "warning");
			if (annotation) {
				const annotated = annotatedIdsFor(call.sessionFacts.session);
				for (const id of annotation.ids) annotated.add(id);
				return { content: [...(event.content ?? []), { type: "text", text: annotation.text }] };
			}
		} catch (error) {
			stop(error);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (stopped) return;
		try {
			const call = takeCall(event.toolCallId);
			if (!call) return;
			const outcome =
				event.result && typeof event.result === "object"
					? (event.result as { content?: ContentLike[]; details?: unknown; usage?: unknown })
					: {};
			const outcomeText = (outcome.content ?? []).map((part) => part.text ?? "").join("");
			writeRecord(call, outcome.content, event.isError, outcome.details, outcome.usage, {
				blocked: call.blocked === true && call.blockReason !== undefined && outcomeText === call.blockReason,
			});
		} catch (error) {
			stop(error);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			stopped = true;
			pending.clear();
			await writer?.close();
		} catch (error) {
			stop(error);
		}
	});
}
