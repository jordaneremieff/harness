import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paneStackingCommand, withPaneStacking } from "./pane-stacking.ts";
import {
	parseOrigin,
	trustedRexExecutable,
	type Runner,
	type RunResult,
	type TerminalOrigin,
} from "./terminal-origin.ts";

export type PanePlacement = { side: "left" | "right"; share: number };
export interface PaneRequest {
	version: 1;
	origin: TerminalOrigin | null;
	argv: string[];
	cwd: string;
	placement?: PanePlacement;
	label?: string;
}
/** The split that `split` created, named by the server identity and its exact anchor and new blocks. */
export interface PaneReceipt {
	server: string;
	hostId: string;
	instanceId: string;
	anchorId: string;
	blockId: string;
}
export interface PaneResult {
	version: 1;
	outcome: "created" | "stale" | "unavailable" | "uncertain";
	detail: string;
	receipt?: PaneReceipt;
}
/** A rectangle as [x, y, width, height] fractions of the anchor's tab. */
export type FloatBounds = [number, number, number, number];
/** With `square`, the adapter replaces the height with the one that makes the pane square on screen. */
export interface FloatRequest {
	version: 1;
	origin: TerminalOrigin | null;
	argv: string[];
	cwd: string;
	bounds: FloatBounds;
	square?: true;
	label?: string;
}
/** The floating pane that `float` created over the tab that held the anchor. */
export interface FloatReceipt {
	server: string;
	hostId: string;
	instanceId: string;
	anchorId: string;
	blockId: string;
	layerId: string;
}
export interface FloatResult {
	version: 1;
	outcome: "created" | "stale" | "unavailable" | "uncertain";
	detail: string;
	receipt?: FloatReceipt;
}
const LIMIT = 16384;
const FLOAT_ARGUMENT_BYTES = 8192;
const FLOAT_MIN_SIZE = 0.1;
const DEFAULT_PLACEMENT: PanePlacement = { side: "right", share: 0.5 };
const DEFAULT_LABEL = "Reader";
const validText = (value: unknown, max: number): value is string =>
	typeof value === "string" && Buffer.byteLength(value) <= max && !value.includes("\0");
function parsePlacement(value: unknown): PanePlacement {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Pane placement must be one object.");
	const placement = value as Record<string, unknown>;
	if (
		Object.keys(placement).some((key) => !["side", "share"].includes(key)) ||
		(placement.side !== "left" && placement.side !== "right") ||
		typeof placement.share !== "number" ||
		!Number.isFinite(placement.share) ||
		placement.share < 0.15 ||
		placement.share > 0.85
	)
		throw new Error("Pane placement requires side left or right and a share from 0.15 to 0.85.");
	return { side: placement.side, share: placement.share };
}
// Printable means one to 32 Unicode code points without control, format or surrogate characters.
function parseLabel(value: unknown): string {
	const length = typeof value === "string" ? [...value].length : 0;
	if (typeof value !== "string" || length < 1 || length > 32 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))
		throw new Error("Pane label requires 1 to 32 printable Unicode characters.");
	return value;
}
function parseArgv(value: unknown, maxBytes: number): string[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 64 ||
		!value.every((arg) => validText(arg, maxBytes)) ||
		!isAbsolute(value[0])
	)
		throw new Error("Pane argv requires an absolute program and bounded, NUL-free arguments.");
	return value;
}
export function parsePaneRequest(input: string): PaneRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<PaneRequest>;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !["version", "origin", "argv", "cwd", "placement", "label"].includes(key)) ||
		value.version !== 1 ||
		!("origin" in value)
	)
		throw new Error("Invalid pane request.");
	value.argv = parseArgv(value.argv, 4096);
	if (!validText(value.cwd, 4096) || !isAbsolute(value.cwd)) throw new Error("Pane cwd must be an absolute path.");
	const placement = value.placement === undefined ? undefined : parsePlacement(value.placement);
	const label = value.label === undefined ? undefined : parseLabel(value.label);
	const origin = value.origin === null ? null : parseOrigin(JSON.stringify(value.origin));
	return {
		version: 1,
		origin,
		argv: value.argv,
		cwd: value.cwd,
		...(placement ? { placement } : {}),
		...(label !== undefined ? { label } : {}),
	};
}

