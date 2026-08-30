import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	EVALUATION_SCHEMA_VERSION,
	THINKING_LEVELS,
	type EvaluationCase,
	type EvaluationPlan,
	type EvaluationPlanBody,
	type EvaluationSuite,
	type Participant,
	type SubjectAdapter,
	type SubjectVariant,
	type ThinkingLevel,
} from "./types.mts";

const ID_PATTERN = /^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$/;
const PLAN_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function fail(message: string): never {
	throw new Error(message);
}

function assertString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
}

function assertId(value: unknown, field: string): asserts value is string {
	assertString(value, field);
	if (!ID_PATTERN.test(value)) fail(`${field} must use lowercase letters, numbers, dots, underscores, or hyphens`);
}

function assertUniqueIds(values: Array<{ id: string }>, field: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		assertId(value.id, `${field}.id`);
		if (seen.has(value.id)) fail(`${field} contains duplicate id ${value.id}`);
		seen.add(value.id);
	}
}

function assertJsonData(value: unknown, field: string): void {
	const ancestors = new WeakSet<object>();
	const visit = (current: unknown, path: string): void => {
		if (current === null || typeof current === "string" || typeof current === "boolean") return;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) fail(`${path} contains a non-finite number`);
			return;
		}
		if (typeof current !== "object") fail(`${path} contains unsupported type ${typeof current}`);
		if (ancestors.has(current)) fail(`${path} contains a cycle`);
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				for (let index = 0; index < current.length; index += 1) {
					if (!Object.hasOwn(current, index)) fail(`${path} contains a sparse array slot at ${index}`);
					visit(current[index], `${path}[${index}]`);
				}
				const extraKeys = Reflect.ownKeys(current).filter(
					(key) => key !== "length" && !(typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)),
				);
				if (extraKeys.length > 0) fail(`${path} contains unsupported array properties`);
				return;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) fail(`${path} must contain only plain objects`);
			for (const key of Reflect.ownKeys(current)) {
				if (typeof key !== "string") fail(`${path} contains a symbol key`);
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
					fail(`${path}.${key} contains an accessor`);
				}
				if (!descriptor.enumerable) fail(`${path}.${key} is not enumerable`);
				visit(descriptor.value, `${path}.${key}`);
			}
		} finally {
			ancestors.delete(current);
		}
	};
	visit(value, field);
}

