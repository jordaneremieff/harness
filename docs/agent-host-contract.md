# Agent host contract

This document defines the current local consumer boundary for retained Durable agents. The Agent extension owns execution, storage, admission, and publication. It may change this contract. Consumers compare supported operation identities with each connected host and refuse mismatched operations; they do not require the extension to preserve older behavior.

The source references below use repository revision `4a423cf2a0a822638c09228c5a10a4df1d324e82`. Paths are relative to the repository root. References describe implementation, not runtime acceptance or the loaded version of an arbitrary running host. The companion [Durable harness track](pi-durable-harness.md) describes lifecycle context.

## Scope and identity

This is a same-user, machine-local interface. Public `@earendil-works/pi-client` and its `/unix` export supply transport. The service names, payloads, catalog publications, operation identities, and retry policy below are harness contracts, not generic Pi protocol features. The endpoint is a private directory and owner-only Unix socket, not remote authentication. Source: `extensions/agent/host-protocol.ts:1-30`; `extensions/agent/host-client.ts:213-222`; `extensions/agent/host-process.ts:523-544`.

Use these terms consistently:

- `<agentDir>` is Pi's resolved agent directory, including its configured override.
- `<store>` is `PI_AGENT_SESSIONS_DIR`, resolved as an absolute path, or `<agentDir>/agent-sessions`.
- `storageId` identifies one Durable SQLite storage and host.
- The external conversation identity is `storageId` for root conversation 1, otherwise `storageId:conversationId`.
- `conversationId`, submission IDs, and entry IDs resolve to positive safe integers. Request parsers also accept decimal-digit strings in the corresponding ID fields; responses use numbers except display snapshot entry IDs, which are strings. Source: `extensions/agent/durable-observation.ts:473-500`.
- `serverId` is the UUID used by the public transport handshake. It is not a conversation identity.

Source: `extensions/agent/index.ts:231-235`; `extensions/agent/identity.ts:15-19`; `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/dashboard-types.ts:107-127`.

A targeted request accepts either `sessionId` (external identity) or `conversationId`, never both. Omission selects root conversation 1. A `sessionId` belonging to another storage is rejected. Prefer explicit `sessionId` for every conversation operation. `dashboard` is an exception: its filter is `conversationId`, not `sessionId`. Source: `extensions/agent/durable-observation.ts:508-522`; `extensions/agent/durable-host.ts:454-457`.

Ordinary primaries are not Durable targets. Their separate presence/message channel does not expose these controls or a live terminal attachment. Source: `extensions/agent/manager.ts:526-555`.

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

Choose the first socket directory for which `join(directory, serverId + ".sock")` is at most 100 UTF-8 bytes: `<agentDir>/durable-hosts`, `join(tmpdir(), "pi-hosts")`, then `/tmp/pi-hosts`. Refuse if none fits. The claim is:

```text
claimKey = sha256(JSON.stringify([resolvedCwd, storageId])).hex
join(hostDirectory, ".claims", claimKey + ".lock")
```

Source: `extensions/agent/host-protocol.ts:34,151-181`; `extensions/agent/claims.ts:47-52`.

Connect with `new Client({serverId, transportFactory: createUnixTransportFactory({path: socketPath})})`, await `connect()`, then negotiate. The configured `serverId` binds the public handshake to the expected server; a matching filename alone is insufficient. Attach-only access first requires a live claim, then a successful connection and usable descriptor. Source: `extensions/agent/host-client.ts:213-222,325-347`.

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

## Negotiation and request envelope

Negotiate on the expected server target:

```json
{"serviceId":"pi.agent.host","member":"runtime-contract","args":[]}
```

