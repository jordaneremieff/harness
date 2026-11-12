# Agent host contract

This document defines the current local boundary between the Agent host and its clients. The Agent extension owns execution, storage, admission, and publication. It may change this contract. Consumers compare supported operation identities with each connected host and refuse mismatched operations; they do not require the extension to preserve older behavior.

Communication shapes and operation identities are defined by `extensions/agent/communication.ts`, `observation-schema.ts`, and `version-contract.ts`. Collaboration thread shapes are defined by `extensions/agent/collaboration.ts`. Historical line-number references use repository revision `4a423cf2a0a822638c09228c5a10a4df1d324e82`, except receipts, configure, task-submit, status and provider-block references, which use `0468691ac2c7bdf8a85d3aa8560f2e5d87dfce26`. These references do not establish the version loaded by a running host.

Paths are relative to the repository root. References describe implementation, not runtime acceptance or the loaded version of an arbitrary running host. The companion [Durable harness track](pi-durable-harness.md) describes lifecycle context.

## Scope and identity

This is a same-user, machine-local interface. Chord's public typed host runtime supplies live calls and state over a bounded Unix-socket `Link`. The [wire contract](#chord-wire-contract) defines the boundary for Agent host clients. Payloads, catalog publications, operation identities, and retry policy remain harness contracts. The endpoint is a private directory and owner-only Unix socket, not remote authentication. Chord owns calls, cancellation, and state; the socket adapter owns framing, bounds, close, and initial identity admission.

Use these terms consistently:

- `<agentDir>` is Pi's resolved agent directory, including its configured override.
- `<store>` is `PI_AGENT_SESSIONS_DIR`, resolved as an absolute path, or `<agentDir>/agent-sessions`.
- `storageId` identifies one Durable SQLite storage and host.
- The external conversation identity is `storageId` for root conversation 1, otherwise `storageId:conversationId`.
- `conversationId`, submission IDs, and entry IDs resolve to positive safe integers. Live request parsers also accept decimal-digit strings in the corresponding ID fields; responses use numbers except display snapshot entry IDs, which are strings. Source: `extensions/agent/durable-observation.ts:473-500`.
- `serverId` is the public server UUID. The expected transport identity name is `pi.agent:<serverId>`. Neither is a conversation identity.

Source: `extensions/agent/index.ts:231-235`; `extensions/agent/identity.ts:15-19`; `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/dashboard-types.ts:107-127`.

A targeted live request accepts either `sessionId` (external identity) or `conversationId`, never both. Omission selects root conversation 1. A `sessionId` belonging to another storage is rejected. Prefer explicit `sessionId` for every conversation operation. `dashboard` is an exception: its filter is `conversationId`, not `sessionId`. Source: `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/durable-host.ts:454-457`.

Ordinary primaries are not Durable targets. Their separate presence/message channel does not expose these controls or a live terminal attachment. Source: `extensions/agent/manager.ts:526-555`.

## Native communication provenance

A `submit` request that delivers a result accepts optional `deliveredResults`: every `{sessionId,submissionId,requestId}` reference that the delivered body settles, not the bounded sample of the communication value. The host validates the list before it admits the body and refuses an invalid list without an admission. After admission it marks each matching outgoing request of the target conversation as delivered, also when the body is a deduplicated replay or was returned to a native wait. Source: `extensions/agent/durable-host.ts`, `durable-delivery.ts`, `continuity-native.ts`.

The existing `submit` and `passive-submit` request objects accept optional `communication: Communication`. This application value never changes native input parameters, model content, admission order, cancellation, reply routing or settlement. Inputs without an envelope keep the original path. Metadata rejection does not reject or resubmit an otherwise valid input.

`Communication` is a closed object with `format: "agent.communication/1"`, `sender`, `body`, `recordedAt`, `kind` and `metadata`. Sender identity is the canonical external conversation identity; optional name and kind are checked supplied facts, not labels or inferred roles. Body has `text`, `complete` and `redacted`. Redaction or omission requires `complete:false`. These local same-user assertions establish neither cryptographic authentication nor instruction authority.

| Kind | Metadata |
|---|---|
| notice | `threadId`, optional `event`, `frameRevision`, `eventKind`, `title`, `passive` |
| report | `sourceId`, `requestId`, optional `replyTo`, `passive` |
| result | `status:done|unanswered`, ordered `references`, `omittedReferences`, optional `reason`, `receiptContinuation` |
| check-in | `sourceId`, `producerRequestId`, `elapsedMs`, `origin:operator|model` |

A reference contains `submissionId` and optional `requestId`, `entryId`, `answerEntryId`. A result value describes one producer answer, or one unanswered input, for one recipient. At most sixteen references fit the value; `omittedReferences` counts only the references cut from the supplied chunk, not references on later pages. `receiptContinuation` is `{tool:"agent_inspect",view:"result",sessionId,submissionId,receiptCursor}` and is present whenever the recipient's receipt group is incomplete, also when `omittedReferences` is zero. A generic passive report has `kind:"report"` with `metadata.passive:true` and no thread fields. Native producers capture structured receipt, report, check-in and collaboration event fields before transport formatting. Existing excerpts have `complete:false`; no prose parser reconstructs missing fields.

The owner captures the first trusted envelope inside the existing post-native classification commit, before a successful host response. That commit reconstructs a classification row evicted during native admission, prepares native submission, input and index reads before classification can prune, then materializes an available link and stores the resulting intent in the existing retained input row. A late suppress classification still retains that already-admitted request before the unchanged native abort. An `aborted` result keeps the suppression response; `already_placed` or `settled` keeps the successful response and captured association. The owner records its capture time as `recordedAt`. Repeated request IDs preserve the first retained value. Conflicts do not replace an original verified association. A plain admission retains an explicit no-envelope decision in the same bounded row. Once its native entry exists, post-native capture or pre-eviction materialization transfers that decision to the persisted communication point-index family. Later capture consults that index, not just the earlier dedupe observation, so an evicted plain row never permits backfill. This marker stays unresolved publicly: it creates neither a companion nor an invalid view. A queued or canceled input without a native entry has no display link.

The existing input provenance collection watermark remains 128, not an admission cap. Its prune predicate retains queued submissions, plus the original live-run condition for unadmitted classification rows. Pending rows keep their exact classifications and communication intents even when the native backlog exceeds the watermark; they do not block later explicit input or named-producer reports. Unrelated reports and automatic inputs retain their no-release behavior. Placed submissions have left the native inbox and no longer need await-release provenance, even while their run continues. Before eviction of placed or terminal rows, the owner prepares all native and index reads for their unlinked intents, then appends companions and updates their indexes in that same prune transaction. Only after those writes does it remove the rows. `CommunicationIndexDoc` is a persisted, session-scoped point-index family (`agent.communication-index`) keyed by storage, original conversation and native entry. It retains target and companion identifiers, invalid markers or no-envelope decisions. This lookup hint does not replace immutable native records as authority. Admission intent stays in the existing provenance rows; no second delivery queue, admission pin or metadata-specific admission capacity rule is introduced. Queued intent reconciliation uses the existing background and reopen paths. Invalid or unavailable metadata produces a bounded owner diagnostic or invalid index marker without changing native input acceptance.

Native admission and post-native classification remain separate commits. A crash after native admission but before owner capture leaves an unresolved association; this interface does not promise crash-atomic capture with native admission. The successful-response and pre-eviction guarantees apply to completed owner bookkeeping commits, not that intervening crash gap.

Active input provenance uses a separate model-less `agent.communication` entry in the original input's conversation. Its data is `{format:"agent.communication-link/1",target:InputLink,value:Communication}`. `InputLink` contains `mode:"input"`, canonical `storageId`, numeric `conversationId`, decimal-string `entryId`, numeric `submissionId`, and `requestId`. The original input remains unchanged. The owner point index and companion append share a transaction; the index is only a lookup hint.

Passive notices retain the original `agent.thread-notice` write and model array. A passive report is a native write of kind `agent.passive-report` on the same path; it is not an input, does not wake the recipient and releases no wait. A report with an exact producer association (`intervention`) cannot be passive. Valid data is `{format:"agent.communication-passive/1",requestId,value}` and requires a notice or a report with `metadata.passive:true`. Its public `PassiveLink` has `mode:"passive"`, the actual storage/conversation/entry IDs and request ID, but no input submission claim. Its own native ID is `recordEntryId`. Invalid metadata adds only bounded `{format:"agent.communication-invalid/1",reason:"invalid"}` data to that original write. The owner verifies the write's exact visibility before publishing the invalid marker.

Every committed snapshot/frame entry and compact history/activity row contains one closed view:

```text
{state:"ready",recordEntryId,target:InputLink|PassiveLink,value:Communication}
{state:"unresolved"}
{state:"unavailable",reason:"limit"|"invalid"}
```

Unresolved means no visible verified association, not human authorship or a promise of future completion. Live progress rows without a committed ID omit this field. Task observation frames are unchanged.

Snapshot, conversation observation and readable inspection share one owner reader. It captures a visible native tail before the read. Every index hit verifies the native submission, actual origin and target/companion records through bounded fork-aware exact-ID queries. Both records must remain visible at that tail. An older display page still uses the captured current view tail, not its `before` anchor, as the provenance cutoff. A fork before the companion never inherits later parent metadata. A visible inherited entry retains its original conversation ID in the communication target; that ID need not equal the selected fork's conversation ID. No client lookup scans for adjacent text or guesses a sender.

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

