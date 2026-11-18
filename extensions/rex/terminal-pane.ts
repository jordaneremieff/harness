import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paneStackingCommand, withPaneStacking } from "./pane-stacking.ts";
import { parseOrigin, trustedRexExecutable, type Runner, type RunResult, type TerminalOrigin } from "./terminal-origin.ts";

export interface PaneRequest { version: 1; origin: TerminalOrigin | null; argv: string[]; cwd: string }
export interface PaneReceipt { server: string; hostId: string; instanceId: string; sessionId: string; windowId: string; anchorId: string; blockId: string }
export interface PaneResult { version: 1; outcome: "created" | "stale" | "unavailable" | "uncertain"; detail: string; receipt?: PaneReceipt }
const LIMIT = 16384;
const validText = (value: unknown, max: number): value is string => typeof value === "string" && Buffer.byteLength(value) <= max && !value.includes("\0");
export function parsePaneRequest(input: string): PaneRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<PaneRequest>;
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "origin", "argv", "cwd"].includes(key)) || value.version !== 1 || !("origin" in value)) throw new Error("Invalid pane request.");
	if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 64 || !value.argv.every((arg) => validText(arg, 4096)) || !isAbsolute(value.argv[0])) throw new Error("Pane argv requires an absolute program and bounded, NUL-free arguments.");
	if (!validText(value.cwd, 4096) || !isAbsolute(value.cwd)) throw new Error("Pane cwd must be an absolute path.");
	const origin = value.origin === null ? null : parseOrigin(JSON.stringify(value.origin));
	return { version: 1, origin, argv: value.argv, cwd: value.cwd };
}