function parseBounds(value: unknown): FloatBounds {
	if (
		!Array.isArray(value) ||
		value.length !== 4 ||
		!value.every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1)
	)
		throw new Error("Float bounds require [x, y, width, height] as fractions of the tab.");
	const [x, y, width, height] = value as FloatBounds;
	if (width < FLOAT_MIN_SIZE || height < FLOAT_MIN_SIZE || x + width > 1 || y + height > 1)
		throw new Error("Float bounds need a width and height of at least 0.1 inside the tab.");
	return [x, y, width, height];
}
export function parseFloatRequest(input: string): FloatRequest {
	if (Buffer.byteLength(input) > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
	const value = JSON.parse(input) as Partial<FloatRequest>;
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(
			(key) => !["version", "origin", "argv", "cwd", "bounds", "square", "label"].includes(key),
		) ||
		value.version !== 1 ||
		!("origin" in value) ||
		(value.square !== undefined && value.square !== true)
	)
		throw new Error("Invalid float request.");
	const argv = parseArgv(value.argv, FLOAT_ARGUMENT_BYTES);
	if (!validText(value.cwd, 4096) || !isAbsolute(value.cwd)) throw new Error("Pane cwd must be an absolute path.");
	const bounds = parseBounds(value.bounds);
	const label = value.label === undefined ? undefined : parseLabel(value.label);
	const origin = value.origin === null ? null : parseOrigin(JSON.stringify(value.origin));
	return {
		version: 1,
		origin,
		argv,
		cwd: value.cwd,
		bounds,
		...(value.square ? { square: true as const } : {}),
		...(label !== undefined ? { label } : {}),
	};
}

