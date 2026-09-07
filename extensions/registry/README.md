# registry: bounded session resource lookup

This extension exposes Pi's current registration records through a read-only
lookup. It does not create a second registry, filesystem index, or persistent
store.

## Surface

| Surface | Kind | Purpose |
|---|---|---|
| `registry` | tool | Discover resources, model capabilities, tool parameters, and observed context paths with explicit evidence boundaries. |

With no arguments, the tool returns available cwd, mode, trust, installed-version,
package, documentation-location, session-ID, and session-file facts. An answered
session-file accessor with no file means an ephemeral session; a failed accessor
means unavailable. Missing accessors remain explicitly
unavailable. The agent-directory fact is Pi's process default, not proof of an
embedding's configured agent directory.

## Parameters

| Parameter | Contract |
|---|---|
| `name` | Optional text, 1–256 characters. Name comparisons are case-sensitive. Skill names also match their `skill:<name>` and `/skill:<name>` invocation forms. |
| `match` | `exact` or `substring`; default `exact`. |
| `kind` | Optional `tool`, `command`, `skill`, `prompt`, `model`, or `context_file`. Without it, name/search queries cover only tools and slash-command resources. |
| `search` | Optional literal text, 1–256 characters. Case-insensitive substring within resource names, descriptions, or registered tool usage guidelines; models use canonical name and display name; context files use path. No file reads, index, or semantic ranking. |
| `detail` | Optional boolean. Requires `kind: "tool"` and an exact name, without `search` or `contains`. `true` returns that tool's complete parameters and prompt guidelines as bounded data. Lists omit them. |
| `provider` | Optional exact provider ID, 1–256 characters. Requires `kind: "model"`. |
| `available` | Optional boolean filter on the cached availability snapshot. Requires `kind: "model"`. |
| `contains` | Optional literal text, 1–1024 characters. Case-insensitive search over one uniquely resolved file-backed skill or prompt. No regular expressions. |
| `limit` | Integer, 1–100; default 20. Applies to record, ambiguity, and content-match pages. |
| `cursor` | Opaque continuation text, at most 16 KiB of UTF-8. Supply it as the only argument. |

Examples:

```json
{}
{"name":"example_tool","kind":"tool","detail":true}
{"search":"file contents","kind":"tool"}
{"kind":"model","provider":"example-provider","available":true}
{"kind":"model","name":"example-provider/example-model"}
{"kind":"context_file","limit":10}
{"name":"example","kind":"skill","contains":"instruction"}
{"kind":"prompt","limit":10}
{"cursor":"<cursor from the preceding result>"}
```

## Agent discovery

Active tools remain directly available to the agent through Pi's normal tool
definitions. Use a visible tool directly when its purpose and arguments fit the
task. The registry supplies discovery when a resource name, tool argument,
model capability, or instruction source is uncertain; it is not a required
lookup before every action.

Search includes the usage guidelines Pi already registers for each tool, so
operator phrases recorded there are discoverable without duplicating keyword
lists across extensions. Each field is searched literally and independently.
A phrase with no match does not prove that no relevant capability exists; try
another short term or inspect a bounded kind list. Exact tool detail returns
its schema and registered guidance without activating it.

## Evidence and observation

- Model records project `ctx.modelRegistry.getAll()`, `getAvailable()`,
  `hasConfiguredAuth()`, `getError()`, `ctx.model`, `ctx.thinkingLevel`, and
  `ctx.scopedModels`. Names are canonical `provider/id`; display names are
  separate. Records state catalog membership, selected state, cached
  availability, configured-auth presence, reasoning capability, supported
  thinking levels, input modalities, context/output limits, and scope membership.
  Only the selected model carries the current thinking level. Scope pins remain
  separate from effective thinking. An empty scope means no restriction.
- Availability is a synchronous local snapshot, not remote health or valid
  credentials. The tool performs no refresh, credential resolution, or network
  probe. Catalog errors return only a boolean, never error text or provider
  configuration. Failed catalog access preserves selected-model evidence but
  reports `unavailable`; catalog errors report `partial`, never absence.
