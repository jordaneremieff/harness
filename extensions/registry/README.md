# registry: bounded session resource lookup

The ordinary extension publishes its registered tool renderers at factory load and
on versioned requests through the [tool display contract](../../docs/conventions/tool-display.md).
The payload contains only tool names and renderer fields, never execution functions.

This extension exposes Pi's current registration records through a read-only
lookup. It does not create a second registry, filesystem index, or persistent
store.

## Surface

The read-only `registry` tool discovers resources, chat model capabilities, tool
parameters, observed context paths, and harness settings with explicit evidence boundaries.

The main description covers ordinary Pi sessions. See [Durable agents](#durable-agents)
for the native contribution to hosts with persistent conversations, including
its unavailable fields and different result carrier.

With no arguments, the tool returns the current model, thinking level, context
usage, cwd, mode, trust, installed-version, package, documentation-location,
session-ID, and session-file facts. An answered
session-file accessor with no file means an ephemeral session; a failed accessor
means unavailable. Missing accessors remain explicitly
unavailable. The agent-directory fact is Pi's process default, not proof of an
embedding's configured agent directory.

## Parameters

| Parameter | Contract |
|---|---|
| `name` | Optional text, 1–256 characters. Name comparisons are case-sensitive. Skills also match `skill:<name>`; ordinary sessions additionally match `/skill:<name>`. |
| `match` | `exact` or `substring`; default `exact`. |
| `kind` | Optional `tool`, `command`, `skill`, `prompt`, `model`, `context_file`, or `setting`. `model` covers chat models only, not classifier or image models. Without it, name/search queries cover only tools and slash-command resources. |
| `search` | Optional text, 1–256 characters. Models require every whitespace-delimited token as a case-insensitive literal substring somewhere in the canonical name or display name, in any order; whitespace-only model queries match nothing. Other resources retain one case-insensitive literal substring within names, descriptions, registered tool usage guidelines, or tool namespace names and aliases; context files use path. Settings match names, descriptions, and environment variable names. Search does not scan resource contents and uses no index or semantic ranking. |
| `detail` | Optional boolean. Requires `kind: "tool"` and an exact name, without `search` or `contains`. `true` returns that tool's complete parameters and prompt guidelines as bounded data. Lists omit them. |
| `provider` | Optional exact provider ID, 1–256 characters. Requires `kind: "model"`. |
| `available` | Optional boolean filter on the cached availability snapshot. Requires `kind: "model"`. |
| `health` | Optional boolean. Requires `kind: "model"`. `true` returns only records with offline catalog review signals; `false` keeps the ordinary model query. |
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
{"kind":"model","health":true}
{"kind":"context_file","limit":10}
{"kind":"setting"}
{"kind":"setting","name":"example.count"}
{"name":"example","kind":"skill","contains":"instruction"}
{"kind":"prompt","limit":10}
{"cursor":"<cursor from the preceding result>"}
```

## Harness settings

`kind: "setting"` requests fresh configuration snapshots through the public
[settings contract](../../docs/conventions/extension-config.md). Each declared row has the name
`<slice>.<key>`, type, effective value, origin (`env`, `file`, or `default`),
validity, description, environment variable, document path, source status, and
field diagnostics. Secrets show `set` or `unset`, never their bytes. Invalid
selected inputs retain the safe default and a rejected-source diagnostic.

`settingsCoverage` names only responding loaded publishers. It preserves each
publication's document and unknown-key diagnostics, including diagnostics with
no declared row. The view does not enumerate all installed or inactive
extensions. Nonresponding publishers remain unknown; an empty response does
not establish that no settings exist. Collection failure is unavailable, and
malformed or omitted publications make coverage partial. Configuration
snapshots do not prove an already-running runtime applied file edits.

Name, substring, metadata search, and continuation work for settings. Tool
detail, model filters, and file content queries do not apply. Fingerprints
include safe values, origins, validity, diagnostics, and collection coverage,
but exclude observation timestamps, secret bytes, and raw document digests.
The existing full-result bounds apply to rows and coverage. An oversized
coverage object produces an explicit blocked page rather than an absence.

The ordinary tool collects on its public session bus. The native Durable
contribution captures the public bus from the factory loaded by its host
resource loader. Both start collection during setup, refresh on inspection or
note composition, and release subscriptions at session shutdown or host close.

## Registry notes

Completed discovery calls can receive a short `[registry]` text part with the
runtime facts the registry already knows. This is result annotation, not an
extra model turn, custom message, prompt rule, argument rewrite, or block.
The `registry` tool's description, parameters, and guidance do not change.

The detector recognises:

- An exact published harness settings document read, including simple shell
  reader commands. The note prioritises environment overrides, invalid rows,
  and diagnostics, then groups keys with default values by slice. It explains
  that file values do not apply while their environment variable is set and
  includes list and exact-setting calls.
- An exact published environment or `slice.key` name in a search pattern,
  `printenv NAME`, `echo $NAME`, or `env | rg/grep NAME`. The note includes
  matching effective values and an exact-name registry call.
- A read, reader path, search path, or enumeration path within an exact loaded
  extension directory. The note identifies the loaded entry path and shows
  that directory's published settings, with environment rows first. A slice
  without a publication receives an explicit no-settings statement. Ordinary
  notes also include an exact tool-detail call when host provenance names a
  tool from that directory. Durable notes omit that tool call. The directory
  is the deduplication target, not each source file.
- An exact read or reader path for `<agentDir>/settings.json`. The note
  distinguishes configured Pi sources from loaded extension provenance and
  shows environment-origin harness settings, or an explicit no-environment
  statement. Counts follow the host provenance available to registry;
  ordinary extensions without registered resources remain outside that count.
  The note does not repeat the Pi settings content.
- Enumeration of an exact known extension, skill, or prompt root, through
  ordinary `ls`/`find` or simple shell `ls`, `fd`, `find`, `tree`, or `rg --files`.
  Names come from loaded provenance, not the directory listing. A listing also
  shows files this session did not load. The note also counts other loaded
  extension directories and gives an exact-tool call for source and scope.
- A read of `<agentDir>/install/current-version` or the running Pi package's
  `package.json`, or `pi --version`/`pi -v`. The note includes the running
  version and package, documentation, and examples paths.

Paths resolve against the session cwd and support `~` and `$HOME`. A path
inside the session cwd normally does not trigger a note: that is development
in the agent's own tree. Targets inside the agent directory are exempt unless
the cwd is itself inside that directory. When cwd is the home directory, the
inside-cwd rule does not apply. Search commands without an external path do not trigger
unless they search an `env` pipe. Other checkouts, path ancestors, and
prefix-only environment names do not match. The shell detector handles simple
quotes, escapes, pipes, command separators, and redirections, not full shell
evaluation. Output redirection targets do not become discovery arguments;
input redirection targets count as reader paths. A literal `cd` changes the
base for later relative paths in the script, not the session development
boundary. An unresolved `cd` suppresses later relative paths; absolute and
home-relative paths remain usable. Search context and format options consume
their separate values. The remaining words after an `fd` execution option
belong to its command, not its search paths.
Heredocs, process substitutions, subshells, command substitutions, and quoted
example commands do not trigger. The detector performs no directory walk or
target-file read.

Settings notes identify configured values from responding loaded extensions
at a UTC time, not proof a running process applied edits. Rows include origin,
environment name, and invalid validity where applicable. Values are clipped
to 80 characters, or 60 characters for environment overrides in document
notes; secrets remain only `set` or `unset`. Unavailable or partial
settings coverage suppresses settings notes. Unavailable provenance suppresses
resource notes. Notes include the applicable registry calls. Explicit
no-settings and no-environment statements cover the current responding
publishers, not inactive or nonresponding extensions.

Each note has at most 10 lines and 1,200 UTF-8 bytes. Each result gains at most
two notes and 1,600 bytes. Each ordinary session or Durable conversation gains
at most six notes. A target receives at most one note in that lifetime,
independently of earlier registry queries. Ordinary `session_start` resets the
budget and pending notes. Durable state belongs to the host incarnation;
a host restart can repeat a note once.

Ordinary delivery uses `tool_result` and preserves structured content, details,
error status, and usage. Nested results remain unchanged; notes wait for the
outermost model-issued call. Durable delivery uses the public ToolTask
`afterTool` hook and appends only to array-shaped output, preserving structured
output and other carriers. Nested notes pass through each ancestor to the
model-issued result. Errors in notes code produce no note and do not fail the
original tool.

Set `registry.notes` to `false` in the machine document or set
`PI_REGISTRY_NOTES=false` to disable notes. The detector reads this setting
fresh before note composition, so the next matching call uses the new value
without a restart. Explicit registry queries remain available.

Evaluate the mechanism through real discovery tasks with notes on and off.
Compare correct answers, avoided manual steps, context cost, and noise.
Remove the mechanism if real sessions show no shorter discovery or the
operator finds the notes noisy. Result delivery alone does not establish use
or benefit.

## Terminal cards

The `registry` tool renders its own card in the interactive transcript. A
collapsed card shows the request on its heading row and at most one qualifier
row (kind, match mode, detail, provider, filters, limit, continuation), then
one or two outcome rows built from the structured details: the outcome, the
returned count against the matched total, the returned resource kinds, page
bounds, and any continuation. A single-record page replaces the kind tally with
that record's key facts: a model's cached availability, configured auth, context
window, and supported thinking levels, or a tool's configured and active state.
A bounded kind tally reports the number of omitted kinds. The host context
percent is a whole number. The argument and result expansion
hints appear only when the collapsed view hides or clips content, and each
rides the row it belongs to. An expanded card shows the full arguments or the
bounded result text.

Cards with `catalogBoundary` state `chat models only`, including no-match cards.
A model page with no matched records also points to native codemode `models.*`
discovery; expansion shows the complete catalog boundary and API names.

Resource and model list cards do not repeat the requested name, search, or
content phrase. Content-scan cards name the resolved resource. Counts are page
counts, not an inventory; the result text carries the evidence and observation
boundaries, and a bounded or partial page never reads as an absence result.
Terminal controls are escaped and long values are clipped.

## Compact results and exact records

List-style text favors discovery. Resource lists show name, invocation when
applicable, description, and source path. Tool lists show configured and active
status; skill lists show default skill-list eligibility. The result header
identifies registration evidence and its observation time. Exact `name` queries, optionally narrowed by `kind`, show every provenance
field and the record's evidence time. Exact resource queries also retain the
observer summary that resource lists omit. `detail: true` with an exact tool name and
`kind: "tool"` additionally returns its parameters and prompt guidelines.

### Chat model lists

Model pages use these groups, in order:

1. Available records with provider configuration evidence.
2. Other available records.
3. Remaining configured-auth records.
4. The rest.

Provider configuration evidence means `providerHasScopedModels === true` in
ordinary sessions or `providerNamedInSettings === true` in Durable hosts. Each
group sorts alphabetically by canonical `provider/id`, independently of selected
model, scope position, price, or past use. Without provider configuration evidence,
all available records remain one alphabetical group. No record is hidden or
filtered by this order. The result header states the rule. Search tokens match
across canonical and display names without aliases or model-family rules.

Lists show canonical and display names, input modalities, selected state,
catalog membership, cached availability, configured-auth presence, scope
membership and position when present, reasoning capability, context window,
supported thinking levels, and current thinking level when present. Scope
position is session cycle order, not operator preference. Each record retains
its evidence time. Use exact `name: "provider/id"` with `kind: "model"` for
provider, ID, output limit, extension-provider registration, and scope thinking pin.
Offline health reports retain records beside their findings.

Model records also carry nullable `oauth`, `subscriptionRecognized`,
`authSource`, `catalogCost`, `catalogCostHasTiers`, and
`providerHasScopedModels`, plus `providerNamedInSettings`. Compact text labels
these as `oauth`, `subscription`, `authSource`, `price`, `tiers`, `providerScoped`,
and `providerSettings`. Price text uses
input/output/cache-read/cache-write rates in USD per million tokens. Structured
`catalogCost` preserves those named base-rate fields; only exact-name lookups
include its optional `tiers` array with `inputTokensAbove` thresholds.
`catalogCostHasTiers` identifies tiered pricing without repeating the tiers on
list pages. Failed or malformed price reads stay null, not zero.

These are catalog and configuration facts, not a billing account view. OAuth
does not by itself establish subscription access. An unrecognized subscription
does not establish metered billing, and nominal catalog prices are not invoices.
The tool holds no preference data. Configured access and scope do not establish
operator preference. Current task directions and operator route, budget, and
role preferences govern selection; quota, balance, and remote health remain
unchecked.

### Non-chat model discovery

`kind: "model"` projects Pi's chat catalog only. Classifier and image models are
not queried, so a `missing` result does not establish their absence. Model pages
carry `catalogBoundary` in both `details` and `structuredContent`, including
no-match, incomplete, health, and continued pages, plus pages whose model
snapshot changed. The same boundary appears in result text. A continuation from
a different session returns a generic `stale_cursor` without `catalogBoundary`.
Invalid or cancelled queries do not claim a catalog read; oversized outer
metadata retains the explicit no-absence bound instead.

Use native codemode `models.getModelsOfType("classifier")` or
`models.getModelsOfType("image")` for catalog discovery. Use
`models.getAvailableOfType(type)` for availability, or
`models.getModelOfType(type, provider, id)` for an exact entry. Those helpers
require an active codemode tool. Registry neither activates it nor calls the
helpers. Read the installed Pi `docs/codemode.md` for `models.classify()` and
`models.generateImages()`, their credentials, usage, and result-error contracts.
Registry adds no non-chat catalog, inference, routing policy, or credential check.

### Structured results

The ordinary tool declares `outputSchema` and returns `structuredContent` on every outcome.
The Durable tool declares `structuredOutputSchema` and returns the same object as
`structuredOutput`, separately from its model-facing `output` and UI `details`.
Codemode scripts receive this object rather than the human text. Its
`records`, `outcome`, `returnedRecords`, `resultBounded`, and `omittedRecordBlocks`
fields are always present. Query-specific fields retain pagination, source
coverage, and failure evidence. A `cursor`, when present, resumes with no other
arguments. `pageBlocked` means the page cannot advance; `omittedDetails` means
oversized outer metadata was omitted. An empty array alone never establishes
absence.

`structuredContent` mirrors the already bounded `details` data. Both
`details.records` and `structuredContent.records` retain the same projected
records in both text forms, except that model price tiers require an exact-name
lookup. Compact pages still fingerprint the complete model snapshot, including
undisplayed tiers and settings scope patterns, for continuation checks.
Resource schemas and guidelines still require tool detail. The complete-result
bound includes content, details, and structuredContent together, so compact text does not guarantee that
an arbitrarily large record fits. Descriptions and other display previews retain
their existing bounded, terminal-safe form.

The no-argument summary retains all host facts and observation state in a
shorter layout. It does not move host facts behind another query. Shared
read-only and evidence-not-authority boundaries appear once. Resource-specific
qualifications accompany the relevant facts, not unrelated model or resource
queries. An unavailable status never becomes false or zero, and omitted list
fields do not imply absence.

## Offline catalog health

Use `{"kind":"model","health":true}` for an on-demand review of the same local
model snapshot. Name, provider, search, availability, limit, and cursor retain
their model-query meanings. The report returns human-readable reasons and
boundaries plus structured `details.records[].findings` and `details.health`.
Each returned row counts once even when it carries several findings.

The supported signals are:

- An explicit `expires-on-` marker followed by a date-shaped suffix in an ID.
  Ordinary version dates do not qualify. The marker is a review cue, not proof
  of expiry: no retirement date is validated and no year is inferred from a
  four-digit suffix.
- The selected provider/model identity is absent from the returned catalog,
  provided the catalog read answered and no catalog error was reported. This
  does not establish removal: Pi can silently omit a provider whose getter fails.
- The selected model has `configuredAuth: false`. Selection is not dispatch
  history, and configuration presence is not credential validity. Unselected
  unauthenticated models are not flagged merely because Pi lists them.
- Duplicate rows with the same provider and model ID disagree on reasoning,
  input modalities, context/output limits, or supported thinking levels. Array
  order and display names do not count as conflicts. Different providers are
  distinct identities, so their different limits are not flagged.

Comparison uses all returned catalog rows before query filters. The report
pages flagged rows, states matched and unflagged row counts, and retains the
normal complete-result bounds. A changed snapshot invalidates its cursor;
query time alone does not. `ok` with no flagged rows means no supported signal
matched the filters, not a healthy or complete catalog. Failed catalog access
returns `unavailable`; reported catalog errors or unavailable selected-auth
presence return `partial`, with independently known signals preserved.
Incomplete reports have no continuation cursor; narrow the filters or reissue
the query after the unavailable source recovers.

Provider-refresh membership and timestamps, recent dispatch use, and dispatch
age are explicitly unavailable. Public synchronous registry getters do not
expose that history. The report does not open provider stores or sibling stores,
resolve credentials, refresh models, probe providers, modify configuration, or
add timers. Remote model resolution remains unchecked.

## Current context usage

The no-argument summary calls Pi's `ctx.getContextUsage()` once at query time.
It returns the estimate's tokens, context window, percentage, observation time,
and `available`, `unknown`, or `unavailable` state in text and structured
`details.context`. Zero usage remains zero; overflow percentages are not clamped.
After compaction, Pi can return a known context window with unknown usage until
a subsequent assistant response supplies usage. Failed or absent accessors
remain unavailable and never expose raw error text.

The estimate uses assistant usage and trailing messages. It is not an exact
provider payload count, a safe remaining budget, or an automatic-compaction
threshold. Response reserves, pending inputs, and subsequent tool results still
need room. Registry does not infer those settings or trigger compaction.

Pi owns the estimate, including its in-memory branch traversal. Registry reads
it only for a valid no-argument summary, not for resource queries, continuations,
or rejected calls. No timer, message injection, retained estimate, directory
scan, or separate context estimator is added.

## Agent discovery

Tool activation, model declaration, and nested-call access are separate facts.
Use a visible tool directly when its purpose and arguments fit the task. The registry supplies discovery when a resource name, tool argument,
model capability, or instruction source is uncertain; it is not a required
lookup before every action.

Search includes the usage guidelines Pi already registers for each tool, so
operator phrases recorded there are discoverable without duplicating keyword
lists across extensions. Each field is searched literally and independently.
A phrase with no match does not prove that no relevant capability exists; try
another short term or inspect a bounded kind list. Exact tool detail returns
its schema and registered guidance without activating it.

## Evidence and observation

- Chat model records project `ctx.modelRegistry.getAll()`, `getAvailable()`,
  `hasConfiguredAuth()`, `isUsingOAuth()`, `getProviderAuthStatus()`,
  `getProvider()`, `getError()`, `getRegisteredProviderIds()`, `ctx.model`,
  `ctx.thinkingLevel`, and `ctx.scopedModels`. Names are canonical `provider/id`;
  display names are separate. Records state catalog membership, selected state,
  cached availability, configured-auth presence, reasoning capability, supported
  thinking levels, input modalities, context/output limits, and scope membership.
  Only the selected model carries the current thinking level. Scope pins remain
  separate from effective thinking. An empty scope means no restriction.
  `scopeIndex` is the model's zero-based position in `ctx.scopedModels`; it is
  omitted for models outside the scope and when no scope is configured.
  `providerHasScopedModels` reports whether the provider has any entry in a
  resolved, nonempty scope; otherwise it is null. A true value moves available
  records from that provider ahead of other available records, even when the
  individual model is outside the scope. It never moves unavailable records
  ahead of available ones. `providerNamedInSettings` stays null in ordinary
  sessions because they use resolved scope, not raw settings-prefix evidence.
  `extensionProvider` is true when `getRegisteredProviderIds()` includes the
  model's provider, false otherwise, and null when the accessor fails. The tool
  reads provider registration once per model snapshot.
  `oauth` projects `isUsingOAuth()`. In ordinary sessions,
  `subscriptionRecognized` combines OAuth use with the provider's public
  `auth.oauth.isSubscription` flag. `authSource` admits only Pi's source enum:
  `stored`, `runtime`, `environment`, `fallback`, `models_json_key`, or
  `models_json_command`. Labels, configuration values, and resolved credentials
  are never returned. `catalogCost` copies only public catalog price fields,
  including request-wide tiers for exact lookups. Unknown facts remain null.
  Scope order describes the session cycle order, with unavailable entries skipped
  by Pi. When no scope is configured, scope order is absent and models
  remain unrestricted.
- Availability is a synchronous local snapshot, not remote health or valid
  credentials. The tool performs no refresh, credential resolution, or network
  probe. Catalog errors return only a boolean, never error text or provider
  configuration. Failed catalog access preserves selected-model evidence but
  reports `unavailable`; catalog errors report `partial`, never absence.
- `kind: "context_file"` pages the observer's retained paths with their observation
  time. It reads no contents. Missing observation returns `unavailable` with
  `not_yet_observed`; overflow returns `partial`, including for zero matches.
- Tool records come from `getAllTools()` and distinguish configured presence
  from `getActiveTools()` membership. The registration snapshot is read at call
  time, and registry does not wait for MCP servers that are still connecting.
  A page taken before a server connects has none of its tools, so missing
  `mcp__<server>__*` records do not show that the server has no tools or is not
  configured. After a successful connection, a fresh registry query includes
  the registered tools. Codemode `describeNamespace(name)` waits for the
  server's startup work, but returns no namespace when no matching callable
  tools exist. If the active-tool accessor fails, active
  status is unavailable rather than false. `exposure`, `namespace`, and
  `annotations` retain native metadata when present; annotations are unverified
  author hints, not permission. A `namespace` carries `name`, `aliases`, and
  `description` when Pi supplies them. Metadata search matches namespace names
  and aliases, but exact `name` queries still select tool names, not namespaces.
  Aliases remain intact in bounded records. Output bounds omit whole records,
  not part of an alias list. When Pi supplies namespace `instructions`, such as
  an MCP server's
  guidance, the record sets `instructionsOmitted: true` instead of the text, and
  the result text adds one boundary line. The text is unbounded and the same on
  every tool of its server, so it never reaches the snapshot, a record, or a
  result; the flag is absent when Pi supplied no non-empty instructions. Read
  the guidance with the codemode helper `describeNamespace(name)`, using the
  record's namespace name. Registry does not return the omitted text, and the
  `describeNamespace` helper requires an active codemode tool.
  `callable` comes only from membership in the
  invocation's `ctx.tools`, with `callableEvidence: "tool_context"`. Failed or
  absent context access omits that fact rather than reporting false.
  `modelDeclared: null` states that final declaration is unavailable here:
  `prepareLoadout` can hide active declarations. The tool never infers it from
  activation. Pi's public `ToolInfo` omits output schemas, so registry does not
  report them. Discovery does not execute or activate any discovered tool,
  including hidden tools; nested-call checks still apply.
- Command, skill, and prompt records come from `getCommands()`. Results preserve
  Pi's invocation name and every `sourceInfo` field: `path`, `source`, `scope`,
  `origin`, and optional `baseDir`.
- Results identify registration, prior observation, or current file-content
  evidence and its observation time. Resource records use deterministic ordinal
  order by kind, name, and source fields, not locale-dependent sorting. Model
  records use the availability groups described above.
- `before_agent_start` copies only names, paths, selected tool names, skill
  invocation metadata, and custom/appended/forced prompt-presence flags. An empty
  forced replacement still counts as present. These are prior handler inputs,
  not proof of the final transcript or provider payload. It retains no
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
  identity. The extension creates no separate session entries or injected
  messages. Registry notes annotate existing tool results instead.

## Outcomes

| Outcome | Meaning |
|---|---|
| `host_summary` | No selectors were supplied; host facts and observation boundaries follow. |
| `ok` | Matching registration records or source lines are available, or a complete health review returned, including one with no flagged records. |
| `missing` | All required registry accessors answered and no record matched within the queried source, or a complete file scan found no matching line. Model queries establish no absence outside the chat catalog. |
| `ambiguous` | More than one file-backed resource matched a content query, or more than one tool matched an exact detail query. No file was opened and no tool schema was returned. |
| `unavailable` | A required host accessor failed, a matched resource has only a synthetic/non-absolute source, or current frontmatter is invalid/non-object. This is not absence. |
| `partial` | A model catalog reports an error, a health review lacks selected-auth evidence, a retained observation overflowed, or a content read stopped or changed. No absence is established. |
| `cancelled` | The call stopped on cancellation. Open handles close before the result returns. |
| `stale_cursor` | The session, query-dependent metadata, model state, retained observation, or scanned file changed. Reissue the original query. |
| `invalid_arguments` | An argument or cursor violates the tool contract. |
| `io_error` | A resolved source could not be read or was not a regular file. This is not absence. |

Pi also validates the public schema before tool execution and reports its own
validation errors. The tool rechecks arguments because extension hooks are able
to mutate them after that validation.

## Request and output boundaries

- Each complete tool result, including `details` and `structuredContent`, fits
  within 50 KiB and 2,000 lines. The renderer measures serialized JSON overhead
  and both structured copies, not just visible text. This can shorten pages;
  continuations resume after the last retained record.
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
  has a public API, but this tool excludes its filesystem traversal to keep its
  no-crawl query contract. Current context estimation uses the host-owned accessor
  only for no-argument summaries, as described above. Slash names
  alone do not prove dispatch to a particular record: extension commands can
  shadow same-name prompts. The final provider payload is not visible here.
- Cursors also detect changes to search metadata, tool schemas/guidelines,
  active-tool state, callable membership, exposure/namespace/annotations,
  model availability/auth configuration/selection/scope
  (including scope order), extension-provider registration, and retained context
  observations. A namespace change means a change to the fields a record shows:
  `name`, `aliases`, `description`, or whether non-empty `instructions` exist.
  Editing the instruction text does not move a cursor, because no page shows that text.
  Read timestamps alone do not invalidate model
  pages. If one required registry accessor fails, results preserve independently
  available matching registration evidence and report an incomplete inventory.
  Its displayed count and `total` describe only known matches, never the complete
  inventory. Incomplete inventories have no cursor; narrow `kind` to an available
  resource class for normal paging.

## Configuration and dependencies

Node built-ins and Pi's existing peer packages supply the implementation.
Loading registers the tool, settings publisher, and result hook; it does not
edit settings or activate other resources. The slice reads only its own
section of `<agentDir>/harness.json`, or the document selected by
`PI_HARNESS_FILE`, through the public
[settings contract](../../docs/conventions/extension-config.md).

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| notes | `PI_REGISTRY_NOTES` | boolean | true | none | Append bounded registry facts to matching completed discovery calls. Read fresh for each matching call. |
<!-- harness:settings:end -->

Environment values take precedence over document values. Boolean environment
values accept `true`, `false`, `1`, and `0`; invalid selected values use the
safe default and publish a diagnostic.

## Durable agents

A Pi Durable conversation receives the lookup through the native contribution
the ordinary factory emits on `durable:contribution`. The contribution installs
the `registry` tool and its prompt section. The tool declares `replay: "safe"`:
it only reads host state, so a rerun after process loss repeats no external
effect and needs no deduplication key.

The native form reads Durable facts instead of a Pi session:

- Installed tools come from the tool task's registry snapshot; the resolved
  agent's tools are the offered set. A tool record's source is the emitting
  contribution's entrypoint when the host's contribution inventory names it;
  otherwise it carries a synthetic `<durable:extension-name>` label.
- Contributed commands come from the host's contribution inventory. They are
  invoked through the host's agent controls, not as slash commands, so their
  records carry no invocation form. A same-name tool from two extensions
  remains two records; Durable resolves the offered set by agent selection.
- Skills, prompt templates, and context files come from the host's cwd-bound
  resource loader. A durable skill record carries `skill:<name>` as a lookup
  alias and reports model-invocability from the loader's disable flag as an
  observation at call time. Content queries read the resolved source file the
  same way as the ordinary tool.
- Chat model records come from the host's model runtime: catalog, cached
  availability snapshot, configured-auth presence, registered providers,
  `isUsingOAuth()`, `isUsingSubscription()`, and `getProviderAuthStatus()`.
  The conversation's selected model and thinking level come from the resolved
  agent. A Durable conversation has no Pi model scope, so `inScope` and
  `providerHasScopedModels` stay null rather than unrestricted.
- Model pages carry `settingsScope: {status, patterns, observedAt}`. A fresh
  public `SettingsManager.create(cwd, agentDir, {projectTrusted})` reads the host's
  global and trusted-project configuration for each model query. The trust flag
  comes from the host's settings manager. Only raw `getEnabledModels()` patterns
  leave that manager; other settings and load-error text stay private. `status`
  is `available` when the key contains a string array, `absent` when the key is
  absent, and `unavailable` after load errors or a malformed value. An explicitly
  empty array remains available; absent and unavailable patterns are null.
  `providerNamedInSettings` reports whether a raw pattern starts with the exact
  literal `<provider>/` prefix. It rejects whitespace and glob, fuzzy, or escape
  punctuation in the provider segment: `* ? [ ] { } ( ) ! + @ ~ ^ $ | \ :`. It
  does not trim, fold case, expand patterns, or inspect the model-ID suffix. A
  literal provider prefix counts even if no model matches its suffix. Prefix-less
  patterns do not count. An available array with no qualifying prefix yields
  false; absent or unavailable patterns yield null. This field is separate from
  `providerHasScopedModels` because naming a provider does not prove resolved
  scope membership. Only true changes the available-record order.
  These patterns are configuration evidence, not resolved session scope or
  preference. No resolver runs: the public scope resolver refreshes availability.
  The read uses Pi's settings lock but calls no setter and changes no settings.
  Cursor fingerprints include pattern values and status, not their read time.
  Oversized settings evidence follows the existing blocked-page result bound.
- The no-argument summary reports the Durable agent identity (storage ID,
  conversation ID, and the external agent ID), `cwd`, the resolved model and
  thinking level, the context estimate, and the Durable coverage: every
  contribution name and every configured extension without a Durable form, from
  `host.inventory.ordinaryOnly`. Resource results add one boundary line when
  ordinary-only extensions exist.

Documented differences from the ordinary tool:

- Agent identity is native: the storage ID, the conversation ID, and the
  external agent ID (`<storageId>` for the root conversation, or
  `<storageId>:<conversationId>` otherwise). The working directory comes from
  the host. `mode`, `hasUI`, `projectTrusted`, `sessionId`, and `sessionFile`
  stay unavailable.
- Context usage is an estimate read from committed state at call time: the
  newest usable assistant usage within the active context, converted to tokens,
  against the model's context window. The scan skips zero-usage, aborted, and
  error responses, so an older usable response still supplies the estimate.
  It stops at a context head, including reset or compaction. A bounded scan
  with no usable usage leaves the state `unknown`; a missing model window or a
  failed read leaves it `unavailable`. The estimate adds no trailing entries
  and never reports zero.
- Durable tool records carry no `promptGuidelines`: the Durable tool registry
  has no such field, so this contribution renders its guidance as a prompt
  section instead. Search matches registered names and descriptions only.
- Installed Durable tools expose name, description, and parameters. `active`
  reports the resolved `Agent.tools` offered set. `callable` reports membership
  in `Agent.callable`, with `callableEvidence: "durable_agent"`; tools-only and
  unloaded deferred tools remain callable without an active model declaration.
  Failed agent resolution omits callable evidence rather than reporting false.
  `exposure`, `namespace`, and `annotations` remain absent because this native
  registry has no matching fields. Native codemode groups tools through its
  own namespace options, not ordinary `ToolInfo` aliases. Pi Durable has no
  tool renderer surface, so ordinary terminal cards are not part of this form.
- The native registration declares `structuredOutputSchema`. `output` carries
  model-facing text, `structuredOutput` carries the bounded object to nested
  calls and codemode, and `details` carries UI data. The contribution does not
  wrap structured output inside details or register an ignored schema property.
- Cursors are bound to one host incarnation and one conversation, so a host
  restart or another conversation cannot resume a stale page; the ordinary tool
  binds them to one Pi session.

## Verification

```bash
node --test --test-concurrency=1 extensions/registry/notes.test.mts
node --test --test-concurrency=1 extensions/registry/notes-ordinary.test.mts
node --test --test-concurrency=1 extensions/registry/notes-durable.test.mts
node --test --test-concurrency=1 extensions/registry/index.test.mts
node --test --test-concurrency=1 extensions/registry/durable.test.mts
node --test --test-concurrency=1 --test-name-pattern='settings contract: registry' scripts/settings-contract.test.mts
npm run typecheck
npm run lint
npm run check
node scripts/extension-load-check.mts extensions/registry/index.ts
```

Run the other colocated test files individually with the same serial test
command. Notes tests cover every trigger, shell non-matches, exact provenance,
inside-cwd skips, byte and line bounds, secrets, deduplication, unavailable
coverage, fresh configuration, ordinary nested delivery, and real Durable
built-in reads over `MemoryStorage` with the faux provider. Durable nested
trials verify that program results do not receive notes and the outermost
model-facing result does.

Colocated tests cover projection, complete source identity, observer privacy and
bounds, argument validation, host facts, lifecycle resets, session-specific
cursors, bounded paging, full-result limits, frontmatter semantics, literal
search, non-regular sources, active cancellation, and explicit failure outcomes.
Model-scope tests retain chat-only evidence and the native non-chat discovery
route through ordinary and Durable delivery, schema checks, bounded pages,
continuations, incomplete sources, health reviews, and collapsed result cards.
Model, metadata-search, exact-schema, and context-path tests also cover safe
field projection, availability groups, token search across model names,
zero-based scope positions, provider scope evidence, public authentication
facts, nullable prices, exact price tiers, extension-provider registration,
selection/scope distinctions, unavailable surfaces, stale continuations,
privacy, and oversized output. Search tests cover tool-guideline
matches, field-local literal semantics, explicit negative-result boundaries,
and continuation invalidation after usage guidance changes. Compact-output tests
check full-record recovery through exact selectors, per-kind caveats, retained
host facts and uncertainty, and smaller list text. Structured model list records
omit price tiers but retain their presence flag; exact selectors recover them.

`durable.test.mts` runs the contribution through a real pi-durable Harness over
`MemoryStorage` with pi-ai's faux provider. It drives model-issued calls across
query kinds and checks the declared `replay: "safe"` class, the native-fact
records, Durable coverage, model-facing output, the root and
non-root agent identity, and the committed-usage context estimate, including
older usable usage after a zero-usage response and reset/compaction boundaries.
It also checks that an aborted host binds the call to `cancelled` without
reading any host fact, and that model pages preserve present, absent, and
unreadable settings evidence. Settings tests verify trusted-project overrides,
privacy, and unchanged settings bytes. A controlled native codemode run uses
real nested tool tasks and the QuickJS sandbox to verify structured registry
pages, missing-resource and chat-only boundaries, settings coverage, and
callable membership for tools-only, deferred, and model-only tools.
Schema tests validate every outcome, source kinds, continuation, partial
coverage, and bounded pages. The ordinary codemode test uses the public factory
and real QuickJS executor with fixture host accessors and nested dispatch. It
establishes object delivery and record selection, not full session dispatch,
model-backed utility, or global activation. Namespace tests check that instruction
text of any length leaves records, results, snapshots, and cursors unchanged except
for the `instructionsOmitted` flag. Namespace tests also cover alias projection,
search, presentation, independent arrays, cursor changes, and oversized-record
bounds. An ordinary codemode test verifies alias search and structured alias data.
An ordinary session test loads Pi's public MCP and
codemode factories against a dependency-free stdio server and runs `registry`
through the ordinary tool pipeline, so the records come from Pi's own
registration. Adapter tests also require zero host probes after caller
or session cancellation. Current-context tests cover fresh reads, zero and overflow,
post-compaction unknown state, accessor failures, and no estimate probes on
resource pages, continuations, or rejected queries. Catalog-health tests cover
expiry cues, selected-model gaps, same-identity conflicts, cross-provider
non-conflicts, clean and incomplete reports, filters, continuation changes,
whole-record output bounds, privacy, and no additional host probes.

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