// Identity validation and the single mutation share one Rex connection. A block anchor never
// means global focus, and placement is checked again without a second creation attempt. A block
// keeps its ID when its tab moves to another session, so each request runs with --block for the
// anchor, and Rex attaches the request to the session that holds the anchor at that time.
const identityScript = `
local a = rex.args
local s = rex.call("server.status")
if not s then return {outcome="unavailable", detail="Rex server identity is unavailable."} end
if s.host_id ~= a.hostId or s.instance_id ~= a.instanceId then return {outcome="stale", detail="Rex server identity changed."} end
local session = rex.session_id
if type(session) ~= "string" then return {outcome="unavailable", detail="Rex session of the anchor is unavailable."} end
local function placement(v, id)
  if not v then return nil end
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
local before = rex.call("session.view", {session_id=session})
if not placement(before, a.blockId) then return {outcome="stale", detail="The invoking terminal block is gone or detached."} end
local created = rex.call("session.new_split", {session_id=session, anchor_id=a.blockId, direction="horizontal", side=a.side, ratio=a.ratio, focus=false,
  layout={block={flavor="com.superlogical.terminal.shell", label=a.label, options={shell="none", command=a.argv, cwd=a.cwd, exit={on_completion=true}}}}})
if not created or created.anchor_id ~= a.blockId or type(created.block_ids) ~= "table" or #created.block_ids ~= 1 or type(created.block_ids[1]) ~= "string" then
  return {outcome="uncertain", detail="Rex did not confirm split creation. Do not retry automatically."}
end
local receipt = {server=a.server, hostId=a.hostId, instanceId=a.instanceId, anchorId=a.blockId, blockId=created.block_ids[1]}
local after = rex.call("session.view", {session_id=session})
local anchorWindow = placement(after, a.blockId)
local paneWindow = placement(after, receipt.blockId)
if not anchorWindow or anchorWindow ~= paneWindow then return {outcome="uncertain", receipt=receipt, detail="Rex created a block but same-tab placement is unconfirmed. Do not retry automatically."} end
-- A zoom can outlast a split made without focus and hide the split behind the zoomed block. Ending the zoom of the
-- focused block by window keeps focus and the active tab. A zoom of the tiled layer stays on behind a focused
-- floating layer, and only a change of focus ends it.
local function zooms(v)
  for _, w in ipairs(v and v.windows or {}) do
    if w.window_id == paneWindow then return w.zoomed_block_id, w.tiled_zoomed_block_id end
  end
end
local detail = "Rex created a split beside the invoking terminal."
if zooms(after) then
  if rex.call("session.zoom_block", {session_id=session, window_id=paneWindow, zoom=false}) then
    detail = detail .. " The tab's zoom ended so the split shows; focus is unchanged."
  end
  after = rex.call("session.view", {session_id=session})
end
local zoomed, tiledZoomed = zooms(after)
if zoomed or tiledZoomed then detail = detail .. " A zoomed pane still hides the split." end
return {outcome="created", receipt=receipt, detail=detail .. " Visibility and program acceptance are not verified."}
`;
// The floating layer joins the window that holds the anchor now. Its program runs through the account's login
// shell with the interactive startup files, so it finds the commands and environment of the operator's terminals.
const floatScript = `${identityScript}
local before = rex.call("session.view", {session_id=session})
local window = placement(before, a.blockId)
if not window then return {outcome="stale", detail="The invoking terminal block is gone or detached."} end
-- A square pane takes its height from the tab's shape on screen: the anchor terminal's pixel size over its share of the tab.
local function rectOf(node, id)
  if not node then return nil end
  if node.block_id == id then return node.rect end
  if node.split then return rectOf(node.split.before, id) or rectOf(node.split.after, id) end
end
local function squareHeight()
  local rect
  for _, w in ipairs(before.windows or {}) do
    if w.window_id == window then
      for _, l in ipairs(w.layers or {}) do rect = rect or rectOf(l.layout, a.blockId) end
    end
  end
  local size = rex.call("block.method", {session_id=session, block_id=a.blockId, method="size"})
  if not rect or not size or not (rect[3] > 0 and rect[4] > 0) then return nil end
  local width = (size.columns or 0) * (size.cell_width_px or 0) / rect[3]
  local height = (size.rows or 0) * (size.cell_height_px or 0) / rect[4]
  if not (width > 0 and height > 0) then return nil end
  return math.max(0.1, math.min(a.bounds[3] * width / height, 1 - a.bounds[2]))
end
local bounds = a.bounds
if a.square then
  local height = squareHeight()
  if height then bounds = {a.bounds[1], a.bounds[2], a.bounds[3], height} end
end
local created = rex.call("session.new_layer", {session_id=session, window_id=window, bounds=bounds, focus=false,
  layout={block={flavor="com.superlogical.terminal.shell", label=a.label, options={command=a.argv, cwd=a.cwd, interactive=true, exit={on_completion=true}}}}})
if not created or type(created.layer_id) ~= "string" or type(created.block_ids) ~= "table" or #created.block_ids ~= 1 or type(created.block_ids[1]) ~= "string" then
  return {outcome="uncertain", detail="Rex did not confirm floating pane creation. Do not retry automatically."}
end
local receipt = {server=a.server, hostId=a.hostId, instanceId=a.instanceId, anchorId=a.blockId, blockId=created.block_ids[1], layerId=created.layer_id}
local after = rex.call("session.view", {session_id=session})
if placement(after, receipt.blockId) ~= window then return {outcome="uncertain", receipt=receipt, detail="Rex created a floating pane but its tab is unconfirmed. Do not retry automatically."} end
return {outcome="created", receipt=receipt, detail="Rex created a floating pane over the invoking terminal's tab. Visibility and program acceptance are not verified."}
`;
const runChild: Runner = (executable, args, options) =>
	new Promise((done) => {
		execFile(
			executable,
			[...args],
			{ ...options, encoding: "utf8", killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				if (!error) return done({ code: 0, stdout, stderr });
				done({
					code: typeof error.code === "number" ? error.code : null,
					stdout,
					stderr,
					failure: error.code === "ENOENT" ? "missing" : error.killed ? "timeout" : "failed",
				});
			},
		);
	});
