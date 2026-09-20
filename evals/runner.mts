import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runManagedChild } from "./process-boundary.mts";
import type { EvaluationPlan, OperationalStatus } from "./types.mts";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function pinnedInstall(): { vitestEntry: string; reporterPath: string } {
	const versions = [
		[resolve(REPOSITORY_ROOT, "node_modules/vitest/package.json"), "4.1.11"],
		[resolve(REPOSITORY_ROOT, "node_modules/vitest-evals/package.json"), "0.16.1"],
	] as const;
	for (const [path, expected] of versions) {
		const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
		if (version !== expected)
			throw new Error(`blocked: expected package version ${expected} at ${path}, found ${String(version)}`);
	}
	return {
		vitestEntry: realpathSync(resolve(REPOSITORY_ROOT, "node_modules/vitest/vitest.mjs")),
		reporterPath: realpathSync(resolve(REPOSITORY_ROOT, "node_modules/vitest-evals/dist/reporter.mjs")),
	};
}

interface ChildOutcome {
	status: OperationalStatus;
	exitCode: number | null;
	error?: string;
}

export function writeVitestConfig(directory: string, plan: EvaluationPlan): { configPath: string; reportPath: string } {
	const reportPath = resolve(directory, "vitest.json");
	const configPath = resolve(directory, "vitest.config.mts");
	const runtimeDirectory = resolve(directory, "runtime");
	mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
	const { reporterPath } = pinnedInstall();
	const source = `import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ${JSON.stringify(REPOSITORY_ROOT)},
  envDir: false,
  cacheDir: ${JSON.stringify(resolve(runtimeDirectory, "cache"))},
  test: {
    include: [${JSON.stringify(realpathSync(plan.suite.path))}],
    exclude: [],
    environment: "node",
    globals: false,
    update: "none",
    cache: false,
    attachmentsDir: ${JSON.stringify(resolve(runtimeDirectory, "attachments"))},
    isolate: true,
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    maxConcurrency: 1,
    retry: 0,
    bail: 0,
    allowOnly: false,
    passWithNoTests: false,
    dangerouslyIgnoreUnhandledErrors: false,
    testTimeout: ${plan.limits.wall.executionTimeoutMs + 5_000},
    reporters: [[${JSON.stringify(reporterPath)}, { reportLevel: "normal", isTTY: false }], "json"],
    outputFile: { json: ${JSON.stringify(reportPath)} },
  },
});
`;
	writeFileSync(configPath, source, { mode: 0o600, flag: "wx" });
	return { configPath, reportPath };
}

export function buildChildEnvironment(
	plan: EvaluationPlan,
	parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR", "FORCE_COLOR"]) {
		if (parent[name] !== undefined) environment[name] = parent[name];
	}
	if (plan.invocation.grant.credentialSources.home && parent.HOME !== undefined) environment.HOME = parent.HOME;
	for (const name of plan.invocation.grant.credentialSources.environment) {
		if (parent[name] === undefined) throw new Error(`Approved credential environment variable is not set: ${name}`);
		environment[name] = parent[name];
	}
	environment.VITEST_EVALS_REPLAY_MODE = "off";
	return environment;
}

