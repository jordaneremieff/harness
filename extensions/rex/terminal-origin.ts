import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TerminalOrigin = {
	version: 1;
	terminal: "Rex";
	application: { bundleId: "com.superlogical.rex" };
	exact?: { server: string; hostId: string; instanceId: string; sessionId: string; blockId: string };
};
export type FocusResult = { outcome: "focused" | "stale" | "unavailable"; detail: string };
export type RunResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	failure?: "missing" | "timeout" | "failed";
};
export type Runner = (
	executable: string,
	args: readonly string[],
	options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<RunResult>;

const inputLimit = 16384;
const childLimit = 32768;
const childTimeout = 3000;

// The mutation checks the identity on the same connection that performs the focus.
const snapshotScript = `
local a = rex.args
local s, se = rex.call("server.status")
if not s then return {outcome="unavailable", detail="Rex server identity is unavailable."} end
if a.hostId and (s.host_id ~= a.hostId or s.instance_id ~= a.instanceId) then
  return {outcome="stale", detail="Rex server host or instance changed."}
end
local v, ve = rex.call("session.view", {session_id=a.sessionId})
if not v then
  if ve and string.find(ve, "code=session_not_found", 1, true) then
    return {outcome="stale", detail="Rex session no longer exists."}
  end
  return {outcome="unavailable", detail="Rex session view is unavailable."}
end
local placed = false
for _, w in ipairs(v.windows or {}) do
  if w.window_id then
    for _, l in ipairs(w.layers or {}) do
      for _, b in ipairs(l.blocks or {}) do
        if b.block_id == a.blockId and b.creator_name == "com.superlogical.terminal" then placed = true end
      end
    end
  end
end
if a.focus then
  if v.session_id ~= a.sessionId or not placed then
    return {outcome="stale", detail="Rex terminal block is gone or detached."}
  end
  local r, e = rex.call("session.focus_block", {session_id=a.sessionId, block_id=a.blockId})
  if not r then
    if e and (string.find(e, "code=not_found", 1, true) or string.find(e, "code=session_not_found", 1, true)) then
      return {outcome="stale", detail="Rex target disappeared before focus."}
    end
    return {outcome="unavailable", detail="Rex focus was not confirmed; do not retry automatically."}
  end
  if type(r.revision) ~= "number" then
    return {outcome="unavailable", detail="Rex focus acknowledgement is invalid; do not retry automatically."}
  end
  return {outcome="focused", detail="Rex selected the terminal block; client and Mac window are not verified."}
end
return {hostId=s.host_id, instanceId=s.instance_id, sessionId=v.session_id, placed=placed}
`;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}
function id(value: unknown, prefix: string): value is string {
	return typeof value === "string" && new RegExp(`^${prefix}[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(value);
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}
function appOrigin(): TerminalOrigin {
	return { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" } };
}

export function parseOrigin(input: string): TerminalOrigin {
	if (Buffer.byteLength(input) > inputLimit) throw new Error("Terminal origin exceeds 16384 bytes.");
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		throw new Error("Terminal origin must be one JSON record.");
	}
	if (!validEnvelope(value)) throw new Error("Terminal origin record is invalid.");
	if (value.exact !== undefined && !validExact(value.exact)) throw new Error("Exact terminal origin is invalid.");
	return value as TerminalOrigin;
}
function validEnvelope(value: unknown): value is Record<string, unknown> {
	return (
		record(value) &&
		onlyKeys(value, ["version", "terminal", "application", "exact"]) &&
		value.version === 1 &&
		value.terminal === "Rex" &&
		record(value.application) &&
		onlyKeys(value.application, ["bundleId"]) &&
		value.application.bundleId === "com.superlogical.rex"
	);
}
function validExact(value: unknown): value is NonNullable<TerminalOrigin["exact"]> {
	return (
		record(value) &&
		onlyKeys(value, ["server", "hostId", "instanceId", "sessionId", "blockId"]) &&
		text(value.server) &&
		id(value.hostId, "") &&
		id(value.instanceId, "") &&
		id(value.sessionId, "session:") &&
		id(value.blockId, "block:")
	);
}

export function trustedRexExecutable(): string {
	return join(
		userInfo().homedir,
		"Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex",
	);
}
const runChild: Runner = (executable, args, options) =>
	new Promise((done) => {
		execFile(
			executable,
			[...args],
			{ ...options, encoding: "utf8", killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				if (!error) return done({ code: 0, stdout, stderr });
				const failure = error.code === "ENOENT" ? "missing" : error.killed ? "timeout" : "failed";
				done({ code: typeof error.code === "number" ? error.code : null, stdout, stderr, failure });
			},
		);
	});
function childEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("REX_")) delete env[key];
	return env;
}
async function invoke(
	server: string,
	sessionId: string,
	args: Record<string, unknown>,
	run: Runner,
): Promise<RunResult> {
	try {
		return await run(
			trustedRexExecutable(),
			[
				"--autostart=false",
				"--color=never",
				"--timeout=2s",
				`--server=${server}`,
				"do",
				"--session",
				sessionId,
				"-e",
				snapshotScript,
				"--args",
				JSON.stringify(args),
				"--json",
			],
			{ timeout: childTimeout, maxBuffer: childLimit, env: childEnvironment() },
		);
	} catch {
		return { code: null, stdout: "", stderr: "", failure: "failed" };
	}
}
function decoded(result: RunResult): unknown {
	if (result.code !== 0 || result.failure || Buffer.byteLength(result.stdout) > childLimit) return undefined;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return undefined;
	}
}
function readSnapshot(
	value: unknown,
): value is { hostId: string; instanceId: string; sessionId: string; placed: boolean } {
	return (
		record(value) &&
		id(value.hostId, "") &&
		id(value.instanceId, "") &&
		id(value.sessionId, "session:") &&
		typeof value.placed === "boolean"
	);
}
function sessionGone(result: RunResult, sessionId: string): boolean {
	return (
		result.code === 3 &&
		!result.failure?.includes("timeout") &&
		result.stderr.trim() === `Error: session target "${sessionId}" not found`
	);
}
function unavailable(result: RunResult): FocusResult {
	if (result.failure === "missing")
		return { outcome: "unavailable", detail: "The trusted Rex program is not installed." };
	if (result.failure === "timeout")
		return { outcome: "unavailable", detail: "Rex timed out; focus is uncertain. Do not retry automatically." };
	return { outcome: "unavailable", detail: "Rex did not confirm the operation. Do not retry automatically." };
}
function focusResult(value: unknown): FocusResult | undefined {
	if (
		!record(value) ||
		!["focused", "stale", "unavailable"].includes(String(value.outcome)) ||
		!text(value.detail, 256)
	)
		return;
	return { outcome: value.outcome as FocusResult["outcome"], detail: value.detail };
}

export async function captureOrigin(
	env: Readonly<Record<string, string | undefined>> = process.env,
	run: Runner = runChild,
): Promise<TerminalOrigin | null> {
	const { REX_SERVER: server, REX_SESSION: sessionId, REX_BLOCK: blockId } = env;
	if (![server, sessionId, blockId].some((value) => value !== undefined)) return null;
	const origin = appOrigin();
	if (!text(server) || !id(sessionId, "session:") || !id(blockId, "block:")) return origin;
	const snapshot = decoded(await invoke(server, sessionId, { sessionId, blockId }, run));
	if (readSnapshot(snapshot) && snapshot.sessionId === sessionId && snapshot.placed) {
		origin.exact = { server, hostId: snapshot.hostId, instanceId: snapshot.instanceId, sessionId, blockId };
	}
	return origin;
}

export async function focusOrigin(origin: TerminalOrigin, run: Runner = runChild): Promise<FocusResult> {
	// Revalidate programmatic calls as well as stdin before any subprocess starts.
	origin = parseOrigin(JSON.stringify(origin));
	const exact = origin.exact;
	if (!exact)
		return {
			outcome: "unavailable",
			detail: "This origin has no verified terminal block. Return to Rex at application level.",
		};
	const result = await invoke(exact.server, exact.sessionId, exact, run);
	if (sessionGone(result, exact.sessionId)) return { outcome: "stale", detail: "Rex session no longer exists." };
	const snapshot = decoded(result);
	if (!readSnapshot(snapshot)) return focusResult(snapshot) ?? unavailable(result);
	if (snapshot.hostId !== exact.hostId || snapshot.instanceId !== exact.instanceId) {
		return { outcome: "stale", detail: "Rex server host or instance changed." };
	}
	if (snapshot.sessionId !== exact.sessionId || !snapshot.placed) {
		return { outcome: "stale", detail: "Rex terminal block is gone or detached." };
	}
	const focused = await invoke(exact.server, exact.sessionId, { ...exact, focus: true }, run);
	if (sessionGone(focused, exact.sessionId)) return { outcome: "stale", detail: "Rex session no longer exists." };
	return focusResult(decoded(focused)) ?? unavailable(focused);
}

async function readInput(input: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of input) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > inputLimit) throw new Error("Terminal origin exceeds 16384 bytes.");
		chunks.push(buffer);
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
export async function terminalOriginMain(
	args: string[],
	input: AsyncIterable<Buffer | string>,
	env: Readonly<Record<string, string | undefined>> = process.env,
	run: Runner = runChild,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		if (args.length !== 1 || !["capture", "focus"].includes(args[0]))
			throw new Error("Usage: terminal-origin.ts capture|focus");
		const value =
			args[0] === "capture"
				? await captureOrigin(env, run)
				: await focusOrigin(parseOrigin(await readInput(input)), run);
		return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
	} catch {
		return { code: 1, stdout: "", stderr: "Invalid terminal-origin command or input (maximum 16384 UTF-8 bytes).\n" };
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await terminalOriginMain(process.argv.slice(2), process.stdin);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.exitCode = result.code;
}