Ordinary Pi custom messages with `customType: "agent.peer"` expose a structured peer contribution through their supplied `details`. This section is the public mapping for consumers; it does not authorize imports of Agent-private types, prose parsing, new delivery operations, or history rewriting. The `primary-delivery/4.0.0` channel requires retained acceptance without changing this payload mapping. `sendMessage`, wake behavior, original content, and `display: false` exclusion retain their meanings. Saved `custom_message` entries and live `role: "custom"` messages use the same mapping before projection drops their details.

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

A null native `entryId` or `answerEntryId` means absent, never `"null"`, zero, or a fabricated entry. The shared `details.answerEntryId` belongs to every reference in this producer's answer group; no per-member answer ID is invented. `omittedReferences` equals the number of supplied members beyond the retained first 16. The supplied members belong to one recipient; later reference pages are outside this count. Do not deduplicate references, substitute `operationId` for `requestId`, infer an admission from `ownerId`, or treat a continuation as a result reference. `details.reason` is optional when non-null and a valid bounded string of at most 1,024 UTF-8 bytes. Invalid supplied reference fields produce `unavailable/invalid`; a missing required submissions/body/status value remains `unresolved`.

A normal receipt also supplies `details.receiptAssociation`: `{sourceId,requestId,recipient,producerStorageId,answerEntryId?,results,complete,receiptContinuation?}`. `sourceId` binds the producer storage, the answer or unanswered input, and the recipient; `requestId` is the delivery request derived from it; `results` holds at most 16 `{sessionId,submissionId,requestId?}` references for that recipient, and `complete` states whether they are the whole group. An informational fallback copy omits the association and uses a separate source ID for each fallback recipient. When the group continues, the association and `details.receiptContinuation` carry the exact `agent_inspect` call described under Native result inspection. The closed communication value carries only that call, as `metadata.receiptContinuation`; the association stays a raw producer detail.

A normal receipt also supplies `details.deliveredResults`: every `{sessionId,submissionId,requestId}` reference that the delivered group settles for its recipient, independent of the sixteen display references. An informational fallback copy omits it. The primary channel forwards `details` unchanged, so this field needs no new `primary-delivery` identity. The native `submit` request carries the same list; see Native communication provenance for its validation and effect.

The existing `continuation` is raw producer detail only. Ordinary entry IDs remain ordinary IDs; do not cast them into Durable integer IDs. Delivery recipient, original owner, source alias, wake/fallback flags, acknowledgement, provider metadata, and cost are not sender authority or extra fields in the closed communication value.

### Body coverage, redaction, and bounded presentation

`body` is `{text, complete, redacted}`. Protect only the selected structured body with the existing credential-redaction transform. Set `redacted: true` exactly when that transform removes source material; this flag describes the normalized body, not an assertion that upstream records never redacted anything. Set `complete: false` for these current ordinary shapes. The producer supplies excerpts and no affirmative complete-body marker: absent `textTruncated` does not prove completeness. `textTruncated: true` independently establishes loss, while passive `operatorMessage` can lose source text without that shared marker. Do not parse the truncation paragraph or invent omitted-byte counts.

Limit normalized body text to 16,384 UTF-8 bytes at valid Unicode boundaries. Any clipping or redaction keeps `complete: false`; preserve ordinary newlines/tabs and reject malformed Unicode or other controls. The closed communication value must fit 24,576 serialized bytes. The ready presentation, including origin and protected raw details, must fit 32,768 serialized bytes; raw details get at most 8,192 serialized bytes and use the existing truthful omission marker. If the attributed value cannot fit, return `unavailable/limit`, not partial identity or silently cut metadata.

Ordinary origin is `{kind: "ordinary-custom", customType: "agent.peer", renderEntryId, sourceEntryId?}`. `renderEntryId` is the existing retained message key; `sourceEntryId` exists only when the public saved record supplies it. Each is a bounded string of at most 256 UTF-8 bytes. A live custom message without a saved entry ID is a valid presentation source but supplies no exact saved-record identity. Native submission, link, or companion fields do not belong in this origin.

Original content remains the source for Raw content and Copy with its actual existing coverage. A normalized card does not replace that content with a reconstructed body, duplicate the transport paragraph at rest, expose secrets through raw details, or change native admission. Preserve a validated communication value through repeated projection rather than treating it as another producer record.

Sources: `extensions/agent/index.ts` ordinary primary registration; `extensions/agent/durable-delivery.ts` `boundedPeerText`, `sharedRowDetails`, `rowDetails`, `reportOptionalDetails`, and `receiptContinuationDetails`; `extensions/agent/durable-controls.ts` `DeliveryReceipt` and `DeliveryReport`; `extensions/agent/identity.ts` `canonicalIdentity`. These references define source fields and mapping, not a claim that an arbitrary running client already consumes them.

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
binds the adapter's identity prelude to the expected host before Chord bytes
reach an accepted host. A matching filename alone is insufficient. Attach-only
access first requires a live claim, then a successful connection and usable
descriptor. An attach failure never authorizes listener replacement. Sources:
`transport/{index,endpoint,unix-link}.ts` and `extensions/agent/host-client.ts`.

Public Unix server discovery enumerates reachable sockets only. It is not retained catalog discovery and cannot find cold storage. No global server is necessary to read catalog publications. Source: `extensions/agent/catalog.ts:343-386`; `extensions/agent/manager.ts:652-701`.

### Native writer evidence

The native runner owns a stable-inode Darwin descriptor lease before runtime construction. It makes one nonblocking `O_EXLOCK|O_NOFOLLOW` open, validates a private regular file owned by the current user with one link, and holds the descriptor while native writes remain possible. A busy lease excludes a second runtime. Release closes only the descriptor; the pathname and inode remain. Path identity checks detect replacement but do not fence an uncooperative writer. The supported substrate is a private local macOS filesystem with cooperating writers. Network/shared filesystems and other platforms are outside this contract. Source: `extensions/agent/native-lease.ts`; `extensions/agent/host-process.ts`.

The diagnostic record contains `{sessionId,cwd,host,createdAt,pid}` and a token. Its bounded parser validates identity, resolved cwd, timestamp and PID without following symlinks. Native metadata-only observation returns `absent` for a missing file. A canonical `endedAt` at or after `createdAt`, with a valid bounded writer token and matching same-host identity, ends only that recorded generation. Without an end marker, only same-host `ESRCH` proves the recorded generation ended. A present or reused PID, `EPERM`, foreign host, malformed marker or other probe failure remains `unknown`. None of this evidence establishes current lease possession, global absence or writer release. Malformed metadata retains its specific unknown reason. The separate Places process-lock classifier retains its PID-based contract. Source: `extensions/agent/claims.ts`; `extensions/agent/places.ts`.

Control and connected observation verify the exact derived endpoint and current operation contract. A failed endpoint remains unavailable, not proven dead. Catalogue and effort reads make no per-record socket probe. A consumer never removes the native lease inode, takes a writer lease for a metadata refresh, or treats end evidence as permission for takeover, automatic recovery, catalogue deletion or release-wait completion. `discardUnopened` retains every present claim, including a previous generation's ended record while a new holder has not rewritten it. Only an absent claim reaches its existing guarded cleanup.

After runtime closure and owned socket removal, the holder validates the named inode and writes its complete record with `endedAt` through the held descriptor at byte offset zero. It releases the descriptor only after that write succeeds. Runtime-close or end-write failure retains exclusion until actual process exit. A new holder overwrites the record without `endedAt`. Source: `extensions/agent/host-process.ts`.

### Explicit stored-host acquisition

A consumer starts a stored host only after explicit user action. Selection, page load, retained discovery, and connection checks do not acquire a writer. Before the action, disclose that starting the host can resume unfinished Durable work without a new prompt. A start request contains an exact external conversation identity and a separate bounded request ID, never composer text or a task-submission payload.

The package process entry is `extensions/agent/durable-runner.ts`. Invoke it without a shell:

```text
node <trusted-harness-package>/extensions/agent/durable-runner.ts <metadata-JSON>
```

Construct metadata from the validated catalogue record with exactly these host fields. Omit `createdAt`, `view`, `threads`, `recoveryDue`, and client diagnostics:

```text
storageId, cwd, agentDir, packageDir, storagePath,
model: {provider, modelId}, thinkingLevel,
name?, trust?, ownerId?, independent?: {inputDigest, projectTrusted}
```

Preserve `trust`, `ownerId`, and the complete `independent` object exactly. Explicit trust participates in the owner's normal trust resolver. If independent metadata exists, `independent.projectTrusted` supplies the prioritized resolver instead. An unresolved normal decision follows the retained owner chain, not the observing primary. Without trust-requiring project resources, normal resolution uses the saved decision, including false, or defaults to true when absent. Explicit trust retains priority. Do not replace absent trust with false, force true, fabricate an owner, or omit independent metadata. Source: `extensions/agent/durable-runtime.ts:55–79`; `durable-services.ts:553–564`; `trust-support.ts:73–109`; installed coding-agent `dist/core/resource-loader.js:352–366`.

Before dynamically loading host modules, the runner binds coding-agent, agent-core, AI, and TUI imports originating under the Agent source root to the selected installation. Durable, Codemode, MCP, Chord, and pi-schema remain dependencies of the configured owner checkout; the binding does not redirect every Pi package. Validate the catalog identity, exact database path under the configured durable catalog root, and existing canonical regular-file/directory paths before spawn. Source: `extensions/agent/{durable-runner,installation-binding,host-protocol}.ts`.