function assertPositiveInteger(value: unknown, field: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field} must be a positive integer`);
}

export function validateSuite(suite: unknown): asserts suite is EvaluationSuite {
	if (!suite || typeof suite !== "object" || Array.isArray(suite)) fail("suite must be an object");
	const candidate = suite as Partial<EvaluationSuite>;
	if (candidate.schemaVersion !== EVALUATION_SCHEMA_VERSION) {
		fail(`suite.schemaVersion must equal ${EVALUATION_SCHEMA_VERSION}`);
	}
	assertId(candidate.id, "suite.id");
	assertString(candidate.title, "suite.title");
	if (!candidate.subject || typeof candidate.subject !== "object") fail("suite.subject must be an object");
	assertId(candidate.subject.adapter, "suite.subject.adapter");
	assertId(candidate.subject.kind, "suite.subject.kind");
	assertString(candidate.subject.description, "suite.subject.description");
	assertJsonData(candidate.subject.config, "suite.subject.config");
	if (!Array.isArray(candidate.subject.variants) || candidate.subject.variants.length < 1) {
		fail("suite.subject.variants must contain at least one variant");
	}
	assertUniqueIds(candidate.subject.variants, "suite.subject.variants");
	for (const variant of candidate.subject.variants) {
		assertString(variant.description, `variant ${variant.id}.description`);
		assertJsonData(variant.config, `variant ${variant.id}.config`);
	}
	if (!Array.isArray(candidate.cases) || candidate.cases.length < 1) fail("suite.cases must contain at least one case");
	assertUniqueIds(candidate.cases, "suite.cases");
	for (const evaluationCase of candidate.cases) {
		assertString(evaluationCase.title, `case ${evaluationCase.id}.title`);
		assertJsonData(evaluationCase.input, `case ${evaluationCase.id}.input`);
		if (!Array.isArray(evaluationCase.checks) || evaluationCase.checks.length < 1) {
			fail(`case ${evaluationCase.id}.checks must contain at least one check`);
		}
		assertUniqueIds(evaluationCase.checks, `case ${evaluationCase.id}.checks`);
		for (const check of evaluationCase.checks) {
			assertId(check.type, `case ${evaluationCase.id} check type`);
			assertJsonData(check.config, `case ${evaluationCase.id} check config`);
		}
		if (evaluationCase.reviewMetadata !== undefined) {
			assertJsonData(evaluationCase.reviewMetadata, `case ${evaluationCase.id}.reviewMetadata`);
		}
	}
	if (!candidate.limits || typeof candidate.limits !== "object") fail("suite.limits must be an object");
	assertPositiveInteger(candidate.limits.wall?.runTimeoutMs, "suite.limits.wall.runTimeoutMs");
	assertPositiveInteger(candidate.limits.wall?.executionTimeoutMs, "suite.limits.wall.executionTimeoutMs");
	assertPositiveInteger(candidate.limits.execution?.maxTotal, "suite.limits.execution.maxTotal");
	assertPositiveInteger(candidate.limits.execution?.maxTurnsEach, "suite.limits.execution.maxTurnsEach");
	assertPositiveInteger(candidate.limits.execution?.maxOutputTokensEach, "suite.limits.execution.maxOutputTokensEach");
	if (candidate.limits.cost?.currency !== "USD") fail("suite.limits.cost.currency must equal USD");
	if (!Number.isFinite(candidate.limits.cost?.maxObserved) || candidate.limits.cost.maxObserved < 0) {
		fail("suite.limits.cost.maxObserved must be a non-negative number");
	}
	if (
		candidate.limits.cost.enforcement !== "observed-after-each-execution" ||
		candidate.limits.cost.hardCap !== false
	) {
		fail("suite cost limits must declare observed-after-each-execution enforcement and hardCap false");
	}
	if (!candidate.authority || typeof candidate.authority !== "object") fail("suite.authority must be an object");
	for (const [field, effects] of [
		["providerNetwork", candidate.authority.requestedEffects?.providerNetwork],
		["credentials", candidate.authority.requestedEffects?.credentials],
		["subject", candidate.authority.requestedEffects?.subject],
	] as const) {
		if (!Array.isArray(effects)) fail(`suite.authority.requestedEffects.${field} must be an array`);
		for (const effect of effects) assertString(effect, `suite.authority.requestedEffects.${field}`);
	}
	if (!candidate.adjudication || typeof candidate.adjudication !== "object") {
		fail("suite.adjudication must be an object");
	}
	if (candidate.adjudication.policy !== "deterministic-only" && candidate.adjudication.policy !== "human-required") {
		fail("suite.adjudication.policy is invalid");
	}
	if (!Array.isArray(candidate.adjudication.criteria)) fail("suite.adjudication.criteria must be an array");
	if (candidate.adjudication.policy === "human-required" && candidate.adjudication.criteria.length < 1) {
		fail("human-required adjudication needs at least one criterion");
	}
	for (const criterion of candidate.adjudication.criteria) assertString(criterion, "suite.adjudication criterion");
	if (candidate.adjudication.metadata !== undefined) {
		assertJsonData(candidate.adjudication.metadata, "suite.adjudication.metadata");
	}
	assertJsonData(suite, "suite");
}

export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export function digest(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function planDigest(body: EvaluationPlanBody): string {
	return digest(stableJson(body));
}

export function parseParticipant(value: string): Participant {
	const slash = value.indexOf("/");
	const colon = value.lastIndexOf(":");
	if (slash < 1 || colon <= slash + 1 || colon === value.length - 1) {
		fail(`participant must use exact provider/model:thinking syntax: ${value}`);
	}
	const provider = value.slice(0, slash);
	const model = value.slice(slash + 1, colon);
	const thinking = value.slice(colon + 1);
	if (!ID_PATTERN.test(provider)) fail(`participant provider is invalid: ${provider}`);
	if (model.trim() !== model || model === "") fail(`participant model is invalid: ${model}`);
	if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) fail(`participant thinking level is invalid: ${thinking}`);
	return { id: value, provider, model, thinking: thinking as ThinkingLevel };
}

function selectById<T extends { id: string }>(values: T[], selectedIds: string[] | undefined, field: string): T[] {
	if (!selectedIds || selectedIds.length === 0) return values;
	const selected = new Set(selectedIds);
	if (selected.size !== selectedIds.length) fail(`${field} selection contains a duplicate`);
	for (const id of selected) {
		if (!values.some((value) => value.id === id)) fail(`${field} selection names unknown id ${id}`);
	}
	return values.filter((value) => selected.has(value.id));
}

export function createPlan(
	suite: EvaluationSuite,
	suitePath: string,
	participants: Participant[],
	repetitions: number,
	adapter: SubjectAdapter,
	grant: EvaluationPlan["invocation"]["grant"],
	selection: { caseIds?: string[]; variantIds?: string[] } = {},
): EvaluationPlan {
	validateSuite(suite);
	if (!isAbsolute(suitePath)) fail("suite path must be absolute before plan creation");
	const resolvedSuitePath = realpathSync(suitePath);
	if (adapter.id !== suite.subject.adapter) fail(`subject adapter ${suite.subject.adapter} is not registered`);
	if (participants.length < 1) fail("at least one caller-selected participant is required");
	assertPositiveInteger(repetitions, "repetitions");
	if (grant.providerNetwork !== "approved-effects-only")
		fail("invocation grant must limit provider and credential activity to approved effects");
	if (!Array.isArray(grant.credentialSources.environment)) fail("invocation credential environment must be an array");
	for (const name of grant.credentialSources.environment) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(`credential environment name is invalid: ${name}`);
	}
	if (!Array.isArray(grant.grantedEffects)) fail("invocation grantedEffects must be an array");
	const requested = new Set(Object.values(suite.authority.requestedEffects).flat());
	for (const effect of grant.grantedEffects) {
		if (!requested.has(effect)) fail(`invocation grants an unrequested effect: ${effect}`);
	}
	for (const effect of requested) {
		if (!grant.grantedEffects.includes(effect)) fail(`invocation grant is missing requested effect: ${effect}`);
	}
	const participantIds = new Set(participants.map((participant) => participant.id));
	if (participantIds.size !== participants.length) fail("participant selection contains a duplicate");
	const cases = selectById(suite.cases, selection.caseIds, "case");
	const variants = selectById(suite.subject.variants, selection.variantIds, "variant");
	const executionCount = cases.length * variants.length * participants.length * repetitions;
	if (executionCount > suite.limits.execution.maxTotal) {
		fail(`plan requires ${executionCount} executions but the suite limit is ${suite.limits.execution.maxTotal}`);
	}
	const body: EvaluationPlanBody = {
		schemaVersion: EVALUATION_SCHEMA_VERSION,
		suite: {
			id: suite.id,
			title: suite.title,
			path: resolvedSuitePath,
			digest: digest(readFileSync(resolvedSuitePath)),
		},
		cases,
		variants,
		participants,
		invocation: { participantRoster: participants, repetitions, grant },
		limits: suite.limits,
		authority: suite.authority,
		subjectResolution: {
			adapter: suite.subject.adapter,
			kind: suite.subject.kind,
			config: suite.subject.config,
			variants: variants.map((variant) => ({
				id: variant.id,
				resolution: adapter.resolve({
					suitePath: resolvedSuitePath,
					subjectKind: suite.subject.kind,
					subjectConfig: suite.subject.config,
					variant,
				}),
			})),
		},
	};
	return { ...body, digest: planDigest(body) };
}

export function verifyPlan(suite: EvaluationSuite, plan: EvaluationPlan, adapter: SubjectAdapter): void {
	if (!PLAN_DIGEST_PATTERN.test(plan.digest)) fail("plan digest has an invalid format");
	const rebuilt = createPlan(
		suite,
		plan.suite.path,
		plan.participants,
		plan.invocation.repetitions,
		adapter,
		plan.invocation.grant,
		{
			caseIds: plan.cases.map((value: EvaluationCase) => value.id),
			variantIds: plan.variants.map((value: SubjectVariant) => value.id),
		},
	);
	if (stableJson(rebuilt) !== stableJson(plan))
		fail("the suite, resources, selections, or participants no longer match the approved plan");
}

export async function loadSuite(
	explicitPath: string,
	cwd = process.cwd(),
): Promise<{ suite: EvaluationSuite; path: string }> {
	assertString(explicitPath, "suite path");
	const requested = resolve(cwd, explicitPath);
	if (!existsSync(requested)) fail(`suite path does not exist: ${explicitPath}`);
	const path = realpathSync(requested);
	if (!path.endsWith(".eval.mts")) fail("suite path must end with .eval.mts");
	const module = (await import(`${pathToFileURL(path).href}?loaded=${Date.now()}`)) as { default?: unknown };
	if (!("default" in module)) fail("suite module must have a default export");
	validateSuite(module.default);
	return { suite: module.default, path };
}

export function repositoryRelative(path: string, root: string): string {
	const value = relative(root, path);
	return value.startsWith("..") ? path : value;
}
