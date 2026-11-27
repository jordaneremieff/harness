/**
 * The version of the configuration block. Setup keeps the exact block of this version, replaces a block of an earlier
 * version after the operator confirms, and refuses any other text between the markers.
 */
export const BLOCK_VERSION = 9;
const BEGIN = /^-- pi-harness: pi actions v(\d+) begin\r?$/gm;
const END = /^-- pi-harness: pi actions end\r?$/gm;
const MARKER = /^-- pi-harness: .*$/gm;

/**
 * The Lua that runs palette commands (docs/conventions/palette-commands.md): it reads the registry that Pi records
 * when each command runs, runs each step's program with `rex.exec`, asks with `rex.ui`, and opens the pane that a
 * command shows. `pi_harness` stays local to the configuration file.
 */
const RUNTIME = `
function pi_harness.valid_entry(entry)
  if type(entry) ~= "table" or type(entry.id) ~= "string" or type(entry.title) ~= "string" then return false end
  if type(entry.argv) ~= "table" or #entry.argv == 0 then return false end
  for index, word in pairs(entry.argv) do
    if type(index) ~= "number" or index > #entry.argv or type(word) ~= "string" then return false end
  end
  return true
end

function pi_harness.read_registry()
  local file = io.open(pi_harness.registry, "r")
  if file == nil then
    return nil, "Pi has not recorded its commands yet. Start Pi in a Rex pane, then try again."
  end
  local text = file:read("*a")
  file:close()
  local ok, value = pcall(rex.json.decode, text)
  if not ok or type(value) ~= "table" or value.version ~= 1 or type(value.commands) ~= "table" then
    return nil, "Pi's command list cannot be read. Start Pi in a Rex pane, then try again."
  end
  local commands = {}
  for _, entry in ipairs(value.commands) do
    if pi_harness.valid_entry(entry) then commands[#commands + 1] = entry end
  end
  value.commands = commands
  return value
end

function pi_harness.one_line(text)
  return (text:gsub("[%c%s]+", " "):gsub("^ +", ""):gsub(" +$", ""))
end

function pi_harness.feedback(title, text)
  rex.ui.pick{ title = title, items = { { id = "ok", title = "OK", subtitle = pi_harness.one_line(text) } } }
end

function pi_harness.say(text)
  pi_harness.feedback("Pi command notice", text)
end

function pi_harness.problem(text)
  pi_harness.feedback("Pi command failed", text)
end

function pi_harness.require_ui()
  if rex.ui == nil then error("Pi commands need Rex 0.1.0-preview.21 or later.", 0) end
end

function pi_harness.open(ctx, registry, show)
  if type(show.argv) ~= "table" or #show.argv == 0 or type(show.label) ~= "string" then
    return pi_harness.problem("The command asked for a pane without a program.")
  end
  if ctx.block_id == nil then
    return pi_harness.problem("Run this command from a pane, so Pi knows where to open it.")
  end
  local command = {}
  if type(registry.paneStacking) == "table" then
    command = { "/usr/bin/env", "PI_PANE_STACKING=" .. rex.json.encode(registry.paneStacking) }
  end
  for _, word in ipairs(show.argv) do command[#command + 1] = word end
  local options = { command = command, exit = { on_completion = true, quick_exit_threshold_ms = 4294967295 } }
  if type(show.cwd) == "string" then options.cwd = show.cwd end
  local layout = rex.layout.block{ flavor = "com.superlogical.terminal.shell", label = show.label, options = options }
  local placed, err
  if show.placement == "float" then
    local described = rex.call("session.describe_block", { session_id = ctx.session_id, block_id = ctx.block_id })
    local window = described and described.block and described.block.window_id
    if window == nil then return pi_harness.problem("Pi could not find the window of this pane.") end
    placed, err = rex.session.new_layer{ window_id = window, bounds = { 0.1, 0.06, 0.8, 0.88 }, layout = layout, focus = false }
  else
    local direction = "horizontal"
    if show.placement == "below" then direction = "vertical" end
    placed, err = rex.session.new_split{ anchor_id = ctx.block_id, direction = direction, side = "after", ratio = 0.5, layout = layout, focus = false }
    if placed ~= nil then pi_harness.reveal(ctx) end
  end
  if placed == nil then pi_harness.problem("Pi could not open the pane: " .. tostring(err)) end
end

-- A zoom can outlast a split made without focus and hide the new pane behind the zoomed block. Ending the zoom of the
-- focused block by window keeps focus and the active tab.
function pi_harness.reveal(ctx)
  local described = rex.call("session.describe_block", { session_id = ctx.session_id, block_id = ctx.block_id })
  local window = described and described.block and described.block.window_id
  if window == nil then return end
  local view = rex.call("session.view", { session_id = ctx.session_id })
  for _, w in ipairs(view and view.windows or {}) do
    if w.window_id == window and w.zoomed_block_id ~= nil then
      rex.call("session.zoom_block", { session_id = ctx.session_id, window_id = window, zoom = false })
    end
  end
end

function pi_harness.request(entry, ctx, answers)
  local parts = {}
  for index, answer in ipairs(answers) do parts[index] = rex.json.encode(answer) end
  local context = { session = ctx.session_id, block = ctx.block_id, client = ctx.client_id, origin = ctx.origin }
  return '{"version":1,"command":' .. rex.json.encode(entry.id) .. ',"context":' .. rex.json.encode(context)
    .. ',"answers":[' .. table.concat(parts, ",") .. ']}'
end

function pi_harness.step(entry, ctx, answers)
  local argv = {}
  for _, word in ipairs(entry.argv) do argv[#argv + 1] = word end
  argv[#argv + 1] = pi_harness.request(entry, ctx, answers)
  local result, err = rex.exec(argv, { timeout = 20 })
  if result == nil then
    return nil, entry.title .. " could not start" .. (#answers == 0 and ": " .. tostring(err) or ".")
  end
  local stdout = result.stdout or ""
  if #stdout > 1048576 then return nil, entry.title .. " printed a reply larger than Pi allows." end
  local ok, reply = pcall(rex.json.decode, stdout)
  if result.ok and ok and pi_harness.valid_reply(reply) then return reply end
  -- A process diagnostic can contain the request argument, including answers.
  local why = #answers == 0 and (tostring(result.stderr or ""):gsub("%s+$", "")) or ""
  if why == "" then why = "it printed no valid reply" end
  return nil, entry.title .. " failed: " .. why:sub(-300)
end

-- A reply holds exactly one of error, ask, show or done, in the shape the contract gives it.
function pi_harness.valid_reply(reply)
  if type(reply) ~= "table" then return false end
  local count = 0
  for _, key in ipairs({ "error", "ask", "show", "done" }) do
    if reply[key] ~= nil then count = count + 1 end
  end
  if count ~= 1 then return false end
  if reply.error ~= nil then return type(reply.error) == "string" end
  if reply.ask ~= nil then
    return type(reply.ask) == "table" and (reply.ask.kind == "pick" or reply.ask.kind == "input") and type(reply.ask.prompt) == "table"
  end
  if reply.show ~= nil then return type(reply.show) == "table" end
  return type(reply.done) == "table"
end

function pi_harness.run_id(ctx, id)
  pi_harness.require_ui()
  local registry, problem = pi_harness.read_registry()
  if registry == nil then return pi_harness.problem(problem) end
  for _, candidate in ipairs(registry.commands) do
    if candidate.id == id then return pi_harness.run(ctx, registry, candidate) end
  end
  pi_harness.problem("Pi has no command " .. tostring(id) .. ". Start Pi in a Rex pane, then try again.")
end

function pi_harness.run(ctx, registry, entry)
  local answers = {}
  for _ = 1, 8 do
    local reply, failure = pi_harness.step(entry, ctx, answers)
    if reply == nil then return pi_harness.problem(failure) end
    if reply.error ~= nil then return pi_harness.problem(reply.error) end
    if reply.ask ~= nil then
      local ask = rex.ui.input
      if reply.ask.kind == "pick" then ask = rex.ui.pick end
      local answer = ask(reply.ask.prompt)
      if answer == nil then return end
      answers[#answers + 1] = answer
    elseif reply.show ~= nil then
      return pi_harness.open(ctx, registry, reply.show)
    else
      if type(reply.done.notice) == "string" then pi_harness.say(reply.done.notice) end
      return
    end
  end
  pi_harness.problem(entry.title .. " asked more questions than Pi allows.")
end

function pi_harness.choose(ctx)
  pi_harness.require_ui()
  local registry, problem = pi_harness.read_registry()
  if registry == nil then return pi_harness.problem(problem) end
  local items = {}
  for _, entry in ipairs(registry.commands) do
    local item = { id = entry.id, title = entry.title }
    if type(entry.description) == "string" then item.subtitle = pi_harness.one_line(entry.description) end
    items[#items + 1] = item
  end
  if #items == 0 then return pi_harness.say("Pi has no commands for Rex yet.") end
  local chosen = rex.ui.pick{ title = "Pi commands", placeholder = "Run a Pi command", items = items }
  if type(chosen) == "string" then pi_harness.run_id(ctx, chosen) end
end

rex.action{
  name = "pi_command",
  title = "Pi: Run Command…",
  description = "Lists Pi's commands and runs the one you choose, or the one that an id argument names. Pi records its commands in " .. pi_harness.registry .. ".",
  category = "Pi",
  args = { id = "string?" },
  run = function(ctx, args)
    if args.id == nil then return pi_harness.choose(ctx) end
    pi_harness.run_id(ctx, args.id)
  end,
}

do
  local registry = pi_harness.read_registry()
  for _, entry in ipairs(registry and registry.commands or {}) do
    local id = entry.id
    local name = "pi_" .. (tostring(id):gsub("%.", "_"))
    if name:match("^pi_[a-z0-9_]+$") and type(entry.title) == "string" then
      rex.action{
        name = name,
        title = "Pi: " .. entry.title,
        description = entry.description,
        category = "Pi",
        run = function(ctx) pi_harness.run_id(ctx, id) end,
      }
    end
  end
end`;

