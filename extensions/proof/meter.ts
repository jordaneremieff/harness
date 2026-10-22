import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

/** The members of the prose meter JSON report this slice reads (contract 1). */
export interface Finding {
	rule: string;
	severity: "hard" | "scored";
	line?: number;
	text?: string;
	message: string;
}
export interface MeterReport {
	contract: 1;
	meterVersion: string;
	hard: Finding[];
	scored: Finding[];
	score: { sq: number; band: "green" | "amber" | "red" | null; reliable: boolean };
	calibration: { cohort: string | null; n: number; date: string | null; status: "uncalibrated" | "calibrated" } | null;
	omitted: { hard: number; scored: number };
}

export type MeterFailure = "missing" | "failed" | "timeout";
export type MeterResult =
	| { ok: true; report: MeterReport }
	| { ok: false; reason: MeterFailure; detail: string };

export interface MeterOptions {
	meterPath: string;
	timeoutMs: number;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DETAIL = 200;
const BANDS: readonly unknown[] = ["green", "amber", "red"];

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function oneLine(text: string): string {
	return text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

function parseFindings(value: unknown, severity: Finding["severity"]): Finding[] {
	if (!Array.isArray(value)) throw new Error("findings are not a list");
	return value.map((item) => {
		if (!object(item) || typeof item.rule !== "string" || typeof item.message !== "string")
			throw new Error("malformed finding");
		const finding: Finding = { rule: item.rule, severity, message: item.message };
		if (typeof item.line === "number" && Number.isFinite(item.line)) finding.line = item.line;
		if (typeof item.text === "string") finding.text = item.text;
		return finding;
	});
}

function parseScore(score: unknown): MeterReport["score"] {
	if (
		!object(score) ||
		typeof score.sq !== "number" ||
		typeof score.reliable !== "boolean" ||
		!(score.band === null || BANDS.includes(score.band))
	)
		throw new Error("malformed score");
	return { sq: score.sq, band: score.band as MeterReport["score"]["band"], reliable: score.reliable };
}
function parseCalibration(value: unknown): MeterReport["calibration"] {
	if (!object(value)) return null;
	return {
		cohort: typeof value.cohort === "string" ? value.cohort : null,
		n: typeof value.n === "number" ? value.n : 0,
		date: typeof value.date === "string" ? value.date : null,
		status: value.status === "calibrated" ? "calibrated" : "uncalibrated",
	};
}
function count(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

/** Validate meter output against this slice's copy of the contract; throws on any mismatch. */
export function parseReport(raw: string): MeterReport {
	const value: unknown = JSON.parse(raw);
	if (!object(value)) throw new Error("report is not an object");
	if (value.contract !== 1) throw new Error(`unknown contract ${oneLine(String(value.contract))}`);
	const omitted = object(value.omitted) ? value.omitted : {};
	return {
		contract: 1,
		meterVersion: typeof value.meterVersion === "string" ? value.meterVersion : "unknown",
		hard: parseFindings(value.hard, "hard"),
		scored: parseFindings(value.scored, "scored"),
		score: parseScore(value.score),
		calibration: parseCalibration(value.calibration),
		omitted: { hard: count(omitted.hard), scored: count(omitted.scored) },
	};
}

function exitFailure(code: number | null, signal: string | null, errText: string): MeterResult | undefined {
	if (code !== null && code >= 0 && code <= 3) return undefined;
	const why = code === 4 ? "usage or input error" : signal ? `signal ${signal}` : `exit status ${code}`;
	const err = oneLine(errText);
	return { ok: false, reason: "failed", detail: err ? `${why}: ${err}` : why };
}
function outputResult(raw: string): MeterResult {
	try {
		return { ok: true, report: parseReport(raw) };
	} catch (error) {
		const why = oneLine(error instanceof Error ? error.message : "parse error");
		return { ok: false, reason: "failed", detail: `unusable output (${why})` };
	}
}

/** Run the meter on `text` with an argument array, no shell, and a hard kill at the time limit. */
export async function runMeter(text: string, options: MeterOptions): Promise<MeterResult> {
	try {
		if (!(await stat(options.meterPath)).isFile()) return { ok: false, reason: "missing", detail: "not a file" };
	} catch {
		return { ok: false, reason: "missing", detail: "file not found" };
	}
	return new Promise<MeterResult>((resolve) => {
		let settled = false;
		const finish = (result: MeterResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn(process.execPath, [options.meterPath, "--stdin", "--format", "json"], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, reason: "timeout", detail: `no result within ${options.timeoutMs} ms` });
		}, options.timeoutMs);
		const out: Buffer[] = [];
		let outBytes = 0;
		let errText = "";
		child.stdout.on("data", (chunk: Buffer) => {
			outBytes += chunk.length;
			if (outBytes > MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				finish({ ok: false, reason: "failed", detail: "output exceeds size limit" });
				return;
			}
			out.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (errText.length < 2000) errText += chunk.toString("utf8");
		});
		child.stdin.on("error", () => {});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish({
				ok: false,
				reason: error.code === "ENOENT" ? "missing" : "failed",
				detail: oneLine(error.code ?? "spawn error"),
			});
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			finish(exitFailure(code, signal, errText) ?? outputResult(Buffer.concat(out).toString("utf8")));
		});
		child.stdin.end(text);
	});
}
