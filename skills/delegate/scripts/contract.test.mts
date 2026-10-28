import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

type Finding = { code: string; message: string };
type ContractSize = { words: number; approxTokens: number };
type Report = {
	file: string;
	kind: string;
	ok: boolean;
	findings: Finding[];
	omitted: number;
	size: ContractSize;
};
type RunResult = SpawnSyncReturns<string> & { report: Report };

const KINDS = ["task", "lead", "partner", "review", "frame", "handoff"] as const;

const script = fileURLToPath(new URL("./contract.mts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "delegate-contract-test-"));
let sequence = 0;

after(() => rmSync(root, { recursive: true, force: true }));

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function isReport(value: unknown): value is Report {
	if (!isRecord(value)) return false;
	if (typeof value.file !== "string" || typeof value.kind !== "string" || typeof value.ok !== "boolean") return false;
	if (!Array.isArray(value.findings)) return false;
	if (typeof value.omitted !== "number") return false;
	if (!isRecord(value.size)) return false;
	return typeof value.size.words === "number" && typeof value.size.approxTokens === "number";
}

function parseReport(output: string): Report {
	const parsed: unknown = JSON.parse(output);
	if (!isReport(parsed)) throw new Error(`contract.mts emitted an invalid JSON report: ${output}`);
	return parsed;
}

function run(args: string[], input?: string): SpawnSyncReturns<string> {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", input });
	assert.equal(result.signal, null, result.stderr);
	return result;
}

function runJson(args: string[], input?: string): RunResult {
	const result = run([...args, "--json"], input);
	return { ...result, report: parseReport(result.stdout) };
}

function template(kind: string): string {
	return readFileSync(fileURLToPath(new URL(`../assets/${kind}.md`, import.meta.url)), "utf8");
}

function writeContract(content: string): string {
	const path = join(root, `contract${++sequence}.md`);
	writeFileSync(path, content);
	return path;
}

function fillerFor(slot: string): string {
	if (/authority|operator directions/i.test(slot))
		return 'The operator said "deliver the outcome". Source: the directing session.';
	if (slot === "End condition")
		return "Stop when the checks pass. Make tool calls first; the last message is the deliverable.";
	return `Filled content for ${slot}.`;
}

function runFrame(input: string): SpawnSyncReturns<string> {
	return run(["frame", "-"], input);
}

function fillTemplate(kind: string, omit: (slot: string) => string | undefined = () => undefined): string {
	const lines = template(kind).split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const heading = line.match(/^## (.+?)(?: <!-- required -->)?$/);
		if (!heading) {
			if (index > 0 && lines[index - 1].startsWith("## ")) continue;
			output.push(line);
			continue;
		}
		const slot = heading[1];
		const override = omit(slot);
		if (override === undefined) {
			output.push(`## ${slot}`, fillerFor(slot));
		} else if (override !== "") {
			output.push(`## ${slot}`, override);
		}
	}
	return output.join("\n");
}

test("each kind's template passes its own structure check when filled", () => {
	for (const kind of KINDS) {
		const path = writeContract(fillTemplate(kind));
		const { status, report } = runJson(["check", path, "--kind", kind]);
		assert.equal(status, 0, `${kind}: ${JSON.stringify(report.findings)}`);
		assert.equal(report.ok, true);
		assert.equal(report.findings.length, 0);
		assert.ok(report.size.words > 0);
		assert.ok(report.size.words <= report.size.approxTokens);
	}
});

test("template command prints the asset with required markers", () => {
	const result = run(["template", "task"]);
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim(), template("task").trim());
	assert.match(result.stdout, /## Objective <!-- required -->/);
});

test("reports a missing required slot and an empty required slot", () => {
	const path = writeContract(
		fillTemplate("task", (slot) => {
			if (slot === "Objective") return "";
			if (slot === "Acceptance evidence") return "<!-- still to write -->";
			return undefined;
		}),
	);
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 1);
	const codes = report.findings.map((finding) => finding.code);
	assert.ok(codes.includes("slot.missing"), JSON.stringify(report.findings));
	assert.ok(codes.includes("slot.empty"), JSON.stringify(report.findings));
	assert.ok(report.findings.some((finding) => finding.message.includes("Objective")));
	assert.ok(report.findings.some((finding) => finding.message.includes("Acceptance evidence")));
});

test("reports a missing end condition with its own code", () => {
	const path = writeContract(fillTemplate("task", (slot) => (slot === "End condition" ? "" : undefined)));
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 1);
	assert.ok(report.findings.some((finding) => finding.code === "end-condition.missing"));
	assert.ok(report.findings.every((finding) => finding.code !== "slot.missing"));
});

