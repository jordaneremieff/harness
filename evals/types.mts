import type { JsonValue, TranscriptEvent, UsageSummary } from "vitest-evals";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SubjectVariant {
	id: string;
	description: string;
	config: JsonValue;
}

export interface EvaluationCheck {
	id: string;
	type: string;
	config: JsonValue;
}

export interface EvaluationCase {
	id: string;
	title: string;
	input: JsonValue;
	checks: EvaluationCheck[];
	reviewMetadata?: JsonValue;
}

export interface EvaluationLimits {
	wall: {
		runTimeoutMs: number;
		executionTimeoutMs: number;
	};
	execution: {
		maxTotal: number;
		maxTurnsEach: number;
		maxOutputTokensEach: number;
	};
	cost: {
		currency: "USD";
		maxObserved: number;
		enforcement: "observed-after-each-execution";
		hardCap: false;
	};
}

export interface EvaluationAuthority {
	requestedEffects: {
		providerNetwork: string[];
		credentials: string[];
		subject: string[];
	};
}

export interface InvocationGrant {
	providerNetwork: "approved-effects-only";
	credentialSources: {
		home: boolean;
		environment: string[];
	};
	grantedEffects: string[];
}

export interface EvaluationSuite {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	id: string;
	title: string;
	subject: {
		adapter: string;
		kind: string;
		description: string;
		config: JsonValue;
		variants: SubjectVariant[];
	};
	cases: EvaluationCase[];
	limits: EvaluationLimits;
	authority: EvaluationAuthority;
	adjudication: {
		policy: "deterministic-only" | "human-required";
		criteria: string[];
		metadata?: JsonValue;
	};
}

export interface Participant {
	id: string;
	provider: string;
	model: string;
	thinking: ThinkingLevel;
}

export interface EvaluationPlanBody {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	suite: {
		id: string;
		title: string;
		path: string;
		digest: string;
	};
	cases: EvaluationCase[];
	variants: SubjectVariant[];
	participants: Participant[];
	invocation: {
		participantRoster: Participant[];
		repetitions: number;
		grant: InvocationGrant;
	};
	limits: EvaluationLimits;
	authority: EvaluationAuthority;
	subjectResolution: {
		adapter: string;
		kind: string;
		config: JsonValue;
		variants: Array<{ id: string; resolution: JsonValue }>;
	};
}

export interface EvaluationPlan extends EvaluationPlanBody {
	digest: string;
}

export interface CheckResult {
	checkId: string;
	type: string;
	passed: boolean;
	message: string;
}

export interface SubjectExecution {
	executionId: string;
	caseId: string;
	variantId: string;
	participantId: string;
	repetition: number;
	blindLabel: string;
}

export interface SubjectOutput {
	value: JsonValue;
	effective: JsonValue;
	checks: CheckResult[];
}

export interface SubjectRunResult {
	output: SubjectOutput;
	events: TranscriptEvent[];
	usage: UsageSummary;
	errors: Array<Record<string, JsonValue>>;
}

export interface SubjectAdapter {
	id: string;
	resolve(args: {
		suitePath: string;
		subjectKind: string;
		subjectConfig: JsonValue;
		variant: SubjectVariant;
	}): JsonValue;
	run(args: {
		suitePath: string;
		subjectKind: string;
		subjectConfig: JsonValue;
		variant: SubjectVariant;
		evaluationCase: EvaluationCase;
		participant: Participant;
		limits: EvaluationLimits;
		authority: EvaluationAuthority;
		grant: InvocationGrant;
		runDirectory: string;
		execution: SubjectExecution;
		signal?: AbortSignal;
	}): Promise<SubjectRunResult>;
}

export type OperationalStatus = "completed" | "partial" | "blocked" | "cancelled" | "timed_out" | "failed";
export type QualityStatus = "pass" | "fail" | "inconclusive" | "not_assessed";

export interface ExecutionExclusion {
	executionId: string;
	errorTypes: string[];
}

export interface RunCoverage {
	plannedExecutions: number;
	usableExecutions: number;
	excludedExecutions: number;
	usableExecutionIds: string[];
	exclusions: ExecutionExclusion[];
}

export interface AdjudicationRecord {
	adjudicatedAt: string;
	verdict: Exclude<QualityStatus, "not_assessed">;
	notes: string;
	preferredLabel?: string;
	scope?: {
		type: "usable-executions";
		executionIds: string[];
	};
}

export interface RunState {
	schemaVersion: typeof EVALUATION_SCHEMA_VERSION;
	runId: string;
	planDigest: string;
	phase: "prepared" | "running" | "terminal";
	operational: {
		status?: OperationalStatus;
		startedAt?: string;
		finishedAt?: string;
		exitCode?: number | null;
		error?: string;
	};
	coverage?: RunCoverage;
	quality: {
		status: QualityStatus;
		adjudicationFile?: string;
	};
}