interface VitestReport {
	success?: boolean;
	numTotalTests?: number;
	testResults?: Array<{ name?: string; assertionResults?: unknown[] }>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readVitestReport(reportPath: string): { report: VitestReport } | { error: string } {
	try {
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const descriptor = openSync(reportPath, constants.O_RDONLY | noFollow);
		try {
			const metadata = fstatSync(descriptor);
			if (!metadata.isFile()) throw new Error("Vitest report must be a regular file");
			if (metadata.size > MAX_REPORT_BYTES) throw new Error(`Vitest report exceeds ${MAX_REPORT_BYTES} bytes`);
			const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Vitest report must be a JSON object");
			}
			return { report: parsed as VitestReport };
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		return { error: `Vitest JSON is invalid: ${errorMessage(error)}` };
	}
}

function resolveReportedFiles(
	testResults: Array<{ name?: string }>,
	expectedFile: string,
): { requested: string; reported: string[] } | { error: string } {
	try {
		return {
			requested: realpathSync(expectedFile),
			reported: testResults.map((result) => {
				if (typeof result.name !== "string") throw new Error("Vitest JSON contains a result without a file name.");
				return realpathSync(result.name);
			}),
		};
	} catch (error) {
		return { error: `Vitest file-set validation failed: ${errorMessage(error)}` };
	}
}

function classifyVitestExit(exitCode: number | null, success: boolean): ChildOutcome {
	if (exitCode === 0 && success) return { status: "completed", exitCode };
	if (exitCode === 1 && !success)
		return { status: "failed", exitCode, error: "One or more operational eval executions failed." };
	if (exitCode === 1 && success) {
		return { status: "failed", exitCode, error: "Vitest exited with code 1 despite a successful JSON report." };
	}
	return {
		status: "failed",
		exitCode,
		error: `Vitest and its JSON report disagree (exit ${exitCode}, success ${success}).`,
	};
}

export function validateVitestReport(
	reportPath: string,
	expectedFile: string,
	expectedExecutions: number,
	exitCode: number | null,
): ChildOutcome {
	const read = readVitestReport(reportPath);
	if ("error" in read) return { status: "failed", exitCode, error: read.error };
	const report = read.report;
	if (typeof report.success !== "boolean" || !Array.isArray(report.testResults)) {
		return { status: "failed", exitCode, error: "Vitest JSON is missing required result fields." };
	}
	const files = resolveReportedFiles(report.testResults, expectedFile);
	if ("error" in files) return { status: "failed", exitCode, error: files.error };
	if (files.reported.length !== 1 || files.reported[0] !== files.requested) {
		return {
			status: "failed",
			exitCode,
			error: `Vitest reported an unexpected file set: ${JSON.stringify(files.reported)}`,
		};
	}
	const assertionCount = report.testResults.reduce(
		(total, result) => total + (result.assertionResults?.length ?? 0),
		0,
	);
	if (report.numTotalTests !== expectedExecutions || assertionCount !== expectedExecutions) {
		return {
			status: "failed",
			exitCode,
			error: `Vitest reported ${report.numTotalTests}/${assertionCount} tests; expected ${expectedExecutions}.`,
		};
	}
	return classifyVitestExit(exitCode, report.success);
}

async function runChildProcess(args: {
	directory: string;
	plan: EvaluationPlan;
	environment: NodeJS.ProcessEnv;
	vitestEntry: string;
	configPath: string;
}): Promise<{ child: Awaited<ReturnType<typeof runManagedChild>> } | ChildOutcome> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		const child = await runManagedChild({
			executable: process.execPath,
			args: [args.vitestEntry, "run", "--config", args.configPath, "--root", REPOSITORY_ROOT, "--no-color"],
			cwd: REPOSITORY_ROOT,
			env: args.environment,
			stdoutPath: resolve(args.directory, "vitest.stdout.log"),
			stderrPath: resolve(args.directory, "vitest.stderr.log"),
			maxOutputBytes: MAX_OUTPUT_BYTES,
			watchdogMs: args.plan.limits.wall.runTimeoutMs,
			terminationGraceMs: 5_000,
			killWaitMs: 2_000,
			signal: controller.signal,
		});
		return { child };
	} catch (error) {
		return { status: "failed", exitCode: null, error: errorMessage(error) };
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}

export async function runVitestChild(
	directory: string,
	plan: EvaluationPlan,
	labelsPath: string,
): Promise<ChildOutcome> {
	let launch: { vitestEntry: string; configPath: string; reportPath: string };
	try {
		const install = pinnedInstall();
		const config = writeVitestConfig(directory, plan);
		launch = { vitestEntry: install.vitestEntry, configPath: config.configPath, reportPath: config.reportPath };
	} catch (error) {
		const message = errorMessage(error);
		return { status: message.startsWith("blocked:") ? "blocked" : "failed", exitCode: null, error: message };
	}
	let environment: NodeJS.ProcessEnv;
	try {
		environment = buildChildEnvironment(plan);
	} catch (error) {
		return { status: "blocked", exitCode: null, error: errorMessage(error) };
	}
	environment.HARNESS_EVAL_PLAN_PATH = join(directory, "plan.json");
	environment.HARNESS_EVAL_RUN_DIRECTORY = directory;
	environment.HARNESS_EVAL_LABELS_PATH = labelsPath;
	const result = await runChildProcess({
		directory,
		plan,
		environment,
		vitestEntry: launch.vitestEntry,
		configPath: launch.configPath,
	});
	if (!("child" in result)) return result;
	const child = result.child;
	if (child.cancellation === "watchdog")
		return { status: "timed_out", exitCode: child.exitCode, error: "The parent run watchdog expired." };
	if (child.cancellation === "parent_signal")
		return { status: "cancelled", exitCode: child.exitCode, error: "The caller cancelled the Vitest process group." };
	if (child.cancellation === "io_error" || child.spawnError || child.signal) {
		return {
			status: "failed",
			exitCode: child.exitCode,
			error: child.spawnError ?? `Vitest ended with signal ${child.signal}`,
		};
	}
	return validateVitestReport(
		launch.reportPath,
		plan.suite.path,
		plan.cases.length * plan.variants.length * plan.participants.length * plan.invocation.repetitions,
		child.exitCode,
	);
}
