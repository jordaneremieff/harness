// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { readFileSync, readSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	type Analyzer,
	analyzeText,
	buildReport,
	CONTRACT,
	exitCodeFor,
	makeAnalyzer,
	METER_VERSION,
	type Report,
} from "./analyze.mts";
import { analyzeDiff, parseDiff } from "./diff.mts";
import { type Kind, kindForPath, normalizeText } from "./extract.mts";
import { renderText, useColor } from "./report.mts";
import { loadRules, RulesError } from "./rules.mts";

export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export interface Io {
	readStdin(): Buffer;
	stdout(text: string): void;
	stderr(text: string): void;
	env: Record<string, string | undefined>;
	stdoutIsTty: boolean;
	stdinIsTty: boolean;
}

export const HELP = `Usage: node extensions/draft/scripts/meter.mts [target] [options]

Find slop tells in prose and report them. The meter never rewrites text.

Input:
  target              One file path. No target, or "-", reads standard input.
  --stdin             Read standard input (no target allowed).
  --diff              Read a unified diff (file or standard input). Only added lines
                      are checked; findings carry new-file line numbers.
  --kind KIND         auto (default), md, html, text, ts, js, commit.
                      auto picks by file extension; standard input is md.

Output:
  --format FORMAT     text (default) or json (the contract in extensions/draft/README.md).
  -v                  Add component metrics to text output.
  -q                  Print one summary line.

Scoring and rules:
  --threshold N       Score at or above N counts as a failure (default from the rule data).
  --strict            Use the green band edge as the threshold.
  --strict-semicolons Make a single prose semicolon a hard finding.
  --spelling au|off   Australian spelling check (default au).
  --times 12h|off     Flag 24-hour and UTC times in prose (default off).
  --rules PATH        Use another rule data file (must pass the schema).

Other:
  --help              Show this text.
  --version           Show the meter and contract versions.

Exit codes:
  0  no hard findings, score below the threshold
  1  hard findings present
  2  score at or above the threshold, no hard findings
  3  hard findings and a score at or above the threshold
  4  usage or input error (bad flag, missing file, directory, not UTF-8, too large)

Hard findings never feed the score. A text under 50 words gets findings but no band
and no score gate. Details of the JSON report: extensions/draft/README.md.
`;

class UsageError extends Error {}

/**
 * Read a file descriptor to its end. A non-blocking pipe reports EAGAIN while the writer is slow,
 * so retry after a short wait. Stops once more than `limit` bytes have arrived.
 */
export function readDescriptor(fd: number, limit: number): Buffer {
	const chunks: Buffer[] = [];
	const chunk = Buffer.alloc(65536);
	const pause = new Int32Array(new SharedArrayBuffer(4));
	let total = 0;
	while (total <= limit) {
		let read = 0;
		try {
			read = readSync(fd, chunk, 0, chunk.length, null);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EOF") break;
			if (code !== "EAGAIN") throw error;
			Atomics.wait(pause, 0, 0, 5);
			continue;
		}
		if (read === 0) break;
		chunks.push(Buffer.from(chunk.subarray(0, read)));
		total += read;
	}
	return Buffer.concat(chunks);
}

const KIND_VALUES = ["auto", "md", "html", "text", "ts", "js", "commit"];

function decode(buffer: Buffer, label: string): string {
	if (buffer.length > MAX_INPUT_BYTES) throw new UsageError(`${label} is larger than ${MAX_INPUT_BYTES} bytes`);
	if (buffer.includes(0)) throw new UsageError(`${label} looks like binary data (NUL byte)`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new UsageError(`${label} is not valid UTF-8`);
	}
}

function readTarget(target: string | undefined, io: Io): { text: string; label: string; path?: string } {
	if (target === undefined || target === "-") {
		if (io.stdinIsTty) throw new UsageError("no input: pass a file, or pipe text on standard input");
		let buffer: Buffer;
		try {
			buffer = io.readStdin();
		} catch (error) {
			throw new UsageError(`cannot read standard input: ${(error as Error).message}`);
		}
		return { text: decode(buffer, "standard input"), label: "stdin" };
	}
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(target);
	} catch (error) {
		throw new UsageError(`cannot read ${target}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
	}
	if (!info.isFile()) throw new UsageError(`${target} is not a regular file`);
	if (info.size > MAX_INPUT_BYTES) throw new UsageError(`${target} is larger than ${MAX_INPUT_BYTES} bytes`);
	return { text: decode(readFileSync(target), target), label: target, path: target };
}

function parseThreshold(value: string): number {
	const number = Number(value);
	if (value.trim() === "" || !Number.isFinite(number) || number < 0 || number > 100)
		throw new UsageError("--threshold must be a number from 0 to 100");
	return number;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string, fallback: T): T {
	if (value === undefined) return fallback;
	if (!(allowed as readonly string[]).includes(value))
		throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}`);
	return value as T;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			format: { type: "string" },
			stdin: { type: "boolean" },
			diff: { type: "boolean" },
			threshold: { type: "string" },
			strict: { type: "boolean" },
			"strict-semicolons": { type: "boolean" },
			kind: { type: "string" },
			spelling: { type: "string" },
			times: { type: "string" },
			rules: { type: "string" },
			v: { type: "boolean", short: "v" },
			q: { type: "boolean", short: "q" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
		},
	});
}

