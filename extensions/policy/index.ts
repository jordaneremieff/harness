/**
 * Policy records paired tool calls and their outcomes against built-in rules.
 *
 * Every mode records. `observe` acts on nothing. `notice` shows the operator a
 * flag in the terminal and adds no model-visible text. `annotate` appends one
 * capped line of guidance to a flagged result, at most once per rule id per
 * session. `enforce` blocks a flagged call with a reason that names the
 * preferred form. No mode changes a tool input because no rewrite is provably
 * semantics-preserving and Pi does not re-validate a mutated input.
 *
 * Duration is measured here because no event carries it: `tool_call` and
 * `tool_result` are paired by call id and stamped on arrival.
 *
 * The slice sits in the path of every tool call, so a defect in it must never
 * reach that call. Every handler body runs inside a boundary that reports the
 * first failure once and then stops acting for the rest of the session.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { notesFor } from "./classify.ts";
import { POLICY_MODES, resolvePolicyMode, resolvePolicyModeValue, type PolicyMode } from "./mode.ts";
import {
	formatPolicyList,
	formatPolicyShow,
	PolicyPanel,
	readFireSummary,
	readRecentActivity,
	terminalSafe,
	type BuiltinRuleInfo,
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
import { RULES } from "./shell-rules.ts";
import { PolicyWriter, resolvePolicyDir } from "./store.ts";

/** Per-session override for the policy mechanism. */
const POLICY_MODE_FLAG = "policy-mode";

/** Marker Pi writes into the system prompt when project context files are loaded. */
const PROJECT_CONTEXT_MARKER = "<project_context>";

/** Prefix that marks harness guidance so it is not read as tool output. */
const POLICY_PREFIX = "[policy]";

/** Upper bound on one appended or returned guidance line. */
const MAX_GUIDANCE_BYTES = 512;

/** Sessions whose annotated rule ids are still tracked. */
const MAX_ANNOTATED_SESSIONS = 16;

const POLICY_USAGE = [
	"Usage:",
	"  /policy                         Open the Rules and Activity panel (TUI only)",
	"  /policy list                    Print built-in rule groups",
	"  /policy show <id>               Print full built-in rule detail and fires by model",
	"  /policy mode                    Report this session's policy mode",
	"  /policy help                    Show this usage",
].join("\n");

const POLICY_VERBS: AutocompleteItem[] = [
	{ value: "list", label: "list", description: "Print built-in rule groups" },
	{ value: "show", label: "show", description: "Show one built-in rule with fires by model" },
	{ value: "mode", label: "mode", description: "Report the active session mode" },
	{ value: "help", label: "help", description: "Show /policy usage" },
];

const MODE_EFFECT: Readonly<Record<PolicyMode, string>> = {
	observe: "Records every tool call and applies no mechanism.",
	notice: "Records every tool call and shows a terminal warning for each flagged call in TUI mode.",
	annotate: "Records every tool call and appends bounded guidance to eligible flagged results.",
	enforce: "Records every tool call and blocks calls matched by built-in rules.",
};

const BUILTIN_RULE_INFOS: BuiltinRuleInfo[] = RULES.map(({ id, note }) => ({ id, note }));

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

function toolFailure(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unknown policy command failure";
	}
}

interface ObservedCall extends PendingCall {
	sessionFacts: SessionFacts;
	/** The call was blocked at the tool boundary. */
	blocked?: boolean;
	/** The reason returned with the block, used to confirm Pi applied it. */
	blockReason?: string;
}

interface Annotation {
	text: string;
	/** Rule ids whose guidance this text carries. */
	ids: string[];
}