- `kind: "context_file"` pages the observer's retained paths with their observation
  time. It reads no contents. Missing observation returns `unavailable` with
  `not_yet_observed`; overflow returns `partial`, including for zero matches.
- Tool records come from `getAllTools()` and distinguish configured presence
  from `getActiveTools()` membership. If the active-tool accessor fails, active
  status is unavailable rather than false.
- Command, skill, and prompt records come from `getCommands()`. Results preserve
  Pi's invocation name and every `sourceInfo` field: `path`, `source`, `scope`,
  `origin`, and optional `baseDir`.
- Results identify registration, prior observation, or current file-content
  evidence and its observation time. Records use deterministic ordinal order by
  kind, name, and source fields, not locale-dependent sorting.
- `before_agent_start` copies only names, paths, selected tool names, skill
  invocation metadata, and custom/appended prompt-presence flags. It retains no
  mutable event, prompt text, or context-file content.
- The retained snapshot contains at most 1,000 records and 256 KiB of serialized
  metadata, including cwd and JSON overhead. It reports overflow explicitly.
  Missing prior observations appear as `not_yet_observed`, not an empty inventory.
- `modelInvocable` means default skill-list eligibility from the disable flag,
  not actual prompt visibility or permission. Active file-read tools and later
  hooks also affect visibility.
- Observed skill metadata joins registration records by name and complete source
  identity. A same-name skill from a different source receives no old hidden-state
  evidence.
- Current file evidence uses Pi's public `parseFrontmatter`. Only strict YAML
  boolean `true` disables model invocation. Quoted `"true"` does not. A complete
  block in a bounded prefix supplies evidence even when the body is too large.
  Absent or unterminated blocks leave model-invocability unknown. Invalid YAML
  and non-object frontmatter produce `unavailable` rather than absence. The
  frontmatter state remains explicit in content-query results.
- `session_start` and `session_shutdown` clear observation state, cancel owned
  work, and invalidate cursors. A fresh extension instance has a distinct session
  identity. The extension writes no session entries and injects no messages.

## Outcomes

| Outcome | Meaning |
|---|---|
| `host_summary` | No selectors were supplied; host facts and observation boundaries follow. |
| `ok` | Matching registration records or source lines are available. |
| `missing` | All required registry accessors answered and no record matched, or a complete file scan found no matching line. |
| `ambiguous` | More than one file-backed resource matched a content query. No file was opened. |
| `unavailable` | A required host accessor failed, a matched resource has only a synthetic/non-absolute source, or current frontmatter is invalid/non-object. This is not absence. |
| `partial` | A model catalog reports an error, a retained observation overflowed, or a content read stopped or changed. No absence is established. |
| `cancelled` | The call stopped on cancellation. Open handles close before the result returns. |
| `stale_cursor` | The session, query-dependent metadata, model state, retained observation, or scanned file changed. Reissue the original query. |
| `invalid_arguments` | An argument or cursor violates the tool contract. |
| `io_error` | A resolved source could not be read or was not a regular file. This is not absence. |

Pi also validates the public schema before tool execution and reports its own
validation errors. The tool rechecks arguments because extension hooks are able
to mutate them after that validation.

## Request and output boundaries

- Each complete tool result, including `details`, fits within 50 KiB and 2,000
  lines. The renderer measures serialized JSON overhead, not just visible text.
- Size-limited pages omit whole tail records with an explicit notice. Their
  cursors resume after the last returned record, not after omitted records.
  Displayed page counts and `returnedRecords` reflect only the retained records
  after output bounds apply. If an individual record or
  outer metadata cannot fit, the result reports `pageBlocked` and supplies no
  nonadvancing cursor. Oversized outer details are explicitly omitted.
- Schemas, guidelines, descriptions, paths, and excerpts are evidence, not new
  instructions or activation authority. Exact tool detail never activates a tool.
  Tool-detail JSON escapes terminal, bidi, and Unicode line-separator controls
  for display; parsing that JSON preserves the registered schema and
  guidelines, including keys and values.
  Structured details retain the original metadata.