An acquiring control first attempts one bounded attachment to the derived endpoint and negotiates its current contract. If no endpoint is available, it starts one detached runner with ignored stdin and drained stdout/stderr. Only that runner attempts the lease. A busy runner opens no storage and emits `PI_AGENT_HOST_BUSY` with `{storageId,socketPath}`; this names the expected attachment target, not a verified owner. The caller attempts that attachment once and otherwise reports unavailable. Concurrent starts reuse one owned attempt. The caller never signals a competing host or removes its inode. Source: `extensions/agent/{native-lease,host-process,host-client}.ts`.

After the listener starts, the owner prints one line with this prefix and JSON record:

```text
PI_AGENT_HOST_READY {"pid":positiveInteger,"socketPath":absolutePath,"writerId":perRunIdentity,"contract":RuntimeContract}
```

Read bounded output within one monotonic deadline covering readiness, connection and negotiation. A matching malformed line ends the startup observation, not the runtime. Validate the diagnostic PID's positive-integer shape, the derived socket path, the bounded writer identity, and the current operation descriptor before the owned launch enters its ready state. The PID is not ownership authority. `serverId` is not a readiness field; derive it from metadata and verify it through the public Unix transport handshake. Then use the existing negotiated preparation and observation paths for the exact conversation. Task input requires a negotiated `task-submit` capability. Readiness alone proves neither a compatible connection nor a valid conversation. Source: `extensions/agent/host-protocol.ts:parseHostReadyLine`; `extensions/agent/host-process.ts:runHost`; `extensions/agent/host-client.ts:launchRunner`.

The host owns its lifetime independently of its clients. Runtime construction resumes unfinished conversations, tool work, and retained deliveries before the socket starts and before READY is emitted. A readiness, negotiation, or startup timeout does not prove that native work was never admitted. Source: `extensions/agent/durable-runtime.ts`; `extensions/agent/durable-host.ts`; `extensions/agent/host-process.ts`; installed Durable `dist/harness/{harness,scheduler}.js` resume paths. Retain an uncertain attempt while its child remains alive; offer an explicit connection check rather than automatic relaunch or task submission. Malformed readiness, socket mismatch, connection failure, client disconnection, and client shutdown never justify killing admitted or pre-existing work. Client shutdown cancels only its own readiness wait and closes its observations/transports. A confirmed exited child permits a new explicit attempt. An attach-only connection keeps that policy during recovery. Retry-safe work alone never grants acquisition. An automatic replacement requires an exact owned failed-child exit; a clean exit or positive owner close does not relaunch. A foreign link without an exit source reports unavailable unless a validated clean-end marker matches that exact negotiated writer; clean retirement is expected, not a recovery fault. Endpoint unavailability plus an ended previous generation never proves that no replacement holds the lease. Release therefore retains its explicit unavailable result. A launch without READY or exit remains unconfirmed: `agent_attach` attempts the endpoint explicitly, but it does not bypass an unresolved launch. If no endpoint answers and no actual exit or successful owner close is observed, reacquisition remains unavailable; there is no automatic duplicate launch or PID-kill remedy. Client close is final across awaited acquisition and rebind, and late transports or subscriptions receive local cleanup only. A persistent inode cannot complete writer-release observation; that observation joins an actual child exit or successful owner close. Source: `extensions/agent/{durable-runner,host-process,host-client,durable-runtime}.ts`.

The existing `runtime-contract` member returns the required current hello `{format:"pi.agent.host-hello/1",writerId,contract:RuntimeContract}`. The server publishes its own per-run random identity from memory, not from diagnostic metadata. The static operation contract does not carry that changing identity. Missing or malformed hello evidence refuses negotiation; a bare operation descriptor is not a hello. The connected hello must match the exact owned launch's validated READY identity before the connection receives its owned-child exit source. A compatible foreign writer remains attachable without that authority. Sources: `extensions/agent/{host-protocol,host-process,host-client}.ts`.

A manager records each known link-loss epoch before catalogue recovery runs. A retained `recoveryDue` marker does not override a foreign, clean, positively released, or pending-exit refusal. Only the matching failed-child outcome releases that loss hold; a newer successful attachment supersedes older callbacks. Primary registration retains its explicit startup-recovery role, and `agent_attach` retains explicit acquisition. Recipient-triggered parked-delivery wake retains its separate predicate. Source: `extensions/agent/manager.ts`.

### Storage status continuation

Unselected status returns `conversations` and page-local `coverage: {complete, returned, scanned, next}`. A missing status still counts as scanned. A non-null `next` is `{tool:"agent_status",view:"storage-page",storageId,cursor,limit}`. Call that tool with the other fields unchanged; the backend owns the JSON-record cursor and the unfiltered conversation scan. No total or frozen membership snapshot is implied.

Both ordinary and native registrations accept this closed branch with an exact bare native `storageId` and an integer `limit` from 1 to 50, default 50. Mixed fleet/session selectors, conversation-qualified IDs and non-record cursors are invalid. Connected and cold observations keep the same scan semantics. Selected status and manager overview are distinct. Global `agent_list` retains its own string cursor. The status operation uses request identity `status/1.1.0` and the exact response-schema identity; incompatible peers refuse rather than return an older shape. Sources: `extensions/agent/{storage-status,durable-host,durable-observation,observation-schema,version-contract}.ts`.

## Chord wire contract

The live interface uses Chord v2's `remote`, `method`, `hostKind`,
`createHost`, facets, references, and byte `Link` contracts. The package-level
transport entrypoint serves the Agent without imports from another extension.
Its contract declarations are:

```typescript
import {
  bool, hostKind, method, obj, oneOf, opt, remote, str, unknown,
} from "@earendil-works/chord";

const placement = hostKind("pi.agent", { serverId: str() });
const Endpoint = remote("pi.agent.endpoint", {
  version: 1,
  params: { serverId: str() },
  hostAddress: ({ serverId }) => placement({ serverId }),
  variants: { default: { methods: {
    request: method(obj({
      method: str({ min: 1, max: 128 }),
      params: opt(unknown()),
      requestId: opt(str({ min: 1, max: 128 })),
      contract: opt(unknown()),
    }), obj({ value: opt(unknown()) })),
  } } },
});
const Feed = remote("pi.agent.feed", {
  version: 1,
  params: {
    serverId: str(), kind: oneOf("changes", "observation"),
    token: str(),
  },
  hostAddress: ({ serverId }) => placement({ serverId }),
  variants: { default: { state: {
    value: obj({ ready: bool(), value: opt(unknown()) }),
  } } },
});
```

Each socket first exchanges one UTF-8 JSON identity record followed by LF:

```json
{"transport":"harness.chord/2","kind":"host","name":"pi.agent:<serverId>"}
```

The client sends the same transport identifier with `kind: "client"` and an
empty name. Identity JSON is bounded at 1,024 bytes before LF. The adapter checks
the exact transport identifier, opposite role, and expected server name, and
rejects additional fields. Identity admission has a five-second deadline; a
client's configured connection deadline also applies. No Chord message reaches
an accepted host before the adapter admits the identity. Old JSON-frame peers,
unknown formats, wrong names, malformed UTF-8 and silent peers fail within a
bound. The transport identifier is independent of Chord's protocol number:
a matching Chord protocol number does not establish adapter compatibility.
There is no old codec, fallback, or automatic protocol negotiation. The
connection deadline applies to the initial endpoint get, not subsequent feed
hydration, which uses Chord's default readiness bound. Client protocol-error
reports retain their reason in connection failures and close notifications.

After identity admission, each socket record is a four-byte unsigned
big-endian payload length followed by that many bytes. Chord's public
`binaryCodec` encodes and decodes the payload. Chord owns its hello, holds,
calls, results, cancellation, state deltas, and protocol validation. The adapter
only moves ordered bytes; it does not inspect encoded calls or derive admission
proof from them.

The default payload bound is 16 MiB. `maxFrameBytes` bounds received records
before payload allocation or codec decoding. `maxSendFrameBytes` independently
bounds outgoing payloads and defaults to `maxFrameBytes`. The four-byte prefix
is excluded from both payload bounds. The default outgoing queue bound is
64 MiB, including those prefixes. Every socket write stays charged until its
write callback completes, even when `socket.writableLength` is zero. Duplicate
callbacks release no extra capacity. Before receiver registration, the same
queue bound limits retained incoming payload bytes. The identity prelude has
its own small bound and is outside the Chord outbox.

Chord's `PartLimits` separately bound JSON parts on receipt, including their
inflated size. The endpoint passes its receive bound to both part limits.
Those checks do not replace whole-record framing or a stalled socket's outbox
bound. These byte limits are not universal maxima on user messages, native
values, or complete observations. Larger exchanges need suitable limits at
both peers. The server forwards its limits to each accepted link.

The server assigns a unique connection principal with `kind: "connection"`.
Supplied message fields never select that principal. Filesystem permissions,
not the public name, enforce same-user access. Attach failure grants no
authority to start or replace a host.

The server loads a facet that serves Endpoint and Feed. Client hosts load
before acquiring references and connect their parent byte link explicitly.
A host address comes from the declared host kind. Calls run through
`host.root()`; references and watches own hydration and cancellation. Each
Feed belongs to its connection's principal and carries transient watchable
state. A native resource opens the application subscription and closes it when
the Feed ends. Structural deltas preserve unchanged history instead of
resending it. Reconnect creates a new client host, references, and observation
tokens, not an old subscription on a new link.