// Identity validation and the single mutation share one Rex connection. A block anchor never
// means global focus, and placement is checked again without a second creation attempt.
const splitScript = `
local a = rex.args
local s = rex.call("server.status")
if not s then return {outcome="unavailable", detail="Rex server identity is unavailable."} end
if s.host_id ~= a.hostId or s.instance_id ~= a.instanceId then return {outcome="stale", detail="Rex server identity changed."} end
local function placement(v, id)
  if not v or v.session_id ~= a.sessionId then return nil end
  for _, w in ipairs(v.windows or {}) do
    for _, l in ipairs(w.layers or {}) do
      for _, b in ipairs(l.blocks or {}) do
        if b.block_id == id and b.creator_name == "com.superlogical.terminal" then return w.window_id end
      end
    end
  end
end
local before = rex.call("session.view", {session_id=a.sessionId})
local window = placement(before, a.blockId)
if not window then return {outcome="stale", detail="The invoking terminal block is gone or detached."} end
local created = rex.call("session.new_split", {session_id=a.sessionId, anchor_id=a.blockId, direction="horizontal", side="after", ratio=0.5, focus=false,
  layout={block={flavor="com.superlogical.terminal.shell", label="Reader", options={shell="none", command=a.argv, cwd=a.cwd, exit={on_completion=true}}}}})
if not created or created.anchor_id ~= a.blockId or type(created.block_ids) ~= "table" or #created.block_ids ~= 1 or type(created.block_ids[1]) ~= "string" then
  return {outcome="uncertain", detail="Rex did not confirm split creation. Do not retry automatically."}
end
local receipt = {server=a.server, hostId=a.hostId, instanceId=a.instanceId, sessionId=a.sessionId, windowId=window, anchorId=a.blockId, blockId=created.block_ids[1]}
local after = rex.call("session.view", {session_id=a.sessionId})
local anchorWindow = placement(after, a.blockId)
local paneWindow = placement(after, receipt.blockId)
if not anchorWindow or anchorWindow ~= paneWindow then return {outcome="uncertain", receipt=receipt, detail="Rex created a block but same-tab placement is unconfirmed. Do not retry automatically."} end
receipt.windowId = paneWindow
return {outcome="created", receipt=receipt, detail="Rex created a split beside the invoking terminal. Visibility and program acceptance are not verified."}
`;
const runChild: Runner = (executable, args, options) => new Promise((done) => {
	execFile(executable, [...args], { ...options, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout, stderr) => {
		if (!error) return done({ code: 0, stdout, stderr });
		done({ code: typeof error.code === "number" ? error.code : null, stdout, stderr, failure: error.code === "ENOENT" ? "missing" : error.killed ? "timeout" : "failed" });
	});
});
const result = (outcome: PaneResult["outcome"], detail: string): PaneResult => ({ version: 1, outcome, detail });
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
function readReceipt(value: unknown, exact: NonNullable<TerminalOrigin["exact"]>): PaneReceipt | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const r = value as PaneReceipt;
	if (r.server !== exact.server || r.hostId !== exact.hostId || r.instanceId !== exact.instanceId || r.sessionId !== exact.sessionId || r.anchorId !== exact.blockId) return;
	if (typeof r.blockId !== "string" || !new RegExp(`^block:${uuid}$`).test(r.blockId) || r.blockId === exact.blockId || typeof r.windowId !== "string" || !new RegExp(`^window:${uuid}$`).test(r.windowId)) return;
	return { server: r.server, hostId: r.hostId, instanceId: r.instanceId, sessionId: r.sessionId, windowId: r.windowId, anchorId: r.anchorId, blockId: r.blockId };
}
export async function splitPane(request: PaneRequest, env: Readonly<NodeJS.ProcessEnv> = process.env, run: Runner = runChild): Promise<PaneResult> {
	request = parsePaneRequest(JSON.stringify(request));
	const exact = request.origin?.exact;
	if (!exact) return result("unavailable", "No verified invoking terminal is available. No pane was created.");
	if (env.REX_SERVER !== exact.server || env.REX_SESSION !== exact.sessionId || env.REX_BLOCK !== exact.blockId) return result("stale", "The inherited terminal differs from the captured origin. No pane was created.");
	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) if (key.startsWith("REX_")) delete childEnv[key];
	// The program learns which content of the window lies over its pane from Rex's layout, as panes that rex_terminal creates do.
	const argv = withPaneStacking(request.argv, paneStackingCommand(exact.server, env));
	let child: RunResult;
	try {
		child = await run(trustedRexExecutable(), ["--autostart=false", "--color=never", "--timeout=3s", `--server=${exact.server}`, "do", "--session", exact.sessionId, "-e", splitScript, "--args", JSON.stringify({ ...exact, argv, cwd: request.cwd }), "--json"], { timeout: 5000, maxBuffer: 32768, env: childEnv });
	} catch { return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically."); }
	if (child.failure === "missing") return result("unavailable", "The trusted Rex program is missing. No pane was created.");
	if (child.failure || child.code !== 0 || Buffer.byteLength(child.stdout) > 32768) return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically.");
	return readResult(child.stdout, exact);
}
function readResult(stdout: string, exact: NonNullable<TerminalOrigin["exact"]>): PaneResult {
	try {
		const value = JSON.parse(stdout) as PaneResult;
		if (!["created", "stale", "unavailable", "uncertain"].includes(value.outcome) || !validText(value.detail, 256) || !value.detail.length || /[\p{Cc}\p{Cf}]/u.test(value.detail)) throw new Error("Invalid result.");
		const receipt = readReceipt(value.receipt, exact);
		if (value.outcome === "created" && !receipt) throw new Error("Missing receipt.");
		return { version: 1, outcome: value.outcome, detail: value.detail, ...(receipt ? { receipt } : {}) };
	} catch { return result("uncertain", "Rex returned an invalid creation result. Do not retry automatically."); }
}
async function main(): Promise<void> {
	if (process.argv.length !== 3 || process.argv[2] !== "split") throw new Error("Use terminal-pane.ts split with one JSON request on stdin.");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
		chunks.push(Buffer.from(chunk));
	}
	const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	process.stdout.write(`${JSON.stringify(await splitPane(parsePaneRequest(input)))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => { process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 256)}\n`); process.exitCode = 1; });
}
