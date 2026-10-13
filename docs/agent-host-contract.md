# Agent host contract

This document defines the current local consumer boundary for retained Durable agents. The Agent extension owns execution, storage, admission, and publication. It may change this contract. Consumers compare supported operation identities with each connected host and refuse mismatched operations; they do not require the extension to preserve older behavior.

Communication shapes and operation identities are defined by `extensions/agent/communication.ts`, `observation-schema.ts`, and `version-contract.ts`. Historical line-number references use repository revision `4a423cf2a0a822638c09228c5a10a4df1d324e82`, except receipts, configure, task-submit, status and provider-block references, which use `0468691ac2c7bdf8a85d3aa8560f2e5d87dfce26`. These references do not establish the version loaded by a running host.

Paths are relative to the repository root. References describe implementation, not runtime acceptance or the loaded version of an arbitrary running host. The companion [Durable harness track](pi-durable-harness.md) describes lifecycle context.

## Scope and identity

This is a same-user, machine-local interface. [Independent retained reads](#independent-retained-reads) use a one-shot process without a live host. Chord's public typed host runtime supplies live calls and state over a bounded Unix-socket `Link`. The [wire contract](#chord-wire-contract) defines the shared boundary for Agent and independent UI consumers. Payloads, catalog publications, operation identities, and retry policy remain harness contracts. The endpoint is a private directory and owner-only Unix socket, not remote authentication. Chord owns calls, cancellation, and state; the socket adapter owns framing, bounds, close, and initial identity admission.

Use these terms consistently:

- `<agentDir>` is Pi's resolved agent directory, including its configured override.
- `<store>` is `PI_AGENT_SESSIONS_DIR`, resolved as an absolute path, or `<agentDir>/agent-sessions`.
- `storageId` identifies one Durable SQLite storage and host.
- The external conversation identity is `storageId` for root conversation 1, otherwise `storageId:conversationId`.
- `conversationId`, submission IDs, and entry IDs resolve to positive safe integers. Live request parsers also accept decimal-digit strings in the corresponding ID fields; responses use numbers except display snapshot entry IDs, which are strings. Source: `extensions/agent/durable-observation.ts:473-500`.
- `serverId` is the expected Chord host name in the first `hello` frame. It is not a conversation identity.

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

The existing input provenance bound remains 128. Its prune predicate retains queued and placed submissions, plus the original live-run condition for unadmitted classification rows. Before eviction of terminal rows, the owner prepares all native and index reads for their unlinked intents, then appends companions and updates their indexes in that same prune transaction. Only after those writes does it remove the rows. `CommunicationIndexDoc` is a persisted, session-scoped point-index family (`agent.communication-index`) keyed by storage, original conversation and native entry. It retains target and companion identifiers, invalid markers or no-envelope decisions. This lookup hint does not replace immutable native records as authority. Admission intent stays in the existing bounded provenance rows; no second delivery queue, admission pin or metadata-specific admission capacity rule is introduced. Queued intent reconciliation uses the existing background and reopen paths. Invalid or unavailable metadata produces a bounded owner diagnostic or invalid index marker without changing native input acceptance.

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

## Ordinary peer communication mapping

Ordinary Pi custom messages with `customType: "agent.peer"` expose a structured peer contribution through their supplied `details`. This section is the public mapping for consumers; it does not authorize imports of Agent-private types, prose parsing, new delivery operations, or history rewriting. The `primary-delivery/2.0.0` channel changes transport identity, not this payload mapping. `sendMessage`, wake behavior, original content, and `display: false` exclusion retain their meanings. Saved `custom_message` entries and live `role: "custom"` messages use the same mapping before projection drops their details.

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

## Chord wire contract

The live interface uses the published Chord `remote`, `method`, `createHost`,
`Link`, and `Frame` contracts. The package-level transport entrypoint serves
both Agent and UI; neither imports the other's private implementation. Its
contract runtime values use these exact closed schemas:

```typescript
import { method, remote } from "@earendil-works/chord";
import { Type } from "typebox";

const Endpoint = remote("pi.agent.endpoint", {
  version: 1,
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
  version: 1,
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
`name: serverId`, and a nonnegative safe-integer epoch. The client rejects a
mismatch and forwards the same matching hello to Chord. The server accepts only client
peers and assigns a unique connection principal; supplied frame fields do not
select that principal. Filesystem permissions, not the public name, enforce
same-user access. Attach failure grants no authority to start or replace a host.

Create a Chord client host, connect the Unix `Link`, and acquire
`host.get(Endpoint, {serverId}, {at: serverId})`. Await its readiness within the
handshake deadline. Run calls through `host.root()`. Unwrap the response's
optional `value` without converting absent values to `null`. Chord errors
remain errors, not empty data. Malformed application input uses `invalid`.
Version refusal uses `unavailable` with reason `version`; other availability,
claim, and internal distinctions remain in the reason. The shared server keeps
Chord errors intact and wraps untyped failures as `unavailable/internal`.
Link loss is a separate failure. Do not encode an error code in its message.

The Unix Link closes on a received `bye` instead of forwarding it. Sending
after close is a no-op. Serialization or queue overflow closes the Link and
returns from its void `send()` without a throw or a partial offending frame.
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

The manager's retained-object identity is `manager/3.0.0`; ordinary primary
channels use `primary-delivery/2.0.0`. Their Endpoint methods are `info`,
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

The current descriptor requires `codingAgent: "1.2.0"` and `durable: "1.2.0"`. The coding-agent floor covers custom-message startup guidance and its retention through tool rounds. The Durable floor covers native codemode, deferred tool search, nested tool execution, and `Session.closed`. These are minimum required APIs, not dependency pins, a supported-version ceiling, or a substitute for exact operation checks. Read floors from the loaded descriptor, not from the source release label. Source: `extensions/agent/version-contract.ts:10-12,30-75`; installed coding-agent and Durable `CHANGELOG.md` sections for 1.2.0.

For every member in the following set, request and response are both `<member>/1.0.0`, with no `durable` field:

```text
close attach report acknowledge abort reset
 timer-list timer-cancel observe-close changes
 collaboration-list collaboration-read collaboration-mutate await-release
```

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
| compact | compact/1.0.0 | compact/1.0.0 | D |
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
H-status        294bb95f3d60b9c9ae2976f291e4f8d41c11d00ec517c1aebcfd9c7af40a3087
H-list          76e932a0749fd72c9aef6b90635d061e455f84fb57f7f9bd102034cf28887600
H-dashboard     a89f98f3eb28c78f115c0010581107073600bfb9ec44934ad622aeb5d1cffcd7
H-profile-read  b78d87440ae527566e0f13603e638dfa057aaa87f2985521e32b9c859baa1889
H-profile-update 7c805d143fae0d6a9fd373a4acb24fc080c94fa4b0787d447545e08714907eb4
H-profile-list  0eb5c60290d491535a1dd158e5d5ed4432eb8f89fe26a496a395e08b58ff4db4
```

Schema owners in table order are `InspectOutputSchema`, `StatusOutputSchema`, `ListRowSchema`, `AgentConversationSummarySchema`, `AgentProfileSchema`, `ProfileUpdateSchema`, and `ProfiledListOutputSchema`. `dashboard` returns an array despite its response identity hashing the row schema. Maintain these identities with the defining schemas; do not infer a complete result shape from the schema name alone. Source: `extensions/agent/version-contract.ts:30-56`; `extensions/agent/durable-host.ts:454-457`.

The table lists advertised identities, not a claim that all members have the same target or side-effect policy. The consumer operations below define the relevant payloads. `changes` gates a Feed subscription; it is not an ordinary runtime request member.

The current `extensions/agent/observation-schema.ts` permits optional native
`startedAt` and `endedAt` on conversation task rows. Durable stamps wall-clock
milliseconds at first running and terminal state; the span includes waits and
recovery, not only execution. Status selects live tasks, so their terminal
`endedAt` remains absent. Missing timestamps remain absent. Schema checks against
Pi/Durable 1.2.0 on 2026-10-13 change inspect, status, and dashboard response
hashes for nested metadata and compaction failure. List and snapshot/observe
response identities retain their shapes; exact native operations still bind D.

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
  modelEvidence?:bounded sampled evidence
}
```

The serialized view is at most 24 KiB. Producer text fields are bounded at 2,000 UTF-16 code units. The root row is first when it fits. `coverage.complete:false` includes omitted rows **or trimmed text**. Missing hints/evidence are unknown, never zero. Invalid view shape or mismatched storage identity makes the view unavailable; it does not make the database empty. Source: `extensions/agent/catalog-view.ts:20-65,91-148,151-192`; `extensions/agent/catalog.ts:264-275`.

A manager roster composes retained views with current claim observations:

- live claim → `owner:"here"`;
- absent/dead claim → `owner:"unknown"`;
- unknown claim → `owner:"unavailable"`;
- any non-live claim changes a published `working` state to `interrupted` and removes `currentTool`;
- missing/unavailable view produces an unavailable row, not a fabricated native state.

`ownerLabel` records publication time and any claim error. Published state, cost, and health remain observations at `updatedAt`, not fresh native assertions. Source: `extensions/agent/manager.ts:677-700`.

Manager `dashboardPage()` returns `{rows, observedAt, coverage:{complete,storagesVisited,skipped,omitted,nextCursor}}`; this composition is not a host operation. Catalog page results carry records, record cursors, skipped storage IDs, observedAt, nextCursor, and `{visited,skipped,complete}`. Catalog pages default to 20 records, cap at 32, and visit at most 256 entries. Manager roster composition visits at most sixteen pages. Each catalog page still enumerates and sorts the entire directory before its bounded reads. Its continuation is not a frozen snapshot; insertion behind a cursor requires a fresh scan. Source: `extensions/agent/catalog.ts:28-75,343-386`; `extensions/agent/manager.ts:90,652-675`; `extensions/agent/dashboard-types.ts:139-163`.

## Transcript pages and inspection

### Snapshot

Params: `{sessionId, before?:positiveInteger, limit?:integer, maxBytes?:integer}`. `limit` is bounded to at most 200 entries. The default byte target is 65,536; the maximum requested byte target is 1,048,576. `before` selects entries strictly older than that native entry ID. Source: `extensions/agent/durable-host.ts:821-824`; `extensions/agent/durable-observation.ts:705-708,1102-1130`.

Result:

```text
{
  entries: Entry[], partial:boolean, revision:string, nextBefore:number|null,
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

A tasks frame is `{scope:"tasks",storageId,revision,observedAt,tasks,labels,coverage:{complete,live}}`. Task rows contain `{id,kind,conversationId,owner?,background,abortRequested,status,phase,waitsOn,policy?,outcome?,conversations}`; labels contain `{conversationId,identity,name?,firstMessage?}`. Source: `extensions/agent/live-frames.ts:33-70`.

Dispose the subscription and close its token when no longer observed. Disconnect cleans connection-owned observations; explicit token cleanup is still the normal path. Observations keep a host alive and block native reload. Disconnect/observation close do not abort admitted work. The host `close` operation is runtime/process shutdown and is not client cleanup. Source: `extensions/agent/host-process.ts:443-456,535-539`; `extensions/agent/host-client.ts:746-767,891-919`; `extensions/agent/durable-runtime.ts:375-411`.

### Changes

After checking the `changes` operation identity, acquire Feed with
`{serverId,kind:"changes"}` and subscribe to `value`. Ignore hydration until
`ready:true`; its value is `{revision:number}`. Later revisions coalesce actual
runtime writes per microtask. Read-only operations create no change event.
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

The result is `{submissionId:number,conversationId:number,deduped:boolean,identity:string,result:{sessionId:string,submissionId:number,requestId?:string}}`. The request above produces a result reference with its requestId. It confirms admitted/already-admitted work, not execution, placement mode, final answer, or operator acceptance. Steer waits for a native boundary; it does not interrupt a running tool. Follow-up waits for the current run. Held-result state can affect placement. Source: `extensions/agent/durable-host.ts:420-430`; `extensions/agent/durable-controls.ts:235-245,401-447`; `extensions/agent/result-reference.ts:53-61`.

The ordinary manager's `control("submit")` maps to `task-submit`; raw host `submit` is a different base operation. Match the documented wire member, not a manager method name. The standalone terminal uses operator origin and self-owned replyTo. Source: `extensions/agent/manager.ts:469-514`; `extensions/agent/terminal-client.ts:123-131`.

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

## Independent retained reads

`extensions/agent/retained-read.ts` exposes `retained-read/1.0.0` outside a Pi
session. It reads retained snapshot and inspection evidence without starting or
resuming an agent. It is a separate executable, not a `durable-runner.ts` mode,
Unix service, or live-host fallback. Consumers use this process contract rather
than importing Agent implementation modules or parsing private SQLite shapes.

### Invocation and descriptor

Invoke without a shell:

```text
node <agent-extension-directory>/retained-read.ts --contract
node <agent-extension-directory>/retained-read.ts
```

The backend chooses the trusted executable path; browser input and retained
`packageDir` never select it. The reader uses its own installed package graph.
It does not load the retained target's package directory, cwd resources,
settings, credentials, models, or extensions.

`--contract` emits `{version,upstream:{codingAgent,durable},operations:{snapshot,inspect}}`
without reading catalog or storage. `version` is exactly `retained-read/1.0.0`.
The loaded reader derives upstream versions and both operation values from
`HOST_CONTRACT`; it advertises no other operations. See the
[descriptor fixture](#fixture-retained-read-descriptor). Its concrete 1.2.0
values describe the current example, not a supported-version ceiling.

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
  sessionId: string, method: "snapshot" | "inspect",
  expected: {request: string, response: string, durable?: string},
  params: object
}
```

Every top-level field is required, including `params:{}` for a snapshot with
no optional parameters. Unknown fields fail. History uses method `inspect`
with `params.view:"history"`; there is no history alias or third method.

- `id` is nonempty, at most 256 UTF-16 code units, and contains no whitespace or
  control characters. It correlates this process response only, not native
  requestId, operationId, or submission ID.
- `store` is an absolute filesystem path, at most 4096 code units, with no
  control characters. It is the existing sessions root containing `durable/`,
  not a database file path.
- `sessionId` is a canonical lowercase storage UUID for root conversation 1,
  or that UUID plus `:` and a canonical positive safe decimal conversation ID
  greater than 1. Handles, names, root `:1`, leading zeros, and paths fail.
- `expected` is the closed existing `OperationContract` shape. Its identity
  strings are nonempty, at most 256 code units, with no ASCII spaces/control
  characters; `durable`, when present, is a valid semantic-version string.

The reader validates the envelope, expected operation, and parameter grammar
before catalog or source-storage access. It parses `expected` with the existing
operation parser and compares request, response, and optional Durable identity
by exact equality against its selected `HOST_CONTRACT` operation. For both
native methods, missing or different Durable identity fails. Consumers supply
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

### Response and failures

A successful read has this closed wrapper:

```text
{
  version: "retained-read/1.0.0", id: string, ok: true,
  method: "snapshot" | "inspect", sessionId: string,
  storageId: string, conversationId: positiveSafeInteger, result: operationPayload
}
```

`result` is the unchanged current [snapshot or inspect payload](#transcript-pages-and-inspection),
not a new transcript format. Snapshot retains native entry/model values,
communication metadata, inherited fork-origin IDs, pagination, and coverage.
The wrapper adds target correlation. Inspect retains its closed output union,
native optional timing fields, and matching sessionId/conversationId. A missing
native result selector target is a successful `status:"unavailable"` inspection,
not a process error or fabricated submission. Missing catalog, source database,
or conversation instead returns `not_found`. An existing empty conversation
returns its normal empty payload. See the
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
| not_found | Catalog, database, or selected conversation absent | false |
| source_changed | Source identities changed during capture; copied view discarded | true |
| source_unreadable | Permissions, nonregular/symlink source, corrupt/unusable SQLite, or unsupported nonempty rollback journal | false |
| limit_exceeded | Request, source, or output byte bound exceeded | false |
| timeout | Cooperative read deadline expired | true |
| cancelled | SIGINT/SIGTERM or caller cancellation of this reader | false |
| internal | Other reader failure | false |

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
{"version":"retained-read/1.0.0","upstream":{"codingAgent":"1.2.0","durable":"1.2.0"},"operations":{"snapshot":{"request":"snapshot/1.0.0","response":"snapshot/2.0.0","durable":"1.2.0"},"inspect":{"request":"inspect/1.1.0","response":"d38d5e5a297d6b3738547ab0154cd494602f01c4a898423a076d2d946e430a6b","durable":"1.2.0"}}}
```

### Fixture: retained-read-request

```json
{"version":"retained-read/1.0.0","id":"retained-example","store":"/example/sessions","sessionId":"00000000-0000-4000-8000-000000000001:2","method":"snapshot","expected":{"request":"snapshot/1.0.0","response":"snapshot/2.0.0","durable":"1.2.0"},"params":{"limit":50,"maxBytes":65536}}
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
