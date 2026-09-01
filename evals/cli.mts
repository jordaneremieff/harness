#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getSubjectAdapter } from "./adapters.mts";
import { createPlan, loadSuite, parseParticipant } from "./core.mts";
import { REPOSITORY_ROOT, runVitestChild } from "./runner.mts";
import {
	adjudicateRun,
	buildReviewArtifact,
	buildRunCoverage,
	deleteRun,
	inspectRun,
	listExecutionEvidence,
	prepareRun,
	writeJson,
} from "./store.mts";
import type { EvaluationPlan, InvocationGrant, QualityStatus, RunState } from "./types.mts";

interface ParsedArguments {
	command: string;
	values: Map<string, string[]>;
	flags: Set<string>;
	positionals: string[];
}

const VALUE_OPTIONS = new Set([
	"suite",
	"participant",
	"repetitions",
	"case",
	"variant",
	"approve",
	"credential-env",
	"grant-effect",
	"run",
	"verdict",
	"notes",
	"preferred",
	"scope",
]);
const FLAG_OPTIONS = new Set(["allow-home-credentials", "reveal"]);
const EVIDENCE_ROOT = join(REPOSITORY_ROOT, ".evals");

function parseArguments(args: string[]): ParsedArguments {
	const [command, ...rest] = args;
	if (!command) return { command: "help", values: new Map(), flags: new Set(), positionals: [] };
	const values = new Map<string, string[]>();
	const flags = new Set<string>();
	const positionals: string[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const name = token.slice(2);
		if (FLAG_OPTIONS.has(name)) {
			flags.add(name);
			continue;
		}
		if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
		values.set(name, [...(values.get(name) ?? []), value]);
		index += 1;
	}
	return { command, values, flags, positionals };
}

function assertAllowed(parsed: ParsedArguments, allowedValues: string[], allowedFlags: string[]): void {
	for (const name of parsed.values.keys()) {
		if (!allowedValues.includes(name)) throw new Error(`Option --${name} is not valid for ${parsed.command}`);
	}
	for (const name of parsed.flags) {
		if (!allowedFlags.includes(name)) throw new Error(`Option --${name} is not valid for ${parsed.command}`);
	}
}

function values(parsed: ParsedArguments, name: string): string[] {
	return parsed.values.get(name) ?? [];
}

function one(parsed: ParsedArguments, name: string, required = true): string | undefined {
	const found = values(parsed, name);
	if (found.length > 1) throw new Error(`Option --${name} must appear once`);
	if (required && found.length === 0) throw new Error(`Option --${name} is required`);
	return found[0];
}

function positional(parsed: ParsedArguments, label: string): string {
	if (parsed.positionals.length !== 1) throw new Error(`${parsed.command} requires one positional <${label}>`);
	return parsed.positionals[0];
}

function repetitions(parsed: ParsedArguments): number {
	const raw = one(parsed, "repetitions");
	const count = Number(raw);
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("--repetitions must be a positive integer");
	return count;
}

function invocationGrant(parsed: ParsedArguments): InvocationGrant {
	const environment = values(parsed, "credential-env");
	const home = parsed.flags.has("allow-home-credentials");
	if (!home && environment.length === 0) {
		throw new Error("Select credential exposure with --allow-home-credentials or --credential-env NAME");
	}
	return {
		providerNetwork: "approved-effects-only",
		credentialSources: { home, environment },
		grantedEffects: values(parsed, "grant-effect"),
	};
}