Responses unwrap the optional `value` without converting absence to `null`.
Chord errors keep their current codes and permitted reasons; version refusal
uses `unavailable/version`. Application failures use `PluginError` codes,
including `invalid`, `claim`, and `internal`, without encoding a code into the
message. The Agent client maps those codes to its own `HostError`.
Connection loss stays distinct from an application error. A failed send rejects
pending requests promptly, but supplies no typed proof of non-admission.
Clients do not replay mutations merely because the link failed.

Sending after close is a no-op. A payload or queue overflow closes the link
without a partial offending record. Socket write errors also close the link.
`Link.send()` returns `void`; Chord owns protocol acknowledgements, not adapter
byte credits. Close ends the socket and bounds its final drain. The listener
refuses an existing path. It binds a private unpublished name and publishes a
hard link without replacement, so Node's close cannot unlink a substituted
public socket. Cleanup unlinks only the socket whose device and inode it
recorded.

The public `transport/index.ts` exports `connectTransport`,
`createTransportServer`, `unixSocketPath`, and the types `TransportClient`,
`TransportRequest`, `TransportServer`, and `TransportSubscription`. Codec
contracts, adapter internals and tests stay in their owning modules. The client
exposes `request`, `subscribe`, `onClose`, `connected`, and `dispose`;
`subscribe` returns a hydrated `value` and `dispose`.

Sources: `transport/{index,endpoint,unix-link}.ts`; Chord 1.5.2
`dist/contracts/{declare,host-kind,params}.d.ts`,
`dist/host/{host,facet,reference,attempt}.d.ts`, and
`dist/link/{link,message,part}.d.ts`.

The manager's retained-object identity is `manager/7.0.0`; ordinary primary
channels use `primary-delivery/4.0.0`. Native tool bindings use
`native-controls/3.0.0;durable=<loaded Durable version>`.
The typed `deliver` payload accepts optional
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
and no host operation contract. Host operation identities do not change merely because the wire changes. A version
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

The current descriptor requires `codingAgent: "1.5.0"` and `durable: "1.5.1"`. Injected keybinding hints set the coding-agent floor; the Chord v2 dependency graph and provider stream options set the Durable floor. The host observes stored commits with `observeCommits()`, reads the task graph through `observeTaskGraph()` and `watchTaskGraph()`, and reads conversation windows through `Conversation.watch()`; tool cards read the keybinding hints Pi injects into render contexts. Native timer and check-in deadline tasks use `TaskRuntime.sleepUntil()`. The `harness.chord/2` identity prelude and Chord v2 codec form a separate transport contract. These are minimum required APIs, not dependency pins, a supported-version ceiling, or a substitute for exact operation checks. Read floors from the loaded descriptor, not from the source release label. Sources: `extensions/agent/version-contract.ts`, `durable-timers.ts`, `durable-checkins.ts`, and the installed Durable `dist/types.d.ts`.

For every member in the following set, request and response are both `<member>/1.0.0`, with no `durable` field:

```text
close attach acknowledge abort release reset
 timer-list observe-close models
 collaboration-list await-release
```

`changes` uses `changes/2.0.0` for request and response. Its initial and later frames are `{revision,writerId,view?}`. `writerId` comes from the server's immutable current hello identity. `view` is the runtime's latest successful bounded catalogue publication, retained after `updateView` succeeds and before notification. A revision without a view proves no publication. The client consumes the initial subscription value and later frames only for the current link and binding. Loss, rebind, local close and successful owner close clear that evidence; obsolete callbacks cannot restore it. A changes-operation mismatch refuses without a fallback and remains visible as unavailable publication evidence. Sources: `extensions/agent/{host-changes,host-client,host-process,durable-runtime,version-contract}.ts`.

`release` aborts the target, places eligible queued writes, and requests host retirement with blockers reported. An unavailable endpoint stays unavailable; no release-only `live:false` result infers global absence.

The inner retirement check does not cancel work. Its delivery facts come from the
existing bounded source driver, not a second ledger traversal. The
`recovery-state` response keeps `deliveriesActive` true while delivery observation
is incomplete, dirty, failed or scheduled, as well as while a route remains
active. A complete pass aggregates parked wake dependencies across all pages.
Recovery and retirement recheck bounded recipient availability; changed facts
resume the driver and block retirement until a fresh pass completes. A `release`
request waits up to 10 seconds for a pass the driver has scheduled but not
started; unfinished pages, in-flight effects and a failed observation refuse
at once with the blocker named. Final retirement also checks native work,
active requests, in-flight delivery and the unchanged admission generation
before it seals admission.

Overrides and remaining members:

| Member | Request | Response | Durable |
|---|---|---|---|
| recovery-state | recovery-state/1.0.0 | recovery-state/1.1.0 | absent |
| submit | submit/1.5.0 | submit/1.2.0 | absent |
| report | report/2.0.0 | report/1.2.0 | absent |
| passive-submit | passive-submit/2.0.0 | passive-submit/1.0.0 | absent |
| spawn | spawn/2.0.0 | spawn/2.0.0 | absent |
| place | place/2.1.0 | place/2.1.0 | absent |
| resolve-agent | resolve-agent/2.0.0 | resolve-agent/2.0.0 | absent |
| receipts | receipts/2.0.0 | receipts/2.0.0 | D |
| inspect | inspect/1.2.0 | H-inspect | D |
| status | status/1.1.0 | H-status | D |
| list | list/1.0.0 | H-list | absent |
| fork | fork/1.0.0 | fork/1.0.0 | D |
| rewind | rewind/1.1.0 | rewind/1.0.0 | D |
| compact | compact/2.0.0 | compact/2.0.0 | D |
| run-scope | run-scope/1.0.0 | run-scope/1.0.0 | absent |
| run-stop | run-stop/1.0.0 | run-stop/1.0.0 | absent |
| request-cancel | request-cancel/1.0.0 | request-cancel/1.0.0 | absent |
| configure | configure/1.3.0 | configure/1.3.0 | absent |
| command | command/1.2.0 | command/1.1.0 | D |
| timer-schedule | timer-schedule/1.1.0 | timer-schedule/2.0.0 | absent |
| timer-cancel | timer-cancel/1.0.0 | timer-cancel/1.1.0 | absent |
| dashboard | dashboard/1.0.0 | H-dashboard | absent |
| snapshot | snapshot/1.0.0 | snapshot/2.0.0 | D |
| observe-open | observe-open/1.0.0 | observe-open/2.0.0 | D |
| observe-frame | observe-frame/1.0.0 | observe-frame/2.0.0 | D |
| changes | changes/2.0.0 | changes/2.0.0 | absent |
| profile-read | profile-read/1.0.0 | H-profile-read | absent |
| profile-update | profile-update/1.0.0 | H-profile-update | absent |
| profile-list | profile-list/1.0.0 | H-profile-list | absent |
| task-submit | task-submit/1.0.0 | task-submit/1.2.0 | absent |
| await-state | await-state/1.1.0 | await-state/1.1.0 | absent |
| collaboration-read | collaboration-read/1.1.0 | collaboration-read/2.0.0 | absent |
| collaboration-mutate | collaboration-mutate/2.0.0 | collaboration-mutate/1.0.0 | absent |

Each `H-*` is the lowercase hex SHA-256 of `JSON.stringify` of the owning schema, not a hash of a response instance. The current schema-derived identities are:

```text
H-inspect       fda259edeae325c7625547e95c55e22cf0bbe1b6b912b51bc3d8d209b396dc67
H-status        f172778ae73ddc09018f68403c693c84a3d91c639a2774b68c9dedaf4e8f5b0b
H-list          1176e0c72bb1e1eb5ca2e574182c802a4733cf77b9a1ea1eabd8af27aa52fbe6
H-dashboard     9708e679163a10e256a4854a0d6b5347f8533d28d35efb707647fda100032b04
H-profile-read  396c6aa90325ba4f92e72f38538561c810d31eb6dde087341591b34af479400b
H-profile-update 8eb14a948f9d42366d9d4eb211d498563693d48806495032fe28f22ca66d942f
H-profile-list  99b00a455cf50a2a24de4a0f9e328a12e775caa9c5031becbef462e06e65a7cf
```

Schema owners in table order are `InspectOutputSchema`, `StatusOutputSchema`, `ListRowSchema`, `AgentConversationSummarySchema`, `AgentProfileSchema`, `ProfileUpdateSchema`, and `ProfiledListOutputSchema`. `dashboard` returns an array despite its response identity hashing the row schema. Maintain these identities with the defining schemas; do not infer a complete result shape from the schema name alone. Source: `extensions/agent/version-contract.ts:30-56`; `extensions/agent/durable-host.ts:454-457`.

`StatusOutputSchema` owns the host response identity. Caller-side catalog rank, inventory coverage, and priority omission counts belong to the existing `ToolStatusSchema` overview extension, not to that wire schema. The caller's catalog scan produces those facts; a host status response does not. An actual host schema change changes its generated operation identity.

The table lists advertised identities, not a claim that all members have the same target or side-effect policy. The consumer operations below define the relevant payloads. `changes` gates a Feed subscription; it is not an ordinary runtime request member.

The current `extensions/agent/observation-schema.ts` permits conversation task
statuses `running`, `pending`, `waiting`, `sleeping`, `completing`, and `blocked`.
`StatusOutputSchema` includes this closed enum; its schema identity therefore
covers sleeping-state support. `InspectOutputSchema` retains its current shape
and identity. Exact native operations still bind D independently of schema hashes.

