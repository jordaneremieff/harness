# Agent host contract

This document defines the current local consumer boundary for retained Durable agents. The Agent extension owns execution, storage, admission, and publication. It may change this contract. Consumers compare supported operation identities with each connected host and refuse mismatched operations; they do not require the extension to preserve older behavior.

Communication shapes and operation identities are defined by `extensions/agent/communication.ts`, `observation-schema.ts`, and `version-contract.ts`. Collaboration thread shapes are defined by `extensions/agent/collaboration.ts`. Historical line-number references use repository revision `4a423cf2a0a822638c09228c5a10a4df1d324e82`, except receipts, configure, task-submit, status and provider-block references, which use `0468691ac2c7bdf8a85d3aa8560f2e5d87dfce26`. These references do not establish the version loaded by a running host.

Paths are relative to the repository root. References describe implementation, not runtime acceptance or the loaded version of an arbitrary running host. The companion [Durable harness track](pi-durable-harness.md) describes lifecycle context.

## Scope and identity

This is a same-user, machine-local interface. [Independent retained reads](#independent-retained-reads) use a one-shot process without a live host. Chord's public typed host runtime supplies live calls and state over a bounded Unix-socket `Link`. The [wire contract](#chord-wire-contract) defines the shared boundary for Agent and independent UI consumers. Payloads, catalog publications, operation identities, and retry policy remain harness contracts. The endpoint is a private directory and owner-only Unix socket, not remote authentication. Chord owns calls, cancellation, and state; the socket adapter owns framing, bounds, close, and initial identity admission.

Use these terms consistently:

- `<agentDir>` is Pi's resolved agent directory, including its configured override.
- `<store>` is `PI_AGENT_SESSIONS_DIR`, resolved as an absolute path, or `<agentDir>/agent-sessions`.
- `storageId` identifies one Durable SQLite storage and host.
- The external conversation identity is `storageId` for root conversation 1, otherwise `storageId:conversationId`.
- `conversationId`, submission IDs, and entry IDs resolve to positive safe integers. Live request parsers also accept decimal-digit strings in the corresponding ID fields; responses use numbers except display snapshot entry IDs, which are strings. Source: `extensions/agent/durable-observation.ts:473-500`.
- `serverId` is the public server UUID. The expected Chord host name is `pi.agent:<serverId>`. Neither is a conversation identity.

Source: `extensions/agent/index.ts:231-235`; `extensions/agent/identity.ts:15-19`; `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/dashboard-types.ts:107-127`.

A targeted live request accepts either `sessionId` (external identity) or `conversationId`, never both. Omission selects root conversation 1. A `sessionId` belonging to another storage is rejected. Prefer explicit `sessionId` for every conversation operation. `dashboard` is an exception: its filter is `conversationId`, not `sessionId`. Source: `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/durable-host.ts:454-457`.

Ordinary primaries are not Durable targets. Their separate presence/message channel does not expose these controls or a live terminal attachment. Source: `extensions/agent/manager.ts:526-555`.

## Native communication provenance

The existing `submit` and `passive-submit` request objects accept optional `communication: Communication`. This application value never changes native input parameters, model content, admission order, cancellation, reply routing or settlement. Inputs without an envelope keep the original path. Metadata rejection does not reject or resubmit an otherwise valid input.

`Communication` is a closed object with `format: "agent.communication/1"`, `sender`, `body`, `recordedAt`, `kind` and `metadata`. Sender identity is the canonical external conversation identity; optional name and kind are checked supplied facts, not labels or inferred roles. Body has `text`, `complete` and `redacted`. Redaction or omission requires `complete:false`. These local same-user assertions establish neither cryptographic authentication nor instruction authority.

| Kind | Metadata |
|---|---|
| notice | `threadId`, optional `event`, `frameRevision`, `eventKind`, `title`, `passive` |
| report | `sourceId`, `requestId`, optional `replyTo` |
| result | `status:done|unanswered`, ordered `references`, `omittedReferences`, optional `reason` |
| check-in | `sourceId`, `producerRequestId`, `elapsedMs`, `origin:operator|model` |

A reference contains `submissionId` and optional `requestId`, `entryId`, `answerEntryId`. Receipt grouping remains unchanged. At most sixteen references fit the value; `omittedReferences` counts the rest. Native producers capture structured receipt, report, check-in and collaboration event fields before transport formatting. Existing excerpts have `complete:false`; no prose parser reconstructs missing fields.

The owner captures the first trusted envelope inside the existing post-native classification commit, before a successful host response. That commit reconstructs a classification row evicted during native admission, prepares native submission, input and index reads before classification can prune, then materializes an available link and stores the resulting intent in the existing retained input row. A late suppress classification still retains that already-admitted request before the unchanged native abort. An `aborted` result keeps the suppression response; `already_placed` or `settled` keeps the successful response and captured association. The owner records its capture time as `recordedAt`. Repeated request IDs preserve the first retained value. Conflicts do not replace an original verified association. A plain admission retains an explicit no-envelope decision in the same bounded row. Once its native entry exists, post-native capture or pre-eviction materialization transfers that decision to the persisted communication point-index family. Later capture consults that index, not just the earlier dedupe observation, so an evicted plain row never permits backfill. This marker stays unresolved publicly: it creates neither a companion nor an invalid view. A queued or canceled input without a native entry has no display link.

The existing input provenance collection watermark remains 128, not an admission cap. Its prune predicate retains queued submissions, plus the original live-run condition for unadmitted classification rows. Pending rows keep their exact classifications and communication intents even when the native backlog exceeds the watermark; they do not block later explicit input or named-producer reports. Unrelated reports and automatic inputs retain their no-release behavior. Placed submissions have left the native inbox and no longer need await-release provenance, even while their run continues. Before eviction of placed or terminal rows, the owner prepares all native and index reads for their unlinked intents, then appends companions and updates their indexes in that same prune transaction. Only after those writes does it remove the rows. `CommunicationIndexDoc` is a persisted, session-scoped point-index family (`agent.communication-index`) keyed by storage, original conversation and native entry. It retains target and companion identifiers, invalid markers or no-envelope decisions. This lookup hint does not replace immutable native records as authority. Admission intent stays in the existing provenance rows; no second delivery queue, admission pin or metadata-specific admission capacity rule is introduced. Queued intent reconciliation uses the existing background and reopen paths. Invalid or unavailable metadata produces a bounded owner diagnostic or invalid index marker without changing native input acceptance.

Native admission and post-native classification remain separate commits. A crash after native admission but before owner capture leaves an unresolved association; this interface does not promise crash-atomic capture with native admission. The successful-response and pre-eviction guarantees apply to completed owner bookkeeping commits, not that intervening crash gap.

Active input provenance uses a separate model-less `agent.communication` entry in the original input's conversation. Its data is `{format:"agent.communication-link/1",target:InputLink,value:Communication}`. `InputLink` contains `mode:"input"`, canonical `storageId`, numeric `conversationId`, decimal-string `entryId`, numeric `submissionId`, and `requestId`. The original input remains unchanged. The owner point index and companion append share a transaction; the index is only a lookup hint.

Passive notices retain the original `agent.thread-notice` write and model array. Valid data is `{format:"agent.communication-passive/1",requestId,value}` and requires a notice with `metadata.passive:true`. Its public `PassiveLink` has `mode:"passive"`, the actual storage/conversation/entry IDs and request ID, but no input submission claim. Its own native ID is `recordEntryId`. Invalid metadata adds only bounded `{format:"agent.communication-invalid/1",reason:"invalid"}` data to that original write. The owner verifies the write's exact visibility before publishing the invalid marker.

Every committed snapshot/frame entry and compact history/activity row contains one closed view:

```text
{state:"ready",recordEntryId,target:InputLink|PassiveLink,value:Communication}
{state:"unresolved"}
{state:"unavailable",reason:"limit"|"invalid"}
```

Unresolved means no visible verified association, not human authorship or a promise of future completion. Live progress rows without a committed ID omit this field. Task observation frames are unchanged.

Snapshot, conversation observation and readable inspection share one owner reader. It captures a visible native tail before the read. Every index hit verifies the native submission, actual origin and target/companion records through bounded fork-aware exact-ID queries. Both records must remain visible at that tail. An older display page still uses the captured current view tail, not its `before` anchor, as the provenance cutoff. A fork before the companion never inherits later parent metadata. A visible inherited entry retains its original conversation ID in the communication target; that ID need not equal the selected fork's conversation ID. No UI or terminal lookup scans for adjacent text or guesses a sender.

The join handles at most 200 display entries. One eligible index hit needs at most one exact target read and one exact companion read, each limited to one record. Added views fit 65,536 serialized bytes per response in returned order; each ready view fits 32,768 bytes. Minimal markers remain reserved for later rows. Communication fits 24,576 bytes and body text fits 16,384 UTF-8 bytes. IDs, counts and times are safe integers; strings reject malformed Unicode and controls except ordinary body newline/tab. Missing optional fields remain absent.

Display snapshots and conversation frames omit the owner-added passive communication data from the entry's `data` field. The bounded joined view carries that metadata after native row selection, so it neither duplicates the body nor evicts native display rows. The original passive write data remains available in raw inspection.

Readable surfaces suppress standalone `agent.communication` bookkeeping while native scan cursors and hidden-entry accounting continue. New metadata changes the opaque snapshot revision and invalidates conversation observation. Native terminal rendering consumes the joined source identity and body directly. Raw exact, branch, search and result inspection retain their original paths and semantics; exact inspection of the companion exposes its separate immutable data.

Source: `extensions/agent/communication.ts`; `communication-retention.ts`; `communication-observation.ts`; `durable-host.ts`; `durable-observation.ts`; `live-observation.ts`; `dashboard-conversation.ts`; `collaboration.ts`.

### Task input sender hints

Snapshot pages and conversation observation frames optionally include
`taskSenders: Record<entryId, {identity:string, name?:string}>`. Keys are native
input entry IDs as canonical decimal strings. These requester facts are separate
from the closed `communication` view and from reply routing. A missing key means
unknown; it does not imply human authorship. No handle is inferred.

Both local task admission and wire `task-submit` capture the structured requester.
A same-storage sender name comes from that sender's retained metadata. Foreign
names remain absent. The existing post-admission bookkeeping retains the first
capture and appends a model-less `agent.task-sender` companion. The existing
communication point index identifies it. Readers verify the native submission,
request ID, original conversation, target entry and companion through the same
fork-aware cutoff. A fork before the companion does not inherit that hint.
Existing no-envelope decisions do not permit historical backfill. Native admission
and owner capture remain separate commits, with the crash boundary stated above.

Hints cover at most 200 selected entries and fit 32,768 serialized UTF-8 bytes.
Omitted hints never remove native entries. Snapshot revisions include these hints;
conversation frames pass them through. Display and compact inspection hide the
companion; exact and branch inspection retain it. Compact inspection does not add
a task variant to `communication`.

Sources: `extensions/agent/task-senders.ts`; `communication-retention.ts`;
`communication-observation.ts`; `durable-agents.ts`; `durable-host.ts`;
`durable-observation.ts`; `live-observation.ts`.

## Ordinary peer communication mapping

Ordinary Pi custom messages with `customType: "agent.peer"` expose a structured peer contribution through their supplied `details`. This section is the public mapping for consumers; it does not authorize imports of Agent-private types, prose parsing, new delivery operations, or history rewriting. The `primary-delivery/3.0.0` channel requires retained acceptance without changing this payload mapping. `sendMessage`, wake behavior, original content, and `display: false` exclusion retain their meanings. Saved `custom_message` entries and live `role: "custom"` messages use the same mapping before projection drops their details.

The normalized value has `format: "agent.communication/1"`, `sender`, `body`, `recordedAt`, and exactly one of the variants below. Unknown properties are not copied into this closed value. Ordinary source records retain their original detail fields separately.

### Identity and timestamp validation

A canonical identity is a lowercase UUID storage identity for conversation 1, or that UUID followed by `:` and a positive safe-integer conversation ID other than 1. UUID syntax is `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`; it does not select a UUID version. A child suffix is canonical decimal text: no sign, leading zero, exponent, fraction, whitespace, or suffix outside `Number.MAX_SAFE_INTEGER`. Do not normalize `uuid:1`, a handle, a label, or uppercase UUID text into asserted authorship. Identity is at most 256 UTF-8 bytes.

For receipts, use `details.identity`. For reports, check-ins, and thread notices, use `details.senderIdentity`. When both fields are present, validate each and require exact equality. If supplied `storageId` or `conversationId` identifies that same receipt producer, require agreement with its canonical identity. A sender contradiction is `unavailable/invalid`, not a guessed preference. A supplied `senderKind` maps to `sender.kind` only when it is `"agent"` or `"session"`. Copy the separately supplied `details.name` to `sender.name` only when it is a well-typed, valid Unicode, control-free string within 160 UTF-8 bytes; `rowDetails` obtains this field from the exact source status. Omit it otherwise. The ordinary `label` may contain a display-name fallback; it remains a presentation label and never supplies `sender.name`.

Use the supplied custom-message timestamp, not `details.createdAt`, receipt time, content text, or the current clock. A live numeric timestamp must be a nonnegative safe integer in milliseconds. A saved-entry ISO timestamp must parse to the same nonnegative safe-integer millisecond domain. Missing required identity, body, timestamp, or variant fields leaves the presentation `unresolved`; malformed supplied values or contradictory identity fields produce `unavailable/invalid`.

### Variant selection and exact fields

Apply these selectors in order, using only structured details:

1. `details.kind === "receipt"`: produce `kind: "result"`; body source is the string `details.answer`, including an explicitly supplied empty string. Require `details.status` to be `"done"` or `"unanswered"` and a nonempty `details.submissions` array. Preserve that array's order and answer grouping. The output metadata is `{status, references, omittedReferences, reason?}`.
2. `details.kind === "report"` with a supplied `checkIn` object: produce `kind: "check-in"`; body source is `details.message`. Metadata is `{sourceId, producerRequestId, elapsedMs, origin}`. `sourceId` is `details.reportSourceId`, or `details.sourceId` when the former is absent; `producerRequestId`, `elapsedMs`, and `origin` come from `checkIn.requestId`, `checkIn.elapsedMs`, and `checkIn.origin`. Elapsed milliseconds are nonnegative safe integers; origin is exactly `"operator"` or `"model"`.
3. `details.kind === "report"` with supplied `threadId` and `operatorMessage`: produce `kind: "notice"`; body source is `details.operatorMessage`. Metadata contains `threadId` and an optional `title` from `details.threadTitle`. Current ordinary details supply no independent event number, frame revision, event kind, or passive flag. Omit those fields; do not infer them from text, wake intent, or transport state.
4. Other `details.kind === "report"`: produce `kind: "report"`; body source is `details.message`. Metadata is `{sourceId, requestId, replyTo?}`. Select source ID as above; use `details.requestId`. Include `details.replyTo` only when non-null and valid as a canonical identity.

A present malformed higher-priority variant does not fall through to a different variant. Source/request IDs are nonempty, valid Unicode, control-free strings of at most 1,024 UTF-8 bytes. Notice thread IDs are nonempty strings of at most 256 UTF-8 bytes; supplied titles are at most 160 UTF-8 bytes. These are same-user producer assertions, not cryptographic authentication or fresh instruction authority.

### Receipt references

For each of the first 16 supplied submission members, map:

```text
submissionId  <- member.submissionId (positive safe integer, required)
requestId     <- member.requestId (valid source/request ID, when supplied)
entryId       <- member.entryId (positive safe integer -> canonical decimal string)
answerEntryId <- details.answerEntryId (positive safe integer -> canonical decimal string)
```

A null native `entryId` or `answerEntryId` means absent, never `"null"`, zero, or a fabricated entry. The shared `details.answerEntryId` belongs to every reference in this producer's answer group; no per-member answer ID is invented. `omittedReferences` equals the number of supplied members beyond the retained first 16. Do not deduplicate references, substitute `operationId` for `requestId`, infer an admission from `ownerId`, or treat a continuation as a result reference. `details.reason` is optional when non-null and a valid bounded string of at most 1,024 UTF-8 bytes. Invalid supplied reference fields produce `unavailable/invalid`; a missing required submissions/body/status value remains `unresolved`.

The existing `continuation` is raw producer detail only. Ordinary entry IDs remain ordinary IDs; do not cast them into Durable integer IDs. Delivery recipient, original owner, source alias, wake/fallback flags, acknowledgement, provider metadata, and cost are not sender authority or extra fields in the closed communication value.

### Body coverage, redaction, and bounded presentation

`body` is `{text, complete, redacted}`. Protect only the selected structured body with the existing credential-redaction transform. Set `redacted: true` exactly when that transform removes source material; this flag describes the normalized body, not an assertion that upstream records never redacted anything. Set `complete: false` for these current ordinary shapes. The producer supplies excerpts and no affirmative complete-body marker: absent `textTruncated` does not prove completeness. `textTruncated: true` independently establishes loss, while passive `operatorMessage` can lose source text without that shared marker. Do not parse the truncation paragraph or invent omitted-byte counts.

Limit normalized body text to 16,384 UTF-8 bytes at valid Unicode boundaries. Any clipping or redaction keeps `complete: false`; preserve ordinary newlines/tabs and reject malformed Unicode or other controls. The closed communication value must fit 24,576 serialized bytes. The ready presentation, including origin and protected raw details, must fit 32,768 serialized bytes; raw details get at most 8,192 serialized bytes and use the existing truthful omission marker. If the attributed value cannot fit, return `unavailable/limit`, not partial identity or silently cut metadata.

Ordinary origin is `{kind: "ordinary-custom", customType: "agent.peer", renderEntryId, sourceEntryId?}`. `renderEntryId` is the existing retained message key; `sourceEntryId` exists only when the public saved record supplies it. Each is a bounded string of at most 256 UTF-8 bytes. A live custom message without a saved entry ID is a valid presentation source but supplies no exact saved-record identity. Native submission, link, or companion fields do not belong in this origin.

Original content remains the source for Raw content and Copy with its actual existing coverage. A normalized card does not replace that content with a reconstructed body, duplicate the transport paragraph at rest, expose secrets through raw details, or change native admission. Preserve a validated communication value through repeated projection rather than treating it as another producer record.

Sources: `extensions/agent/index.ts` ordinary primary registration; `extensions/agent/durable-delivery.ts` `boundedPeerText`, `sharedRowDetails`, `rowDetails`, `reportOptionalDetails`, and `receiptContinuationDetails`; `extensions/agent/durable-controls.ts` `DeliveryReceipt` and `DeliveryReport`; `extensions/agent/identity.ts` `canonicalIdentity`. These references define source fields and mapping, not a claim that an arbitrary running UI already consumes them.

## Retained discovery and endpoint derivation

### Catalog records

The retained catalog is `<store>/durable/<storageId>.json`; the associated database path is `<store>/durable/<storageId>.sqlite`. A bounded regular-file read uses `O_NOFOLLOW | O_NONBLOCK`, reads at most 32,768 bytes, and checks the identity and expected database path. Source: `extensions/agent/catalog.ts:28-29,199-246`.

The record has this shape. `?` means optional; this notation is descriptive, not JSON:

```text
{
  storageId: string, cwd: absolutePath, agentDir: absolutePath,
  packageDir: absolutePath, storagePath: absolutePath,
  model: {provider: string, modelId: string}, thinkingLevel: string,
  name?: string, trust?: boolean, ownerId?: string,
  independent?: {inputDigest: sha256, projectTrusted: boolean},
  createdAt: string,
  view?: CatalogView,
  threads?: bounded thread-discovery publication,
  recoveryDue?: boolean
}
```

The metadata parser limits paths to 4,096 characters, identity/model strings to 512, and names/thinking strings to 256; it rejects control characters and unsupported metadata fields. Catalog projections are removed before that strict metadata parse. `packageDir` is retained metadata, not permission for a consumer to execute a file. The manager supplies its current Pi package directory on acquisition. Source: `extensions/agent/host-protocol.ts:36-143`; `extensions/agent/catalog.ts:77-89,223-245`; `extensions/agent/manager.ts:247`.

Catalog records have no separate top-level schema version or runtime descriptor. A consumer validates the current documented structure; an offline publication is not proof of operation compatibility. Connecting to a host still requires negotiation. Unknown or malformed records must not become control targets.

### Socket and writer claim paths

The current deterministic derivation is:

```text
resolvedCwd = resolve(cwd)
h = sha256("pi.agent.host" + NUL + storageId + NUL + resolvedCwd).hex
variant = hex((parseInt(h[16], 16) & 3) | 8)
serverId = h[0:8] + "-" + h[8:12] + "-4" + h[13:16]
         + "-" + variant + h[17:20] + "-" + h[20:32]
key = sha256(storageId + NUL + resolvedCwd).hex
hostDirectory = join(agentDir, "durable-hosts", key)
```

The public `unixSocketPath(serverId, directory)` uses
`join(directory, serverId + ".sock")` when it fits 100 UTF-8 bytes. For a longer
path, it hashes the complete resolved endpoint path, takes its first 40 hex
characters, and returns `/tmp/harness-chord-<uid>/<hash>.sock`. Hashing the complete
path keeps different endpoint directories distinct. The host supplies
`<agentDir>/durable-hosts` first. The listener validates the resulting private
directory's ownership before chmod and uses an owner-only socket. A filename
or hello name is not peer-credential authentication. The claim is:

```text
claimKey = sha256(JSON.stringify([resolvedCwd, storageId])).hex
join(hostDirectory, ".claims", claimKey + ".lock")
```

Source: `extensions/agent/host-protocol.ts:34,151-181`; `extensions/agent/claims.ts:47-52`.

Import `connectTransport` from the public `transport/index.ts` entrypoint and
call `connectTransport({serverId, path: socketPath})`, then negotiate with
`client.request({method: "runtime-contract"})`. The configured `serverId`
binds the first server hello to the expected host; the same matching hello
then reaches Chord. A matching filename alone is insufficient. Attach-only
access first requires a live claim, then a successful connection and usable
descriptor. An attach failure never authorizes listener replacement. Sources:
`transport/{index,endpoint,unix-link}.ts` and `extensions/agent/host-client.ts`.

Public Unix server discovery enumerates reachable sockets only. It is not retained catalog discovery and cannot find cold storage. No global server is necessary to read catalog publications. Source: `extensions/agent/catalog.ts:343-386`; `extensions/agent/manager.ts:652-701`.

### Claim and liveness semantics

A claim contains `{sessionId,cwd,host,createdAt,pid}`; the parser accepts extra claim fields but validates these. `cwd` must equal the resolved cwd, `createdAt` must round-trip as an ISO timestamp, and PID must be a positive safe integer no greater than 2,147,483,647. Read only a regular file, without following a symlink, within 16 KiB. Source: `extensions/agent/claims.ts:8-11,54-114,115-136`.

| Observation | Meaning |
|---|---|
| `absent` | Claim file is absent. |
| `dead` | Valid same-host claim; `kill(pid,0)` returned ESRCH. |
| `live` | Valid same-host claim; PID probe succeeded or returned EPERM. This is process presence, not idle state or socket readiness. |
| `unknown` | Invalid/unreadable claim, another hostname, or an unexpected probe error. This is not proof that the owner is dead. |

A consumer never removes a claim, takes a writer lock, or starts a host merely to refresh metadata. Source: `extensions/agent/claims.ts:25-35,98-136`; `extensions/agent/manager.ts:284-303,652-701`.

### Explicit stored-host acquisition

A consumer starts a stored host only after explicit user action. Selection, page load, retained discovery, and connection checks do not acquire a writer. Before the action, disclose that starting the host can resume unfinished Durable work without a new prompt. A start request contains an exact external conversation identity and a separate bounded request ID, never composer text or a task-submission payload.

The package process entry is `extensions/agent/durable-runner.ts`. Invoke it without a shell:

```text
node <trusted-harness-package>/extensions/agent/durable-runner.ts <metadata-JSON>
```

The UI reads server-owned global `<agentDir>/settings.json`, using the server's public `getAgentDir()` resolution rather than the retained record or project settings. It requires exactly one explicit local source entry in `packages` or `extensions` ending in `/extensions/agent/index.ts`. An absolute entry resolves directly; `./` and `../` entries resolve relative to the global agent directory, as the installed package manager defines. That entry selects the adjacent `durable-runner.ts`, with canonical regular-file checks and validation of the owning `harness` package and its `pi.extensions` declaration. An absent, ambiguous, disabled, or unsupported source configuration refuses before spawn. The UI package's own Agent copy is not assumed to be the configured source. Neither browser input nor retained `packageDir` selects executable source. Source: installed coding-agent `dist/core/settings-manager.d.ts:Settings`, `dist/core/package-manager.js:resolveLocalExtensionSource,getBaseDirForScope`; the configured owner package's `pi.extensions` declaration. Construct metadata from the validated catalog record with exactly the host fields below; omit `createdAt`, `view`, `threads`, `recoveryDue`, and consumer diagnostics:

```text
storageId, cwd, agentDir, packageDir, storagePath,
model: {provider, modelId}, thinkingLevel,
name?, trust?, ownerId?, independent?: {inputDigest, projectTrusted}
```

Replace `packageDir` with the installation selected by the server's configured `--pi` executable, not the retained installation or an unrelated ambient SDK import. An executable name resolves through the server's bounded PATH search; an absolute executable resolves directly. The supported shapes are the coding-agent package's `dist/bundle/cli.js` and the current managed `bin/pi` launcher beside `install/current-version`. The managed marker selects `install/releases/<version>/node_modules/@earendil-works/pi-coding-agent`; its bounded version must agree with the package manifest. Both shapes require the coding-agent package name, a valid version, its `bin.pi` declaration, and canonical CLI/package paths. Unknown wrappers or missing installation metadata refuse. If `PI_PACKAGE_DIR` is set, its canonical root must agree with that selected installation. Source: the installed coding-agent `package.json:bin`, `dist/config.js:getPackageDir`, and managed `bin/pi` launcher.

Preserve `trust`, `ownerId`, and the complete `independent` object exactly. Explicit trust participates in the owner's normal trust resolver. If independent metadata exists, `independent.projectTrusted` supplies the prioritized resolver instead. An unresolved normal decision follows the retained owner chain, not the Primary displayed in the browser. Do not replace absent trust with false, force true, fabricate an owner, or omit independent metadata. Source: `extensions/agent/durable-runtime.ts:55–79`; `durable-services.ts:553–564`; `trust-support.ts:73–109`; installed coding-agent `dist/core/resource-loader.js:352–366`.

Before dynamically loading host modules, the runner binds coding-agent, agent-core, ai, tui, and typebox imports originating under the Agent source root to the selected installation. Durable, Codemode, MCP, and Chord remain dependencies of the configured owner checkout; the binding does not redirect every Pi package. Validate the catalog identity, exact database path under the configured durable catalog root, and existing canonical regular-file/directory paths before spawn. Source: `extensions/agent/{durable-runner,installation-binding,host-protocol}.ts`.

A live same-host writer claim requires attach and negotiation without a spawn. An unknown claim refuses acquisition. For an absent or proven-dead claim, launch one detached runner with ignored stdin and drained stdout/stderr. The runner, not the consumer, acquires and releases its writer claim. Consumers never remove, rewrite, or lock claims. Concurrent starts for one storage join the same attempt; repeated request IDs retain the same outcome. If another process wins the claim, its live ownership remains authoritative and the consumer attaches to that owner. It never signals the competing owner. Source: `extensions/agent/{claims,host-process,host-client}.ts`.

After the listener starts, the owner prints one line with this prefix and JSON record:

```text
PI_AGENT_HOST_READY {"pid":positiveInteger,"socketPath":absolutePath,"contract":RuntimeContract}
```

Read a bounded amount of output within a bounded deadline. A matching malformed line is a refusal, not ordinary output. Validate the spawned PID, the derived socket path, and the current operation descriptor. `serverId` is not a readiness field; derive it from metadata and verify it through the public Unix transport handshake. Then use the existing negotiated preparation and observation paths for the exact conversation. A usable composer requires a negotiated `task-submit` capability. Readiness alone proves neither a compatible connection nor a valid conversation. Source: `extensions/agent/host-protocol.ts:parseHostReadyLine`; `extensions/agent/host-process.ts:runHost`; `extensions/agent/host-client.ts:launchRunner`.

The host owns its lifetime independently of the UI. Runtime construction resumes unfinished conversations, tool work, and retained deliveries before the socket starts and before READY is emitted. A readiness, negotiation, or startup timeout does not prove that native work was never admitted. Source: `extensions/agent/durable-runtime.ts:324–350`; `durable-host.ts:353–362`; `host-process.ts:277–302,688–711`; owner-installed Durable `dist/harness/{harness,scheduler}.js:resume`. Retain an uncertain attempt while its child remains alive; offer an explicit connection check rather than automatic relaunch or task submission. Malformed readiness, socket mismatch, connection failure, browser loss, and UI shutdown never justify killing admitted or pre-existing work. UI shutdown cancels only its own readiness wait and closes its observations/transports. A confirmed exited child permits a new explicit attempt. The owner client's current cleanup implementation is not a consumer requirement or permission to interrupt work. Source: `extensions/agent/{durable-runner,host-process,durable-runtime}.ts`.

## Saved context creation

The browser's explicit `agent.convert` operation creates a new native root from
an ordinary saved session. It never resumes or writes the ordinary file. Public
primary discovery records at `<store>/.primaries/<id>.json` supply only declared
identity, cwd, name and saved-file association. A name fallback requires matching
the file header identity and canonical file path. Saved name declarations,
including clears, remain authoritative. Discovery does not establish a live
selected branch or idle state.

The UI captures a complete unchanged file in current format version 3, bounded to 64 MiB,
32 MiB per record and 65,536 records. Conversion's 4 KiB name check is only an
outer byte bound. Native host metadata still limits names to 256 UTF-16 code
units and rejects control characters (`host-protocol.ts`). A source name outside
that existing native contract refuses; conversion never expands the limit or
truncates the name. The worker has a 15-second capture deadline
and a bounded heap. Invalid UTF-8, JSON, headers, entries, duplicate identities,
missing parents, cycles, incomplete final records and changed input refuse.
Public `parseSessionEntries` then `buildSessionProjection` selects the final
persisted leaf; `convertToLlm` applies Pi's custom/bash/summary semantics. System
entries, system prompts, tool definitions and ordinary runtime state do not enter
the native initialization.

The server selects `create-saved-context.ts` only from global configured Agent
resources. Its internal process contract uses metadata with `protocol: 1`,
server-owned roots and package directory, source identity, cwd, optional actual
name and a stable request key. stdin contains only the projected message array,
with a 64 MiB ceiling. stdout returns `protocol: 1`, `state`, `identity`, and
`name`; a completed result names the new identity. A definite pre-admission
refusal is rejected. Lost acknowledgment or failure after creation starts is
uncertain, not an instruction to replay.

The Agent helper uses existing preference selection, catalog deduplication,
exclusive host admission and root profile/name initialization. It supplies no
prompt. Initialization requires a fresh writer claim and an absent storage file;
it never attaches to an existing root or overwrites its context. The runner checks
storage absence inside the writer claim. A collision remains unconfirmed rather
than acknowledging an empty or unrelated root. The detached runner accepts the
bounded initial array through stdin;
`ConversationInit` appends matching UserEntry, AssistantEntry and ToolResultEntry
model messages in order. Original message timestamps, content and
`argumentsError` remain intact. Tool-result entries have empty native diagnostics
and no invented task receipts; original result details stay in the model message.
The new root uses fresh execution and trust settings. Source queues, reports,
role, live leaf and coordinator ownership are not transferred. Repeated UI
requests retain the same operation key; uncertain creation is never replayed
automatically. No ordinary owner endpoint or resource reload is a conversion
prerequisite. The creating SDK must satisfy the current minimum Pi version.

## Chord wire contract

The live interface uses the published Chord `remote`, `method`, `createHost`,
`Link`, and `Frame` contracts. The package-level transport entrypoint serves
both Agent and UI; neither imports the other's private implementation. Its
contract runtime values use these exact closed schemas:

```typescript
import { hostFamily, method, remote } from "@earendil-works/chord";
import { Type } from "typebox";

const Endpoint = remote("pi.agent.endpoint", {
  version: 1, host: hostFamily("pi.agent:", "serverId"),
  input: Type.Object({ serverId: Type.String() }, { additionalProperties: false }),
  variants: { default: { methods: {
    request: method(Type.Object({
      method: Type.String({ minLength: 1, maxLength: 128 }),
      params: Type.Optional(Type.Unknown()),
      requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      contract: Type.Optional(Type.Unknown()),
    }, { additionalProperties: false }),
    Type.Object({ value: Type.Optional(Type.Unknown()) }, { additionalProperties: false })),
  } } },
});

const Feed = remote("pi.agent.feed", {
  version: 1, host: hostFamily("pi.agent:", "serverId"),
  input: Type.Object({
    serverId: Type.String(),
    kind: Type.Union([Type.Literal("changes"), Type.Literal("observation")]),
    token: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  variants: { default: { state: {
    value: Type.Object({ ready: Type.Boolean(), value: Type.Optional(Type.Unknown()) },
      { additionalProperties: false }),
  } } },
});
```

One UTF-8 JSON Chord frame followed by LF forms one socket record. The adapter
handles split and combined reads, ordered writes, backpressure, byte bounds,
and close. It rejects invalid UTF-8, malformed JSON, a nonobject frame or
missing string tag, and an invalid initial hello before Chord dispatch.
Chord validates its remaining frame protocol. Chord owns its hello, call, result, cancellation,
subscription, and state protocol. No retired Pi service envelope is accepted.

The default frame bound is 16 MiB of UTF-8 JSON, excluding LF. `maxFrameBytes`
bounds received frames. `maxSendFrameBytes` independently bounds outgoing JSON
frames, excluding LF, and defaults to `maxFrameBytes`. A consumer with a complete
socket-record budget of `N` bytes sets `maxSendFrameBytes: N - 1` to reserve LF.
Independent bounds let clients accept large observations while limiting smaller
requests without changing the wire contract.

The default outgoing queue bound is 64 MiB of encoded bytes, including LF.
Every socket write stays charged until its write callback completes, even when
`socket.writableLength` is zero. This includes call and control frames; a
successful callback releases exactly that write's encoded bytes. Write errors
close the Link without proving non-admission. Before receiver registration, the
queue bound counts JSON frame bytes without LF. Both `connectTransport` and
`createTransportServer` accept `maxFrameBytes`, `maxSendFrameBytes`, and
`maxQueueBytes`; the listener forwards its limits to each accepted Link.
These are encoded-byte limits, not universal maxima on user messages, native
values, or complete observations. JSON escaping changes the encoded size;
equal numeric defaults do not establish equal payload capacity across wire
formats. Larger exchanges require suitable limits at both peers.

The first server frame is `hello` with `kind: "host"`, exact expected
`name: pi.agent:<serverId>`, protocol 4, and a nonnegative safe-integer `codeVersion`. The client rejects a
mismatch and forwards the same matching hello to Chord. The server accepts only client
peers and assigns a unique connection principal; supplied frame fields do not
select that principal. Filesystem permissions, not the public name, enforce
same-user access. Attach failure grants no authority to start or replace a host.

Create a Chord client host with explicit self and principal values and an
upstream `{link, principal}`. Acquire `host.hold(Endpoint, {serverId})` and await
its readiness with state disabled within the handshake deadline. Placement comes
from the declared host family, not an `at` option. References use `Ref`; await
hydration before reading state. The server opens named `self.state` and
`self.resource` handles. Run calls through `host.root()`. Unwrap the response's
optional `value` without converting absent values to `null`. Chord errors
remain errors, not empty data. Malformed application input uses `invalid`.
Version refusal uses `unavailable` with reason `version`; other availability,
claim, and internal distinctions remain in the reason. The shared server keeps
Chord errors intact and wraps untyped failures as `unavailable/internal`.
Link loss is a separate failure. Do not encode an error code in its message.

The Unix Link closes on a received `bye` instead of forwarding it. Sending
after close is a no-op. Serialization or queue overflow closes the Link and
returns `undefined` from `send()` without a throw or a partial offending frame.
Chord treats that absent byte count as zero.
A successful send returns the encoded byte count including LF. Chord owns its
frame acknowledgments; the adapter does not reinterpret them as byte credits.
The public `UnixLink.onSendRefusal` event supplies that unsent frame and a
`LocalTransportRefusal` before close notification. Its `code` is
`"transport-local-refusal"`; its `reason` is `"frame-limit"`, `"queue-limit"`, or
`"serialization"`. Its optional `encodedBytes` is the UTF-8 JSON size excluding
LF, absent when serialization fails. Sending after close produces no refusal.

`TransportClient.request` throws that exported class only for the exact
Endpoint call that the adapter refused before socket write. Correlation uses
the local invocation's async scope, the Endpoint hold, and the `request` call
member, not cloned argument identity, application request IDs, error text, or
another control frame. Concurrent already-written requests interrupted by that
close retain link-loss errors: their admission and side effects remain uncertain.
Incoming overflow, remote errors, cancellation, and synchronous or asynchronous
socket write failures do not acquire the local-refusal classification. This
allows each client to distinguish definite local non-admission from uncertain
loss without replaying a mutation automatically.

Close attempts a bounded `bye` and ends the socket. The listener refuses an
existing path. It binds a private unpublished name and publishes a hard link
without replacement, so Node's own close cannot unlink a substituted public
socket. Cleanup unlinks only the public socket whose device/inode it recorded.

Both Agent and UI import `transport/index.ts`; neither imports another slice's
transport implementation or supplies a second adapter. Its public factories
are `connectTransport`, `createTransportServer`, `createUnixLink`,
`connectUnixLink`, and `listenUnixLinks`. The client exposes `request`,
`subscribe`, `onClose`, `connected`, and `dispose`; `subscribe` returns a
hydrated `value` and `dispose`. Reconnect creates a new client host and fresh
Feed handles and observation tokens, not `host.connect()` with old handles.
Sources: `transport/{index,endpoint,unix-link}.ts`.

The manager's retained-object identity is `manager/4.0.0`; ordinary primary
channels use `primary-delivery/3.0.0`. The typed `deliver` payload accepts optional
`requireRetained:boolean`, defaulting to true. Source-ledger owner and fallback
routes explicitly require retained acceptance: an exact `agent.peer` source
identity and matching entry bytes in the primary's actual session JSONL file,
not a queued call to Pi's void `sendMessage`. Direct ordinary-primary submit/report
routes explicitly set false and accept queued admission without a retention
promise; they have no source ledger to retry a pending refusal. Deduplication
keeps those acceptance modes separate. The source ledger retains retry ownership
while bounded file verification is incomplete. Unrelated transcript records are
streamed past without a record-size limit or general transcript validation. A new custom-only session remains unconfirmed
until Pi flushes its first conversation. Older endpoints refuse the new channel;
restart the primary and source hosts at their agreed safe boundaries. Their Endpoint methods are `info`,
`deliver`, and `trustPrompt`, with the existing single payload in `params`
and no host operation contract. Host operation identities and
`retained-read/1.0.0` do not change merely because the wire changes. A version
refusal contains an incompatible call; it is not a safe activation plan.

## Negotiation and request envelope

Negotiate on the expected server target:

```json
{"method":"runtime-contract"}
```

Call `Endpoint.request` with `{method:"runtime-contract"}` through a Chord root. The response wrapper's `value` is:

```text
{
  format: "pi.agent.contract/1",
  release: semver,
  upstream: {codingAgent: semver, durable: semver},
  requires: {codingAgent: stableSemver, durable: stableSemver},
  operations: {[member]: {request: string, response: string, durable?: semver}}
}
```

The parser rejects malformed descriptors, invalid operation names, more than 128 operation entries, invalid operation records, and unmet advertised API floors. Floors and release labels are not a promise of compatibility with future releases. Source: `extensions/agent/version-contract.ts:14-28,72-116`; `extensions/agent/host-client.ts:338-347`.

An operation call uses:

```text
host.root(ctx => endpoint.request({
  method: member,
  params,
  requestId: wireRequestId,
  contract: expectedOperationContract,
}, ctx), {signal})
```

The host recognizes `runtime-contract` before operation dispatch. Otherwise it compares the supplied operation's request, response, and optional Durable identities against its own identities **before parsing or admitting the operation payload**. A mismatch produces a Chord `unavailable` error with reason `version` and no operation is admitted. The client also checks before dispatch. Source: `extensions/agent/host-client.ts:499-516`; `extensions/agent/host-process.ts:523-544`; `extensions/agent/version-contract.ts:118-131`.

A consumer must possess an expected contract for the payload it implements. It must not simply echo unknown identities from the remote descriptor: that defeats the check. Require equality of request, response, and optional `durable`. Missing or malformed negotiation disables the host; mismatch of one operation disables that operation. Check the complete dependency set for a composite action. Re-negotiate after reconnect with a fresh transport client. Do not infer compatibility from source release ordering, endpoint liveness, or a successful unrelated call. Source: `extensions/agent/version-contract.ts:118-131`; `extensions/agent/host-protocol.ts:218-223`; `extensions/agent/host-client.ts:325-347,499-506,640-646`.

### Current operation identities

`D` below is the exact `@earendil-works/pi-durable` release loaded by that process, not a future version pinned by this document. A consumer of opaque native values compares it with the Durable representation it supports. The descriptor's `release` is currently `1.0.0`.

The current descriptor requires `codingAgent: "1.3.0"` and `durable: "1.4.0"`. Native timer and check-in deadline tasks use `TaskRuntime.sleepUntil()`; the ordinary service API floor remains unchanged. Chord wire 4 is a separate transport contract. These are minimum required APIs, not dependency pins, a supported-version ceiling, or a substitute for exact operation checks. Read floors from the loaded descriptor, not from the source release label. Sources: `extensions/agent/version-contract.ts`, `durable-timers.ts`, `durable-checkins.ts`, and the installed Durable `dist/types.d.ts`.

For every member in the following set, request and response are both `<member>/1.0.0`, with no `durable` field:

```text
close attach report acknowledge abort release reset
 timer-list timer-cancel observe-close changes
 collaboration-list collaboration-read collaboration-mutate await-release
```

`release` aborts the target, places eligible queued writes, and requests host retirement with blockers reported.

Overrides and remaining members:

| Member | Request | Response | Durable |
|---|---|---|---|
| recovery-state | recovery-state/1.0.0 | recovery-state/1.1.0 | absent |
| submit | submit/1.3.0 | submit/1.1.0 | absent |
| passive-submit | passive-submit/1.1.0 | passive-submit/1.0.0 | absent |
| spawn | spawn/2.0.0 | spawn/2.0.0 | absent |
| place | place/2.0.0 | place/2.0.0 | absent |
| resolve-agent | resolve-agent/2.0.0 | resolve-agent/2.0.0 | absent |
| receipts | receipts/1.1.0 | receipts/1.2.0 | D |
| inspect | inspect/1.1.0 | H-inspect | D |
| status | status/1.0.0 | H-status | D |
| list | list/1.0.0 | H-list | absent |
| fork | fork/1.0.0 | fork/1.0.0 | D |
| rewind | rewind/1.1.0 | rewind/1.0.0 | D |
| compact | compact/2.0.0 | compact/2.0.0 | D |
| run-scope | run-scope/1.0.0 | run-scope/1.0.0 | absent |
| run-stop | run-stop/1.0.0 | run-stop/1.0.0 | absent |
| request-cancel | request-cancel/1.0.0 | request-cancel/1.0.0 | absent |
| configure | configure/1.3.0 | configure/1.3.0 | absent |
| command | command/1.1.0 | command/1.0.0 | D |
| timer-schedule | timer-schedule/1.1.0 | timer-schedule/1.0.0 | absent |
| dashboard | dashboard/1.0.0 | H-dashboard | absent |
| snapshot | snapshot/1.0.0 | snapshot/2.0.0 | D |
| observe-open | observe-open/1.0.0 | observe-open/2.0.0 | D |
| observe-frame | observe-frame/1.0.0 | observe-frame/2.0.0 | D |
| profile-read | profile-read/1.0.0 | H-profile-read | absent |
| profile-update | profile-update/1.0.0 | H-profile-update | absent |
| profile-list | profile-list/1.0.0 | H-profile-list | absent |
| task-submit | task-submit/1.0.0 | task-submit/1.2.0 | absent |
| await-state | await-state/1.1.0 | await-state/1.1.0 | absent |

Each `H-*` is the lowercase hex SHA-256 of `JSON.stringify` of the owning schema, not a hash of a response instance. The current schema-derived identities are:

```text
H-inspect       d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b
H-status        d1f5f022e262aba18b6de135e891aef526cf9f0f62f114e51f3c132e624eb6cf
H-list          76e932a0749fd72c9aef6b90635d061e455f84fb57f7f9bd102034cf28887600
H-dashboard     a89f98f3eb28c78f115c0010581107073600bfb9ec44934ad622aeb5d1cffcd7
H-profile-read  b78d87440ae527566e0f13603e638dfa057aaa87f2985521e32b9c859baa1889
H-profile-update 7c805d143fae0d6a9fd373a4acb24fc080c94fa4b0787d447545e08714907eb4
H-profile-list  0eb5c60290d491535a1dd158e5d5ed4432eb8f89fe26a496a395e08b58ff4db4
```

Schema owners in table order are `InspectOutputSchema`, `StatusOutputSchema`, `ListRowSchema`, `AgentConversationSummarySchema`, `AgentProfileSchema`, `ProfileUpdateSchema`, and `ProfiledListOutputSchema`. `dashboard` returns an array despite its response identity hashing the row schema. Maintain these identities with the defining schemas; do not infer a complete result shape from the schema name alone. Source: `extensions/agent/version-contract.ts:30-56`; `extensions/agent/durable-host.ts:454-457`.

`StatusOutputSchema` owns the host response identity. Caller-side catalog rank, inventory coverage, and priority omission counts belong to the existing `ToolStatusSchema` overview extension, not to that wire schema. The caller's catalog scan produces those facts; a host status response does not. An actual host schema change changes its generated operation identity.

The table lists advertised identities, not a claim that all members have the same target or side-effect policy. The consumer operations below define the relevant payloads. `changes` gates a Feed subscription; it is not an ordinary runtime request member.

The current `extensions/agent/observation-schema.ts` permits conversation task
statuses `running`, `ready`, `waiting`, `sleeping`, `completing`, and `blocked`.
`StatusOutputSchema` includes this closed enum; its schema identity therefore
covers sleeping-state support. `InspectOutputSchema` retains its current shape
and identity. Exact native operations still bind D independently of schema hashes.

Conversation task rows permit optional native `startedAt` and `endedAt`.
Durable stamps wall-clock milliseconds at first running and terminal state;
the span includes waits and recovery, not only execution. Status selects live
tasks, so their terminal `endedAt` remains absent. Missing timestamps remain
absent.

## Native result inspection

The existing `inspect` operation accepts `{sessionId?,view:"result",requestId?,submissionId?,entryId?,operationId?}`. The selected storage/conversation qualifies every lookup; a root session uses its storage UUID and a child uses `UUID:conversationId`. One of requestId, submissionId or operationId is required. A native requestId resolves exactly through public `Tx.submissionByRequest(conversationId,requestId)`, not a report ID, text search or another store.

Multiple selectors must identify the same native submission. A supplied entryId must equal its native input/write entry, not its answer entry. Conflicting selectors fail. OperationId is a separate admission value resolved through retained receipts in the selected conversation; it is never a requestId alias. A missing operation receipt is unavailable rather than an unverified operation association.

A missing native submission returns `{view:"result",sessionId,conversationId,status:"unavailable",reason,usage}` with the supplied requestId/submissionId/operationId selectors when present. It invents no submission ID or native entry. A found result retains the native status, submissionId, producer requestId, entry/answer IDs and answer/reason fields. RequestId selects only the result view. Native terminal tool text uses the same validated output. No new operation, store or private-store parser participates.

## Roster publications and dashboard

### Native dashboard operation

Params: `{conversationId?: positiveInteger, cwd?: string}`. Result: `AgentConversationSummary[]`, not `{rows,coverage}`. The cwd supplies presentation context. This reads one host's native summaries; it does not enumerate the machine's catalog. Source: `extensions/agent/durable-host.ts:454-457,481-490`; `extensions/agent/durable-observation.ts:705-708`; `extensions/agent/dashboard-types.ts:60-104`.

A summary has required fields:

```text
{id, storageId, cwd, modifiedAt:number, owner, state, cost:number, partial:boolean}
```

Optional fields are `creatingOwnerId`, `name`, `firstMessage`, `model:{provider,modelId,thinkingLevel}`, `ownerLabel`, `latestReply`, `error`, `toolCalls`, `currentTool:{name,argument}`, `durationMs`, `health`, and `awaiting`. Manager-enriched rows can also include `profile`; it is not part of the base native row contract. `owner` is `here | unavailable | unknown`. `state` is `starting | working | idle | done | failed | stopped | interrupted | new | unavailable`. `health` carries optional `lastError`, `compactionFailure:{reason,at?,errorMessage?}`, and `autoRetry:{attempt,maxAttempts,delayMs,errorMessage}`. `awaiting` is optional retained wait information; a consumer that does not display it leaves it opaque. Source: `extensions/agent/dashboard-types.ts:13-104`; `extensions/agent/version-contract.ts:54`; `extensions/agent/manager.ts:677-700`.

Dashboard summary `durationMs` remains the wall-clock span of the latest user turn, ending at the live clock while busy or the final retained message when settled. It is not recorded tool execution time. Activity `runningTools.elapsedMs` remains elapsed time from the tool-call entry, qualified by `elapsedFrom:"tool-call-entry"`. Native task timestamps do not replace either quantity. These are the separate `turnDuration` and `activityMetadata` projections in
`extensions/agent/durable-observation.ts`; native task execution duration does
not replace them.

### Catalog view and machine roster

`CatalogView` is:

```text
{
  updatedAt: ISO timestamp,
  rows: AgentConversationSummary[],
  coverage: {complete:boolean, omitted:nonnegativeInteger},
  storageId?:string, unavailable?:string,
  profiles?:bounded profile hints,
  profileSeed?:retained creation defaults,
  attention?:bounded intervention hints,
  modelEvidence?:bounded sampled evidence
}
```

The serialized view is at most 24 KiB. Producer text fields are bounded at 2,000 UTF-16 code units, including any truncation marker. Truncation never splits a surrogate pair. The root row is first when it fits. `coverage.complete:false` includes omitted rows **or trimmed text**. Missing hints/evidence are unknown, never zero. Invalid view shape or mismatched storage identity makes the view unavailable; it does not make the database empty. Source: `extensions/agent/catalog-view.ts:20-65,91-148,151-192`; `extensions/agent/catalog.ts:264-275`.

`profiles` has this closed hint shape:

```text
{
  rows: [{identity:string, handle:string|null, role:string, revision:string,
          hasExpertise:boolean, updatedAt:number|null}],
  coverage: {complete:boolean, omitted:nonnegativeInteger}
}
```

Join a hint's `identity` to the exact conversation row `id`. A known handle includes
its leading `@`; `null` means that profile has no handle. An absent hint is unknown,
not a handle clear. `revision` identifies the retained profile state; `updatedAt`
is its update time in milliseconds, or null when absent. `role` is a bounded role
hint, and `hasExpertise` reports whether the profile retains expertise without
publishing that text. Profile hints use only the remaining publication budget and
never evict operational rows. Their coverage is separate from row coverage.
Sources: `extensions/agent/profile-schema.ts` `ProfileHintSchema` and
`ProfileHintsSchema`; `extensions/agent/catalog-view.ts` `withProfileHints`.

`attention` has this shape:

```text
{
  rows: [
    {identity:string, kind:"provider-blocked", blockId:string}
    | {identity:string, kind:"task-blocked", taskId:positiveInteger,
       reason:"missing_task"|"task_too_old"|"migration_failed"|"restart_limit"}
    | {identity:string, kind:"failed-turn"}
  ],
  coverage: {complete:boolean, omitted:nonnegativeInteger}
}
```

Join each hint to the exact conversation row `id`. At most one hint appears per
row, with provider block before blocked task before failed turn. Provider blocks
require explicit recovery; blocked tasks require host repair; failed turns need a
new input. `restart_limit` identifies a task parked by the native restart guard.
Expected task sleep does not create an attention hint. Automatic retry and
compaction diagnostics do not establish a need for intervention. Absence remains unknown even with complete publication coverage;
this section does not detect unanswered human questions. Hints use only space
left after native rows and profile hints. Coverage counts omitted hints and rows,
not an inferred number of intervention needs. The base row state enum is unchanged.
Sources: `extensions/agent/catalog-attention.ts` `projectCatalogAttention`;
`extensions/agent/catalog-view.ts` `withAttentionHints`.

A manager roster composes retained views with current claim observations:

- live claim → `owner:"here"`;
- absent/dead claim → `owner:"unknown"`;
- unknown claim → `owner:"unavailable"`;
- any non-live claim changes a published `working` state to `interrupted` and removes `currentTool`;
- missing/unavailable view produces an unavailable row, not a fabricated native state.

`ownerLabel` records publication time and any claim error. Published state, cost, and health remain observations at `updatedAt`, not fresh native assertions. Source: `extensions/agent/manager.ts:677-700`.

Manager `dashboardPage()` composes caller-local roster rows and coverage; it is not a host operation. `AgentCatalog.priorityPage()` inspects every candidate in the initial directory snapshot with bounded record and claim reads, then selects a finite output. Live hosts and caller-owned records come first; file modification time and identity order each group. Coverage includes the complete scan, output bounds, unknown claims, excluded records and rows, and per-storage view exclusions. Roster continuations rank a fresh snapshot, so changed publication time or claims can move records across the cursor; refresh to rediscover them. `AgentCatalog.page()` retains bounded filename-based reads for stable `agent_list` and thread discovery. Neither read is a frozen snapshot. Sources: `extensions/agent/catalog.ts`; `extensions/agent/manager.ts` `dashboardPage`; `extensions/agent/dashboard-types.ts`.

## Transcript pages and inspection

### Snapshot

Params: `{sessionId, before?:positiveInteger, limit?:integer, maxBytes?:integer}`. `limit` is bounded to at most 200 entries. The default byte target is 65,536; the maximum requested byte target is 1,048,576. `before` selects entries strictly older than that native entry ID. Source: `extensions/agent/durable-host.ts:821-824`; `extensions/agent/durable-observation.ts:705-708,1102-1130`.

Result:

```text
{
  entries: Entry[], partial:boolean, revision:string, nextBefore:number|null,
  taskSenders?:Record<entryId,{identity:string,name?:string}>,
  coverage:{complete:boolean,entries:number,bytes:number,hiddenExcluded:number,
            entryLimitReached:boolean,byteLimitReached:boolean}
}
Entry = {id:string,kind:string,communication:CommunicationView,model?:PiMessage[],data?:JSON,head?:string}
```

Entries are oldest first. System and communication bookkeeping entries are hidden. `revision` is an opaque display revision, not a durable replay cursor. Preserve `partial`, coverage, and `nextBefore`; an empty bounded scan with null continuation does not override `complete:false`. Earlier reads scan at most eight source pages of 64 entries. Source: `extensions/agent/dashboard-types.ts:107-135`; `extensions/agent/durable-observation.ts:1037-1057,1102-1200`.


Native assistant and tool-result messages retain optional recorded `durationMs` through snapshot projection and existing terminal component handoff. Assistant duration times the final response stream; tool duration times its executed attempt, not task waits or recovery. Interrupted or unavailable results need not carry duration. The assistant schema permits the native field without a new timing view. Sources: `extensions/agent/{durable-observation,observation-schema,dashboard-conversation}.ts`,
`pi-durable/dist/harness/tool.js`, `pi-ai/dist/utils/event-stream.js`, and
coding-agent `dist/modes/interactive/components/tool-execution.js`. These source
contracts do not establish terminal rendering under every process or task.

**Byte-bound exception:** selection admits the first visible entry even if that entry alone exceeds `maxBytes`. `coverage.bytes` measures source-entry selection, not a hard serialized response bound. Model messages, entry data, and live frames require separate consumer output/memory bounds. Source: `extensions/agent/durable-observation.ts:1063-1097`.

### Inspect

Params: `{sessionId, view?, limit?, cursor?, entryId?, fromId?, offset?, query?, source?, requestId?, submissionId?, operationId?}`. `requestId` selects only `view:"result"`. Supported views are `activity`, `history`, `branch`, `search`, `exact`, and `result`; the raw host default is `history` (`extensions/agent/durable-observation.ts:1858-1873`). Sources are `user`, `assistant`, `toolResult`, `summary`, and `custom`. `cursor` is an opaque JSON object: pass the returned cursor unchanged to the same query/target, never fabricate it from entry IDs. Source: `extensions/agent/durable-observation.ts:77-90,524-541`; `extensions/agent/durable-host.ts:612-618`; `extensions/agent/observation-schema.ts:47,306-427`.

Output is discriminated by `view`:

| View | Result fields |
|---|---|
| history | `{view:"history",format:"compact",sessionId,conversationId,entries:CompactEntry[],nextCursor:object|null,order:"newestFirst",detail:string}` |
| branch | Same common history fields, `view:"branch"`, raw entry rows instead of compact format. |
| activity | `{view:"activity",format:"compact",sessionId,conversationId,turns:[{entries:CompactEntry[]}],nextCursor,metadata,coverage,detail}` |
| exact | `{view:"exact",sessionId,conversationId,entryId,offset,text,nextOffset:number|null,truncated,omissions?}`; text is retained redacted JSON, not an unredacted archive. |
| search | `{view:"search",sessionId,conversationId,matches,nextCursor,coverage:{scannedEntries,scannedBytes,complete},detail}` |
| result | Retained result: `{view:"result",sessionId,conversationId,submissionId,status,requestId?,operationId?,entryId?,answerEntryId?,reason?,answer?,usage,providerBlock?,recoveryOf?}`; status is queued, placed, done, or unanswered. Unavailable result: `{view:"result",sessionId,conversationId,status:"unavailable",reason,usage,requestId?,submissionId?,operationId?}`; only supplied selectors are retained, with no fabricated submission or entry. |

`providerBlock` is an optional retained fact in result inspection and conversation status. Its closed shape is `{blockId,conversationId,providerSessionId,epoch,model:{provider,modelId},error,errorRedacted,errorTruncated,source:"provider"|"host-block",timestamp,originalResults,omittedOriginalResults}`. `originalResults` contains at most 16 closed references `{sessionId,submissionId,requestId?}`; error text is bounded to 4,096 characters. `recoveryOf` is an optional string in a result. These fields do not add a result status or authorize automatic replay. Source: `extensions/agent/observation-schema.ts:143-144,413-431`; `extensions/agent/provider-block.ts:18-26`; `extensions/agent/result-reference.ts:6-10`.

`CompactEntry` has `{id:number,kind,source,role?,text,truncated,communication:CommunicationView,format:"compact",nextOffset:null,omissions?,toolCalls?,toolResults?,omittedParts?}`. Tool call summaries carry `{callId?,name,arguments,truncated}`; tool result summaries carry `{callId?,name,text,isError,truncated,durationMs?}`. This optional duration is the native recorded execution duration; zero stays present and missing duration stays absent. It is not derived from entry timestamps or running-tool elapsed time. Raw rows omit the compact discriminator and may carry `preview:{text,truncated}` plus `nextOffset`. Omission counters are `{providerSignatures,imagePayloads,redactedThinking}`. Search matches carry `{entryId,kind,source,matchOffset,excerpt,excerptText,truncated}` and their cursor is `{cursor:object|null,skip,scannedBytes}`. Source: `extensions/agent/observation-schema.ts:306-377`.

Activity metadata contains `{owner,live,operation:number|null,runningTools,pending:number|null,streamedText?,lastError?,compactionFailure?,autoRetry?}`. Running tools carry `{toolCallId,name,taskId?,parentToolCallId?,parentTaskId?,issuedAt?,elapsedMs?,elapsedFrom?}`.
Nested rows retain native task and parent-call identity rather than a fabricated
model-issued result. Missing timing and parent fields remain absent. Activity coverage includes scanned entries/bytes, complete, entry/scan-byte/output-byte limit flags, output bytes, omittedEntries, and metadataTruncated. Usage is `{models:{[key]:Usage},tools:{[key]:Usage}}`, with Pi usage values; consumers need not display financial fields to read an answer. Source: `extensions/agent/observation-schema.ts:49-60,379-425`.

These are retained/read projections, not proof of operation completion outside the requested result reference. Exact continuation uses `nextOffset`; history/activity/search use `nextCursor`. Do not silently exchange them.

## Collaboration threads

A collaboration thread is a shared frame (purpose, authority, restrictions, acceptance, integrator), a member list, and an append-only exchange of numbered events. Each thread lives in the storage that created it, and its identity is `<storageId>/<32 lowercase hexadecimal characters>`. A storage-scoped list or read serves only that storage: there is no cross-storage native index. A live connection selects the storage; the [independent retained reader](#independent-retained-reads) selects it through a verified bare storage UUID and reads a private snapshot without starting a host. Cross-storage discovery uses catalog hints, then a consumer selects each storage for a full list or read.

`collaboration-list` and `collaboration-read` are read-only, retry-safe, and have no `durable` identity (see [Current operation identities](#current-operation-identities)). Neither takes `sessionId` or `conversationId`; the connection selects the storage. They never start a model or write state. `collaboration-mutate` is not described here. Text fields are returned as stored, with no truncation except the 160-character `purpose` of a list summary.

### Catalog thread discovery

The existing optional catalog-record field is separate from `CatalogView`:

```text
threads?: {items:CollaborationSummary[], omitted:nonnegativeInteger, updatedAt:string}
```

The producer selects the last eight keys in the storage's thread index, newest
creation first, then removes summaries until the serialized `items` array fits
4,000 UTF-8 bytes. Updating an older thread does not move it into that selection.
`omitted` counts indexed threads without a returned summary, including selected
frames that were unavailable and summaries removed for space. Missing hints
mean unknown discovery coverage, not an empty thread index. The publication's
`updatedAt` records hint publication time, not the latest event time of every
thread. Full frames, members, and exchange events remain in native storage.

Catalog discovery searches only these summaries, including their shortened
purpose. Its cursor binds the query and the publication identity for an
unfinished storage. Changed hints require a fresh query. It does not freeze
all catalog records across pages. A full storage-scoped retained list uses the
native index instead of this hint selection and therefore reaches threads
omitted from hints. Sources: `extensions/agent/collaboration.ts`
(`projectCollaboration`), `collaboration-discovery.ts`, and `catalog.ts`.

### collaboration-list

Params: `{cursor?:string, limit?:integer 1..20, query?:string}`. `limit` defaults to 10. `query` is nonblank, at most 256 characters, and matches case-insensitively as a substring of a thread's `title`, `purpose`, or `id`. `cursor` is a canonical decimal offset into this storage's thread index, between zero and its current length. It is not bound to the query, index revision, or publication time. Repeat the same query to continue the intended search. The page scan reads at most 64 indexed thread frames per call, so a page can hold fewer items than `limit` (or none) and still carry a non-null `nextCursor`. The reader validates all present index keys before the page scan, including their selected-storage prefix when the caller supplies that controlled target. Continue until `nextCursor` is `null`. The order is the creation order of the index, oldest thread first. Each retained invocation captures its own snapshot; appended threads or changed query matches affect later pages. Source: `extensions/agent/collaboration.ts` (`listCollaboration`); `extensions/agent/durable-host.ts`.

Result:

```text
{
  items: CollaborationSummary[],
  nextCursor: string|null,
  coverage: {complete:boolean, visited:number, omitted:number, unavailable?:number}
}
CollaborationSummary = {id:string, title:string, purpose:string, updatedAt:number, closed:boolean, members:number}
```

`purpose` is the first 160 UTF-16 code units of the thread's purpose. `updatedAt` is epoch milliseconds of the latest event. `members` is the member count in the selected state, not live participant presence. `coverage.visited` counts indexed frames tested for this page, not index-key validation, and `coverage.complete` means the page scan reached the end of that index in this request. Native local lists report `omitted:0` and no `unavailable`; this does not establish complete global discovery or a frozen cross-request snapshot. An absent index in an otherwise valid storage yields an empty indexed list. A malformed present index or an index that names a missing frame is a source error, not an empty result. Source: `extensions/agent/collaboration.ts` (`listCollaboration`).

### collaboration-read

Params: `{threadId:string, limit?:integer 1..20, before?:positiveInteger}`. `threadId` is required and must be an identity returned by `collaboration-list` or by thread creation. `limit` defaults to 10. `before` is an exclusive upper event sequence: the page holds the newest events with `sequence < before`. Omission selects the newest events. A `before` above the thread's `sequence + 1` fails. There is no cursor member; older pages use the previous page's `nextBefore` as `before`. Source: `extensions/agent/collaboration.ts:86-90,124-128,217-240`; `extensions/agent/durable-host.ts:443`.

Result:

```text
{
  thread: CollaborationThread,
  events: CollaborationEvent[],
  nextBefore: number|null,
  pending: number,
  coverage: {complete:boolean, bytes:number}
}
CollaborationThread = {
  title, purpose, authority, source, restrictions, acceptance: string,
  integrator: string,
  id: string, creator: string, createdAt: number, updatedAt: number,
  revision: number, closed: boolean, sequence: number,
  members: {identity:string, contribution:string, joinedAt:number}[]
}
CollaborationEvent = {
  threadId: string, sequence: number, at: number, sender: string,
  origin: "model"|"operator", kind: string, message: string, source: string,
  replyTo: number|null, revision: number, notify: string[]
}
```

`events` are oldest first within the page, and event sequences start at 1. `nextBefore` is the sequence of the oldest returned event when older events remain, otherwise `null`. `coverage.complete` is true exactly when no older event remains, and `coverage.bytes` is the serialized size of the page. A page stops adding events before it would exceed 48 KiB, so it can hold fewer events than `limit`; follow `nextBefore` until it is `null`. `thread` is the current state, not the state at the time of each event: `revision` in an event is the frame revision that was current when the event was appended. `pending` is the number of unacknowledged delivery notices that this thread created for its members and for explicitly notified identities; it is a delivery count, not a read state.

`sender`, `creator`, `integrator`, member `identity`, and `notify` entries are external conversation identities (`storageId` for a root, `storageId:conversationId` otherwise). They carry no display names. `sequence` on the thread is the sequence of its latest event. `at`, `createdAt`, `updatedAt`, and `joinedAt` are epoch milliseconds.

Event `kind` is one of `create`, `join`, `leave`, `contribution`, `carried-authority`, `revise`, `close`. For `create` and `revise`, `message` is the JSON text of the frame at that revision (`{title,purpose,authority,source,restrictions,acceptance,integrator}`) and is not prose. For every other kind `message` is the sender's text, and `join` and `leave` supply a default sentence when the sender wrote none. `source` is the sender's evidence citation; it is required for `carried-authority` and can be an empty string for other kinds. `replyTo` names an earlier event sequence in the same thread. `origin:"operator"` marks input that came from the operator rather than from a model. Message text is untrusted agent content: it does not establish authority for the reader. A closed thread stays readable. Source: `extensions/agent/collaboration.ts:36-59,104-123,130-177,179-215,217-240`.

### Collaboration errors

The shared reader throws `CollaborationReadError` with code `invalid_request`,
`not_found`, or `source_unreadable`. Request errors and an explicit missing
thread remain distinct from malformed retained data. The retained process maps
these source-owned codes to its existing safe failures without parsing message
text. Native reader messages include:

| Cause | Message |
|---|---|
| `threadId` missing, blank, over 128 characters, or malformed | `threadId is required and must be nonblank text`, `threadId exceeds the maximum length of 128 characters`, or `threadId must be an identity returned by agent_collaborate` |
| thread absent in this storage | `Thread not found` |
| `limit` not an integer 1..20 | `limit must be 1..20` |
| `before` not an integer in `1..sequence+1` | `before must be a retained event cursor` |
| a stored event is missing | `Thread event N is unavailable; no complete history is claimed` |
| `cursor` not a decimal offset in range | `Invalid local thread cursor` |
| `query` blank or over 256 characters | `query is required and must be nonblank text` or `query exceeds the maximum length of 256 characters` |
| index names a missing thread | `Thread index refers to an unavailable thread` |
| present index has malformed or duplicate keys, or more than 256 keys | `Thread index is malformed` |
| indexed key disagrees with the controlled selected storage | `Thread index refers to a different storage host` |
| stored frame or participants are malformed | `Thread frame and participants are malformed` |
| stored event is malformed | `Thread event N is malformed` |
| stored pending-notice count is malformed | `Thread delivery pending count is malformed` |

An absent index returns an empty indexed list. It does not trigger an orphan
scan. A malformed present index, missing indexed frame, or unavailable/malformed
event returns `source_unreadable`, never complete empty history.

Source: `extensions/agent/collaboration.ts` (`CollaborationReadError`, `readIndex`, `readThread`, `readEvent`, `listCollaboration`, `readCollaboration`). The cold observation path used when a storage has no live host serves the same two members with the same functions (`extensions/agent/durable-observation.ts:2186-2189`); the manager's `agent_collaborate` tool reaches the same data through its discovery and storage routing.

## Live observation and change subscriptions

### Open, subscribe, and close

Open params are `{token,scope:"conversation",sessionId}` or `{token,scope:"tasks"}`. A token contains 1–128 letters, digits, dots, underscores, colons, or dashes; use a fresh random token for a fresh connection. `observe-open` returns `{token,frame}`. `observe-frame` with `{token}` returns the current frame. `observe-close` with `{token}` returns `{closed:boolean}`. Source: `extensions/agent/durable-host.ts:101-117,841-859`.

After open, acquire a Feed on the **same accepted connection**:

```text
host.get(Feed, {serverId, kind:"observation", token}, {at:serverId})
```

The host tracks tokens by the assigned connection principal and rejects an
unowned token. Subscribe to the handle's `value`. Ignore `ready:false` and
undefined hydration; the first `ready:true` value is the baseline
`ObservationFrame`. Prefer that baseline to the earlier open result. Later
values are complete current frames. A ready `null` value means the observation
is unavailable. Chord applies its own deltas internally; consumers do not parse
retired service snapshots or custom delta envelopes.

Release the Feed handle and subscription, then await `observe-close` on the
same accepted connection. The host retains token ownership during automatic
cleanup and joins that cleanup before the explicit close response. A repeated
close returns `{closed:false}` for an absent token; this acknowledges cleanup,
not an error. Foreign active tokens and malformed requests remain invalid.
Disconnect releases all connection-owned tokens, including admission races.
The disconnected attachment retains its token ownership until all pending native
closes settle; another connection cannot use those tokens during cleanup.
Reconnect uses fresh tokens and a new baseline, not old live state.
Source: `extensions/agent/host-process.ts:323-334,385-395,495-505`.
Mark observations unavailable immediately on link loss. Hydration supplies a
current snapshot, not replay of missed events.

A conversation frame is:

```text
{
  scope:"conversation",storageId,conversationId:number,revision:number,observedAt:string,
  entries:Entry[],nextBefore:number|null,live:Entry[],status:ConversationStatus,
  coverage:{complete,entries,bytes,hiddenExcluded,entryLimitReached,byteLimitReached}
}
```

`entries` are committed visible entries; `live` is uncommitted assistant/tool output. Live IDs include `live:generation` and `live:tool:<callId>`. They must not become committed history. The frame is coalesced current state, not an append-only event stream. Revision ordering applies within the current observation lifetime; a new connection/token starts a new baseline. Source: `extensions/agent/live-frames.ts:15-30,74-140`; `extensions/agent/host-client.ts:697-741`.

`ConversationStatus` includes `{conversationId,identity,busy,lastText,live,inbox,agent,tasks,submissions}` and optional `name`, `owner`, `firstMessage`, `forkSource`, `ownerTaskId`, `awaiting`, `cwd`, `lastTextRole`, `usage`, `timers`, `providerBlock`. `agent` carries `{model?:{provider,modelId},thinkingLevel,extensions:string[],tools:string[],cwd?,instructions?}`. Tasks carry `{id,kind,status,background,owner?,abortRequested}`; submissions carry `{id,type:"input"|"write",status,requestId?,entryId?,answerEntryId?,reason?}`. Native `live`, `inbox`, usage, and task statuses belong to the exact declared
Durable representation. `live.nestedTools` has real task IDs, parent call/task
IDs, arguments, progress, and optional terminal summaries. `live.compactionFailure`
contains its task ID, reason, and error, not a fabricated timestamp. The
presentation health projection therefore keeps `at` optional. Source: `extensions/agent/durable-observation.ts:99-156`; `providerBlock`: `extensions/agent/observation-schema.ts:143-144`.

A tasks frame is `{scope:"tasks",storageId,revision,observedAt,tasks,labels,coverage:{complete,live}}`. Task rows contain `{id,kind,conversationId,owner?,background,abortRequested,status,phase,until?,blocked?,waitsOn,policy?,outcome?,conversations}`; labels contain `{conversationId,identity,name?,firstMessage?}`. Graph statuses are `pending`, `running`, `waiting`, `sleeping`, and `completing`. A sleeping row supplies `until`, an absolute deadline on the native Harness clock. Optional `blocked` is the native reason `missing_task`, `task_too_old`, `migration_failed`, or `restart_limit`; it is separate from the graph status. Sleeping is expected state, not a failed turn. Sources: `extensions/agent/live-frames.ts` and the installed Durable `dist/harness/task-graph.d.ts`.

Dispose the subscription and close its token when no longer observed. Disconnect cleans connection-owned observations; explicit token cleanup is still the normal path. Observations keep a host alive and block native reload. Disconnect/observation close do not abort admitted work. The host `close` operation is runtime/process shutdown and is not client cleanup. Source: `extensions/agent/host-process.ts:443-456,535-539`; `extensions/agent/host-client.ts:746-767,891-919`; `extensions/agent/durable-runtime.ts:375-411`.

### Changes

After checking the `changes` operation identity, acquire Feed with
`{serverId,kind:"changes"}` and subscribe to `value`. Ignore hydration until
`ready:true`; its value is `{revision:number}`. Later revisions coalesce actual
runtime writes per microtask. Read-only operations create no change event.
These are subscription-local invalidations, not catalog deltas or replay
cursors. Release the handle and subscription on close.

## Native namespace creation and recovery

A managed namespace binds a catalogue root to one sealed Agent source and its Pi dependency installation. Runtime setup supplies these paths. A browser never selects an executable or rebinds a retained store. Existing ordinary roots keep their original source route. New namespaces remain outside the ordinary manager's configured catalogue, so an older manager cannot acquire them after their host retires.

`extensions/agent/create-conversation.ts` accepts a JSON argument:

```text
{protocol:1,root,agentDir,packageDir,cwd,requestId,
 name?,model?,thinkingLevel?,preset?,existingSources?:[{root,sourceRoot,packageDir}]}
```

It creates an empty native root through `AgentManager`, with no fabricated primary role or project-trust override. Saved trust decisions retain their normal authority. Model and preset resolution use the selected machine document and the supplied installation. A completed receipt is `{protocol:1,state:"completed",identity,name,root,sourceRoot,packageDir}`. Rejected and uncertain receipts use the same state field. Identity is null when creation never established one. Runtime binds the complete creation request before invoking the helper and preserves an uncertain result instead of blindly repeating creation. The manager's native catalogue request key deduplicates the underlying creation.

The optional `existingSources` inventory contains exact trusted root/source/installation routes, not copied profiles or tasks. Agent setup merges those immutable bindings into `<root>/native-sources.json`. Nested managers read the inventory from their namespace root. Handle resolution checks the current catalogue and the bounded selected roots, rejects ambiguous or unavailable ownership, and executes a retained target through its original source and dependencies. Native controls, exact-result waits, producer watches and public observations use the target's runner and dependency installation, not the caller's installation. An earlier source needs its existing public runner and host contracts, not a newly added helper file. An identity absent from the selected native catalogues requires a real registered ordinary-primary descriptor before ordinary routing is considered. Missing native metadata alone is never that proof. This inventory is deployment metadata. Native documents remain authoritative for profiles, requests, tasks and ownership.

`extensions/agent/namespace-recovery.ts` accepts `{protocol:1,root,agentDir,packageDir,cwd,existingSources?}` as its JSON argument. A runtime supervisor starts it through Chord's `forkDriver` and `createHostManager`, with a per-namespace process lock. The child supports ready, status and shutdown control messages. Ready confirms the recovery owner, not completion of every recovery. Its bounded stdout report is `{protocol:1,type:"namespace-recovery",visited,attempted,complete,failures}`. The owner reuses `AgentManager` catalogue recovery and host-loss observation without an ordinary primary or a second task index. Parent disconnect and shutdown release its clients and observations, not admitted native work. Each retained namespace keeps its selected source and dependency installation during restoration.

## Operator admission and controls

### task-submit

Text input params:

```text
{
  sessionId:string, message:string,
  origin:"operator", requester:string, replyTo:string,
  requestId:string, whenBusy?:"steer"|"followUp"|"reject",
  operationId?:string, checkInMinutes?:number
}
```

The broader native input also accepts content-part arrays; a text-only consumer need not implement them. Origin and requester are required. `replyTo` defaults to requester, so a consumer seeking a self-owned result must explicitly set `replyTo` to the target conversation. The server supplies senderIdentity from that conversation; do not impersonate a native sender to create work. Source: `extensions/agent/durable-host.ts:420-430`; `extensions/agent/durable-controls.ts:221-238`.

The result is `{submissionId:number,conversationId:number,deduped:boolean,identity:string,result:{sessionId:string,submissionId:number,requestId?:string}}`. The request above produces a result reference with its requestId. It confirms admitted/already-admitted work, not execution, placement mode, final answer, or operator acceptance. Steer waits for a native boundary; it does not interrupt a running tool. Explicit `followUp` normally waits for the current run to end. Source: `extensions/agent/durable-host.ts:420-430`; `extensions/agent/durable-controls.ts:235-245,401-447`; `extensions/agent/result-reference.ts:53-61`.

During active `agent_await`, admitted explicit input, including `followUp`,
releases the wait and joins the current work at its post-tools boundary. It does
not guarantee a separate next answer. Native explicit report delivery carries
report provenance: an awaited producer's report releases the wait, while an
unrelated report on that route keeps normal follow-up placement. The ordinary
`AgentManager` report control instead submits without report provenance; the
recipient classifies it as explicit input, so it releases an active await even
when its sender is not an awaited producer. A same-storage background
`Reporter` answer notification uses raw native `followUp` without release
provenance and does not itself release the wait. Automatic input classification,
check-in suppression, and scheduled-message placement do not change. See
[await admission and continuity](../extensions/agent/README.md#await-exact-peer-results).

The original request remains open after release, with unresolved producer
references retained and their work still active. The recipient applies the
input, then awaits unresolved references again on that same request. Distinct
admitted inputs retain distinct request IDs. Recorded requester/reply routes
remain per request, even when several inputs share one final answer. A generation
hook resolves each native run input through its submission and entry. It inserts
one frozen `agent-request-route` user note immediately after that input's last
user message. The note holds requestId, requester, replyTo and origin. Static
system guidance explains automatic final-answer delivery and explicit report
routing; the system section contains no per-request route list.

The host retains notes per conversation with count and byte bounds. Saved notes
hold native entry IDs, input-message digests including timestamps, and frozen
text. Task memos freeze only this set. Each call resolves positions from current
request messages, including retry after overflow compaction. Unique digests skip
the native context view only while the prior user-message sequence through the
last noted input is an exact prefix. A rolling hash and count retain that prefix
inside bounded conversation state, excluding trailing guidance messages. Without
that prefix, every retained, memoised and new note uses native entry identity;
this includes host start, eviction and compaction. Duplicate digests also use
native entry order. Compaction drops absent inputs' notes. A restarted host
reconstructs notes from active routes only. The route hook adds no changing
per-request bytes while its notes remain retained. This claim excludes other
hooks and a separate guidance tail. Internal hook errors return no change;
aborts still propagate.

A storage-scoped document holds a random secret created once inside a commit.
HMAC-SHA256 of the conversation ID derives a stable tag. Both the static section
and each `<agent-request-route host="TAG">` note carry that tag. Blocks without
the exact attribute, and blocks quoted inside inputs or tool results, have no
route or origin authority.

The tag marks host-written notes against route-like text inside inputs and tool
results. It is not a boundary against local agents or forks: Durable agents run
bash, local processes can read the secret in the storage SQLite file, and forks
already copy their parent's context.

Status and Profile omit the tag and secret.
Inspection replaces only tag values inside the route guidance with
`[withheld route tag]` and retains the guidance. Inspection schemas and operation
contracts remain unchanged. A search for the tag does not match. This route hook
does not put the secret in model messages or inspection.

At the per-conversation count or byte bound, current-run notes stay
and the oldest settled notes leave first. A host-wide byte bound evicts the least
recently used whole conversation. Its next request reconstructs active notes.
These bounded evictions change a cached prefix but never refuse generation.
Profile reads remain unchanged. An input without a note has no retained route
evidence; read `agent_profile` before an
explicit report. Interim reports use `agent_send` with mode `report` and that
input's replyTo. Creating-owner provenance never selects the recipient.
Durability preserves admitted work and its routes; it does not prescribe answer
timing or separate answers. Sources:
`extensions/agent/durable-controls.ts` (`awaitInputMode`, `admitConversation`),
`awaited-results.ts` (`classifyAwaitInput`, `reconcileInputRelease`),
`request-context.ts` (`recordRequestContext`, `requestContextHooks`, `requestContextSection`),
`request-route-state.ts` (`RequestRouteState`),
`manager.ts` (`controlClient`), `durable-delivery.ts` (`reportProvenance`), and
`durable-agents.ts` (`Reporter`).

The ordinary manager's `control("submit")` maps to `task-submit`; raw host `submit` is a different base operation. Match the documented wire member, not a manager method name. The standalone terminal uses operator origin and self-owned replyTo. Source: `extensions/agent/manager.ts:469-514`; `extensions/agent/terminal-client.ts:123-131`.

### compact

Params: `{sessionId,instructions?}`. `compact/2.0.0` requests native compaction without first aborting foreground work, background work or queued input. Native work continues while compaction prepares its result. The summary enters context at a native boundary. The response retains the native compaction observation and therefore compares the exact Durable identity `D`. Explicit Stop remains a separate operation. Self-compaction retains its native completed-tool boundary.

### run-scope and run-stop

`run-scope({sessionId})` returns:

```text
{
  sessionId,runId:number|null,taskId:number|null,
  inputs:[{sessionId,submissionId,requestId?}],
  delegations:[{sessionId,createdBy,ownership:"created"|"reused",
                result?:{sessionId,submissionId,requestId?},reporterTaskId?,anchorTaskId?}],
  coverage:{complete:boolean,omitted:number}
}
```

`runId` is the first native input submission ID in the selected admitted group. It is an opaque selector, not a task ID. `taskId` observes the current native generation. Native generation handover changes taskId while the admitted group continues with the same input identities. An idle conversation returns null selectors. Native task ancestry and retained input/task links associate owned dispatches with their input group, including dispatches from an earlier generation.

`run-stop({sessionId,runId,inputs?})` returns:

```text
{
  sessionId,runId,state:"stopped"|"settled"|"partial"|"protected",
  inputs:[{sessionId,submissionId,requestId?}],
  delegations:[{sessionId,runId?,state:"stopped"|"settled"|"cancelled"|"protected"|"unavailable",reason?}],
  coverage:{complete:boolean,omitted:number},effects:"partial-effects-possible"
}
```

Stop follows native generations only while the exact selected input remains in their admitted group. A later independent group remains untouched. An optional `inputs` list requires every observed input in the selected group to belong to that exact owned set. Delegated Stop uses this guard for both active and retired groups to preserve shared work in reused agents. A synchronous native commit observer cancels a guarded abort before admission if unrelated input joins. Generation handovers trigger bounded re-observation of the same input group, never a conversation-wide abort fallback.

Stop withdraws each exact owned queued delegation before it considers active work. It then traverses each original admitted input's local or foreign group, including surviving descendants after that input answers. Retained native input/task links recover the observed cohort of a retired group. A newer unrelated group is neither selected nor aborted. Several owned references for one cohort share one guarded traversal. A settled submission alone does not establish that its descendants stopped. Native background reporters associated with the selected group stop separately. A creator label or a result reference alone does not establish ownership. Unknown ownership, unavailable host contracts, in-flight dispatch without a confirmed result, or a traversal limit produces an explicit protected, unavailable or partial boundary. `coverage.omitted` counts known omitted source rows and incomplete capture/scan markers. It is not a total of unseen tasks. Cancellation does not undo external effects.

### request-cancel

Params: `{result:{sessionId,submissionId,requestId?}}`. The result is `{result,state:"aborted"|"already_placed"|"settled"|"not_found",effects:"not-started"|"partial-effects-possible"}`. The host verifies the exact native conversation and request identity. Only an actual native `aborted` outcome establishes `not-started`; if placement wins the race, the response reports `already_placed` with possible partial effects. This operation never guesses a task or broadens to a conversation abort.

Sources for these controls: `extensions/agent/run-control.ts`, `run-control-state.ts`, `durable-host.ts`, `durable-agents.ts`, `durable-runtime.ts`, and the installed Durable generation, submission and commit implementations.

### abort

Params: `{sessionId,background?:boolean}`; background defaults false. Result: `{conversationId,identity,background}` after the abort control returns. Aborting the foreground does not imply stopping background ownership trees. Do not resend an uncertain abort automatically: it could stop later work. Source: `extensions/agent/durable-host.ts:710-715`; `extensions/agent/host-protocol.ts:196-202`.

### configure

Use `{sessionId,requestId,name?,model?,thinkingLevel?,preset?}`. A model is `{provider,modelId}`; the runtime also resolves a canonical model string and execution preset before native configuration. Prefer the object form. Thinking values are `off|minimal|low|medium|high|xhigh|max`. Name can clear via an empty string; the inner native layer accepts null values, but the runtime's preset/model resolver runs first, so null is not a generic outer reset contract. Supply concrete supported values or omit fields. Configuration requires an idle conversation. Source: `extensions/agent/configuration.ts:3-28,65-80`; `extensions/agent/durable-host.ts:732-747`; `extensions/agent/durable-runtime.ts:356-373,457-460`; `extensions/agent/durable-controls.ts:849-865`.

Result:

```text
{
  sessionId, outcome:"applied"|"failed",
  before:{name,model:string|null,thinkingLevel:string|null},beforeSource:"live"|"retained",
  requested:{name?,model?:string,thinkingLevel?},
  after:{name,model:string|null,thinkingLevel:string|null},afterSource:"live"|"retained",
  reasoning?:{requested,effective:string|null,clamped:boolean|null},
  hookErrors:{count,events:string[],omitted,observation},
  persistence:{nativeWrites:"completed"|"uncertain"|"not-attempted",fileExists,note},
  error?:string,truncated?:string[],selection:ExecutionSelection
}
```

`selection` carries `{inputDigest,source,preset?,presetNames,values,origins,unapplied,diagnostics,thinking?}`. `source` has `{path,digest:string|null,observedAt,status}`; values contain optional model/thinking/role/check-in fields; origins name explicit/preset/defaultPreset/retained/default; diagnostics contain field/message. A request key retains the resolved selection, not permission to replay the whole mutation after arbitrary later work. Do not automatically retry configure after an uncertain outcome. Source: `extensions/agent/configuration.ts:15-43`; `extensions/agent/agent-preferences.ts:24-48`; `extensions/agent/durable-runtime.ts:356-373,457-460`; `extensions/agent/host-protocol.ts:196-202`.

### status

Params for one conversation: `{sessionId}`. `status` is read-only and retry-safe. The reply to a live host is `{conversation:ConversationStatus, inventory:HostInventory, pid:number, storageId:string, deliveryError?:string}`; a host that is not live answers `{conversation, live:false, storageId}` with no inventory and no process identity. A consumer that wants commands reads only `inventory` and `storageId`, treats `conversation` as an opaque object, and treats a missing `inventory` as unavailable, never as an empty list. Without `sessionId` the reply lists up to 50 conversations (`conversations`), which a command consumer does not need.

```text
HostInventory = {
  contributions: {name:string, source:string, commands:{name:string, description:string}[]}[],
  ordinaryOnly: string[],
  failed?: {path:string, error:string}[]   // present only when an extension failed to load
}
```

`contributions[].name` is the contribution that supplies its commands, and `source` is where it was loaded from. `ordinaryOnly` names extensions that load but add no host command. The response identity is the schema hash `H-status`, so a consumer checks the operation identity above and the shape it uses, and refuses a reply whose `inventory` has a field outside this shape. The inventory belongs to the loaded runtime: a host reload replaces it, so a cached copy is valid only for the connection it was read on. Source: `extensions/agent/observation-schema.ts:243-249,317-320`; `extensions/agent/durable-runtime.ts:508`.

### command

Params: `{sessionId, name:string, args?:string, invocationId:string, data?:JsonValue}`. `name` is a command in the host inventory. `args` is the text after the name and defaults to empty. `invocationId` is required by the host and is correlation only: it is not an idempotency key, so reusing it does not make the host skip a second run (the runtime fills a missing one from the wire request ID). The host runs the command against the target conversation and answers after the command returns.

Result: `{name:string, conversationId:number, identity:string, text:string}`. `text` is whatever the command returned and has no host bound below the transport frame bound, so a consumer that shows it bounds it itself.

Two names are reserved for the host's own use and are never contribution commands: `tree` (a fork at a native entry) and `reload` (a runtime reload that needs an idle storage and closed observers). A consumer that lists or runs commands leaves them out. A name the host has not registered fails with `durable command <name> is not registered`; a command that throws fails with the thrown message. Both are definite answers from the host.

`command` is not retry-safe. A command can change state, and a lost connection says nothing about whether it ran. Do not resend after a lost connection, a malformed reply or a timeout; report the outcome as unknown and let the operator decide. A command that answers with an error may have changed state before it failed, and the answer text is the only evidence. Source: `extensions/agent/durable-host.ts:832-848`; `extensions/agent/durable-runtime.ts:398-440,507`.

## Request keys, retry, and completion

There are three distinct IDs:

1. Chord's call ID, owned by its runtime.
2. `wireRequestId`, the Endpoint request's `requestId`, retained by a caller across safe link recovery.
3. Native `params.requestId`, the admission/mutation key. The runtime fills a missing native key from the wire key for task-submit, profile-update, submit, rewind, and report.

Keep both application keys stable for the same logical request, including its target and original input. Never reuse a key for edited text. Request admission deduplicates; this is not an exactly-once guarantee for external tools or provider calls. Source: `extensions/agent/host-client.ts:499-516`; `extensions/agent/host-process.ts:517-528`; `extensions/agent/durable-runtime.ts:477-480`; `extensions/agent/durable-controls.ts:235-240,389-423`.

The current retry-safe method set is exactly:

```text
profile-read profile-list profile-update task-submit resolve-agent
collaboration-list collaboration-read collaboration-mutate passive-submit
submit report acknowledge inspect status list receipts dashboard snapshot
observe-open observe-frame observe-close timer-list
```

Unknown methods, abort, configure, fork, rewind, compact, spawn, place, reset, close, and timer mutations are not made retry-safe merely by having a request ID. A consumer may use a narrower retry policy. Observation reconnection creates fresh tokens and a new baseline. The shared transport supports caller-local cancellation of a Chord wait. The
Agent adapter forwards its call signal to the native runtime only for
`receipts` with `wait:true`; other cancellation or disconnect must not cancel
admitted work. The separate ordinary-primary `trustPrompt` also supports caller
cancellation. Observation cleanup releases handles and tokens, not native work. Source: `extensions/agent/host-protocol.ts:196-235`; `extensions/agent/host-client.ts:546-553,697-740`.

Admission and answer delivery are separate. Native result inspection or retained delivery receipts establish result state. Acknowledgment marks receipt delivery, not operator acceptance of the answer. Self-owned result delivery acknowledges in place without another model input. Ordinary RPC prompt IDs have no equivalent native retry guarantee. Source: `extensions/agent/durable-controls.ts:905-936,995-1043,1103-1140`; `extensions/agent/README.md:1453-1460,1535-1547`.

## No-start observation versus acquiring controls

Catalog/presence reads, attach-only `connectHost`, and manager observational reads do not launch a host. Without a live host, the manager uses a bounded cold database/WAL capture for observation. This is not a wire operation and is not zero-cost filesystem work. A surviving live claim still subjects manager reads to live connection negotiation; the independent reader below does not use that route. Source: `extensions/agent/manager.ts` (`observationConnection`, `observeDurableStorage`); `extensions/agent/cold-observation.ts` (`openColdObservationSnapshot`); `extensions/agent/snapshot-capture.ts` (`captureSnapshot`).

Acquiring controls resolve the retained record and acquire/start its owner. An explicit attach can resume unfinished work even with no new prompt. Low-level `snapshotHost()` acquires despite its name; do not use it as an attach-only helper. Native wire spawn requires a sender conversation in an already running host; there is no hostless spawn member available from a bare transport client. Fleet/effort composition and ordinary-primary intent publication are manager functions, not host members. Source: `extensions/agent/manager.ts:469-523,762-783,830-851`; `extensions/agent/host-client.ts:910-932`; `extensions/agent/durable-runtime.ts:411-438`.

An upgraded writer follows the [store migration and retained-consumer
boundary](pi-durable-harness.md#store-format-and-retained-task-versions).
Existing consumers retain intact source and dependency bytes until their
owner-agreed transition; a new process must load one complete accepted runtime.
Cold observation opens SQLite only on a disposable copy, not the retained source store.
It does not authorize a live writer or a consumer restart.

## Independent retained reads

`extensions/agent/retained-read.ts` exposes `retained-read/1.0.0` outside a Pi
session. It reads retained snapshot, inspection, collaboration, and Recents evidence
without starting or resuming an agent. It is a separate executable, not a
`durable-runner.ts` mode, Unix service, or live-host fallback. Consumers use this process contract rather
than importing Agent implementation modules or parsing private SQLite shapes.

### Recents facts

`--contract recents` advertises only `operations.recents`, with request and
response identity `recents/1.0.0`, inside `retained-read/1.0.0`. Each request
supplies that exact operation identity and the reader's current Durable version.
`method:"recents"` accepts a bare storage UUID and
`params:{conversationIds:[1,2,...]}`. The batch contains unique positive integer
IDs, bounded by `RECENTS_CONVERSATION_LIMIT` in `extensions/agent/recents.ts`.
The result is `{items:[{conversationId,activity}]}` with exactly one item per
requested conversation. Each activity contains
`{creator,createdAt?,lastUserAt?,lastAnswerAt?,hasMessages?}`. Times are finite
epoch milliseconds. `creator` is `operator`, `agent`, or `unknown`.

The public pure `creationActor()` export owns retained root classification.
Consumers do not interpret Agent caller identifiers. The current reader copies
one retained snapshot per storage batch and classifies native conversation
metadata before reading message activity. An explicit native task owner means
`agent`. Otherwise, a fork marker and operator correction admission with the
same request ID and child ID establish `operator`. A later operator input with
a different request ID does not reclassify a plain fork or model-created child.
Children never inherit root classification. Plain command creation, plain
forks and ownerless roots without defining actor evidence remain `unknown`.
No migration, guessed origin or additional origin store exists.

Only confirmed operator conversations receive message-activity scans. Those
scans exclude inherited entries from other conversations. Operator message
time uses explicit retained admission origin. Answer time uses completed
assistant text, not tool-call rounds or status. Unknown creation time stays
absent rather than inheriting the root's time. A header-only conversation has
`hasMessages:false`. Reading changes neither execution nor retained source data.

The UI enriches the same cached rows asynchronously. Publication revisions
trigger one bounded batch of published conversation IDs per storage, with
concurrency and frequency bounded in `ui/agents/catalog.mts`. A storage has no
parallel batch of its own. Sidebar paints do not start reads. A failed or
pending read leaves the ordinary-session list and cached Agent rows available.

### Invocation and descriptor

Invoke without a shell:

```text
node <agent-extension-directory>/retained-read.ts --contract
node <agent-extension-directory>/retained-read.ts --contract collaboration
node <agent-extension-directory>/retained-read.ts --contract recents
node <agent-extension-directory>/retained-read.ts
```

The backend chooses its current packaged reader independently of the target's
execution source and starter. Existing hosts keep their execution source and
package tuple. Browser input and retained `packageDir` never select the reader. The reader uses its own installed package graph.
It does not load the retained target's package directory, cwd resources,
settings, credentials, models, or extensions.

`--contract` emits `{version,upstream:{codingAgent,durable},operations:{snapshot,inspect}}`
without reading catalog or storage. `version` is exactly `retained-read/1.0.0`.
The loaded reader derives upstream versions and both operation values from
`HOST_CONTRACT`; the default descriptor still advertises no other operations.
`--contract collaboration` emits the same envelope version and upstream fields,
with only `operations:{"collaboration-list","collaboration-read"}`. Those are the
existing operation contracts, each with request and response identity
`<method>/1.0.0` and no `durable` member. This selector does not change the
default descriptor or any live operation identity. A consumer must explicitly
support the selected descriptor and payloads. See the
[descriptor fixture](#fixture-retained-read-descriptor) for default negotiation.
The runtime emits its own loaded versions and schema identities. Examples are
neither a supported-version ceiling nor a substitute for checking the reader's
supported contracts before a request.

Default mode reads exactly one UTF-8 JSON request on stdin followed by EOF.
The caller closes stdin and drains stdout/stderr concurrently. The reader emits
exactly one JSON object plus newline on stdout. Stderr contains diagnostics,
never protocol data. Success or descriptor exits 0; a structured read failure
exits 1. Bootstrap/process failure without a valid envelope is a transport
failure, not an empty history result. The caller owns this short-lived child;
there is no server, socket, detached owner, watcher, or subscription.

### Request and exact negotiation

The closed request shape is:

```text
{
  version: "retained-read/1.0.0", id: string, store: absolutePath,
  sessionId: string,
  method: "snapshot" | "inspect" | "collaboration-list" | "collaboration-read",
  expected: {request: string, response: string, durable?: string},
  params: object
}
```

Every top-level field is required, including `params:{}` for a snapshot with
no optional parameters. Unknown fields fail. History uses method `inspect`
with `params.view:"history"`; there is no history alias.

- `id` is nonempty, at most 256 UTF-16 code units, and contains no whitespace or
  control characters. It correlates this process response only, not native
  requestId, operationId, or submission ID.
- `store` is an absolute filesystem path, at most 4096 code units, with no
  control characters. It is the existing sessions root containing `durable/`,
  not a database file path.
- `sessionId` is a canonical lowercase storage UUID for root conversation 1,
  or that UUID plus `:` and a canonical positive safe decimal conversation ID
  greater than 1 for snapshot and inspect. Collaboration methods require the
  bare storage UUID and return root `conversationId:1`; child targets fail.
  Handles, names, root `:1`, leading zeros, and paths fail.
- `expected` is the closed existing `OperationContract` shape. Its identity
  strings are nonempty, at most 256 code units, with no ASCII spaces/control
  characters; `durable`, when present, is a valid semantic-version string.

The reader validates the envelope, expected operation, and parameter grammar
before catalog or source-storage access. It parses `expected` with the existing
operation parser and compares request, response, and optional Durable identity
by exact equality against its selected `HOST_CONTRACT` operation. Snapshot and
inspect require the matching Durable identity. Collaboration operations have
no Durable identity, so an added `expected.durable` also fails. Consumers supply
the identities of the payload they support; echoing an unknown descriptor does
not establish compatibility. The descriptor does not replace the per-request
check, including when the executable changes between invocations. Live-host
negotiation remains separate and unchanged. See
[current operation identities](#current-operation-identities) and the
[snapshot request fixture](#fixture-retained-read-request).

### Parameter grammar

Only the top-level `sessionId` selects a target. Unknown parameter fields,
including `sessionId`, `conversationId`, `cwd`, and `ownerId`, fail. The reader
injects the verified identity internally after validation.

Snapshot parameters:

```ts
{ before?: number; limit?: number; maxBytes?: number }
```

`before` is a positive safe integer; `limit` is an integer from 1 through 100;
`maxBytes` is an integer from 1 through 1048576. Omitted values use existing
snapshot defaults. This public limit is narrower than the live snapshot limit.
Existing page selection, first-entry byte exception, coverage, and `nextBefore`
semantics still apply; the process response has a separate hard byte bound.

Inspect parameters:

```ts
{
  view: "history" | "branch" | "activity" | "exact" | "search" | "result";
  limit?: number;
  cursor?: JsonObject;
  entryId?: number;
  fromId?: number;
  offset?: number;
  query?: string;
  source?: "user" | "assistant" | "toolResult" | "summary" | "custom";
  submissionId?: number;
  requestId?: string;
  operationId?: string;
}
```

`view` is required. `limit` is an integer from 1 through 100.
`entryId`, `fromId`, and `submissionId` are positive safe integers; `offset` is a
nonnegative safe integer. Numbers are required, not decimal-string aliases.
`cursor` is a JSON object with at most 4096 serialized UTF-8 bytes. Pass returned
cursors unchanged to the same target/query. `query` is nonempty and at most 256
code units. `requestId` and `operationId` are nonempty, at most 1024 code units,
and contain no control characters; their contents are not normalized.

Exact view requires `entryId`. Search requires `query`. `requestId` is legal
only in result view. Result requires at least one of `requestId`, `submissionId`,
or `operationId`. Matching combined selectors remain valid; the native reader
rejects selectors for different submissions. Allowed parameters pass through
the existing inspection parser and reader, with their existing per-view
semantics and bounds. This boundary does not invent result lookup rules.

Collaboration list parameters:

```ts
{ query?: string; cursor?: string; limit?: number }
```

`query` is nonblank and at most 256 UTF-16 code units. `cursor` is the canonical
nonnegative safe decimal index offset, at most 16 code units; its current range
is checked against the captured native index. `limit` is an integer from 1
through 20, default 10. These are local [list semantics](#collaboration-list), not the opaque global
hint-discovery cursor.

Collaboration read parameters:

```ts
{ threadId: string; before?: number; limit?: number }
```

`threadId` uses the existing `<storage UUID>/<32 lowercase hexadecimal>` format.
Its storage prefix must match the envelope's bare UUID before any catalog or
source access. `before` is a positive safe integer no greater than the captured
thread's `sequence + 1`. `limit` is an integer from 1 through 20, default 10.
These are the existing [thread-page semantics](#collaboration-read), including
the 48 KiB page bound and exact sequence continuation. No mutation method,
identity override, or arbitrary storage path is accepted in either parameter
object.

### Response and failures

A successful read has this closed wrapper:

```text
{
  version: "retained-read/1.0.0", id: string, ok: true,
  method: "snapshot" | "inspect" | "collaboration-list" | "collaboration-read",
  sessionId: string,
  storageId: string, conversationId: positiveSafeInteger, result: operationPayload
}
```

`result` is the unchanged current [snapshot or inspect payload](#transcript-pages-and-inspection)
or [collaboration list/page](#collaboration-threads), not a new transcript or
thread format. Collaboration responses correlate the selected bare UUID with
`storageId` and `conversationId:1`. Their documents are session-scoped, so these
methods do not require a root-conversation record to exist. The bridge verifies
every list summary's storage prefix and the read page's exact requested thread
identity; a mismatched result returns `source_unreadable`. A retained thread's
member and pending-notice counts describe the captured state, not live presence
or delivery progress. Snapshot retains native entry/model values,
communication metadata, inherited fork-origin IDs, pagination, and coverage.
The wrapper adds target correlation. Inspect retains its closed output union,
native optional timing fields, and matching sessionId/conversationId. A missing
native result selector target is a successful `status:"unavailable"` inspection,
not a process error or fabricated submission. Missing catalog or source database,
a selected snapshot/inspect conversation, or an explicit thread instead returns
`not_found`. An existing empty conversation returns its normal empty payload. See the
[success fixture](#fixture-retained-read-success).

A failure has only `{version,id,ok:false,error:{code,message,retryable}}`.
`id` is the valid parsed process ID, or null if unavailable/malformed. Failure
includes no method, target, or result fields. Messages are at most 2000 code
units and omit stacks, credentials, retained content, and incidental private
paths. Local typed failures determine codes rather than broad text matching.
See the [failure fixture](#fixture-retained-read-error).

| Code | Condition | retryable |
|---|---|---|
| invalid_request | Bad JSON, envelope, identity, parameters, unsupported method or CLI arguments | false |
| incompatible | Envelope version or expected request/response/Durable identity mismatch | false |
| not_found | Catalog, database, selected snapshot/inspect conversation, or explicitly requested thread absent | false |
| source_changed | Source identities changed during capture; copied view discarded | true |
| source_unreadable | Permissions, nonregular/symlink source, corrupt/unusable SQLite, unsupported nonempty rollback journal, malformed collaboration records, or missing indexed frame/event | false |
| limit_exceeded | Request, source, or output byte bound exceeded | false |
| timeout | Cooperative read deadline expired | true |
| cancelled | SIGINT/SIGTERM or caller cancellation of this reader | false |
| internal | Other reader failure | false |

Collaboration reads map the source-owned `CollaborationReadError` codes
`invalid_request`, `not_found`, and `source_unreadable` to these existing retained
codes. They do not classify error messages with regular expressions. An explicit
missing thread returns `not_found` with the fixed message
`The retained thread does not exist.` Invalid `before` or local index cursors
return `invalid_request`; malformed present records and missing indexed
frames/events return `source_unreadable`. An absent index remains a valid empty
indexed list, with no orphan-record scan or replacement index.

`retryable` is advice, not an automatic process loop. A consumer keeps live-host
incompatibility separate from a successful retained read.

### Source isolation and lifecycle bounds

The entire request is bounded to 65536 UTF-8 bytes. The serialized response is
bounded to 16 MiB; oversized output returns `limit_exceeded`, never truncated
JSON success. The main database plus WAL is bounded to 512 MiB. One 30-second
**cooperative absolute deadline** starts when the CLI begins reading stdin and
covers request collection, capture, open, query, and cleanup. The reader passes
the same deadline through these stages; EOF does not reset it. This is not a
hard wall-time interrupt. Copy chunks check cancellation and use a small bounded
buffer, not a source-sized allocation. Synchronous SQLite `quick_check` and
cleanup are not interruptible by a timer. The caller owns any optional hard
process timeout. Forced termination leaves source unchanged but can leave
private scratch.

The reader resolves the canonical catalog record and its exact assigned database
path. It does not accept arbitrary storage paths, cwd, or packageDir fields.
It opens source main/WAL files only with read-only, no-follow filesystem handles
and regular-file checks, never through SQLite. It rejects a nonempty rollback
journal. It copies database and optional WAL to private scratch, without copying
SHM. Before and after capture, it checks the full source identities, including
initially absent WAL: existence, device, inode, size, mtimeNs, and ctimeNs. It
compares file descriptors with current paths. Replacement, truncation, or other
identity change discards the copy without a hidden retry.

SQLite validation/recovery and paused `Harness.open` operate only on the private
copy, with an empty registry/models configuration. Opening a paused Harness
reconciles native task state in that copy; it is not live scheduler truth.
The reader never resumes, submits, waits for idle, acquires a writer claim,
initializes cwd services, or connects to/signals a live host. An absent or
incompatible live host therefore does not gate reads. An independent writer
that changes the capture returns `source_changed`, not live incompatibility.

The guarantee is no reader-caused writes, creation, or deletion in source
database/WAL/SHM/journal, catalog, claims, or retained entries/tasks/submissions.
Only private scratch is writable. Ordinary filesystem access-time accounting
and independent writer changes are outside this guarantee. On orderly success,
failure, cancellation, and timeout, the reader closes its observation and raw
handles and removes only its own scratch directory **before the response**.
Forced process termination does not promise cleanup. Scratch never resides under
the retained source store.

Every invocation returns one retained snapshot, not `live:true`, resumable-host
readiness, or fresh runtime state. Separate invocations see independently captured
state. Existing page anchors/cursors retain their semantics; no cross-request
snapshot lease or storage cache is introduced. The manager's existing bounded
cold cache remains separate and reuses only stable source identities.

Defining sources: `extensions/agent/retained-read.ts`, `retained-errors.ts`,
`snapshot-capture.ts`, `catalog.ts` (`read`), `durable-observation.ts`
(`DurableObservation`, `readInspection`), and `version-contract.ts`
(`HOST_CONTRACT`, `parseOperationContract`, `operationContractMismatch`).
Installed Durable `dist/storage/sqlite/node.js` and `dist/harness/harness.js`
define the private adapter/open behavior. These references describe source
mechanisms and protocol requirements, not runtime acceptance.

## Synthetic contract examples

These examples contain fabricated identities and data. They are valid-shape examples for consumer fixtures, not recorded sessions or evidence of execution. A fixture test must also test incompatible identities and malformed fields. Native-version-dependent fixtures use the consumer's supported `D` in their operation envelope.

### Fixture: operator-input

```json
{"method":"task-submit","params":{"sessionId":"00000000-0000-4000-8000-000000000001","message":"Describe the current state.","origin":"operator","requester":"consumer:example","replyTo":"00000000-0000-4000-8000-000000000001","requestId":"input-example","whenBusy":"steer"},"requestId":"input-example","contract":{"request":"task-submit/1.0.0","response":"task-submit/1.2.0"}}
```

### Fixture: admitted-input

```json
{"submissionId":7,"conversationId":1,"deduped":false,"identity":"00000000-0000-4000-8000-000000000001","result":{"sessionId":"00000000-0000-4000-8000-000000000001","submissionId":7,"requestId":"input-example"}}
```

### Fixture: unavailable-result

```json
{"view":"result","sessionId":"00000000-0000-4000-8000-000000000001","conversationId":1,"status":"unavailable","requestId":"missing-native-request","reason":"No native submission matches the result selector in this conversation","usage":{"models":{},"tools":{}}}
```

### Fixture: empty-snapshot

```json
{"entries":[],"partial":false,"revision":"empty","nextBefore":null,"coverage":{"complete":true,"entries":0,"bytes":0,"hiddenExcluded":0,"entryLimitReached":false,"byteLimitReached":false}}
```

### Fixture: empty-publication

```json
{"storageId":"00000000-0000-4000-8000-000000000001","updatedAt":"2026-01-01T00:00:00.000Z","rows":[],"coverage":{"complete":true,"omitted":0}}
```

### Fixture: change-state

```json
{"ready":true,"value":{"revision":1}}
```

### Fixture: retained-read-descriptor

```json
{"version":"retained-read/1.0.0","upstream":{"codingAgent":"1.4.0","durable":"1.4.0"},"operations":{"snapshot":{"request":"snapshot/1.0.0","response":"snapshot/2.0.0","durable":"1.4.0"},"inspect":{"request":"inspect/1.1.0","response":"d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b","durable":"1.4.0"}}}
```

### Fixture: retained-read-request

```json
{"version":"retained-read/1.0.0","id":"retained-example","store":"/example/sessions","sessionId":"00000000-0000-4000-8000-000000000001:2","method":"snapshot","expected":{"request":"snapshot/1.0.0","response":"snapshot/2.0.0","durable":"1.4.0"},"params":{"limit":50,"maxBytes":65536}}
```

### Fixture: retained-read-success

```json
{"version":"retained-read/1.0.0","id":"retained-example","ok":true,"method":"snapshot","sessionId":"00000000-0000-4000-8000-000000000001:2","storageId":"00000000-0000-4000-8000-000000000001","conversationId":2,"result":{"entries":[],"partial":false,"revision":"empty","nextBefore":null,"coverage":{"complete":true,"entries":0,"bytes":0,"hiddenExcluded":0,"entryLimitReached":false,"byteLimitReached":false}}}
```

### Fixture: retained-read-error

```json
{"version":"retained-read/1.0.0","id":"retained-example","ok":false,"error":{"code":"source_changed","message":"Retained storage changed during capture. Retry the read.","retryable":true}}
```

Retained-read fixture shapes: `extensions/agent/retained-read.ts`; operation
identities: `extensions/agent/version-contract.ts`. Synthetic paths and identities
are examples, not retained sessions. Agent and UI fixture tests must read these documented
fixtures independently, without imports from another slice's implementation
or tests.

Fixture shape sources: `extensions/agent/durable-host.ts:420-430`; `extensions/agent/durable-observation.ts:1133-1143`; `extensions/agent/catalog-view.ts:48-65`; `extensions/agent/host-process.ts:387-399`.
