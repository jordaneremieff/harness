/** Capture and evaluate the unified rule aggregate. */

import {
	effectiveState,
	type CommandShapeSpec,
	type RuleMatchContext,
	type RuleRecord,
	type RuleScope,
} from "./rule.ts";
import {
	captureShell,
	codeMatcherStageEligible,
	PACKAGE_CATALOG,
	redactShell,
	resolveCodeMatcher,
	type CodeMatcher,
} from "./shell-rules.ts";
import { parseStatements, type Stage } from "./shell.ts";

export type CodeMatcherResolver = (domain: string, key: string) => CodeMatcher | undefined;

/** Input text declared by the tool's policy domain, or undefined. */
export function captureFor(tool: string, input: Record<string, unknown>): string | undefined {
	return captureShell(tool, input);
}

/** Domain-owned redaction applied before telemetry persistence. */
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
): boolean {
	if (stage.command !== match.command) return false;
	if (match.flags && !match.flags.every((flag) => stage.args.includes(flag))) return false;
	if (match.absentFlags?.some((flag) => stage.args.includes(flag))) return false;
	const operands = stage.args.filter((arg) => !arg.startsWith("-"));
	if (match.operands?.min !== undefined && operands.length < match.operands.min) return false;
	if (match.operands?.max !== undefined && operands.length > match.operands.max) return false;
	if (match.operands?.any && !operands.some((operand) => match.operands!.any!.includes(operand))) return false;
	if (match.operands?.at) {
		for (const [index, choices] of Object.entries(match.operands.at)) {
			if (!choices.includes(operands[Number(index)])) return false;
		}
	}
	const pipe = match.pipe;
	if (pipe?.from !== undefined && stage.fromPipe !== pipe.from) return false;
	if (pipe?.to !== undefined && stage.toPipe !== pipe.to) return false;
	if (pipe?.fromRedirect !== undefined && stage.fromRedirect !== pipe.fromRedirect) return false;
	if (pipe?.toRedirect !== undefined && stage.toRedirect !== pipe.toRedirect) return false;
	if (pipe?.next && !pipe.next.includes(statement[position + 1]?.command ?? "")) return false;
	if (pipe?.later && !statement.slice(position + 1).some((later) => pipe.later!.includes(later.command))) return false;
	return true;
}

/**
 * Evaluate only active, available, in-scope records.
 *
 * Candidate selection precedes matcher resolution. A disabled or retired record
 * therefore cannot execute a package predicate or enter the declarative path.
 */
export function matchRuleRecords(
	tool: string,
	captured: string,
	records: Iterable<RuleRecord>,
	context: RuleMatchContext,
	resolveMatcher: CodeMatcherResolver = resolveCodeMatcher,
): RuleRecord[] {
	if (tool !== "bash") return [];
	const candidates = [...records].filter(
		(record) =>
			record.domain === "tool-call" &&
			effectiveState(record) === "active" &&
			record.matcherAvailable &&
			ruleScopeMatches(record.definition.scope, context),
	);
	if (candidates.length === 0) return [];
	const statements = parseStatements(captured);
	const matched: RuleRecord[] = [];
	for (const record of candidates) {
		let applies = false;
		if (record.matcher.kind === "code") {
			const predicate = resolveMatcher(record.domain, record.matcher.key);
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
		} else {
			const spec = record.matcher.spec;
			for (const statement of statements) {
				if (statement.some((stage, index) => declarativeStageMatches(stage, index, statement, spec))) {
					applies = true;
					break;
				}
			}
		}
		if (applies) matched.push(record);
	}
	const packageMatches = matched.filter((record) => record.source.kind === "package");
	const localMatches = matched
		.filter((record) => record.source.kind === "local")
		.sort((left, right) => left.id.localeCompare(right.id));
	return [...packageMatches, ...localMatches];
}

function installedRecords(): RuleRecord[] {
	return PACKAGE_CATALOG.map((row) => ({
		id: row.id,
		source: { kind: "package" },
		domain: row.domain,
		matcher: structuredClone(row.matcher),
		definition: {
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
