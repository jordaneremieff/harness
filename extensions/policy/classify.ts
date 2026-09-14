/** Extract command-match evidence and redact command text for records. */

import { PACKAGE_CATALOG } from "./catalog.ts";
import { type CliEvidence, decodeGitPush } from "./cli.ts";
import type { Truth } from "./data.ts";
import {
	type CommandShapeSpec,
	effectiveState,
	type RuleMatchContext,
	type RuleRecord,
	type RuleScope,
} from "./rule.ts";
import { parseShellEvidence, type Stage } from "./shell.ts";
import {
	type CodeMatcher,
	captureShell,
	codeMatcherStageEligible,
	redactShell,
	resolveCodeMatcher,
} from "./shell-rules.ts";

/** Truth and fixed reason codes share the same captured input snapshot. */
export class CommandEvidence extends Map<string, Truth> {
	readonly reasons = new Map<string, string[]>();
}

export type CodeMatcherResolver = (key: string) => CodeMatcher | undefined;

/** Command text from the declared argument field, or undefined. */
export function captureFor(tool: string, input: Record<string, unknown>): string | undefined {
	return captureShell(tool, input);
}

/** Command redaction applied before telemetry persistence. */
export function redactFor(tool: string, captured: string): string {
	return redactShell(tool, captured);
}

function excludingScopeField(scope: RuleScope | undefined, context: RuleMatchContext): keyof RuleScope | undefined {
	if (!scope) return undefined;
	if (scope.modelProviders && !scope.modelProviders.includes(context.provider ?? "")) return "modelProviders";
	if (scope.models && !scope.models.includes(context.model ?? "")) return "models";
	if (scope.cwdPrefixes && !scope.cwdPrefixes.some((prefix) => context.cwd.startsWith(prefix))) return "cwdPrefixes";
	return undefined;
}

export function ruleScopeMatches(scope: RuleScope | undefined, context: RuleMatchContext): boolean {
	return excludingScopeField(scope, context) === undefined;
}

/** Describe whether a definition's scope admits the supplied session context. */
export function ruleScopeVisibility(record: Pick<RuleRecord, "definition">, context: RuleMatchContext): string {
	const excludingField = excludingScopeField(record.definition.scope, context);
	return `scope matches this session: ${excludingField ? `no (${excludingField})` : "yes"}`;
}

function declarativeStageMatches(
	stage: Stage,
	position: number,
	statement: readonly Stage[],
	match: CommandShapeSpec,
	cli?: CliEvidence,
): Truth {
	if (match.cli && stage.commandLiteral === false) return "unknown";
	if (stage.command !== match.command) return false;
	if (cli?.status === "unrelated") return false;
	const pipe = match.pipe;
	if (pipe?.from !== undefined && stage.fromPipe !== pipe.from) return false;
	if (pipe?.to !== undefined && stage.toPipe !== pipe.to) return false;
	if (pipe?.fromRedirect !== undefined && stage.fromRedirect !== pipe.fromRedirect) return false;
	if (pipe?.toRedirect !== undefined && stage.toRedirect !== pipe.toRedirect) return false;
	if (pipe?.next && !pipe.next.includes(statement[position + 1]?.command ?? "")) return false;
	if (pipe?.later && !statement.slice(position + 1).some((later) => pipe.later!.includes(later.command))) return false;
	if (cli?.status === "unknown") return "unknown";
	const flags = cli?.status === "known" ? cli.options.map((option) => option.spelling) : stage.args;
	if (match.flags && !match.flags.every((flag) => flags.includes(flag))) return false;
	if (match.anyFlags && !match.anyFlags.some((flag) => flags.includes(flag))) return false;
	if (match.absentFlags?.some((flag) => flags.includes(flag))) return false;
	const operands = cli?.status === "known" ? cli.operands : stage.args.filter((arg) => !arg.startsWith("-"));
	if (match.operands?.min !== undefined && operands.length < match.operands.min) return false;
	if (match.operands?.max !== undefined && operands.length > match.operands.max) return false;
	if (match.operands?.any && !operands.some((operand) => match.operands!.any!.includes(operand))) return false;
	if (match.operands?.at) {
		for (const [index, choices] of Object.entries(match.operands.at)) {
			if (!choices.includes(operands[Number(index)])) return false;
		}
	}
	return true;
}

/**
 * Evaluate only active, available, in-scope records.
 *
 * Candidate selection precedes matcher resolution. A disabled or retired record
 * therefore cannot execute a package predicate or enter the declarative path.
 */
