import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { refineOperationalStatus } from "./cli.mts";
import type { OperationalStatus } from "./types.mts";

function evidenceDirectory(errors: Array<Array<{ type: string; message: string }>>): string {
	const directory = mkdtempSync(join(tmpdir(), "evals-cli-test-"));
	mkdirSync(join(directory, "executions"), { recursive: true });
	const files: string[] = [];
	for (const [index, executionErrors] of errors.entries()) {
		const file = `execution-${index}.json`;
		writeFileSync(
			join(directory, "executions", file),
			`${JSON.stringify({ result: { errors: executionErrors } })}\n`,
		);
		files.push(file);
	}
	writeFileSync(join(directory, "execution-files.json"), `${JSON.stringify({ files })}\n`);
	return directory;
}

function classify(errors: Array<Array<{ type: string; message: string }>>): OperationalStatus | undefined {
	const directory = evidenceDirectory(errors);
	try {
		return refineOperationalStatus(directory, "failed");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("refineOperationalStatus", () => {
	it("maps a provider rejection to blocked", () => {
		const status = classify([
			[
				{ type: "AssistantError", message: "400 quota refused the request." },
				{ type: "AssistantStopReason", message: "Assistant stopped with error." },
			],
		]);
		assert.equal(status, "blocked");
	});

	it("maps an execution deadline to timed_out", () => {
		assert.equal(classify([[{ type: "Timeout", message: "deadline" }]]), "timed_out");
	});

	it("maps caller cancellation to cancelled", () => {
		assert.equal(classify([[{ type: "CancellationError", message: "cancelled" }]]), "cancelled");
	});

	it("maps a declared blocked error to blocked", () => {
		assert.equal(classify([[{ type: "BlockedError", message: "cost limit" }]]), "blocked");
	});

	it("keeps a harness failure failed", () => {
		assert.equal(classify([[{ type: "TypeError", message: "bad argument" }]]), "failed");
	});

	it("keeps mixed harness and provider failures failed", () => {
		const status = classify([
			[
				{ type: "AssistantError", message: "400 refused." },
				{ type: "TypeError", message: "bad argument" },
			],
		]);
		assert.equal(status, "failed");
	});

	it("keeps failed when no execution evidence exists", () => {
		const directory = mkdtempSync(join(tmpdir(), "evals-cli-empty-"));
		try {
			assert.equal(refineOperationalStatus(directory, "failed"), "failed");
			assert.equal(refineOperationalStatus(directory, "completed"), "completed");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