const result = (
	outcome: PaneResult["outcome"],
	detail: string,
): { version: 1; outcome: PaneResult["outcome"]; detail: string } => ({
	version: 1,
	outcome,
	detail,
});
const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const receiptFields = ["server", "hostId", "instanceId", "anchorId", "blockId"];
function readReceipt(value: unknown): PaneReceipt | undefined {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !receiptFields.includes(key))
	)
		return;
	const r = value as PaneReceipt;
	const id = (value: unknown, prefix = "") => typeof value === "string" && new RegExp(`^${prefix}${uuid}$`).test(value);
	if (
		!validText(r.server, 4096) ||
		!r.server.length ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(r.server) ||
		!id(r.hostId) ||
		!id(r.instanceId) ||
		!id(r.anchorId, "block:") ||
		!id(r.blockId, "block:") ||
		r.anchorId === r.blockId
	)
		return;
	return r;
}
/** The inherited pane is the captured one: the same server route and block, wherever its tab is now. */
function matchesOrigin(env: Readonly<NodeJS.ProcessEnv>, server: string, block: string): boolean {
	return env.REX_SERVER === server && env.REX_BLOCK === block;
}
/** Rex refused to attach the request because no session holds the anchor block any more. */
function blockGone(result: RunResult, block: string): boolean {
	return (
		result.code === 3 &&
		result.failure !== "timeout" &&
		result.stderr.trim() === `Error: block target "${block}" not found`
	);
}
function runRex(run: Runner, server: string, anchor: string, script: string, args: object): Promise<RunResult> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("REX_")) delete env[key];
	return run(
		trustedRexExecutable(),
		[
			"--autostart=false",
			"--color=never",
			"--timeout=3s",
			`--server=${server}`,
			"do",
			"--block",
			anchor,
			"-e",
			script,
			"--args",
			JSON.stringify(args),
			"--json",
		],
		{ timeout: 5000, maxBuffer: 32768, env },
	);
}
export async function splitPane(
	request: PaneRequest,
	env: Readonly<NodeJS.ProcessEnv> = process.env,
	run: Runner = runChild,
): Promise<PaneResult> {
	request = parsePaneRequest(JSON.stringify(request));
	const exact = request.origin?.exact;
	if (!exact) return result("unavailable", "No verified invoking terminal is available. No pane was created.");
	if (!matchesOrigin(env, exact.server, exact.blockId))
		return result("stale", "The inherited terminal differs from the captured origin. No pane was created.");
	// The program learns which content of the window lies over its pane from Rex's layout, as panes that rex_terminal creates do.
	const argv = withPaneStacking(request.argv, paneStackingCommand(exact.server, env));
	const placement = request.placement ?? DEFAULT_PLACEMENT;
	const before = placement.side === "left";
	const ratio = before ? placement.share : 1 - placement.share;
	const label = request.label ?? DEFAULT_LABEL;
	let child: RunResult;
	try {
		child = await runRex(run, exact.server, exact.blockId, splitScript, {
			...exact,
			argv,
			cwd: request.cwd,
			side: before ? "before" : "after",
			ratio,
			label,
		});
	} catch {
		return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically.");
	}
	if (child.failure === "missing")
		return result("unavailable", "The trusted Rex program is missing. No pane was created.");
	if (blockGone(child, exact.blockId))
		return result("stale", "The invoking terminal block no longer exists. No pane was created.");
	if (child.failure || child.code !== 0 || Buffer.byteLength(child.stdout) > 32768)
		return result("uncertain", "Rex split creation is unconfirmed. Do not retry automatically.");
	return readResult(child.stdout, exact);
}
export async function floatPane(
	request: FloatRequest,
	env: Readonly<NodeJS.ProcessEnv> = process.env,
	run: Runner = runChild,
): Promise<FloatResult> {
	request = parseFloatRequest(JSON.stringify(request));
	const exact = request.origin?.exact;
	if (!exact) return result("unavailable", "No verified invoking terminal is available. No pane was created.");
	if (!matchesOrigin(env, exact.server, exact.blockId))
		return result("stale", "The inherited terminal differs from the captured origin. No pane was created.");
	let child: RunResult;
	try {
		child = await runRex(run, exact.server, exact.blockId, floatScript, {
			...exact,
			argv: request.argv,
			cwd: request.cwd,
			bounds: request.bounds,
			square: request.square === true,
			label: request.label ?? DEFAULT_LABEL,
		});
	} catch {
		return result("uncertain", "Rex floating pane creation is unconfirmed. Do not retry automatically.");
	}
	if (child.failure === "missing")
		return result("unavailable", "The trusted Rex program is missing. No pane was created.");
	if (blockGone(child, exact.blockId))
		return result("stale", "The invoking terminal block no longer exists. No pane was created.");
	if (child.failure || child.code !== 0 || Buffer.byteLength(child.stdout) > 32768)
		return result("uncertain", "Rex floating pane creation is unconfirmed. Do not retry automatically.");
	return readFloatResult(child.stdout, exact);
}
const floatReceiptFields = ["server", "hostId", "instanceId", "anchorId", "blockId", "layerId"];
function readFloatResult(stdout: string, exact: NonNullable<TerminalOrigin["exact"]>): FloatResult {
	try {
		const value = JSON.parse(stdout) as FloatResult;
		if (
			!["created", "stale", "unavailable", "uncertain"].includes(value.outcome) ||
			!validText(value.detail, 256) ||
			!value.detail.length ||
			/[\p{Cc}\p{Cf}]/u.test(value.detail)
		)
			throw new Error("Invalid result.");
		const r = value.receipt as Partial<FloatReceipt> | undefined;
		const receipt =
			r &&
			typeof r === "object" &&
			!Object.keys(r).some((key) => !floatReceiptFields.includes(key)) &&
			r.server === exact.server &&
			r.hostId === exact.hostId &&
			r.instanceId === exact.instanceId &&
			r.anchorId === exact.blockId &&
			typeof r.blockId === "string" &&
			new RegExp(`^block:${uuid}$`).test(r.blockId) &&
			r.blockId !== exact.blockId &&
			typeof r.layerId === "string" &&
			new RegExp(`^layer:${uuid}$`).test(r.layerId)
				? (r as FloatReceipt)
				: undefined;
		if (value.outcome === "created" && !receipt) throw new Error("Missing receipt.");
		return { version: 1, outcome: value.outcome, detail: value.detail, ...(receipt ? { receipt } : {}) };
	} catch {
		return result("uncertain", "Rex returned an invalid creation result. Do not retry automatically.");
	}
}
function readResult(stdout: string, exact: NonNullable<TerminalOrigin["exact"]>): PaneResult {
	try {
		const value = JSON.parse(stdout) as PaneResult;
		if (
			!["created", "stale", "unavailable", "uncertain"].includes(value.outcome) ||
			!validText(value.detail, 256) ||
			!value.detail.length ||
			/[\p{Cc}\p{Cf}]/u.test(value.detail)
		)
			throw new Error("Invalid result.");
		const r = readReceipt(value.receipt);
		const receipt =
			r?.server === exact.server &&
			r.hostId === exact.hostId &&
			r.instanceId === exact.instanceId &&
			r.anchorId === exact.blockId
				? r
				: undefined;
		if (value.outcome === "created" && !receipt) throw new Error("Missing receipt.");
		return { version: 1, outcome: value.outcome, detail: value.detail, ...(receipt ? { receipt } : {}) };
	} catch {
		return result("uncertain", "Rex returned an invalid creation result. Do not retry automatically.");
	}
}
const operations = {
	split: (input: string) => splitPane(parsePaneRequest(input)),
	float: (input: string) => floatPane(parseFloatRequest(input)),
};
async function main(): Promise<void> {
	const operation = process.argv[2];
	if (process.argv.length !== 3 || !Object.hasOwn(operations, operation ?? ""))
		throw new Error("Use terminal-pane.ts split or float with one JSON request on stdin.");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > LIMIT) throw new Error("Pane request exceeds 16384 bytes.");
		chunks.push(Buffer.from(chunk));
	}
	const input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	process.stdout.write(`${JSON.stringify(await operations[operation as keyof typeof operations](input))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void main().catch((error) => {
		process.stderr.write(
			`${String(error instanceof Error ? error.message : error)
				.replace(/[\p{Cc}\p{Cf}]/gu, " ")
				.slice(0, 256)}\n`,
		);
		process.exitCode = 1;
	});
}