Conversation task rows permit optional native `startedAt` and `endedAt`.
Durable stamps wall-clock milliseconds at first running and terminal state;
the span includes waits and recovery, not only execution. Status selects live
tasks, so their terminal `endedAt` remains absent. Missing timestamps remain
absent.

## Native result inspection

The existing `inspect` operation accepts `{sessionId?,view:"result",requestId?,submissionId?,entryId?,operationId?,offset?,receiptCursor?}`. The selected storage/conversation qualifies every lookup; a root session uses its storage UUID and a child uses `UUID:conversationId`. One of requestId, submissionId or operationId is required. A native requestId resolves exactly through public `Tx.submissionByRequest(conversationId,requestId)`, not a report ID, text search or another store.

Multiple selectors must identify the same native submission. A supplied entryId must equal its native input/write entry, not its answer entry. Conflicting selectors fail. OperationId is a separate admission value resolved through retained receipts in the selected conversation; it is never a requestId alias. A missing operation receipt is unavailable rather than an unverified operation association.

A missing native submission returns `{view:"result",sessionId,conversationId,status:"unavailable",reason,usage}` with the supplied requestId/submissionId/operationId selectors when present. It invents no submission ID or native entry. A found result retains the native status, submissionId, producer requestId, entry/answer IDs and answer/reason fields. An `unanswered` reason of `restart_limit` or `interrupted` is terminal: host crashes ended the run, and the host does not resubmit it. RequestId selects only the result view. Native terminal tool text uses the same validated output. No new operation, store or private-store parser participates.

A `done` result returns its answer in pages. `offset` is a nonnegative count of UTF-16 code units, default 0; an offset beyond the retained answer is refused. A page holds at most 4,096 UTF-16 code units and does not split a surrogate pair. The page fields are `answer`, `offset`, `nextOffset:number|null`, `truncated`, and, when text remains, `answerContinuation:{tool:"agent_inspect",view:"result",sessionId,submissionId,requestId?,offset}`.

A settled input with a retained receipt also returns `receiptGroup:{recipient,results,complete,next}`. `results` holds at most 16 `{sessionId,submissionId,requestId?}` references for the recipient of the selected receipt. `next` is null or `{tool:"agent_inspect",view:"result",sessionId,submissionId,requestId?,receiptCursor}`. A request with `receiptCursor` returns the result identity and the next reference page without the answer body. An unanswered input has one reference, `complete:true`, and accepts no cursor.

`receiptCursor` is an opaque string of 1 to 2,048 base64url characters that selects only the result view. It binds the storage, the recipient, the selected submission, the answer entry, the current page position, and the page and offset that ended the list at the first read. Rows appended later never enter that cursor. The host refuses a malformed cursor, a cursor for another selection or recipient, a changed or invalid terminal boundary, and a position outside the captured range. A cursor for an unsettled input, or for a result without a retained receipt, is refused. One reference page reads the current list page and, when it is a different page, the page that holds the captured end: at most two page documents and 128 stored references. It examines at most 64 membership references and returns at most 16. A page that holds no reference for the recipient still returns `next`.

The answer and reference continuations are separate calls; neither advances the other. The complete serialised result, including identity, body and receipt metadata, fits 65,536 UTF-8 bytes; a larger result is refused. Result inspection acknowledges no delivery. `view:"exact"` remains the raw redacted entry read. Source: `extensions/agent/durable-observation.ts` (`readResult`, `RESULT_PAGE_UNITS`, `RESULT_PAGE_BYTES`); `extensions/agent/delivery-store.ts` (`receiptReferencePage`); `extensions/agent/observation-schema.ts` (`AnswerContinuationSchema`, `ReceiptGroupSchema`).

## Roster publications and dashboard

### Native dashboard operation

Params: `{conversationId?: positiveInteger, cwd?: string}`. Result: `AgentConversationSummary[]`, not `{rows,coverage}`. The cwd supplies presentation context. This reads one host's native summaries; it does not enumerate the machine's catalog. Source: `extensions/agent/durable-host.ts:454-457,481-490`; `extensions/agent/durable-observation.ts:705-708`; `extensions/agent/dashboard-types.ts:60-104`.

A summary has required fields:

```text
{id, storageId, cwd, modifiedAt:number, owner, state, cost:number, partial:boolean}
```