test("reports a slot that still holds the template guidance", () => {
	const guidance = "The single outcome the worker must deliver, stated as an observable end state.";
	const path = writeContract(fillTemplate("task", (slot) => (slot === "Objective" ? guidance : undefined)));
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 1);
	assert.deepEqual(
		report.findings.map((finding) => finding.code),
		["slot.unfilled"],
	);
});

test("reports an end condition without the last-message rule", () => {
	const path = writeContract(
		fillTemplate("lead", (slot) => (slot === "End condition" ? "Stop when all workers are resolved." : undefined)),
	);
	const { status, report } = runJson(["check", path, "--kind", "lead"]);
	assert.equal(status, 1);
	assert.deepEqual(
		report.findings.map((finding) => finding.code),
		["end-condition.no-final-message"],
	);
});

test("reports an authority slot without verbatim quotes and a source", () => {
	const path = writeContract(
		fillTemplate("task", (slot) =>
			slot === "Operator authority" ? "The operator directed this task last week." : undefined,
		),
	);
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 1);
	assert.deepEqual(
		report.findings.map((finding) => finding.code),
		["authority.missing-verbatim"],
	);
});

test("reports a frame field over the agent_collaborate limit", () => {
	const path = writeContract(fillTemplate("frame", (slot) => (slot === "Title" ? "x".repeat(161) : undefined)));
	const { status, report } = runJson(["check", path, "--kind", "frame"]);
	assert.equal(status, 1);
	assert.deepEqual(
		report.findings.map((finding) => finding.code),
		["frame.field-too-long"],
	);
	assert.ok(report.findings[0].message.includes("161"));
});

test("reports instructions to sleep, wait a fixed duration, or poll", () => {
	const path = writeContract(
		fillTemplate("task", (slot) =>
			slot === "Acceptance evidence"
				? "Poll agent_status every 30 seconds until the worker answers. Use sleep 5 between tries."
				: undefined,
		),
	);
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 1);
	assert.ok(report.findings.some((finding) => finding.code === "text.sleep-wait-poll"));
});

test("does not flag prohibitions of sleep, waits, or polling", () => {
	const path = writeContract(
		fillTemplate("task", (slot) => {
			if (slot === "Restrictions and exclusions")
				return "Never sleep. Do not poll agent_status. Avoid timed waits. The worker must not poll.";
			if (slot === "End condition")
				return "Stop when the checks pass. No polling is permitted. The last message is the deliverable.";
			return undefined;
		}),
	);
	const { status, report } = runJson(["check", path, "--kind", "task"]);
	assert.equal(status, 0, JSON.stringify(report.findings));
});

test("frame prints agent_collaborate create arguments for a clean frame", () => {
	const result = runFrame(fillTemplate("frame", (slot) => (slot === "Integrator" ? "" : undefined)));
	assert.equal(result.status, 0, result.stderr);
	const args: unknown = JSON.parse(result.stdout);
	assert.ok(isRecord(args));
	assert.equal(args.action, "create");
	assert.equal(args.title, "Filled content for Title.");
	assert.equal(args.source, "Filled content for Source.");
	assert.equal(args.authority, fillerFor("Authority"));
	assert.equal("integrator" in args, false);
});

test("frame refuses a missing field and an oversized field without printing JSON", () => {
	const result = runFrame(
		fillTemplate("frame", (slot) => {
			if (slot === "Acceptance") return "";
			if (slot === "Source") return "s".repeat(2001);
			return undefined;
		}),
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /slot\.missing: frame: required slot is missing: Acceptance/);
	assert.match(result.stderr, /frame\.field-too-long: frame: field 'source' is 2001/);
});

test("reads a contract from stdin", () => {
	const { status, report } = runJson(["check", "-", "--kind", "review"], fillTemplate("review"));
	assert.equal(status, 0, JSON.stringify(report.findings));
	assert.equal(report.file, "-");
});

test("rejects invalid invocations with exit code 2", () => {
	const cases: string[][] = [
		[],
		["inspect", "x.md"],
		["template", "unknown"],
		["template", "task", "--json"],
		["check"],
		["check", "x.md"],
		["check", "x.md", "--kind", "unknown"],
		["check", "x.md", "--kind", "task", "extra.md"],
		["check", join(root, "does-not-exist.md"), "--kind", "task"],
		["frame"],
		["frame", "x.md", "--json"],
	];
	for (const args of cases) {
		const result = run(args);
		assert.equal(result.status, 2, `args ${JSON.stringify(args)}: ${result.stdout} ${result.stderr}`);
		assert.match(result.stderr, /Error:/);
	}
});

test("--help exits 0 and documents the required-slot marking", () => {
	const result = run(["--help"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /<!-- required -->/);
	assert.match(result.stdout, /Exit codes:/);
});