export function evaluateCommandRecords(
	tool: string,
	captured: string,
	records: Iterable<RuleRecord>,
	context: RuleMatchContext,
	resolveMatcher: CodeMatcherResolver = resolveCodeMatcher,
): CommandEvidence {
	const all = [...records];
	const result = new CommandEvidence(all.map((record) => [record.id, false]));
	if (tool !== "bash") return result;
	const candidates = all.filter(
		(record) =>
			effectiveState(record) === "active" &&
			record.matcherAvailable &&
			ruleScopeMatches(record.definition.scope, context),
	);
	if (candidates.length === 0) return result;
	const parsed = parseShellEvidence(captured);
	const statements = parsed.statements;
	const decoded = new Map<Stage, CliEvidence>();
	if (
		candidates.some(
			(record) =>
				record.matcher.kind === "declarative" &&
				record.matcher.language === "command-shape/v1" &&
				record.matcher.spec.cli,
		)
	) {
		let options = 0;
		for (const statement of statements) {
			for (const stage of statement) {
				const cli = decodeGitPush(stage);
				decoded.set(stage, cli);
				if (cli.status === "known") options += cli.globals.length + cli.options.length;
			}
		}
		if (parsed.wordCount + options > 4096) {
			parsed.complete = false;
			parsed.reasons.push("option-limit");
			for (const [stage, cli] of decoded)
				if (cli.status === "known") decoded.set(stage, { status: "unknown", reason: "option-limit" });
		}
	}
	for (const record of candidates) {
		let applies: Truth = false;
		const reasons = new Set<string>();
		if (record.matcher.kind === "code") {
			const predicate = resolveMatcher(record.matcher.key);
			if (!predicate) continue;
			for (const statement of statements) {
				for (let index = 0; index < statement.length; index++) {
					const stage = statement[index];
					if (!codeMatcherStageEligible(stage)) continue;
					if (predicate({ statement, stage, index })) {
						applies = true;
						break;
					}
				}
				if (applies) break;
			}
		} else if (record.matcher.language === "command-shape/v1") {
			const spec = record.matcher.spec;
			if (spec.cli && !parsed.complete) {
				applies = "unknown";
				for (const reason of parsed.reasons) reasons.add(reason);
			}
			for (const statement of statements) {
				for (let index = 0; index < statement.length; index++) {
					const stage = statement[index];
					let cli: CliEvidence | undefined;
					if (spec.cli) {
						cli = decoded.get(stage)!;
					}
					const indirect =
						spec.cli &&
						(stage.commandLiteral === false ||
							stage.shellReasons?.includes("unresolved-command") ||
							[
								"eval",
								"source",
								".",
								"sh",
								"bash",
								"zsh",
								"dash",
								"ksh",
								"xargs",
								"for",
								"select",
								"case",
								"function",
							].includes(stage.command));
					const truth = indirect ? "unknown" : declarativeStageMatches(stage, index, statement, spec, cli);
					if (truth === true) {
						applies = true;
						break;
					}
					if (truth === "unknown") {
						applies = "unknown";
						reasons.add(
							indirect ? "unresolved-command" : cli?.status === "unknown" ? cli.reason : "shell-evidence-unavailable",
						);
					}
				}
				if (applies === true) break;
			}
		}
		result.set(record.id, applies);
		if (applies === "unknown") result.reasons.set(record.id, [...reasons].slice(0, 16));
	}
	return result;
}

/** True-only convenience view over the same evidence evaluator. */
export function matchRuleRecords(
	tool: string,
	captured: string,
	records: Iterable<RuleRecord>,
	context: RuleMatchContext,
	resolveMatcher: CodeMatcherResolver = resolveCodeMatcher,
): RuleRecord[] {
	const all = [...records];
	const evidence = evaluateCommandRecords(tool, captured, all, context, resolveMatcher);
	return all.filter((record) => evidence.get(record.id) === true);
}

function installedRecords(): RuleRecord[] {
	return PACKAGE_CATALOG.map((row) => ({
		id: row.id,
		source: { kind: "package" },
		matcher: structuredClone(row.matcher),
		definition: {
			purpose: row.purpose,
			authority: row.authority,
			...(row.applicability ? { applicability: structuredClone(row.applicability) } : {}),
			revision: row.revision,
			state: "active",
			effect: row.effect,
			note: row.note,
			...(row.suggestion ? { suggestion: structuredClone(row.suggestion) } : {}),
			...(row.scope ? { scope: structuredClone(row.scope) } : {}),
		},
		matcherAvailable: true,
		staleOverride: false,
	}));
}

/** Convenience classifier over installed package defaults only. */
export function classify(tool: string, input: Record<string, unknown>): string[] {
	const captured = captureFor(tool, input);
	if (captured === undefined) return [];
	return matchRuleRecords(tool, captured, installedRecords(), { cwd: process.cwd() }).map((record) => record.id);
}

export function classifyCaptured(tool: string, captured: string): string[] {
	return matchRuleRecords(tool, captured, installedRecords(), { cwd: process.cwd() }).map((record) => record.id);
}

/** Installed package guidance retained for callers that only have historical ids. */
export function notesFor(tool: string, ruleIds: readonly string[]): string[] {
	if (tool !== "bash") return [];
	const notes: string[] = [];
	for (const id of ruleIds) {
		const note = PACKAGE_CATALOG.find((row) => row.id === id)?.note;
		if (note !== undefined && !notes.includes(note)) notes.push(note);
	}
	return notes;
}