/** A path that a Lua string holds unchanged: no quote, backslash or control character. */
function luaPath(path: string): string {
	if (!path.startsWith("/") || /["\\\p{Cc}\p{Cf}]/u.test(path))
		throw new Error(
			`Pi cannot name ${JSON.stringify(path)} in the Rex configuration. Use an agent directory whose path has no quotes, backslashes or control characters.`,
		);
	return `"${path}"`;
}

/** The Rex configuration block that Pi's /rex setup writes: the runtime of palette commands. */
export function configBlock(registryPath: string): string {
	return `-- pi-harness: pi actions v${BLOCK_VERSION} begin
-- Pi commands in the Rex palette.
-- Pi's /rex setup wrote this block and /rex remove deletes it.
local pi_harness = { registry = ${luaPath(registryPath)} }
${RUNTIME}
-- pi-harness: pi actions end`;
}

interface Block {
	start: number;
	end: number;
	/** The block that an earlier version of Pi wrote, which setup replaces and remove deletes. */
	earlier: boolean;
}

/**
 * The block that setup wrote, if the configuration holds one. Only the exact text of the current block counts as
 * current, so marker lines around other text, such as inside a Lua string, are never taken for it. A block whose
 * begin marker names an earlier version counts as Pi's earlier block. A partial, repeated or changed block, or a block
 * of a later version, is refused and stays for the operator to correct.
 */
export function findConfigBlock(source: string, registryPath: string): Block | undefined {
	const begins = [...source.matchAll(BEGIN)];
	const ends = [...source.matchAll(END)];
	// Any other marker line belongs to an earlier Pi block, whose actions the current block would define twice.
	if ([...source.matchAll(MARKER)].length !== begins.length + ends.length)
		throw new Error(
			'The Rex configuration holds an earlier Pi block (lines that start with "-- pi-harness:"). Delete it by hand, then run /rex setup again.',
		);
	if (begins.length === 0 && ends.length === 0) return undefined;
	const begin = begins[0];
	const end = ends[0];
	if (begins.length !== 1 || ends.length !== 1 || !begin || !end || end.index < begin.index)
		throw new Error(
			"The Rex configuration has a partial or repeated Pi block. Correct it by hand, then run /rex setup again.",
		);
	const stop = end.index + end[0].length;
	const region = { start: begin.index, end: source[stop] === "\n" ? stop + 1 : stop, earlier: false };
	const version = Number(begin[1]);
	if (version < BLOCK_VERSION) return { ...region, earlier: true };
	if (version > BLOCK_VERSION)
		throw new Error(
			`A later Pi wrote the Pi block in the Rex configuration (version ${version}). Run /rex setup from that Pi.`,
		);
	const text = source.slice(region.start, region.end).replaceAll("\r\n", "\n");
	const block = configBlock(registryPath);
	if (text !== `${block}\n` && text !== block)
		throw new Error(
			`The Pi block in the Rex configuration differs from the version ${BLOCK_VERSION} block that Pi writes. Remove the block by hand, then run /rex setup again.`,
		);
	return region;
}

/**
 * The configuration with the block added at the end, after a line break when the last line has none. A configuration
 * that already holds the block stays as it is.
 */
export function withConfigBlock(source: string, registryPath: string): string {
	const found = findConfigBlock(source, registryPath);
	if (found?.earlier) return `${source.slice(0, found.start)}${configBlock(registryPath)}\n${source.slice(found.end)}`;
	if (found) return source;
	return `${source}${source.length > 0 && !source.endsWith("\n") ? "\n" : ""}${configBlock(registryPath)}\n`;
}

/** The configuration without the block. Every other byte stays as it is. */
export function withoutConfigBlock(source: string, registryPath: string): string {
	const found = findConfigBlock(source, registryPath);
	return found ? source.slice(0, found.start) + source.slice(found.end) : source;
}