This is the `call` passed to `client.request({serverId}, call)`, not the complete CBOR protocol envelope. Its result is:

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
client.request(
  {serverId},
  {serviceId: "pi.agent.host", member,
   args: [params ?? null, wireRequestId, expectedOperationContract]}
)
```

The host recognizes `runtime-contract` before operation dispatch. Otherwise it compares the supplied operation's request, response, and optional Durable identities against its own identities **before parsing or admitting the operation payload**. A mismatch produces a service error and no operation is admitted. The client also checks before dispatch. Source: `extensions/agent/host-client.ts:499-516`; `extensions/agent/host-process.ts:523-544`; `extensions/agent/version-contract.ts:118-131`.

A consumer must possess an expected contract for the payload it implements. It must not simply echo unknown identities from the remote descriptor: that defeats the check. Require equality of request, response, and optional `durable`. Missing or malformed negotiation disables the host; mismatch of one operation disables that operation. Check the complete dependency set for a composite action. Re-negotiate after reconnect. Do not infer compatibility from source release ordering, endpoint liveness, or a successful unrelated call. Source: `extensions/agent/version-contract.ts:118-131`; `extensions/agent/host-protocol.ts:218-223`; `extensions/agent/host-client.ts:325-347,499-506,640-646`.

### Current operation identities

`D` below is the exact `@earendil-works/pi-durable` release loaded by that process, not a future version pinned by this document. A consumer of opaque native values compares it with the Durable representation it supports. The descriptor's `release` is currently `1.0.0`, and both API floors are `1.0.0`; those labels do not replace this table. Source: `extensions/agent/version-contract.ts:10-12,30-70`.

For every member in the following set, request and response are both `<member>/1.0.0`, with no `durable` field:

```text
close passive-submit attach report acknowledge abort reset
 timer-list timer-cancel observe-close changes
 collaboration-list collaboration-read collaboration-mutate await-release
