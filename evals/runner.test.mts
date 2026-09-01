import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { EvaluationPlan } from "./types.mts";
import { validateVitestReport, writeVitestConfig } from "./runner.mts";
import { createBoundedFileSink } from "./bounded-file.mts";

const plan = (suitePath: string): EvaluationPlan => ({
	schemaVersion: 1,
	suite: { id: "suite", title: "Suite", path: suitePath, digest: `sha256:${"1".repeat(64)}` },
	cases: [{ id: "case", title: "Case", input: {}, checks: [{ id: "check", type: "check", config: {} }] }],
	variants: [{ id: "variant", description: "Variant", config: {} }],
	participants: [{ id: "test/model:off", provider: "test", model: "model", thinking: "off" }],
	invocation: {
		participantRoster: [{ id: "test/model:off", provider: "test", model: "model", thinking: "off" }],
		repetitions: 1,
		grant: {
			providerNetwork: "approved-effects-only",
			credentialSources: { home: true, environment: [] },
			grantedEffects: [],
		},
	},
	limits: {
		wall: { runTimeoutMs: 10_000, executionTimeoutMs: 1_000 },
		execution: { maxTotal: 1, maxTurnsEach: 1, maxOutputTokensEach: 10 },
		cost: { currency: "USD", maxObserved: 0, enforcement: "observed-after-each-execution", hardCap: false },
	},
	authority: { requestedEffects: { providerNetwork: [], credentials: [], subject: [] } },
	subjectResolution: { adapter: "test", kind: "adhoc", config: {}, variants: [{ id: "variant", resolution: {} }] },
	digest: `sha256:${"2".repeat(64)}`,
});

describe("Vitest child boundary", () => {
	it("writes a pinned isolated config with no positional test filter", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-runner-"));
		try {
			const suitePath = join(directory, "suite.eval.mts");
			writeFileSync(suitePath, "export default {};\n");
			const { configPath } = writeVitestConfig(directory, plan(suitePath));
			const config = readFileSync(configPath, "utf8");
			for (const expected of [
				"envDir: false",
				"exclude: []",
				'pool: "forks"',
				"fileParallelism: false",
				"maxConcurrency: 1",
			]) {
				assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
			assert.equal(statSync(configPath).mode & 0o777, 0o600);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("binds JSON success to the exact file, test count, and exit code", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-report-"));
		try {
			const suitePath = join(directory, "suite.eval.mts");
			const otherPath = join(directory, "other.eval.mts");
			const reportPath = join(directory, "report.json");
			writeFileSync(suitePath, "export default {};\n");
			writeFileSync(otherPath, "export default {};\n");
			const writeReport = (name: string, total: number, assertions: unknown[]): void => {
				writeFileSync(
					reportPath,
					JSON.stringify({
						success: true,
						numTotalTests: total,
						testResults: [{ name, assertionResults: assertions }],
					}),
				);
			};

			writeReport(suitePath, 1, [{}]);
			assert.equal(validateVitestReport(reportPath, suitePath, 1, 0).status, "completed");
			assert.match(validateVitestReport(reportPath, suitePath, 1, 1).error ?? "", /exited with code 1/);

			writeReport(otherPath, 1, [{}]);
			assert.match(validateVitestReport(reportPath, suitePath, 1, 0).error ?? "", /unexpected file set/);

			writeReport(suitePath, 2, [{}]);
			assert.match(validateVitestReport(reportPath, suitePath, 1, 0).error ?? "", /reported 2\/1 tests; expected 1/);
			writeReport(suitePath, 1, []);
			assert.match(validateVitestReport(reportPath, suitePath, 1, 0).error ?? "", /reported 1\/0 tests; expected 1/);

			writeFileSync(reportPath, "null");
			assert.match(validateVitestReport(reportPath, suitePath, 1, 0).error ?? "", /must be a JSON object/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("bounds private child output files", () => {
		const directory = mkdtempSync(join(tmpdir(), "eval-output-"));
		try {
			const path = join(directory, "output.log");
			const sink = createBoundedFileSink(path, 128);
			sink.accept(Buffer.alloc(1_024, 65));
			const result = sink.close();
			assert.deepEqual({ bytes: result.bytes, truncated: result.truncated }, { bytes: 128, truncated: true });
			assert.equal(statSync(path).mode & 0o777, 0o600);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
