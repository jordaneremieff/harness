import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paneStackingCommand, withPaneStacking } from "./pane-stacking.ts";
import { parseOrigin, trustedRexExecutable, type Runner, type RunResult, type TerminalOrigin } from "./terminal-origin.ts";

export type PanePlacement = { side: "right" | "below"; share: number };
export interface PaneRequest { version: 1; origin: TerminalOrigin | null; argv: string[]; cwd: string; placement?: PanePlacement; label?: string }
type Direction = "horizontal" | "vertical";
export interface PaneResizeRequest { version: 1; receipt: PaneReceipt; share: number }
export interface PaneResizeResult { version: 1; outcome: "resized" | "stale" | "unavailable" | "uncertain"; detail: string }
export interface PaneFocusRequest { version: 1; receipt: PaneReceipt }
export interface PaneFocusResult { version: 1; outcome: "focused" | "stale" | "unavailable" | "uncertain"; detail: string }
export interface PaneReceipt { server: string; hostId: string; instanceId: string; sessionId: string; windowId: string; anchorId: string; blockId: string; direction: Direction }
export interface PaneResult { version: 1; outcome: "created" | "stale" | "unavailable" | "uncertain"; detail: string; receipt?: PaneReceipt }
const LIMIT = 16384;
const DEFAULT_PLACEMENT: PanePlacement = { side: "right", share: 0.5 };
const DEFAULT_LABEL = "Reader";
const validText = (value: unknown, max: number): value is string => typeof value === "string" && Buffer.byteLength(value) <= max && !value.includes("\0");
function parsePlacement(value: unknown): PanePlacement {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pane placement must be one object.");
	const placement = value as Record<string, unknown>;
	if (Object.keys(placement).some((key) => !["side", "share"].includes(key)) || (placement.side !== "right" && placement.side !== "below") || typeof placement.share !== "number" || !Number.isFinite(placement.share) || placement.share < 0.15 || placement.share > 0.85) throw new Error("Pane placement requires side right or below and a share from 0.15 to 0.85.");
	return { side: placement.side, share: placement.share };
}
// Printable means one to 32 Unicode code points without control, format or surrogate characters.
function parseLabel(value: unknown): string {
	const length = typeof value === "string" ? [...value].length : 0;
	if (typeof value !== "string" || length < 1 || length > 32 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new Error("Pane label requires 1 to 32 printable Unicode characters.");
	return value;
}
export function parsePaneRequest(input: string): PaneRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<PaneRequest>;
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["version", "origin", "argv", "cwd", "placement", "label"].includes(key)) || value.version !== 1 || !("origin" in value)) throw new Error("Invalid pane request.");
	if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 64 || !value.argv.every((arg) => validText(arg, 4096)) || !isAbsolute(value.argv[0])) throw new Error("Pane argv requires an absolute program and bounded, NUL-free arguments.");
	if (!validText(value.cwd, 4096) || !isAbsolute(value.cwd)) throw new Error("Pane cwd must be an absolute path.");
	const placement = value.placement === undefined ? undefined : parsePlacement(value.placement);
	const label = value.label === undefined ? undefined : parseLabel(value.label);
	const origin = value.origin === null ? null : parseOrigin(JSON.stringify(value.origin));
	return { version: 1, origin, argv: value.argv, cwd: value.cwd, ...(placement ? { placement } : {}), ...(label !== undefined ? { label } : {}) };
}