```

Overrides and remaining members:

| Member | Request | Response | Durable |
|---|---|---|---|
| recovery-state | recovery-state/1.0.0 | recovery-state/1.1.0 | absent |
| submit | submit/1.1.0 | submit/1.1.0 | absent |
| spawn | spawn/2.0.0 | spawn/2.0.0 | absent |
| place | place/2.0.0 | place/2.0.0 | absent |
| resolve-agent | resolve-agent/2.0.0 | resolve-agent/2.0.0 | absent |
| receipts | receipts/1.1.0 | receipts/1.1.0 | D |
| inspect | inspect/1.0.0 | H-inspect | D |
| status | status/1.0.0 | H-status | D |
| list | list/1.0.0 | H-list | absent |
| fork | fork/1.0.0 | fork/1.0.0 | D |
| rewind | rewind/1.1.0 | rewind/1.0.0 | D |
| compact | compact/1.0.0 | compact/1.0.0 | D |
| configure | configure/1.2.0 | configure/1.2.0 | absent |
| command | command/1.1.0 | command/1.0.0 | D |
| timer-schedule | timer-schedule/1.1.0 | timer-schedule/1.0.0 | absent |
| dashboard | dashboard/1.0.0 | H-dashboard | absent |
| snapshot | snapshot/1.0.0 | snapshot/1.0.0 | D |
| observe-open | observe-open/1.0.0 | observe-open/1.0.0 | D |
| observe-frame | observe-frame/1.0.0 | observe-frame/1.0.0 | D |
| profile-read | profile-read/1.0.0 | H-profile-read | absent |
| profile-update | profile-update/1.0.0 | H-profile-update | absent |
| profile-list | profile-list/1.0.0 | H-profile-list | absent |
| task-submit | task-submit/1.0.0 | task-submit/1.1.0 | absent |
| await-state | await-state/1.1.0 | await-state/1.1.0 | absent |

Each `H-*` is the lowercase hex SHA-256 of `JSON.stringify` of the owning schema, not a hash of a response instance. The current schema-derived identities are:

```text
H-inspect       98cbec841b6626155420cf582d77e318ea0c8e7607f113dffe04d94bf1b99736
H-status        5df139e808900bee9bf561760b4f7da690df743f336609ec26ab0a7a11957dc1
H-list          76e932a0749fd72c9aef6b90635d061e455f84fb57f7f9bd102034cf28887600
H-dashboard     46dd1bdd919bd3093ad6a3c0a316b35fa05d491490a37c9879ef9a9cffc4f241
H-profile-read  b78d87440ae527566e0f13603e638dfa057aaa87f2985521e32b9c859baa1889
H-profile-update 7c805d143fae0d6a9fd373a4acb24fc080c94fa4b0787d447545e08714907eb4
H-profile-list  0eb5c60290d491535a1dd158e5d5ed4432eb8f89fe26a496a395e08b58ff4db4
```

Schema owners in table order are `InspectOutputSchema`, `StatusOutputSchema`, `ListRowSchema`, `AgentConversationSummarySchema`, `AgentProfileSchema`, `ProfileUpdateSchema`, and `ProfiledListOutputSchema`. `dashboard` returns an array despite its response identity hashing the row schema. Maintain these identities with the defining schemas; do not infer a complete result shape from the schema name alone. Source: `extensions/agent/version-contract.ts:30-56`; `extensions/agent/durable-host.ts:454-457`.

The table lists advertised identities, not a claim that all members have the same target or side-effect policy. The consumer operations below define the relevant payloads. `changes` gates a service subscription; it is not an ordinary runtime request member.

## Roster publications and dashboard

### Native dashboard operation

Params: `{conversationId?: positiveInteger, cwd?: string}`. Result: `AgentConversationSummary[]`, not `{rows,coverage}`. The cwd supplies presentation context. This reads one host's native summaries; it does not enumerate the machine's catalog. Source: `extensions/agent/durable-host.ts:454-457,481-490`; `extensions/agent/durable-observation.ts:705-708`; `extensions/agent/dashboard-types.ts:60-104`.

A summary has required fields:

```text
{id, storageId, cwd, modifiedAt:number, owner, state, cost:number, partial:boolean}
```

Optional fields are `creatingOwnerId`, `name`, `firstMessage`, `model:{provider,modelId,thinkingLevel}`, `ownerLabel`, `latestReply`, `error`, `toolCalls`, `currentTool:{name,argument}`, `durationMs`, `health`, and `awaiting`. Manager-enriched rows can also include `profile`; it is not part of the base native row contract. `owner` is `here | unavailable | unknown`. `state` is `starting | working | idle | done | failed | stopped | interrupted | new | unavailable`. `health` carries optional `lastError`, `compactionFailure:{reason,at,errorMessage?}`, and `autoRetry:{attempt,maxAttempts,delayMs,errorMessage}`. `awaiting` is optional retained wait information; a consumer that does not display it leaves it opaque. Source: `extensions/agent/dashboard-types.ts:13-104`; `extensions/agent/version-contract.ts:54`; `extensions/agent/manager.ts:677-700`.

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
Entry = {id:string,kind:string,model?:PiMessage[],data?:JSON,head?:string}
```

Entries are oldest first. System entries are hidden. `revision` is an opaque display revision, not a durable replay cursor. Preserve `partial`, coverage, and `nextBefore`; an empty bounded scan with null continuation does not override `complete:false`. Earlier reads scan at most eight source pages of 64 entries. Source: `extensions/agent/dashboard-types.ts:107-135`; `extensions/agent/durable-observation.ts:1037-1057,1102-1200`.

**Byte-bound exception:** selection admits the first visible entry even if that entry alone exceeds `maxBytes`. `coverage.bytes` measures source-entry selection, not a hard serialized response bound. Model messages, entry data, and live frames require separate consumer output/memory bounds. Source: `extensions/agent/durable-observation.ts:1063-1097`.

### Inspect

Params: `{sessionId, view?, limit?, cursor?, entryId?, fromId?, offset?, query?, source?, submissionId?, operationId?}`. Supported views are `activity`, `history`, `branch`, `search`, `exact`, and `result`; the raw host default is `history` (`extensions/agent/durable-observation.ts:1858-1873`). Sources are `user`, `assistant`, `toolResult`, `summary`, and `custom`. `cursor` is an opaque JSON object: pass the returned cursor unchanged to the same query/target, never fabricate it from entry IDs. Source: `extensions/agent/durable-observation.ts:77-90,524-541`; `extensions/agent/durable-host.ts:612-618`; `extensions/agent/observation-schema.ts:47,306-427`.

