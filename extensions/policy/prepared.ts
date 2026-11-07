/**
 * One verified policy generation: compiled rules, data bindings, and the
 * read-only view that evaluation uses until the authoritative bytes change.
 */

import { compileRule } from "./compiler.ts";
import { type NamedData, type PreparedNamedData, prepareNamedData } from "./data.ts";
import { type ProgramPhase, type ProgramRule, programSteps } from "./program.ts";
import { contentRevision, effectiveState, type RuleRecord } from "./rule.ts";
import type { RuleSnapshot } from "./local-rules.ts";

export interface PreparedPolicy {
	/** Identity of the authoritative bytes this generation was prepared from. */
	readonly revision: string;
	readonly records: ReadonlyMap<string, RuleRecord>;
	readonly compiled: ReadonlyMap<string, ProgramRule>;
	/** Every active rule whose matcher is available, in record order. */
	readonly rules: readonly ProgramRule[];
	readonly byPhase: Readonly<Record<ProgramPhase, readonly ProgramRule[]>>;
	readonly data: PreparedNamedData;
}

const phases: readonly ProgramPhase[] = ["input", "result", "completion", "context"];

/** Compile each verified record once and group its steps by phase. */
export function preparePolicy(
	source: {
		revision: string;
		records: ReadonlyMap<string, RuleRecord>;
		data: ReadonlyMap<string, NamedData>;
	},
	previous?: PreparedPolicy,
): PreparedPolicy {
	const compiled = new Map<string, ProgramRule>();
	const rules: ProgramRule[] = [];
	for (const [id, record] of source.records) {
		const reused = previous?.records.get(id) === record ? previous.compiled.get(id) : undefined;
		const rule = reused ?? compileRule(record);
		compiled.set(id, rule);
		if (effectiveState(record) === "active" && record.matcherAvailable) rules.push(rule);
	}
	const byPhase = Object.fromEntries(
		phases.map((phase) => [
			phase,
			Object.freeze(
				rules
					.flatMap(programSteps)
					.filter((rule) => rule.program.phase === phase)
					.sort((left, right) => left.id.localeCompare(right.id)),
			),
		]),
	) as Record<ProgramPhase, readonly ProgramRule[]>;
	return {
		revision: source.revision,
		records: source.records,
		compiled,
		rules: Object.freeze(rules),
		byPhase: Object.freeze(byPhase),
		data: prepareNamedData([...source.data.values()]),
	};
}

const attached = new WeakMap<object, PreparedPolicy>();

/** Attach the registry's owner-held generation to one isolated snapshot copy. */
export function attachPreparedPolicy(snapshot: object, policy: PreparedPolicy): void {
	attached.set(snapshot, policy);
}

export function attachedPreparedPolicy(snapshot: object): PreparedPolicy | undefined {
	return attached.get(snapshot);
}

/** The generation for this snapshot, or a fresh preparation of a caller-built one. */
export function preparedPolicyFor(snapshot: RuleSnapshot): PreparedPolicy {
	return (
		attachedPreparedPolicy(snapshot) ??
		preparePolicy({
			revision: contentRevision(
				[...snapshot.records].map(([id, record]) => [
					id,
					record.definition.revision,
					record.definition.state,
					record.matcherAvailable,
					record.override?.state ?? null,
					record.override?.effect ?? null,
				]),
			),
			records: snapshot.records,
			data: snapshot.data,
		})
	);
}
