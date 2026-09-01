import { validateSuite } from "./core.mts";
import type { EvaluationSuite } from "./types.mts";

const runtime = process.env.HARNESS_EVAL_PLAN_PATH ? await import("./vitest-runtime.mts") : undefined;

export type { EvaluationCheck, EvaluationSuite } from "./types.mts";

export function defineSuite<T extends EvaluationSuite>(suite: T): T {
	validateSuite(suite);
	runtime?.registerPlannedSuite(suite);
	return suite;
}