Optional fields are `creatingOwnerId`, `name`, `firstMessage`, `model:{provider,modelId,thinkingLevel}`, `ownerLabel`, `latestReply`, `error`, `toolCalls`, `currentTool:{name,argument}`, `durationMs`, `health`, and `awaiting`. Manager-enriched rows can also include `profile`; it is not part of the base native row contract. `owner` is `here | unavailable | unknown`. `state` is `starting | working | idle | done | failed | stopped | interrupted | new | unavailable`. `health` carries optional `lastError`, `compactionFailure:{trigger,at?,errorMessage?}`, and `autoRetry:{attempt,maxAttempts,delayMs,errorMessage}`. `awaiting` is optional retained wait information; a consumer that does not display it leaves it opaque. Source: `extensions/agent/dashboard-types.ts:13-104`; `extensions/agent/version-contract.ts:54`; `extensions/agent/manager.ts:677-700`.

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
       reason:"missing_task"|"task_too_old"|"migration_failed"}
    | {identity:string, kind:"failed-turn"}
  ],
  coverage: {complete:boolean, omitted:nonnegativeInteger}
}
```

Join each hint to the exact conversation row `id`. At most one hint appears per
row, with provider block before blocked task before failed turn. Provider blocks
require explicit recovery; blocked tasks require host repair; failed turns need a
new input. Work cut off by host crashes at the native restart limit ends instead
of blocking: a run that ended that way records `pi.live.runFailure` with reason
`restart_limit`, its row state is `failed`, and its hint is `failed-turn`. The
host never resubmits that work; a new input runs it again.
Expected task sleep does not create an attention hint. Automatic retry and
compaction diagnostics do not establish a need for intervention. Absence remains unknown even with complete publication coverage;
this section does not detect unanswered human questions. Hints use only space
left after native rows and profile hints. Coverage counts omitted hints and rows,
not an inferred number of intervention needs. The base row state enum is unchanged.
Sources: `extensions/agent/catalog-attention.ts` `projectCatalogAttention`;
`extensions/agent/catalog-view.ts` `withAttentionHints`.

A manager roster composes retained views with current claim observations:

- verified current-link publication → `owner:"here"`, with its published state and `currentTool`;
- absent/dead recorded generation without a current publication → `owner:"unknown"`, with retained `working` rows shown as `interrupted`;
- unknown claim or current host without a successful publication → `owner:"unavailable"`, with retained `working` rows shown as `unavailable`;
- an end marker for that exact connected writer overrides the retiring link; a different generation's marker does not;
- rows without verified current-host publication lose their stale `currentTool`;
- missing/unavailable view produces an unavailable row, not a fabricated native state.

`ownerLabel` records publication time, claim observation time and any claim error. Published state, cost, and health remain observations at `updatedAt`, not fresh native assertions. A cached claim does not establish current liveness. The raw catalogue coverage remains unchanged, including `unknownClaims`. Presentation completeness resolves selected claims with verified publications and still reports unresolved claims, unseen records, unreadable records and projection omissions. The footer counts the displayed verified `working` rows and adds `+` only while presentation coverage is incomplete. Source: `extensions/agent/manager.ts` `catalogRows`.

Manager `dashboardPage()` composes caller-local roster rows and coverage; it is not a host operation. One manager-owned `CatalogObservation` holds source identities, record facts, claim qualifications and observation times for footer, roster and no-target status roster consumers. Initial discovery inspects every candidate in its directory snapshot with bounded record and claim reads. Each caller projects its own priority ordering and cursors from those raw facts, its ownership set and manager-local launch/recovery facts. The priority projection retains its live-claim branch, but native diagnostic metadata never establishes that priority. Caller-owned records and local active stores retain their priority; file modification time and identity order each group. A connected publication changes presentation, not catalogue rank. Coverage includes the scan, output bounds, unknown claims, excluded records and rows, and per-storage view exclusions. Reprojecting cached facts does not advance the inventory observation time.

The existing namespace socket accepts newline-terminated JSON `{format:"pi.agent.catalog-changed/1",storageIds?:string[]}`. `storageIds` contains bare storage UUIDs, with at most 64 identities and a 4,096-byte notice bound. Missing, empty, malformed, unknown or oversized notices mean whole-namespace dirty; they never mean no change. Identity-free notices therefore remain safe generic invalidations within the current process. Observer registration remains `pi.agent.catalog-observer/1`; these notices are not Chord host operations and do not change generated operation identities.

Every shared inventory read captures the current directory snapshot and checks each record with a symlink-refusing file stat. The stamp includes device, inode, size, modification time and change time. Changed or unreadable records receive bounded payload reads; unchanged records reuse their facts. The retained stamp comes from the opened file's `fstat`, so an atomic replacement between pathname validation and payload read cannot bind new bytes to an old stamp. This path observes final publication even before its asynchronous notice arrives.

Publishers accumulate identities during an in-flight broadcast. Managers combine namespace changes and connected-host notices, whose connection supplies the storage identity. Known changes refresh affected claims; overflow invalidates claims across the namespace. On the next read after two seconds, the shared owner refreshes all claims to detect silent writer death, without reopening unchanged record payloads. Directory validation also detects missed publications, deletions and unreadable records. The dashboard's existing reconciliation demand drives this path without another timer or persistent mirror. Failed discovery leaves the inventory dirty for another read.

Roster continuations bind the caller's ownership set and local active stores, and rank the current shared observation, so changed publication time or claims can move records across the cursor; refresh to rediscover them. `AgentCatalog.page()` retains bounded filename-based reads for stable `agent_list` and thread discovery. Exact-target reads and controls remain independent of this observation. Recovery conservatively considers all source records within its existing bound, then checks recipient availability freshly: a notice for recipient B also reaches parked work in source A. Sources: `extensions/agent/catalog.ts`; `extensions/agent/catalog-events.ts`; `extensions/agent/manager.ts`; `extensions/agent/dashboard-types.ts`.

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

Entries are oldest first, from the conversation's fork-aware history (`Conversation.entries()`): every page, with or without `before`, includes head markers such as compaction summaries where they were written instead of cutting the entries before them. System and communication bookkeeping entries are hidden. `revision` is an opaque display revision, not a durable replay cursor. Preserve `partial`, coverage, and `nextBefore`; an empty bounded scan with null continuation does not override `complete:false`. Each read scans at most eight source pages of 64 entries and reports `complete:false` when the source holds more. Source: `extensions/agent/dashboard-types.ts:107-135`; `extensions/agent/durable-observation.ts:1037-1057,1102-1200`.


Native assistant and tool-result messages retain optional recorded `durationMs` through snapshot projection and existing terminal component handoff. Assistant duration times the final response stream; tool duration times its executed attempt, not task waits or recovery. Interrupted or unavailable results need not carry duration. The assistant schema permits the native field without a new timing view. Sources: `extensions/agent/{durable-observation,observation-schema,dashboard-conversation}.ts`,
`pi-durable/dist/harness/tool.js`, `pi-ai/dist/utils/event-stream.js`, and
coding-agent `dist/modes/interactive/components/tool-execution.js`. These source
contracts do not establish terminal rendering under every process or task.

**Byte-bound exception:** selection admits the first visible entry even if that entry alone exceeds `maxBytes`. `coverage.bytes` measures source-entry selection, not a hard serialized response bound. Model messages, entry data, and live frames require separate consumer output/memory bounds. Source: `extensions/agent/durable-observation.ts:1063-1097`.

### Inspect

Params: `{sessionId, view?, limit?, cursor?, entryId?, fromId?, offset?, query?, source?, requestId?, submissionId?, operationId?, receiptCursor?}`. `requestId` and `receiptCursor` select only `view:"result"`. Supported views are `activity`, `history`, `branch`, `search`, `exact`, and `result`; the raw host default is `history` (`extensions/agent/durable-observation.ts:1858-1873`). Sources are `user`, `assistant`, `toolResult`, `summary`, and `custom`. `cursor` is an opaque JSON object: pass the returned cursor unchanged to the same query/target, never fabricate it from entry IDs. Source: `extensions/agent/durable-observation.ts:77-90,524-541`; `extensions/agent/durable-host.ts:612-618`; `extensions/agent/observation-schema.ts:47,306-427`.

Output is discriminated by `view`:

| View | Result fields |
|---|---|
| history | `{view:"history",format:"compact",sessionId,conversationId,entries:CompactEntry[],nextCursor:object|null,order:"newestFirst",detail:string}` |
| branch | Same common history fields, `view:"branch"`, raw entry rows instead of compact format. |
| activity | `{view:"activity",format:"compact",sessionId,conversationId,turns:[{entries:CompactEntry[]}],nextCursor,metadata,coverage,detail}` |
| exact | `{view:"exact",sessionId,conversationId,entryId,offset,text,nextOffset:number|null,truncated,omissions?}`; text is retained redacted JSON, not an unredacted archive. |
| search | `{view:"search",sessionId,conversationId,matches,nextCursor,coverage:{scannedEntries,scannedBytes,complete},detail}` |
| result | Retained result: `{view:"result",sessionId,conversationId,submissionId,status,requestId?,operationId?,entryId?,answerEntryId?,reason?,answer?,offset?,nextOffset?,truncated?,answerContinuation?,receiptGroup?,usage,providerBlock?,recoveryOf?}`; status is queued, placed, done, or unanswered. See Native result inspection for the page fields. Unavailable result: `{view:"result",sessionId,conversationId,status:"unavailable",reason,usage,requestId?,submissionId?,operationId?}`; only supplied selectors are retained, with no fabricated submission or entry. |

`providerBlock` is an optional retained fact in result inspection and conversation status. Its closed shape is `{blockId,conversationId,providerSessionId,epoch,model:{provider,modelId},error,errorRedacted,errorTruncated,source:"provider"|"host-block",timestamp,originalResults,omittedOriginalResults}`. `originalResults` contains at most 16 closed references `{sessionId,submissionId,requestId?}`; error text is bounded to 4,096 characters. `recoveryOf` is an optional string in a result. These fields do not add a result status or authorize automatic replay. Source: `extensions/agent/observation-schema.ts:143-144,413-431`; `extensions/agent/provider-block.ts:18-26`; `extensions/agent/result-reference.ts:6-10`.

`CompactEntry` has `{id:number,kind,source,role?,text,truncated,communication:CommunicationView,format:"compact",nextOffset:null,omissions?,toolCalls?,toolResults?,omittedParts?}`. Tool call summaries carry `{callId?,name,arguments,truncated}`; tool result summaries carry `{callId?,name,text,isError,truncated,durationMs?}`. This optional duration is the native recorded execution duration; zero stays present and missing duration stays absent. It is not derived from entry timestamps or running-tool elapsed time. Raw rows omit the compact discriminator and may carry `preview:{text,truncated}` plus `nextOffset`. Omission counters are `{providerSignatures,imagePayloads,redactedThinking}`. Search matches carry `{entryId,kind,source,matchOffset,excerpt,excerptText,truncated}` and their cursor is `{cursor:object|null,skip,scannedBytes}`. Source: `extensions/agent/observation-schema.ts:306-377`.

Activity metadata contains `{owner,live,operation:number|null,runningTools,pending:number|null,streamedText?,lastError?,compactionFailure?,autoRetry?}`. Running tools carry `{toolCallId,name,taskId?,parentToolCallId?,parentTaskId?,issuedAt?,elapsedMs?,elapsedFrom?}`.
Nested rows retain native task and parent-call identity rather than a fabricated
model-issued result. Missing timing and parent fields remain absent. Activity coverage includes scanned entries/bytes, complete, entry/scan-byte/output-byte limit flags, output bytes, omittedEntries, and metadataTruncated. Usage is `{models:{[key]:Usage},tools:{[key]:Usage}}`, with Pi usage values; consumers need not display financial fields to read an answer. Source: `extensions/agent/observation-schema.ts:49-60,379-425`.

These are retained/read projections, not proof of operation completion outside the requested result reference. Exact continuation uses `nextOffset`; history/activity/search use `nextCursor`. Do not silently exchange them.

## Collaboration threads

A collaboration thread is a shared frame (purpose, authority, restrictions, acceptance, integrator), a member list, and an append-only exchange of numbered events. Each thread lives in the storage that created it, and its identity is `<storageId>/<32 lowercase hexadecimal characters>`. A storage-scoped list or read serves only that storage: there is no cross-storage native index. The client selects the storage by its canonical identity. Cold reads use a private snapshot without starting a host. Cross-storage discovery uses catalog hints, then a consumer selects each storage for a full list or read.

`collaboration-list` and `collaboration-read` are read-only, retry-safe, and have no `durable` identity (see [Current operation identities](#current-operation-identities)). Neither takes `sessionId` or `conversationId`; the connection selects the storage. They never start a model or write state. `collaboration-mutate` is not described here. The read request identity covers the `after` and `knownFrameRevision` members, and the read response identity covers `atUtc`, the emptied create message with `frameOmitted`, and the forward page. A client and a host that disagree on a `collaboration-read` or `collaboration-mutate` identity refuse the operation through the operation-identity check. `collaboration-list` keeps the default identity. Text fields are returned as stored, with two exceptions: a list summary shortens `purpose` to 160 characters, and a read omits the frame text of a `create` event.

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

Params are one of two closed selector forms:

```text
{threadId:string, limit?:integer 1..20, before?:positiveInteger}
{threadId:string, limit?:integer 1..20, after:nonnegativeInteger, knownFrameRevision?:positiveInteger}
```

`threadId` is required and must be an identity returned by `collaboration-list` or by thread creation. `limit` defaults to 10. The reader refuses a member outside these forms, except the caller-routing members that `validateCollaborationAction` permits for every action (`action`, `sessionId`, `senderIdentity`, `origin`, `requestId`, `ownerId`, `cwd`). Source: `extensions/agent/collaboration.ts` (`readCollaboration`, `validateReadCursors`); `collaboration-contract.ts` (`validateCollaborationAction`); `durable-host.ts` (`collaboration-read`).

Without `after`, the read is backward. `before` is an exclusive upper event sequence: the page holds the newest events with `sequence < before`. Omission selects the newest events. A `before` above the thread's `sequence + 1` fails. There is no cursor member; older pages use the previous page's `nextBefore` as `before`.

Backward result:

```text
{
  thread: CollaborationThread,
  events: CollaborationEventView[],
  nextBefore: number|null,
  pending: number,
  coverage: {complete:boolean, bytes:number}
}
```

With `after`, the read is forward. `after` is an exclusive lower event sequence: the page holds the oldest events with `sequence > after`, and `after:0` starts at the first event. `after` and `before` are exclusive. `knownFrameRevision` requires `after`. An `after` above the thread's `sequence`, or a `knownFrameRevision` above its `revision`, fails.

Forward result:

```text
{
  direction: "forward",
  threadId: string,
  frameRevision: number,
  sequence: number,
  closed: boolean,
  thread?: CollaborationThread,
  events: CollaborationEventView[],
  next: null | {tool:"agent_collaborate", action:"read", threadId:string, after:number, knownFrameRevision:number, limit:number},
  pending: number,
  coverage: {complete:boolean, bytes:number, after:number, through:number}
}
```

`frameRevision`, `sequence`, and `closed` are the thread's current values. `thread` is absent exactly when the supplied `knownFrameRevision` equals the current revision. `coverage.after` repeats the request cursor, and `coverage.through` is the sequence of the newest returned event, or `after` when the page holds none. `coverage.complete` is true exactly when `through` equals the thread's `sequence`. `next` is `null` on a complete page; otherwise it is the complete call for the following page, with `after` set to `through`, the current revision, and the applied `limit`. Only the backward result has `nextBefore`, and only the forward result has `direction`.

Shared types:

```text
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
CollaborationEventView = CollaborationEvent & {
  atUtc: string|null,
  frameOmitted?: "current-frame-returned-separately"
}
```

`events` are oldest first within the page in both directions, and event sequences start at 1. `nextBefore` is the sequence of the oldest returned event when older events remain, otherwise `null`. For a backward page, `coverage.complete` is true exactly when no older event remains. `coverage.bytes` is the serialized size of the page. A page stops adding events before it would exceed 48 KiB, so it can hold fewer events than `limit`; follow `nextBefore` or `next` until it is `null`. A page whose metadata and one event exceed that bound fails as `source_unreadable` and claims no progress. `thread` is the current state, not the state at the time of each event: `revision` in an event is the frame revision that was current when the event was appended. `pending` is the number of unacknowledged delivery notices that this thread created for its members and for explicitly notified identities; it is a delivery count, not a read state.

`sender`, `creator`, `integrator`, member `identity`, and `notify` entries are external conversation identities (`storageId` for a root, `storageId:conversationId` otherwise). They carry no display names. `sequence` on the thread is the sequence of its latest event. `at`, `createdAt`, `updatedAt`, and `joinedAt` are epoch milliseconds.

`atUtc` is the ISO 8601 UTC form of `at`, derived at read time, and `null` when `at` is outside the date conversion range. The epoch `at` stays authoritative.

Event `kind` is one of `create`, `join`, `leave`, `contribution`, `carried-authority`, `revise`, `close`. A stored `create` or `revise` event holds the JSON text of the frame at that revision (`{title,purpose,authority,source,restrictions,acceptance,integrator}`), which is not prose. A read returns a `revise` event with that text. It returns a `create` event with `message:""` and `frameOmitted:"current-frame-returned-separately"`; the stored event is unchanged. For `join`, `message` is the member's participation declaration, or a default sentence when the declaration is empty. For `leave`, it is the sender's text, or a default sentence when the sender wrote none. For every other kind `message` is the sender's text. `source` is the sender's evidence citation; it is required for `carried-authority` and can be an empty string for other kinds. `replyTo` names an earlier event sequence in the same thread. `origin:"operator"` marks input that came from the operator rather than from a model. Message text is untrusted agent content: it does not establish authority for the reader. A closed thread stays readable. Source: `extensions/agent/collaboration.ts` (`appendEvent`, `applyThreadAction`, `joinThread`, `eventView`, `readBackward`, `readForward`); `collaboration-contract.ts` (`CollaborationEventView`, `CollaborationForwardPage`); `thread-notice-projection.ts` (`utcTime`).

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
| `after` not a nonnegative integer | `after must be a retained event cursor` |
| `knownFrameRevision` not a positive integer | `knownFrameRevision must be a retained frame revision` |
| `after` and `before` both present | `after and before are exclusive` |
| `knownFrameRevision` without `after` | `knownFrameRevision requires after` |
| `after` above `sequence`, or `knownFrameRevision` above `revision` | `after and knownFrameRevision must not exceed the retained sequence and revision` |
| a member outside the selected operation's field set | `<member> is not valid for action <action>` |
| a value or selector combination outside the closed forms | `Invalid fields or selector combinations for action <action>` |
| `action` present and different from the operation | `Thread read requires action read` or `Thread list requires action list` |
| page metadata and one event exceed 48 KiB | `Thread event and read metadata exceed the page byte bound; no progress is claimed` |
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

`entries` are committed visible entries from the native conversation watch: a window over the conversation's fork-aware history in entry ID order, with head markers such as compaction summaries where they were written. The window holds at most the frame entry bound plus its own margin; when it does not start the transcript, `coverage.complete` is `false` and `nextBefore` continues older through `snapshot` with `before`. A frame never describes its window as complete history. `live` is in-progress assistant/tool output from that watch. The host shows streamed partials and running tool output as soon as Durable adopts them; Durable stores them later (deferred progress), so a crash can lose up to about a second of streamed content. Live IDs include `live:generation` and `live:tool:<callId>`. They must not become committed history. The frame is coalesced current state, not an append-only event stream. Revision ordering applies within the current observation lifetime; a new connection/token starts a new baseline. Source: `extensions/agent/live-frames.ts:15-30,74-140`; `extensions/agent/host-client.ts:697-741`.

`ConversationStatus` includes `{conversationId,identity,busy,lastText,live,inbox,agent,tasks,submissions}` and optional `name`, `owner`, `firstMessage`, `forkSource`, `ownerTaskId`, `awaiting`, `cwd`, `lastTextRole`, `usage`, `timers`, `providerBlock`. `agent` carries `{model?:{provider,modelId},thinkingLevel,extensions:string[],tools:string[],cwd?,instructions?}`. Tasks carry `{id,kind,status,background,owner?,abortRequested}`; submissions carry `{id,type:"input"|"write"|"continue",status,requestId?,entryId?,answerEntryId?,reason?}`; a `continue` submission has no entry. Native `live`, `inbox`, usage, and task statuses belong to the exact declared
Durable representation. Tool calls in status and live frames preserve optional
string `argumentsError`; terminal call cards show the diagnostic on one line.
Usage preserves optional boolean `cost.totalFromProvider` in model totals, tool
totals, generation messages, and nested summaries. Absent or false denotes an
estimate; true denotes a provider-reported total. Projections do not aggregate
usage or forward provider-private parsing buffers. Native aggregation remains
upstream-owned. `live.nestedTools` has real task IDs, parent call/task
IDs, arguments, progress, and optional terminal summaries. `live.compactionFailure`
contains its task ID, `trigger`, and error, not a fabricated timestamp.
`live.runFailure` records why the newest run ended without an answer, including
`restart_limit` and `interrupted`; a later run removes it. `live.run.turns` counts
the run's tool rounds. The
presentation health projection therefore keeps `at` optional. Source: `extensions/agent/durable-observation.ts:99-156`; `providerBlock`: `extensions/agent/observation-schema.ts:143-144`.

A tasks frame is `{scope:"tasks",storageId,revision,observedAt,tasks,labels,coverage:{complete,live}}`. Task rows contain `{id,kind,conversationId,owner?,background,abortRequested,status,phase,until?,blocked?,waitsOn,policy?,outcome?,conversations}`; labels contain `{conversationId,identity,name?,firstMessage?}`. Graph statuses are `pending`, `running`, `waiting`, `sleeping`, and `completing`. A sleeping row supplies `until`, an absolute deadline on the native Harness clock. Optional `blocked` is the native reason `missing_task`, `task_too_old`, or `migration_failed`; it is separate from the graph status. Work cut off at the restart limit ends and leaves the graph, so it never appears as a blocked row. The host reads the graph through `watchTaskGraph()`. Sleeping is expected state, not a failed turn. Sources: `extensions/agent/live-frames.ts` and the installed Durable `dist/harness/task-graph.d.ts`.

Dispose the subscription and close its token when no longer observed. Disconnect cleans connection-owned observations; explicit token cleanup is still the normal path. Observations keep a host alive and block native reload. Disconnect/observation close do not abort admitted work. The host `close` operation is runtime/process shutdown and is not client cleanup. Source: `extensions/agent/host-process.ts:443-456,535-539`; `extensions/agent/host-client.ts:746-767,891-919`; `extensions/agent/durable-runtime.ts:375-411`.

### Changes

After checking the `changes` operation identity, acquire Feed with
`{serverId,kind:"changes"}` and subscribe to `value`. Ignore hydration until
`ready:true`; its value is `{revision:number}`. Later revisions coalesce actual
runtime writes per microtask. Read-only operations create no change event.
The feed follows stored commits (Durable `observeCommits()`): deferred progress
such as streamed partials and running tool output reaches it only when Durable
stores it, together with a later commit or within about a second. Show live
progress from observation frames, not from this feed.
These are subscription-local invalidations, not catalog deltas or replay
cursors. Release the handle and subscription on close.

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
inside bounded conversation state, excluding trailing guidance messages. The
runtime clears that conversation's route state when a native head marker or
contribution edit commits. Reset, compaction and context edits therefore break
continuity at placement, not while their writes remain queued. Without that
prefix, every retained, memoised and new note uses native entry identity;
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

### timer-schedule

Params: `{sessionId,message,deliverAt,mode?,origin?,ownerId,scheduleId?,requestId?,checkInMinutes?,selfOwned?}`. The host normalises the absolute deadline, target identity, follow-up mode and check-in interval before admission. The result is `{timerId,conversationId,identity,deadline,mode,origin,scheduleId,deduped,disposition:"scheduled"|"retained",status,outcome?}`. `status` is the native task state: `pending`, `running`, `waiting`, `sleeping`, `completing` or `terminal`. A new schedule returns `scheduled` and `pending`. A repeated key returns `retained` with the original task's current state, not a new pending timer. When present, `outcome.status` is `completed`, `aborted`, `failed`, `faulted` or `orphaned`; `completed` carries the timer result including its admitted submission ID. Failed outcomes retain their native error; orphaned outcomes retain their reason.

The session-scoped `agent.timer-schedule` document family stores only the schedule key's native task ID and payload fingerprint. The key and new native timer commit together. The fingerprint binds target, message, absolute deadline, mode, origin, owner, request ID, normalised check-in interval and request context, excluding creation time. Conflicting payload reuse refuses. Native task input and outcome remain authoritative. Listing pruning does not remove the keyed identity.

A missing index entry triggers a storage-wide timer-kind task scan, including terminal tasks and other conversations. A unique retained match is adopted for that key only. Ambiguous or incomplete bounded lookup refuses admission. The scan bounds are `TIMER_LOOKUP_PAGE_SIZE` and `TIMER_LOOKUP_PAGE_LIMIT` in `durable-timers.ts`; there is no bulk backfill. Timer execution still uses native `sleepUntil`. Cancellation reads the native task even after listing pruning; an already admitted input reports `fired`, never prevented admission.

### timer-cancel

Params: `{sessionId?,timerId}`. The timer must belong to the selected conversation; a timer of another conversation or a timer that this storage does not retain is refused. The result is `{timerId,outcome:"marked"|"terminal",status:"cancelled"|"fired"|"faulted"|"orphaned",identity}`. `outcome` is `marked` when this call committed the abort and `terminal` when the task had already settled. `identity` is the canonical external identity of the conversation that the host resolved from `sessionId`, in the same form as the `timer-schedule` result. Timer IDs are local to one storage, so a caller that tracks a scheduled input closes it only for that identity and only on `cancelled`; a result without `identity` closes nothing. Source: `extensions/agent/durable-timers.ts` (`cancelTimer`); `extensions/agent/durable-host.ts`; `extensions/agent/continuity-admission.ts` (`recordTimerCancelled`).

### place

The manager resolves the canonical area owner, creating it when absent. An absent or empty prompt resolves only; nonempty text passes verbatim. A prompted response carries `sessionId`, `submissionId` and an exact `result:{sessionId,submissionId,requestId}` for the stable place request ID, plus creation or reuse selection facts.

Native `agent_place` captures its initiating inputs and pending dispatch before external admission. It validates the returned canonical target and exact request reference before confirmation. Confirmation retains the canonical area alongside the response. At tool entry, a confirmed replay validates its task and request identity and returns the retained response before filesystem checks or other admission prerequisites, even if the directory disappears or its owner binding changes. The version-1 capture permits absent area metadata: replay presents `placeArea` when present and otherwise omits the area from text and details without changing the capture; the retained place response carries no area of its own. Present area metadata must be an absolute path. Replay never reconstructs the area from current arguments, cwd, registry state or the filesystem. Unconfirmed admission contributes incomplete run-control coverage. Place ownership never makes the shared owner an exclusively owned child; selected-run Stop uses only its captured exact input references and protects unrelated work.

Sources: `extensions/agent/durable-timers.ts`, `durable-agents.ts`, `run-control-state.ts`, `result-reference.ts`, and `manager.ts`.

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

`contributions[].name` is the contribution that supplies its commands, and `source` is where it was loaded from. A contribution may carry `display`, `{ version: 1, entry, export: "toolDisplay" }`, which names a presentation-only module that an attached terminal imports locally; the host advertises it only after `entry` resolves to a file inside the directory of the admitted `source`, and the field is absent otherwise. See `docs/conventions/tool-display.md`. A contribution may also carry `panel`, `{ version: 1, entry, export: "operatorPanel", command }`, which names an interactive browser module for the attached terminal and the contribution's own command that serves its requests; the host advertises it only after `entry` resolves inside the owner directory and `command` names one of that contribution's commands. See `docs/conventions/operator-panels.md`. `ordinaryOnly` names extensions that load but add no host command. The response identity is the schema hash `H-status`, so a consumer checks the operation identity above and the shape it uses, and refuses a reply whose `inventory` has a field outside this shape. The inventory belongs to the loaded runtime: a host reload replaces it, so a cached copy is valid only for the connection it was read on. Adding `display`, and later `panel`, changed `H-status`, so a host and a client from different releases refuse each other's `status` through the existing operation-identity check; no reader accepts the previous shape. Source: `extensions/agent/observation-schema.ts:243-249,317-320`; `extensions/agent/durable-runtime.ts:508`.

### Model choices

`models` takes the usual `sessionId` and returns `{ models, source, error?, observedAt }`. `models` lists `provider`, `modelId`, an optional `name`, `reasoning` and an optional `contextWindow` for each model the host's configured model runtime currently reports as available. `source` is `"available-snapshot"`: the host reads the runtime's last-known list, so the read starts no credential check and no network request. `error` carries the runtime's last availability error when it has one. The operation is read-only and safe to retry. A client uses the list to offer choices and to describe the selected conversation's model. It does not infer that a model absent from the list is unusable, only that this host did not list it. Source: `extensions/agent/durable-runtime.ts` (`modelChoices`); `observation-schema.ts` (`ModelChoicesSchema`).

### command

Params: `{sessionId, name:string, args?:string, invocationId:string, data?:JsonValue, origin?:"operator"|"model"}`. `name` is a command in the host inventory. `args` is the text after the name and defaults to empty. `invocationId` is required by the host and is correlation only: it is not an idempotency key, so reusing it does not make the host skip a second run (the runtime fills a missing one from the wire request ID). `data` is structured input the owning contribution validates; `origin` states who invoked the command and reaches the command as audit context, never as approval. The host runs the command against the target conversation and answers after the command returns.

Result: `{name:string, conversationId:number, identity:string, text:string, data?:JsonValue}`. `text` is whatever the command returned and has no host bound below the transport frame bound, so a consumer that shows it bounds it itself. `data` is present only when the command answered a structured request; its shape belongs to the owning contribution.

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
observe-open observe-frame observe-close timer-list models
```