Output is discriminated by `view`:

| View | Result fields |
|---|---|
| history | `{view:"history",format:"compact",sessionId,conversationId,entries:CompactEntry[],nextCursor:object|null,order:"newestFirst",detail:string}` |
| branch | Same common history fields, `view:"branch"`, raw entry rows instead of compact format. |
| activity | `{view:"activity",format:"compact",sessionId,conversationId,turns:[{entries:CompactEntry[]}],nextCursor,metadata,coverage,detail}` |
| exact | `{view:"exact",sessionId,conversationId,entryId,offset,text,nextOffset:number|null,truncated,omissions?}`; text is retained redacted JSON, not an unredacted archive. |
| search | `{view:"search",sessionId,conversationId,matches,nextCursor,coverage:{scannedEntries,scannedBytes,complete},detail}` |
| result | `{view:"result",sessionId,conversationId,submissionId,status,requestId?,operationId?,entryId?,answerEntryId?,reason?,answer?,usage}`; status is queued, placed, done, or unanswered. |

`CompactEntry` has `{id:number,kind,source,role?,text,truncated,format:"compact",nextOffset:null,omissions?,toolCalls?,toolResults?,omittedParts?}`. Tool call summaries carry `{callId?,name,arguments,truncated}`; tool result summaries carry `{callId?,name,text,isError,truncated}`. Raw rows omit the compact discriminator and may carry `preview:{text,truncated}` plus `nextOffset`. Omission counters are `{providerSignatures,imagePayloads,redactedThinking}`. Search matches carry `{entryId,kind,source,matchOffset,excerpt,excerptText,truncated}` and their cursor is `{cursor:object|null,skip,scannedBytes}`. Source: `extensions/agent/observation-schema.ts:306-377`.

Activity metadata contains `{owner,live,operation:number|null,runningTools,pending:number|null,streamedText?,lastError?,compactionFailure?,autoRetry?}`. Running tools carry `{toolCallId,name,issuedAt?,elapsedMs?,elapsedFrom?}`. Activity coverage includes scanned entries/bytes, complete, entry/scan-byte/output-byte limit flags, output bytes, omittedEntries, and metadataTruncated. Usage is `{models:{[key]:Usage},tools:{[key]:Usage}}`, with Pi usage values; consumers need not display financial fields to read an answer. Source: `extensions/agent/observation-schema.ts:49-60,379-425`.

These are retained/read projections, not proof of operation completion outside the requested result reference. Exact continuation uses `nextOffset`; history/activity/search use `nextCursor`. Do not silently exchange them.

## Live observation and change subscriptions

### Open, subscribe, and close

Open params are `{token,scope:"conversation",sessionId}` or `{token,scope:"tasks"}`. A token contains 1–128 letters, digits, dots, underscores, colons, or dashes; use a fresh random token for a fresh connection. `observe-open` returns `{token,frame}`. `observe-frame` with `{token}` returns the current frame. `observe-close` with `{token}` returns `{closed:boolean}`. Source: `extensions/agent/durable-host.ts:101-117,841-859`.

After open, subscribe on the **same Client connection**:

```text
client.subscribeService(
  {serverId}, "pi.agent.host.observe:" + token, "singleton", listener
)
```

The host tracks tokens per connection and rejects a subscription to an unowned token. Its snapshot is:

```text
{
  serviceId:"pi.agent.host.observe", mode:"singleton",
  instances:[{members:[{
    name:"frame",kind:"state",sequence:frame.revision,ops:[["r",frame]]
  }]}]
}
```

The snapshot serviceId intentionally lacks the token suffix. Later state updates use member `frame` and root-replacement ops `[["r",frame]]`. Handle service unavailability separately. Inspect the subscription snapshot before `subscription.start()`; later buffered updates then follow it. Prefer that snapshot to the earlier open result. Source: `extensions/agent/host-process.ts:403-440`; `extensions/agent/host-client.ts:697-740`; `extensions/agent/live-frames.ts:179-185`.