// Identity validation and the single mutation share one Rex connection. A block anchor never
// means global focus, and placement is checked again without a second creation attempt.
const identityScript = `
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
`;
const splitScript = `${identityScript}
local before = rex.call("session.view", {session_id=a.sessionId})
local window = placement(before, a.blockId)
if not window then return {outcome="stale", detail="The invoking terminal block is gone or detached."} end
local created = rex.call("session.new_split", {session_id=a.sessionId, anchor_id=a.blockId, direction=a.direction, side="after", ratio=a.ratio, focus=false,
  layout={block={flavor="com.superlogical.terminal.shell", label=a.label, options={shell="none", command=a.argv, cwd=a.cwd, exit={on_completion=true}}}}})
if not created or created.anchor_id ~= a.blockId or type(created.block_ids) ~= "table" or #created.block_ids ~= 1 or type(created.block_ids[1]) ~= "string" then
  return {outcome="uncertain", detail="Rex did not confirm split creation. Do not retry automatically."}
end
local receipt = {server=a.server, hostId=a.hostId, instanceId=a.instanceId, sessionId=a.sessionId, windowId=window, anchorId=a.blockId, blockId=created.block_ids[1], direction=a.direction}
local after = rex.call("session.view", {session_id=a.sessionId})
local anchorWindow = placement(after, a.blockId)
local paneWindow = placement(after, receipt.blockId)
if not anchorWindow or anchorWindow ~= paneWindow then return {outcome="uncertain", receipt=receipt, detail="Rex created a block but same-tab placement is unconfirmed. Do not retry automatically."} end
receipt.windowId = paneWindow
return {outcome="created", receipt=receipt, detail="Rex created a split beside the invoking terminal. Visibility and program acceptance are not verified."}
`;
const resizeScript = `${identityScript}
local view = rex.call("session.view", {session_id=a.sessionId})
if placement(view, a.anchorId) ~= a.windowId or placement(view, a.blockId) ~= a.windowId then
  return {outcome="stale", detail="The terminal blocks are no longer in the receipt window."}
end
-- The server selects the innermost split in the requested direction with this ordered pair.
local resized = rex.call("session.resize_pane", {session_id=a.sessionId, before_block_id=a.anchorId, after_block_id=a.blockId, direction=a.direction, ratio=a.ratio})
if not resized or type(resized.revision) ~= "number" then
  return {outcome="uncertain", detail="Rex did not confirm the resize. Do not retry automatically."}
end
return {outcome="resized", detail="Rex confirmed the split resize."}
`;
// Focus never switches the session's tab: an anchor in a window that the session does not show stays unfocused.
const focusScript = `${identityScript}
local view = rex.call("session.view", {session_id=a.sessionId})
if placement(view, a.anchorId) ~= a.windowId or placement(view, a.blockId) ~= a.windowId then
  return {outcome="stale", detail="The terminal blocks are no longer in the receipt window."}
end
if view.active_window_id ~= a.windowId then
  return {outcome="unavailable", detail="The session does not show the receipt window."}
end
for _, w in ipairs(view.windows or {}) do
  if w.window_id == a.windowId and w.focused_block_id == a.anchorId then
    return {outcome="focused", detail="The anchor terminal already has focus."}
  end
end
local focused = rex.call("session.focus_block", {session_id=a.sessionId, block_id=a.anchorId})
if not focused or type(focused.revision) ~= "number" then
  return {outcome="uncertain", detail="Rex did not confirm the focus. Do not retry automatically."}
end
return {outcome="focused", detail="Rex focused the anchor terminal."}
`;
const runChild: Runner = (executable, args, options) => new Promise((done) => {
	execFile(executable, [...args], { ...options, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout, stderr) => {
		if (!error) return done({ code: 0, stdout, stderr });
		done({ code: typeof error.code === "number" ? error.code : null, stdout, stderr, failure: error.code === "ENOENT" ? "missing" : error.killed ? "timeout" : "failed" });
	});
});
const result = (outcome: PaneResult["outcome"], detail: string): PaneResult => ({ version: 1, outcome, detail });
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const receiptFields = ["server", "hostId", "instanceId", "sessionId", "windowId", "anchorId", "blockId", "direction"];
function readReceipt(value: unknown): PaneReceipt | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !receiptFields.includes(key))) return;
	const r = value as PaneReceipt;
	const id = (value: unknown, prefix = "") => typeof value === "string" && new RegExp(`^${prefix}${uuid}$`).test(value);
	if (!validText(r.server, 4096) || !r.server.length || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(r.server) || !id(r.hostId) || !id(r.instanceId) || !id(r.sessionId, "session:") || !id(r.windowId, "window:") || !id(r.anchorId, "block:") || !id(r.blockId, "block:") || r.anchorId === r.blockId || (r.direction !== "horizontal" && r.direction !== "vertical")) return;
	return r;
}
export function parseResizeRequest(input: string): PaneResizeRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<PaneResizeRequest>;
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["version", "receipt", "share"].includes(key)) || value.version !== 1 || typeof value.share !== "number" || !Number.isFinite(value.share) || value.share < 0.1 || value.share > 0.9) throw new Error("Invalid pane resize request.");
	const receipt = readReceipt(value.receipt);
	if (!receipt) throw new Error("Pane resize requires an exact split receipt.");
	return { version: 1, receipt, share: value.share };
}
export function parseFocusRequest(input: string): PaneFocusRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<PaneFocusRequest>;
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "version" && key !== "receipt") || value.version !== 1) throw new Error("Invalid pane focus request.");
	const receipt = readReceipt(value.receipt);
	if (!receipt) throw new Error("Pane focus requires an exact split receipt.");
	return { version: 1, receipt };
}
function matchesOrigin(env: Readonly<NodeJS.ProcessEnv>, server: string, session: string, block: string): boolean {
	return env.REX_SERVER === server && env.REX_SESSION === session && env.REX_BLOCK === block;
}
function runRex(run: Runner, server: string, sessionId: string, script: string, args: object): Promise<RunResult> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("REX_")) delete env[key];
	return run(trustedRexExecutable(), ["--autostart=false", "--color=never", "--timeout=3s", `--server=${server}`, "do", "--session", sessionId, "-e", script, "--args", JSON.stringify(args), "--json"], { timeout: 5000, maxBuffer: 32768, env });
}
export async function splitPane(request: PaneRequest, env: Readonly<NodeJS.ProcessEnv> = process.env, run: Runner = runChild): Promise<PaneResult> {
	request = parsePaneRequest(JSON.stringify(request));
	const exact = request.origin?.exact;
	if (!exact) return result("unavailable", "No verified invoking terminal is available. No pane was created.");
	if (!matchesOrigin(env, exact.server, exact.sessionId, exact.blockId)) return result("stale", "The inherited terminal differs from the captured origin. No pane was created.");
	// The program learns which content of the window lies over its pane from Rex's layout, as panes that rex_terminal creates do.
	const argv = withPaneStacking(request.argv, paneStackingCommand(exact.server, env));
	const placement = request.placement ?? DEFAULT_PLACEMENT;
	const direction = placement.side === "below" ? "vertical" : "horizontal";
	const ratio = 1 - placement.share;
	const label = request.label ?? DEFAULT_LABEL;
	let child: RunResult;
	try {
		child = await runRex(run, exact.server, exact.sessionId, splitScript, { ...exact, argv, cwd: request.cwd, direction, ratio, label });
	} catch { return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically."); }
	if (child.failure === "missing") return result("unavailable", "The trusted Rex program is missing. No pane was created.");
	if (child.failure || child.code !== 0 || Buffer.byteLength(child.stdout) > 32768) return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically.");
	return readResult(child.stdout, exact, direction);
}
function readResult(stdout: string, exact: NonNullable<TerminalOrigin["exact"]>, direction: Direction): PaneResult {
	try {
		const value = JSON.parse(stdout) as PaneResult;
		if (!["created", "stale", "unavailable", "uncertain"].includes(value.outcome) || !validText(value.detail, 256) || !value.detail.length || /[\p{Cc}\p{Cf}]/u.test(value.detail)) throw new Error("Invalid result.");
		const r = readReceipt(value.receipt);
		const receipt = r?.server === exact.server && r.hostId === exact.hostId && r.instanceId === exact.instanceId && r.sessionId === exact.sessionId && r.anchorId === exact.blockId && r.direction === direction ? r : undefined;
		if (value.outcome === "created" && !receipt) throw new Error("Missing receipt.");
		return { version: 1, outcome: value.outcome, detail: value.detail, ...(receipt ? { receipt } : {}) };
	} catch { return result("uncertain", "Rex returned an invalid creation result. Do not retry automatically."); }
}
export async function resizePane(request: PaneResizeRequest, env: Readonly<NodeJS.ProcessEnv> = process.env, run: Runner = runChild): Promise<PaneResizeResult> {
	const { receipt, share } = parseResizeRequest(JSON.stringify(request));
	const response = (outcome: PaneResizeResult["outcome"], detail: string): PaneResizeResult => ({ version: 1, outcome, detail });
	if (!matchesOrigin(env, receipt.server, receipt.sessionId, receipt.anchorId)) return response("stale", "The inherited terminal differs from the receipt anchor.");
	try {
		const child = await runRex(run, receipt.server, receipt.sessionId, resizeScript, { ...receipt, ratio: 1 - share });
		if (child.failure === "missing") return response("unavailable", "The trusted Rex program is missing.");
		if (!child.failure && child.code === 0 && Buffer.byteLength(child.stdout) <= 32768) {
			const { outcome, detail } = JSON.parse(child.stdout) as PaneResizeResult;
			if (["resized", "stale", "unavailable", "uncertain"].includes(outcome) && validText(detail, 256) && detail.length && !/[\p{Cc}\p{Cf}]/u.test(detail)) return response(outcome, detail);
		}
	} catch { /* An unconfirmed mutation is not safe to repeat. */ }
	return response("uncertain", "Rex resize is unconfirmed. Do not retry automatically.");
}
export async function focusPane(request: PaneFocusRequest, env: Readonly<NodeJS.ProcessEnv> = process.env, run: Runner = runChild): Promise<PaneFocusResult> {
	const { receipt } = parseFocusRequest(JSON.stringify(request));
	const response = (outcome: PaneFocusResult["outcome"], detail: string): PaneFocusResult => ({ version: 1, outcome, detail });
	if (!matchesOrigin(env, receipt.server, receipt.sessionId, receipt.anchorId)) return response("stale", "The inherited terminal differs from the receipt anchor.");
	try {
		const child = await runRex(run, receipt.server, receipt.sessionId, focusScript, receipt);
		if (child.failure === "missing") return response("unavailable", "The trusted Rex program is missing.");
		if (!child.failure && child.code === 0 && Buffer.byteLength(child.stdout) <= 32768) {
			const { outcome, detail } = JSON.parse(child.stdout) as PaneFocusResult;
			if (["focused", "stale", "unavailable", "uncertain"].includes(outcome) && validText(detail, 256) && detail.length && !/[\p{Cc}\p{Cf}]/u.test(detail)) return response(outcome, detail);
		}
	} catch { /* An unconfirmed focus change is not safe to repeat. */ }
	return response("uncertain", "Rex focus is unconfirmed. Do not retry automatically.");
}
const operations = {
	split: (input: string) => splitPane(parsePaneRequest(input)),
	resize: (input: string) => resizePane(parseResizeRequest(input)),
	focus: (input: string) => focusPane(parseFocusRequest(input)),
};
async function main(): Promise<void> {
	const operation = process.argv[2];
	if (process.argv.length !== 3 || (operation !== "split" && operation !== "resize" && operation !== "focus")) throw new Error("Use terminal-pane.ts split, resize or focus with one JSON request on stdin.");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
		chunks.push(Buffer.from(chunk));
	}
	const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	process.stdout.write(`${JSON.stringify(await operations[operation](input))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => { process.stderr.write(`${String(error instanceof Error ? error.message : error).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 256)}\n`); process.exitCode = 1; });
}