export default function registerPolicy(pi: ExtensionAPI) {
	pi.registerFlag(POLICY_MODE_FLAG, {
		type: "string",
		description: `Policy mode (${POLICY_MODES.join(", ")}); overrides PI_POLICY_MODE`,
	});

	const pending = new Map<string, ObservedCall>();
	let stopped = false;
	let failureReported = false;
	let writer: PolicyWriter | null = null;
	let mode: PolicyMode = "observe";
	let modeResolved = false;
	let modeSource = "PI_POLICY_MODE is unset; observe is the default";

	/** Rule ids already annotated, per session, so history survives a session round-trip. */
	const annotatedBySession = new Map<string, Set<string>>();

	/** One bounded guidance line for the matched built-in rule ids. */
	const guidanceFor = (tool: string, classes: readonly string[]): string => {
		let text = POLICY_PREFIX;
		const included = new Set<string>();
		for (const id of classes) {
			const [note] = notesFor(tool, [id]);
			if (note === undefined || included.has(note)) continue;
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
		}
		if (text === POLICY_PREFIX) throw new Error("policy rules matched but no guidance exists for the matched classes");
		return text;
	};

	/** Bind mutable context facts to the call that observed them. */
	const sessionFacts = (ctx: ExtensionContext): SessionFacts => {
		const model = ctx.model;
		return {
			session: ctx.sessionManager.getSessionId(),
			mode: ctx.mode,
			cwd: ctx.cwd,
			model: model ? `${model.provider}/${model.id}` : null,
			thinkingLevel: ctx.thinkingLevel ?? null,
			projectContext: ctx.getSystemPrompt().includes(PROJECT_CONTEXT_MARKER),
		};
	};

	/** Stop recording and report once without throwing through a tool boundary. */
	const stop = (error: unknown): void => {
		stopped = true;
		pending.clear();
		if (failureReported) return;
		failureReported = true;
		let reason = "reason unavailable";
		try {
			reason = error instanceof Error ? error.message : String(error);
		} catch {
			// A thrown value that cannot describe itself still stops recording.
		}
		try {
			console.warn(`[policy] recording stopped for this session: ${reason}`);
		} catch {
			// A failing console leaves no channel to report through.
		}
	};

	const ensureMode = (): boolean => {
		if (modeResolved || stopped) return !stopped;
		modeResolved = true;
		try {
			const flagValue = pi.getFlag(POLICY_MODE_FLAG);
			if (flagValue !== undefined) {
				const setting = typeof flagValue === "string" ? flagValue : String(flagValue);
				mode = resolvePolicyModeValue(setting, `--${POLICY_MODE_FLAG}`);
				modeSource = `--${POLICY_MODE_FLAG}=${setting.trim()}`;
			} else {
				mode = resolvePolicyMode(process.env);
				const setting = process.env.PI_POLICY_MODE?.trim() ?? "";
				modeSource = setting ? `PI_POLICY_MODE=${setting}` : "PI_POLICY_MODE is unset; observe is the default";
			}
		} catch (error) {
			stop(error);
		}
		return !stopped;
	};

	pi.on("session_start", async () => {
		ensureMode();
	});

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

	const commandFailure = (ctx: ExtensionCommandContext, message: string): void => {
		const safe = terminalSafe(message);
		if (ctx.hasUI) {
			ctx.ui.notify(safe, "error");
			return;
		}
		throw new Error(safe);
	};

	const rulesDir = resolvePolicyDir(process.env, getAgentDir());

	const loadRuleData = async (): Promise<Pick<PolicyPanelData, "builtins" | "fireSummary">> => ({
		builtins: BUILTIN_RULE_INFOS,
		fireSummary: await readFireSummary(rulesDir),
	});

	const loadPanelData = async (): Promise<PolicyPanelData> => {
		const [ruleData, activity] = await Promise.all([loadRuleData(), readRecentActivity(rulesDir)]);
		return { ...ruleData, activity };
	};

	const argumentCompletions = (text: string): AutocompleteItem[] | null => {
		if (!text.includes(" ")) {
			const matches = POLICY_VERBS.filter((verb) => verb.value.startsWith(text));
			return matches.length > 0 ? matches : null;
		}
		const firstSpace = text.indexOf(" ");
		const verb = text.slice(0, firstSpace);
		const tail = text.slice(firstSpace + 1);
		if (verb !== "show" || tail.includes(" ")) return null;
		const matches = BUILTIN_RULE_INFOS.filter((rule) => rule.id.startsWith(tail)).map((rule) => ({
			value: `show ${rule.id}`,
			label: rule.id,
			description: terminalSafe(rule.note),
		}));
		return matches.length > 0 ? matches : null;
	};

	const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
		let data: PolicyPanelData;
		try {
			data = await loadPanelData();
		} catch (error) {
			commandFailure(ctx, `Could not load policy data: ${toolFailure(error)}`);
			return;
		}
		let result: PolicyPanelResult | undefined;
		try {
			result = await ctx.ui.custom<PolicyPanelResult>(
				(tui, theme, _keybindings, done) =>
					new PolicyPanel({
						data,
						theme,
						tui,
						getMaxRows: () => Math.max(1, tui.terminal.rows - 6),
						done,
					}),
				{
					overlay: true,
					overlayOptions: { width: "94%", minWidth: 112, maxHeight: "92%", anchor: "center", margin: 1 },
				},
			);
		} catch (error) {
			commandFailure(ctx, `Policy panel failed: ${toolFailure(error)}`);
			return;
		}
		void result;
	};

	pi.registerCommand("policy", {
		description: "Browse built-in policy rules and recorded activity",
		getArgumentCompletions: argumentCompletions,
		handler: async (args, ctx) => {
			ensureMode();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0];
			if (!verb) {
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					commandFailure(
						ctx,
						"The interactive policy panel requires TUI mode. Use /policy list, /policy show <id>, /policy mode, or /policy help.",
					);
					return;
				}
				await openPanel(ctx);
				return;
			}
			if (verb === "help") {
				if (parts.length !== 1) return commandFailure(ctx, "Usage: /policy help");
				commandText(ctx, POLICY_USAGE);
				return;
			}
			if (verb === "mode") {
				if (parts.length !== 1) return commandFailure(ctx, "Usage: /policy mode");
				commandText(
					ctx,
					[
						`active mode: ${mode}`,
						`source: ${terminalSafe(modeSource)}`,
						`effect: ${MODE_EFFECT[mode]}`,
						"A session keeps its original mode after --policy-mode or PI_POLICY_MODE changes.",
					].join("\n"),
				);
				return;
			}
			if (verb === "list") {
				if (parts.length !== 1) return commandFailure(ctx, "Usage: /policy list");
				commandText(ctx, formatPolicyList(await loadRuleData()));
				return;
			}
			if (verb === "show") {
				if (parts.length !== 2) return commandFailure(ctx, "Usage: /policy show <id>");
				const shown = formatPolicyShow(await loadRuleData(), parts[1]);
				if (shown === undefined) return commandFailure(ctx, `unknown policy rule "${parts[1]}"`);
				commandText(ctx, shown);
				return;
			}
			commandFailure(ctx, `Unknown /policy action "${terminalSafe(verb)}". Use /policy help.`);
		},
	});

	const recordWriter = (): PolicyWriter => {
		writer ??= new PolicyWriter(rulesDir, stop);
		return writer;
	};

	const takeCall = (callId: string): ObservedCall | undefined => {
		const call = pending.get(callId);
		if (call) pending.delete(callId);
		return call;
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

	/** Rule ids already annotated in one session, created on first use. */
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

	/** Build guidance for the rule ids this session has not annotated yet. */
	const annotationFor = (tool: string, classes: string[], session: string): Annotation | undefined => {
		const annotated = annotatedIdsFor(session);
		let text = POLICY_PREFIX;
		const ids: string[] = [];
		const included = new Set<string>();
		for (const id of classes) {
			if (annotated.has(id)) continue;
			const [note] = notesFor(tool, [id]);
			if (note === undefined) continue;
			if (included.has(note)) {
				ids.push(id);
				continue;
			}
			const candidate = `${text} ${note}`;
			if (Buffer.byteLength(candidate, "utf8") > MAX_GUIDANCE_BYTES) break;
			text = candidate;
			included.add(note);
			ids.push(id);
		}
		if (included.size === 0) return undefined;
		return { text, ids };
	};

	pi.on("tool_call", async (event, ctx) => {
		if (!ensureMode()) return;
		try {
			const call: ObservedCall = {
				...startCall(event.toolName, event.toolCallId, event.input as Record<string, unknown>),
				sessionFacts: sessionFacts(ctx),
			};
			trackPending(pending, call);
			if (mode === "enforce" && call.classes.length > 0) {
				const reason = guidanceFor(call.tool, call.classes);
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
			if (call.classes.length > 0) {
				if (mode === "notice" && ctx.mode === "tui") effects.notified = true;
				if (mode === "annotate" && event.isError !== true) {
					annotation = annotationFor(call.tool, call.classes, call.sessionFacts.session);
					if (annotation) effects.annotationBytes = Buffer.byteLength(annotation.text, "utf8");
				}
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
			if (effects.notified === true) ctx.ui.notify(`${POLICY_PREFIX} ${call.classes.join(", ")}`, "warning");
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