Unknown methods, abort, configure, fork, rewind, compact, spawn, place, reset, close, and timer mutations are not made retry-safe merely by having a request ID. A consumer may use a narrower retry policy. Observation reconnection creates fresh tokens and a new baseline. The shared transport supports caller-local cancellation of a Chord wait. The
Agent adapter forwards its call signal to the native runtime only for
`receipts` with `wait:true`; other cancellation or disconnect must not cancel
admitted work. The separate ordinary-primary `trustPrompt` also supports caller
cancellation. Observation cleanup releases handles and tokens, not native work. Source: `extensions/agent/host-protocol.ts:196-235`; `extensions/agent/host-client.ts:546-553,697-740`.

Admission and answer delivery are separate. Native result inspection or retained delivery receipts establish result state. Acknowledgment marks receipt delivery, not operator acceptance of the answer. Self-owned result delivery acknowledges in place without another model input. Ordinary RPC prompt IDs have no equivalent native retry guarantee. Source: `extensions/agent/durable-controls.ts:905-936,995-1043,1103-1140`; `extensions/agent/README.md:1453-1460,1535-1547`.

## No-start observation versus acquiring controls

Catalog/presence reads, attach-only `connectHost`, and manager observational reads do not launch a host. Without a live host, the manager uses a bounded cold database/WAL capture for observation. This is not a wire operation and is not zero-cost filesystem work. A surviving live claim still subjects manager reads to live connection negotiation; the independent reader below does not use that route. Source: `extensions/agent/manager.ts` (`observationConnection`, `observe`); `extensions/agent/cold-observation.ts` (`openColdObservationSnapshot`); `extensions/agent/snapshot-capture.ts` (`captureSnapshot`).

Acquiring controls resolve the retained record and acquire/start its owner. An explicit attach can resume unfinished work even with no new prompt. Low-level `snapshotHost()` acquires despite its name; do not use it as an attach-only helper. Native wire spawn requires a sender conversation in an already running host; there is no hostless spawn member available from a bare transport client. Fleet/effort composition and ordinary-primary intent publication are manager functions, not host members. Source: `extensions/agent/manager.ts:469-523,762-783,830-851`; `extensions/agent/host-client.ts:910-932`; `extensions/agent/durable-runtime.ts:411-438`.

An upgraded writer follows the [store migration and retained-consumer
boundary](pi-durable-harness.md#store-format-and-retained-task-versions).
Existing consumers retain intact source and dependency bytes until their
owner-agreed transition; a new process must load one complete accepted runtime.
Cold observation opens SQLite only on a disposable copy, not the retained source store.
It does not authorize a live writer or a consumer restart.

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

Fixture shape sources: `extensions/agent/durable-host.ts:420-430`; `extensions/agent/durable-observation.ts:1133-1143`; `extensions/agent/catalog-view.ts:48-65`; `extensions/agent/host-process.ts:387-399`.