A conversation frame is:

```text
{
  scope:"conversation",storageId,conversationId:number,revision:number,observedAt:string,
  entries:Entry[],nextBefore:number|null,live:Entry[],status:ConversationStatus,
  coverage:{complete,entries,bytes,hiddenExcluded,entryLimitReached,byteLimitReached}
}
```

`entries` are committed visible entries; `live` is uncommitted assistant/tool output. Live IDs include `live:generation` and `live:tool:<callId>`. They must not become committed history. The frame is coalesced current state, not an append-only event stream. Revision ordering applies within the current observation lifetime; a new connection/token starts a new baseline. Source: `extensions/agent/live-frames.ts:15-30,74-140`; `extensions/agent/host-client.ts:697-741`.

`ConversationStatus` includes `{conversationId,identity,busy,lastText,live,inbox,agent,tasks,submissions}` and optional `name`, `owner`, `firstMessage`, `forkSource`, `ownerTaskId`, `awaiting`, `cwd`, `lastTextRole`, `usage`, `timers`. `agent` carries `{model?:{provider,modelId},thinkingLevel,extensions:string[],tools:string[],cwd?,instructions?}`. Tasks carry `{id,kind,status,background,owner?,abortRequested}`; submissions carry `{id,type:"input"|"write",status,requestId?,entryId?,answerEntryId?,reason?}`. Native `live`, `inbox`, usage, and task statuses belong to the exact declared Durable representation. Source: `extensions/agent/durable-observation.ts:99-156`.

A tasks frame is `{scope:"tasks",storageId,revision,observedAt,tasks,labels,coverage:{complete,live}}`. Task rows contain `{id,kind,conversationId,owner?,background,abortRequested,status,phase,waitsOn,policy?,outcome?,conversations}`; labels contain `{conversationId,identity,name?,firstMessage?}`. Source: `extensions/agent/live-frames.ts:33-70`.

Dispose the subscription and close its token when no longer observed. Disconnect cleans connection-owned observations; explicit token cleanup is still the normal path. Observations keep a host alive and block native reload. Disconnect/observation close do not abort admitted work. The host `close` operation is runtime/process shutdown and is not client cleanup. Source: `extensions/agent/host-process.ts:443-456,535-539`; `extensions/agent/host-client.ts:746-767,891-919`; `extensions/agent/durable-runtime.ts:375-411`.

### Changes

After checking the `changes` operation identity, subscribe to `pi.agent.host.changes`, mode `singleton`. Its state member is `change`; the baseline uses sequence 0 and `ops:[["r",{revision:0}]]`. Later revisions coalesce actual runtime writes per microtask. They are subscription-local invalidations, not global catalog deltas or replay cursors. Source: `extensions/agent/host-process.ts:367-399`; `extensions/agent/host-client.ts:586-610`.

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

The broader native input also accepts content-part arrays; a text-only consumer need not implement them. Origin and requester are required. `replyTo` defaults to requester, so a consumer seeking a self-owned result must explicitly set `replyTo` to the target conversation. The server supplies senderIdentity from that conversation; do not impersonate a native sender to create work. Source: `extensions/agent/durable-host.ts:126-138,403-414`; `extensions/agent/durable-controls.ts:216-240`.

The result is `{submissionId:number,conversationId:number,deduped:boolean,identity:string,result:{sessionId:string,submissionId:number,requestId?:string}}`. The request above produces a result reference with its requestId. It confirms admitted/already-admitted work, not execution, placement mode, final answer, or operator acceptance. Steer waits for a native boundary; it does not interrupt a running tool. Follow-up waits for the current run. Held-result state can affect placement. Source: `extensions/agent/durable-host.ts:403-414`; `extensions/agent/durable-controls.ts:235-240,350-423`; `extensions/agent/result-reference.ts:32-60`.

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

1. The public transport's correlation ID, owned by pi-client.
2. `wireRequestId`, the second service argument, retained by a caller across safe link recovery.
3. Native `params.requestId`, the admission/mutation key. The runtime fills a missing native key from the wire key for task-submit, profile-update, submit, rewind, and report.