async function planned(
	parsed: ParsedArguments,
): Promise<{ plan: EvaluationPlan; suite: Awaited<ReturnType<typeof loadSuite>>["suite"] }> {
	assertAllowed(
		parsed,
		[
			"participant",
			"repetitions",
			"case",
			"variant",
			"credential-env",
			"grant-effect",
			...(parsed.command === "run" ? ["approve"] : []),
		],
		["allow-home-credentials"],
	);
	const loaded = await loadSuite(positional(parsed, "suite"), REPOSITORY_ROOT);
	const participants = values(parsed, "participant").map(parseParticipant);
	if (participants.length === 0) throw new Error("At least one --participant is required");
	const adapter = getSubjectAdapter(loaded.suite.subject.adapter);
	const grant = invocationGrant(parsed);
	const requestedEffects = Object.values(loaded.suite.authority.requestedEffects).flat();
	for (const effect of requestedEffects) {
		if (!grant.grantedEffects.includes(effect))
			throw new Error(`Invocation grant is missing requested effect: ${effect}`);
	}
	if (grant.credentialSources.home && !grant.grantedEffects.includes("read-approved-model-credentials")) {
		throw new Error("--allow-home-credentials requires the read-approved-model-credentials grant");
	}
	const plan = createPlan(loaded.suite, loaded.path, participants, repetitions(parsed), adapter, grant, {
		caseIds: values(parsed, "case"),
		variantIds: values(parsed, "variant"),
	});
	return { plan, suite: loaded.suite };
}

function help(): string {
	return `Usage: npm run evals -- <command> [options]

Commands:
  validate   <suite>
  plan       <suite> --participant <provider/model:thinking> --repetitions <n> <authority options>
  run        <suite> <plan options> --approve <sha256:digest>
  inspect    <run-id> [--reveal]
  adjudicate <run-id> --verdict <pass|fail|inconclusive> --notes <text> [--preferred <label>] [--scope usable-executions]
  delete     <run-id> --approve <run-id>

Authority options:
  --allow-home-credentials
  --credential-env <NAME>       Repeat for each approved provider credential variable.
  --grant-effect <effect>        Repeat for each suite-requested effect.

Selection options --participant, --case, and --variant are repeatable. The run command requires the exact digest printed by plan.
`;
}

export function refineOperationalStatus(
	directory: string,
	status: RunState["operational"]["status"],
): RunState["operational"]["status"] {
	if (!status || status === "completed") return status;
	const evidence = listExecutionEvidence(directory) as Array<{
		result?: { errors?: Array<{ type?: string }> };
	}>;
	const hasUsableExecution = evidence.some(
		(entry) => Array.isArray(entry.result?.errors) && entry.result.errors.length === 0,
	);
	const hasErroredExecution = evidence.some(
		(entry) => Array.isArray(entry.result?.errors) && entry.result.errors.length > 0,
	);
	if (hasUsableExecution && hasErroredExecution) return "partial";
	if (status !== "failed") return status;
	const types = evidence.flatMap((entry) => entry.result?.errors?.map((error) => error.type ?? "Error") ?? []);
	if (types.length === 0) return "failed";
	const groups = new Set(
		types.map((type) => {
			if (type === "Timeout") return "timed_out";
			if (type === "Cancelled" || type === "CancellationError") return "cancelled";
			// A provider rejection is an external refusal of an approved request:
			// the harness machinery itself did not fail.
			if (type === "AssistantError" || type === "AssistantStopReason") return "blocked";
			if (type === "Blocked" || type === "BlockedError") return "blocked";
			return "failed";
		}),
	);
	if (groups.has("failed")) return "failed";
	if (groups.size === 1) return [...groups][0] as RunState["operational"]["status"];
	return "failed";
}