- A content query reads at most 256 KiB from the single resolved file and returns
  matching source lines with adjacent-line context. Display lines have bounded
  previews and omit terminal/bidi controls. File text is evidence, not an
  instruction to the agent. Current prompt-file bytes are not proof of the loaded
  template body, which Pi expands from its cached template content.
- Content cursors carry the affected file's path, device/inode, size, change and
  modification times, and bounded-content digest. Continuation rereads only that
  resolved file. A removed or unreadable previously scanned source also makes
  its cursor stale. Unrelated file contents are neither read nor hashed.
- Synthetic paths, directories, sockets, devices, and FIFOs are not scanned.
  Nonblocking opens plus regular-file checks cover replacement races. Abort
  listeners close handles during active reads; final cleanup is repeatable.
- The tool accepts no arbitrary path, crawls no directory, performs no mutation,
  activation, credential resolution, network operation, or watch.
- Source records identify registration origins, not immutable executing bytes.
  Hook-only extensions, complete settings, resource load rejection reasons, and
  built-in interactive commands are not an enumerated inventory. Theme enumeration
  and context-usage estimation have public APIs, but this tool excludes their
  filesystem and complete-branch traversal to keep its no-crawl query contract. Slash names
  alone do not prove dispatch to a particular record: extension commands can
  shadow same-name prompts. The final provider payload is not visible here.
- Cursors also detect changes to search metadata, tool schemas/guidelines,
  active-tool state, model availability/auth configuration/selection/scope, and
  retained context observations. Read timestamps alone do not invalidate model
  pages. If one required registry accessor fails, results preserve independently
  available matching registration evidence and report an incomplete inventory.
  Its displayed count and `total` describe only known matches, never the complete
  inventory. Incomplete inventories have no cursor; narrow `kind` to an available
  resource class for normal paging.

## Configuration and dependencies

No `PI_*` configuration is required. Node built-ins and Pi's existing peer
packages supply the implementation. Loading this extension registers the tool;
its source does not edit settings or activate other resources.

## Verification

```bash
node --test "extensions/registry/*.test.mts"
npm run typecheck
npm run lint
npm run check
npm test
```

Colocated tests cover projection, complete source identity, observer privacy and
bounds, argument validation, host facts, lifecycle resets, session-specific
cursors, bounded paging, full-result limits, frontmatter semantics, literal
search, non-regular sources, active cancellation, and explicit failure outcomes.
Model, metadata-search, exact-schema, and context-path tests also cover safe
field projection, selection/scope distinctions, unavailable surfaces, stale
continuations, privacy, and oversized output. Search tests cover tool-guideline
matches, field-local literal semantics, explicit negative-result boundaries,
and continuation invalidation after usage guidance changes.
These tests establish component and adapter behavior, not model-backed utility
or global activation. Adapter tests also require zero host probes after caller
or session cancellation.

### Task evaluation

`registry.eval.mts` compares the candidate with a no-registry control under the
same synthetic resources and ordinary built-in tools. Its cases cover discovery
inside other tasks, tools found only through registered usage guidance, honest
absence and unavailable-source answers, hostile file text, and tasks that need
no registry call. Direct use of an already visible tool
remains a valid route.

```bash
npm run evals -- validate extensions/registry/registry.eval.mts
node --test extensions/registry/registry-evals.test.mts
```

The fixtures restrict reads and writes to synthetic inputs and the requested
`summary.txt` output. They restrict shell commands and block publication and
archive actions. The locked synthetic provider references the deliberately
unset `PI_REGISTRY_EVAL_UNSET`; this is a fixture condition, not production
configuration.

Participants and repetitions remain execution inputs. Validation and deterministic
tests do not run paid inference. Model execution requires the evaluation
framework's separate authority gate. Human-required task quality remains
`not_assessed` until operator adjudication; tool-call checks alone do not establish
utility. Evaluation outputs stay outside the repository.