type Parsed = ReturnType<typeof parse>;

interface Flags {
	format: "text" | "json";
	kind: string;
	spelling: "au" | "off";
	times: "12h" | "off";
	threshold: number | undefined;
	strict: boolean;
	strictSemicolons: boolean;
	rulesPath: string | undefined;
	verbose: boolean;
	quiet: boolean;
	diff: boolean;
	target: string | undefined;
}

function readFlags(parsed: Parsed): Flags {
	const { values, positionals } = parsed;
	if (positionals.length > 1) throw new UsageError("give at most one target");
	if (values.stdin === true && positionals.length > 0 && positionals[0] !== "-")
		throw new UsageError("--stdin cannot be combined with a target");
	if (values.v === true && values.q === true) throw new UsageError("choose one of -v and -q");
	return {
		format: oneOf(values.format as string | undefined, ["text", "json"] as const, "--format", "text"),
		kind: oneOf(values.kind as string | undefined, KIND_VALUES as readonly string[], "--kind", "auto"),
		spelling: oneOf(values.spelling as string | undefined, ["au", "off"] as const, "--spelling", "au"),
		times: oneOf(values.times as string | undefined, ["12h", "off"] as const, "--times", "off"),
		threshold: values.threshold === undefined ? undefined : parseThreshold(String(values.threshold)),
		strict: values.strict === true,
		strictSemicolons: values["strict-semicolons"] === true,
		rulesPath: values.rules as string | undefined,
		verbose: values.v === true,
		quiet: values.q === true,
		diff: values.diff === true,
		target: positionals[0],
	};
}

function buildAnalyzer(flags: Flags): Analyzer {
	try {
		return makeAnalyzer(loadRules(flags.rulesPath), {
			spelling: flags.spelling,
			times: flags.times,
			strictSemicolons: flags.strictSemicolons,
		});
	} catch (error) {
		if (error instanceof RulesError) throw new UsageError(error.message);
		throw error;
	}
}

function resolveKind(flags: Flags, path: string | undefined): Kind {
	if (flags.kind !== "auto") return flags.kind as Kind;
	if (path === undefined) return "md";
	return kindForPath(path) ?? "text";
}

function analyzeInput(flags: Flags, analyzer: Analyzer, input: { text: string; path?: string }): Report {
	const scoring = analyzer.set.scoring;
	const threshold = flags.strict ? scoring.bands.green : (flags.threshold ?? scoring.defaultThreshold);
	const target = input.path === undefined ? {} : { target: input.path };
	if (flags.diff) {
		const diff = analyzeDiff(analyzer, parseDiff(input.text));
		return buildReport(analyzer, diff.results, {
			inputKind: "diff",
			threshold,
			rawLines: normalizeText(input.text).split("\n").length,
			skippedFiles: diff.skipped,
			...target,
		});
	}
	return analyzeText(analyzer, input.text, resolveKind(flags, input.path), { threshold, ...target });
}

function execute(argv: string[], io: Io): number {
	let parsed: Parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
	if (parsed.values.help === true) {
		io.stdout(HELP);
		return 0;
	}
	if (parsed.values.version === true) {
		io.stdout(`meter ${METER_VERSION} (contract ${CONTRACT})\n`);
		return 0;
	}
	const flags = readFlags(parsed);
	const analyzer = buildAnalyzer(flags);
	const report = analyzeInput(flags, analyzer, readTarget(flags.target, io));
	if (flags.format === "json") {
		io.stdout(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		const color = useColor(io.env, io.stdoutIsTty);
		io.stdout(renderText(report, { verbose: flags.verbose, quiet: flags.quiet, color }));
	}
	return exitCodeFor(report);
}

export function runCli(argv: string[], io: Io): number {
	try {
		return execute(argv, io);
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`meter: ${error.message}\nRun with --help for usage.\n`);
			return 4;
		}
		io.stderr(`meter: unexpected failure: ${(error as Error).message}\n`);
		return 4;
	}
}