async function executeRun(parsed: ParsedArguments): Promise<Record<string, unknown>> {
	const { plan, suite } = await planned(parsed);
	const approval = one(parsed, "approve")!;
	if (approval !== plan.digest) throw new Error(`Approval digest mismatch. Exact plan digest: ${plan.digest}`);
	const prepared = prepareRun(EVIDENCE_ROOT, plan);
	const state = prepared.state;
	state.phase = "running";
	state.operational.startedAt = new Date().toISOString();
	writeJson(join(prepared.directory, "state.json"), state);
	let outcome: Awaited<ReturnType<typeof runVitestChild>>;
	try {
		outcome = await runVitestChild(prepared.directory, plan, join(prepared.directory, "variant-map.json"));
	} catch (error) {
		outcome = {
			status: "failed",
			exitCode: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	state.phase = "terminal";
	const coverage = buildRunCoverage(prepared.directory, plan);
	state.coverage = coverage;
	const operationalStatus = refineOperationalStatus(prepared.directory, outcome.status);
	state.operational = {
		...state.operational,
		status: operationalStatus,
		finishedAt: new Date().toISOString(),
		exitCode: outcome.exitCode,
		...(outcome.error ? { error: outcome.error } : {}),
	};
	if (suite.adjudication.policy === "deterministic-only" && outcome.status === "completed") {
		const evidence = listExecutionEvidence(prepared.directory) as Array<{
			execution?: { executionId?: string };
			result?: { output?: { checks?: Array<{ passed?: boolean }> } };
		}>;
		const usableIds = new Set(coverage.usableExecutionIds);
		const usableEvidence = evidence.filter(
			(entry) => entry.execution?.executionId !== undefined && usableIds.has(entry.execution.executionId),
		);
		const passed =
			coverage.usableExecutions === coverage.plannedExecutions &&
			usableEvidence.length === coverage.usableExecutions &&
			usableEvidence.every((entry) => entry.result?.output?.checks?.every((check) => check.passed) === true);
		state.quality.status = passed ? "pass" : "fail";
	}
	writeJson(join(prepared.directory, "state.json"), state);
	writeJson(join(prepared.directory, "review.json"), buildReviewArtifact(prepared.directory, suite, state));
	return { runId: prepared.runId, directory: prepared.directory, planDigest: plan.digest, state };
}

export function runExitCode(state: RunState): number {
	return state.operational.status !== "completed" || state.quality.status === "fail" ? 1 : 0;
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
	try {
		const parsed = parseArguments(args);
		switch (parsed.command) {
			case "help":
			case "--help":
				process.stdout.write(help());
				return 0;
			case "validate": {
				assertAllowed(parsed, [], []);
				const loaded = await loadSuite(positional(parsed, "suite"), REPOSITORY_ROOT);
				const adapter = getSubjectAdapter(loaded.suite.subject.adapter);
				for (const variant of loaded.suite.subject.variants) {
					adapter.resolve({
						suitePath: loaded.path,
						subjectKind: loaded.suite.subject.kind,
						subjectConfig: loaded.suite.subject.config,
						variant,
					});
				}
				process.stdout.write(
					`${JSON.stringify({ valid: true, suite: loaded.suite.id, path: loaded.path }, null, 2)}\n`,
				);
				return 0;
			}
			case "plan": {
				const { plan } = await planned(parsed);
				process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
				return 0;
			}
			case "run": {
				const result = await executeRun(parsed);
				process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
				const state = result.state as RunState;
				return runExitCode(state);
			}
			case "inspect":
				assertAllowed(parsed, [], ["reveal"]);
				process.stdout.write(
					`${JSON.stringify(inspectRun(EVIDENCE_ROOT, positional(parsed, "run-id"), parsed.flags.has("reveal")), null, 2)}\n`,
				);
				return 0;
			case "adjudicate": {
				assertAllowed(parsed, ["verdict", "notes", "preferred", "scope"], []);
				const verdict = one(parsed, "verdict") as QualityStatus;
				if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
					throw new Error("--verdict must be pass, fail, or inconclusive");
				}
				const scope = one(parsed, "scope", false);
				if (scope !== undefined && scope !== "usable-executions") {
					throw new Error("--scope must be usable-executions");
				}
				const state = adjudicateRun(
					EVIDENCE_ROOT,
					positional(parsed, "run-id"),
					verdict,
					one(parsed, "notes")!,
					one(parsed, "preferred", false),
					scope,
				);
				process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
				return 0;
			}
			case "delete": {
				assertAllowed(parsed, ["approve"], []);
				const runId = positional(parsed, "run-id");
				deleteRun(EVIDENCE_ROOT, runId, one(parsed, "approve")!);
				process.stdout.write(`${JSON.stringify({ deleted: runId }, null, 2)}\n`);
				return 0;
			}
			default:
				throw new Error(`Unknown command: ${parsed.command}`);
		}
	} catch (error) {
		process.stderr.write(`evals: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = await runCli();