Keep both application keys stable for the same logical request, including its target and original input. Never reuse a key for edited text. Request admission deduplicates; this is not an exactly-once guarantee for external tools or provider calls. Source: `extensions/agent/host-client.ts:499-516`; `extensions/agent/host-process.ts:517-528`; `extensions/agent/durable-runtime.ts:477-480`; `extensions/agent/durable-controls.ts:235-240,389-423`.

The current retry-safe method set is exactly:

```text
profile-read profile-list profile-update task-submit resolve-agent
collaboration-list collaboration-read collaboration-mutate passive-submit
submit report acknowledge inspect status list receipts dashboard snapshot
observe-open observe-frame observe-close timer-list
```

Unknown methods, abort, configure, fork, rewind, compact, spawn, place, reset, close, and timer mutations are not made retry-safe merely by having a request ID. A consumer may use a narrower retry policy. Observation reconnection creates fresh tokens and a new baseline. Only `receipts` with `wait:true` forwards request cancellation to the host; other client cancellation/disconnect must not cancel admitted work. Source: `extensions/agent/host-protocol.ts:196-235`; `extensions/agent/host-client.ts:546-553,697-740`.

Admission and answer delivery are separate. Native result inspection or retained delivery receipts establish result state. Acknowledgment marks receipt delivery, not operator acceptance of the answer. Self-owned result delivery acknowledges in place without another model input. Ordinary RPC prompt IDs have no equivalent native retry guarantee. Source: `extensions/agent/durable-controls.ts:905-936,995-1043,1103-1140`; `extensions/agent/README.md:1453-1460,1535-1547`.

## No-start observation versus acquiring controls

Catalog/presence reads, attach-only `connectHost`, and manager observational reads do not launch a host. Without a live host, the manager can make a bounded cold SQLite copy for observation; this is not a wire operation and is not zero-cost filesystem work. Source: `extensions/agent/manager.ts:284-303,703-733`; `extensions/agent/cold-observation.ts:133-190`.

Acquiring controls resolve the retained record and acquire/start its owner. An explicit attach can resume unfinished work even with no new prompt. Low-level `snapshotHost()` acquires despite its name; do not use it as an attach-only helper. Native wire spawn requires a sender conversation in an already running host; there is no hostless spawn member available from a bare transport client. Fleet/effort composition and ordinary-primary intent publication are manager functions, not host members. Source: `extensions/agent/manager.ts:469-523,762-783,830-851`; `extensions/agent/host-client.ts:910-932`; `extensions/agent/durable-runtime.ts:411-438`.

## Synthetic contract examples

These examples contain fabricated identities and data. They are valid-shape examples for consumer fixtures, not recorded sessions or evidence of execution. A fixture test must also test incompatible identities and malformed fields. Native-version-dependent fixtures use the consumer's supported `D` in their operation envelope.

### Fixture: operator-input

```json
{"serviceId":"pi.agent.host","member":"task-submit","args":[{"sessionId":"00000000-0000-4000-8000-000000000001","message":"Describe the current state.","origin":"operator","requester":"consumer:example","replyTo":"00000000-0000-4000-8000-000000000001","requestId":"input-example","whenBusy":"steer"},"input-example",{"request":"task-submit/1.0.0","response":"task-submit/1.1.0"}]}
```

### Fixture: admitted-input

```json
{"submissionId":7,"conversationId":1,"deduped":false,"identity":"00000000-0000-4000-8000-000000000001","result":{"sessionId":"00000000-0000-4000-8000-000000000001","submissionId":7,"requestId":"input-example"}}
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
{"type":"state","member":"change","sequence":1,"ops":[["r",{"revision":1}]]}
```

Fixture shape sources: `extensions/agent/durable-host.ts:403-414`; `extensions/agent/durable-observation.ts:1133-1143`; `extensions/agent/catalog-view.ts:48-65`; `extensions/agent/host-process.ts:387-399`.
