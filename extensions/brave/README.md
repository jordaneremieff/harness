# brave: bounded general web search and public-page reading

This extension gives the agent public-page reading and web search without an extension-local SDK, package manifest, lockfile, or
`node_modules` tree.

## Surface

| Surface | Kind | Purpose |
|---|---|---|
| `web_read` | tool | Read one public HTTP(S) page as bounded static text, locate a literal phrase, or discover exact HTML source links, with the final URL, retrieval time, and snapshot references. |
| `web_search` | tool | Search the public web with optional country, language, freshness, SafeSearch, spellcheck, extra excerpts, and pagination controls. |

`web_read` registers first, then `web_search`. The reader covers the observed
job of opening a public primary page as evidence; the search tool covers
discovery. No other browser, image, video, news, or local tool is registered
without a demonstrated need, which keeps the model-facing schema and
maintenance surface small.

## Tool cards

Each tool draws a compact TUI card. A collapsed call shows one heading row
(`web_read · <url>` or `web_search · <query>`) plus, when the call sets other
fields, one dim qualifier row with the view, find phrase, offsets, source id,
byte budget, or search controls. The argument expansion hint appears only when
the URL or query is clipped.

A collapsed result leads with the outcome the response establishes:

- `web_read` text reads show the status, the excerpt count, whether a continuation
  exists, an exact label range when no `find` applies, and the first matched label
  for a `find`. Coverage flags state extraction or output truncation. A redirect
  shows the final URL when it differs from the request.
- `web_read` links reads show the link count, page offset, coverage flags, and
  the `max_bytes` the next complete record needs.
- `web_search` shows the returned result count, whether more pages are
  available, an altered query, and output truncation.

Expansion shows the full result text with a display bound; terminal controls
escape to text in every collapsed value.

## Use

Call `web_search` to find a source, then open its public URL:

```json
{"url":"https://example.com/","max_bytes":16000}
```

Pass that object to `web_read`. Cite the returned final URL and excerpt label.
The reader does not need a Brave subscription token.

For later excerpts, copy the response's `nextOffset` into `excerpt_offset` and
its `Source` into `expected_source_id`, with the same `url`. For example, if the
response returns offset `31` and source `0123456789abcdef`:

```json
{"url":"https://example.com/","excerpt_offset":31,"expected_source_id":"0123456789abcdef","max_bytes":16000}
```

Use the actual returned values, not these example values. A `null` next offset
ends the retained excerpts, not necessarily the full page. Each call fetches and
extracts the public page again. No snapshot or cursor is stored. If the source
changes, start a new read without continuation fields and keep its evidence
separate from the earlier snapshot. The byte budget may change between calls.

To locate a named phrase without returning all preceding excerpts, add `find`:

```json
{"url":"https://git-scm.com/docs/git-worktree","find":"git worktree repair","max_bytes":1000}
```

The query is a case-sensitive, single-line literal, not a regex or fuzzy search.
Search compares it exactly with the retained normalized text. It does not trim,
case-fold, or normalize the query's whitespace or Unicode. Normalized paragraphs
are separated by newlines; a single-line query does not cross those boundaries.
It does cross the reader's excerpt splits within a paragraph.

Results contain the full excerpt chunks that intersect any match, once each in
source order, with their original labels. They omit nonmatching chunks, not just
preceding text. Counts refer to returned excerpts, not query occurrences. A match
across a split selects both chunks; the byte budget can put those parts in separate
responses. Repeat the same `find`, `url`, and returned continuation fields to
obtain the remaining matching excerpts. `excerpt_offset` still means an index
in the snapshot, never an index in the filtered results. `nextOffset: null` ends
matching retained excerpts, not necessarily the full page.

For surrounding context, omit `find` and use the source-checked sequential call
shown in the response. That call starts one excerpt before the first returned
matching excerpt (or at zero). Continue sequentially for further context.
`details.find.firstMatchOffset` gives the first returned matching excerpt's
zero-based snapshot index, or `null` when none is returned. No-match results
state the requested offset and apply only to retained text at or after that
excerpt, not to the complete page.

## Source links

Use the opt-in links view to follow a source's actual anchors instead of
reconstructing a destination from its label:

```json
{"url":"https://docs.python.org/3/whatsnew/3.14.html","view":"links","find":"PEP 734","max_bytes":4000}
```

The default remains `view: "text"`. Its output, extraction rules, excerpt
segmentation, and source identities are unchanged. Links support `text/html`
only. XHTML (`application/xhtml+xml`), plain text, Markdown, and other content
types are refused. The HTML parser does not implement XML namespace semantics;
using it for XHTML anchors would invent links from non-HTML elements. Text mode
retains its existing XHTML support.

Each `[<sourceId>:L<n>]` reference precedes a JSON record with `label`,
`labelSource`, `labelTruncated`, and `url`. The URL is the complete serialized
resolution of the anchor's `href`, including query and fragment. JSON escaping
is presentation syntax, not part of the URL. Repeated destinations remain
separate source-order occurrences. A link proves a relationship on the fetched
source, not the destination's contents or safety. Open the selected URL with a
separate ordinary `web_read` call before relying on destination evidence.

- **Selection.** The existing parser collects links during the text traversal.
  It uses exactly the same main/article/body selection and hidden-element
  exclusions, not a separate navigation scan. Only selected `<a href>` elements
  contribute records; resource `<link>` elements, scripts, SVG, MathML, and
  template contents are not link discoveries. Region choice still depends on
  readable text. For example, an image-only `<main>` does not override a readable
  article or body. HTML parsing uses `htmlparser2`, including its recovery for
  malformed markup, not a browser DOM or a general XML parser.
- **Labels.** The reader uses visible descendant text, with image `alt` text in
  place, then the anchor's `aria-label`, then its `title`, then an empty label.
  This is not the browser accessible-name algorithm. Whitespace collapses to
  spaces; controls and bidi formatting are removed. Each normalized label
  retains at most 512 UTF-16 code units without a split surrogate pair.
  `labelTruncated` explicitly identifies a shortened label. URLs never use a
  shortened display form.
- **Resolution.** Relative, query-only, empty, and fragment-only hrefs use the
  final response URL or the first `<base href>` outside template and foreign
  content, even if that base appears after the anchor. Later bases do not apply.
  A malformed, `data:`, or `javascript:` base falls back to the final URL under
  the [HTML base rules](https://html.spec.whatwg.org/multipage/semantics.html#the-base-element).
  Other schemes do not acquire an invented HTTP fallback. Browser CSP is not
  evaluated. A base attribute longer than 4096 UTF-16 code units prevents
  relative resolution and reports `baseStatus: "over-limit"`; absolute links
  still resolve. The raw base is never returned. Anchor attributes are entity
  decoded, then resolved through the URL parser. Edge ASCII whitespace is
  removed; embedded controls, bidi formatting, unpaired surrogates, and
  backslashes are rejected rather than silently repaired.
- **No destination traffic.** Resolution and validation make no requests or
  DNS lookups for listed destinations. Complete resolved URLs must pass the
  existing HTTP(S), no-userinfo, default-port, length, and literal-address
  restrictions. Hostnames are not DNS-vetted during listing. Every later
  explicit read retains the full existing DNS, address, redirect, and transport
  restrictions. Skipped destinations are counted, not echoed.
- **Bounds and coverage.** The existing download, decode, parser, and deadline
  limits apply. Each body/main/article bucket retains at most 2048 candidate
  records and 256 KiB of JSON-encoded candidate data. The selected bucket also
  caps resolved record data at 256 KiB. The byte calculation includes the label
  and its metadata, not only the href. Candidate limits stop retention, not the
  bounded parser traversal. The reader counts all selected anchor occurrences
  and reports `anchorsSeen`, `retainedLinks`, `skippedUrl`, and `skippedLimit`.
  The first count equals the sum of the other three. `truncatedLabels` counts
  shortened labels among retained records, not another omission category.
  `extractionTruncated` covers record, byte, label, and base limits. Text's
  separate retained-text cap does not stop link collection. No-match and
  end-of-retained-links results never establish full-page coverage.
- **Search and paging.** With `view: "links"`, `find` matches case-sensitive
  literals in retained normalized labels only, not destinations. The shared
  query validation and lack of query normalization still apply. Truncated
  labels are searched only within their retained prefixes. `link_offset` is a
  zero-based retained-record index, including records omitted by `find`, not a
  match ordinal. Copy `nextOffset` into `link_offset`, use the same view, URL,
  and query, and supply the returned `Source` as `expected_source_id`. Do not
  supply `excerpt_offset` in links view or `link_offset` in text view, even at
  zero. Nonzero offsets require the matching source ID. Exact-end offsets
  return an empty page; offsets beyond the retained count fail. Each response
  returns at most 160 complete records within `max_bytes`. If the first eligible
  record exceeds that budget, the response returns no partial record and gives
  `requiredMaxBytes`; retry with at least that budget and the returned
  continuation fields. Every admitted record fits the maximum output budget.
- **Identity.** The link source ID hashes a links-specific serialization of the
  final URL, effective base identity/status, region, limits, retained resolved
  records, and coverage metadata. A changed retained href destination invalidates
  link continuation even if text and text identity stay unchanged. Search,
  offsets, budgets, retrieval time, and title do not select this identity.
  Unretained href changes with unchanged coverage need not change it. Text and
  link source IDs are not interchangeable. No snapshot, cursor, or link archive
  is stored; each call refetches and checks its own view's source.

Link `details` reports the view, standard response metadata, source ID, region,
base status, returned and retained link counts, retained bytes, omission and
truncation counts, offset, next offset, required budget, limits, and output
truncation. Search adds `find: { query, firstMatchOffset }`, where the offset is
the first returned match or `null`. It contains no duplicate record list, raw
HTML, or raw base. `outputTruncated` means another eligible record remains or
extraction reached a limit; URL-policy omissions remain separately visible.

## Durable agents

The extension has a native Pi Durable form beside its ordinary entrypoint. The
factory emits one contribution on the `durable:contribution` channel; the agent
session host installs it into the session registry. An ordinary Pi session has
no listener on that channel, so the emission has no effect there. The
contribution names `extensions/brave/index.ts` as its source, so the host can
match it to the resolved path of the loaded extension.

`extensions/brave/durable.ts` builds the native extension from the shared
`capability.ts` surface: parameter schemas, descriptions, model guidance, and
the `web_search` execution. It adds no documents, hooks, tasks, or commands,
and `create()` uses no ordinary session API. The native form registers
`web_read`, then `web_search`, and one prompt section, `web-guidance`, carrying
in one section the same guidance text as the ordinary prompt snippet and
prompt guidelines.

Replay classes:

| Tool | Replay | Why |
|---|---|---|
| `web_read` | `safe` | A rerun repeats an idempotent public GET with no credential and no external mutation. Each call rebuilds the snapshot from the live page and checks the same source digest, so a continuation still refuses a changed source. |
| `web_search` | `unsafe` | A rerun would repeat a billed Brave query. If the process dies after intent and before the result, the model receives an interrupted result instead. |

The native tool result carries the same text and details data as the ordinary
tool. Durable results must be strict JSON, so an optional details key with no
value (`alteredQuery`, `nextOffset`) is absent instead of `undefined`. The
Durable form has no terminal cards: `renderCall` and `renderResult` are
ordinary-session surfaces.

`extensions/brave/durable.test.mts` runs the contribution in a real Durable
Harness over `MemoryStorage` with the pi-ai faux provider. It drives one
model-issued call per tool and checks both replay classes across a close and
reopen over retained storage.

## Configuration

The `web_search` subscription token comes from `PI_BRAVE_API_KEY` in the Pi
process environment. The extension reads no configuration file; the token never
sits inside the repository tree. An explicit key passed to the client options
overrides the variable for tests and programmatic callers. `web_read` requires
no key or configuration; it fetches only public pages with no credential.

## web_read boundaries

- **Input.** The following excerpt rules describe the default text view;
  [source links](#source-links) defines the opt-in view's record contract.
  `url` must be a public HTTP(S) URL with no userinfo credentials and
  default ports only (80/443, whether explicit or implicit), bounded to 4096 characters. `max_bytes`
  is the per-response excerpt byte budget: an integer 1000 through 24000, default 16000.
  `excerpt_offset` is a zero-based excerpt index, default 0, bounded to 131072
  (the retained-text limit bounds the possible excerpt count). Every nonzero
  offset requires `expected_source_id`, exactly 16 lowercase hex characters.
  A supplied source ID is checked even at offset zero. The reader validates
  effective arguments after Pi's schema normalization, before network access.
  Pi omits optional null values and can convert numbers or booleans to strings;
  the reader does not impose a separate raw-input policy. Malformed effective
  continuation inputs are refused before network access. Use the returned
  `nextOffset`; offsets beyond the retained excerpt count are refused, while an exact-end
  offset returns no excerpts and `nextOffset: null`.
  Optional `find` is a nonblank single-line literal of at most 200 UTF-16 code
  units. The reader rejects control characters, bidi controls, line separators,
  and unpaired surrogates before network access. Reader-owned semantic errors
  do not echo the invalid query. Pi's earlier schema-validation errors can
  include JSON-escaped received arguments. Valid query text is explicitly
  labeled as an untrusted literal.
- **Public addresses only.** The hostname is resolved for A and AAAA records and
  every returned address is checked against an allow/deny policy before use. IPv4
  rejects special-use blocks (private, loopback, link-local, CGNAT, multicast,
  reserved, documentation/test ranges, and some public special-purpose services).
  IPv6 admits only global unicast `2000::/3` minus protocol assignments,
  documentation, 6to4, AS112, and former 6bone space. It also rejects ISATAP,
  dotted or zone-identified forms, mapped addresses, and translation prefixes. The connection is pinned to the validated numeric address so no second
  DNS lookup can bypass the policy.
- **Redirects.** Only HTTP 301/302/303/307/308 redirects are followed, each one
  re-validated against the same URL and address policy, up to a limit of 3. The
  final URL is reported.
- **Transport.** Requests use Node's `http`/`https` request paths with a fixed
  20-second deadline and strict certificate verification for HTTPS. Bodies are
  capped at 2 MiB and response headers at 16 KiB. Only HTTP 200 with
  absent or `identity` content encoding is accepted. Compressed, incomplete,
  length-mismatched, or oversized bodies are refused. Chunked transfers are
  supported. The request declares `Accept-Encoding: identity`; a server that
  ignores it receives no decompression fallback. Other 2xx statuses remain
  unsupported and are identified as such, not described as unsuccessful HTTP
  responses; the reader requires a complete HTTP 200 response.
- **No browser, cookies, credentials, private network, or archive.** The reader
  makes a stateless GET per hop. It keeps no cookie jar, runs no script, CSS, or
  plugin, sends no stored credential, ignores environment proxies, and rejects
  targets whose DNS answers include disallowed addresses. It fetches the live public page directly; it is not a web
  archive or snapshot service.
- **Extraction.** `text/html`, `application/xhtml+xml`, `text/plain`, and
  `text/markdown` content is decoded to text (fatal on unknown or malformed
  character encoding; binary labeled as text is rejected). The decoder uses the
  HTTP charset or UTF-8 by default; HTML meta charset declarations are not used.
  HTML is parsed with
  `htmlparser2`. `script`, `style`, `noscript`, `template`, `svg`, `canvas`,
  `iframe`, `object`, `embed`, `nav`, `header`, `footer`, `aside`, `form`, and
  hidden elements are excluded. Static text is taken from `<main>`, else
  `<article>`, else the filtered body, and reported as extraction `main`,
  `article`, or `body`. Multiple matching regions are concatenated in source order.
  Intake is capped at 2 MiB. Each of the fixed body/main/article buffers retains
  at most 128 Ki UTF-16 code units after whitespace normalization.
  The parser rejects more than 50,000 elements
  or nesting beyond 256 and yields between input chunks under the invocation
  deadline. Script-only pages report no readable text; static shells may still
  return incomplete text.
- **References and provenance.** Each returned excerpt carries a reference
  `[<sourceId>:E<n>]`. `sourceId` is a 16-hex SHA-256 of the final URL plus the
  normalized extracted paragraphs. A NUL separates the URL from the newline-joined
  paragraphs. Unchanged URL and text
  yield the same labels independent of response budgets, offsets, and `find`. Excerpts
  split each paragraph into chunks of at most 800 UTF-8 bytes without splitting
  Unicode code points. A changed final URL or retained text yields a different
  source ID and refuses a continuation before returning any excerpts. This ID
  does not cover the raw page, title, extraction method, extraction-cap flag, or
  discarded text beyond the cap. Changes outside the normalized retained text
  therefore need not change it. Labels
  identify the extracted snapshot, not anchors in the live page; the output says
  to cite the final URL plus labels. The header states the final URL, requested
  URL, retrieval time (ISO 8601), title, content type, extraction method and
  status, and the source id.
- **Pagination and extraction limits.** Each response's model-visible text
  stays below Pi's 50 KiB / 2000-line tool-output limits and returns at most
  160 excerpts within its byte budget. These are text bounds, not a limit on
  `JSON.stringify(result)`: escaping and serialized metadata add bytes.
  `nextOffset` identifies the first unreturned eligible excerpt, or is `null`
  when none remain. Without `find`, all retained excerpts are eligible.
  With `find`, only chunks that intersect a literal match are eligible, including
  a match that begins in a previous chunk. `extractionTruncated` separately reports
  the retained-text cap. Text beyond that cap is unavailable through continuation;
  the warning persists on the final page. Static extraction remains incomplete
  evidence even without that flag. `outputTruncated` is true when more excerpts
  follow or extraction hit the cap; it does not describe excerpts before the
  requested offset. The model-visible header contains the offset, excerpt
  count, next offset, and extraction flag. Continuation guidance includes both
  required continuation arguments.
  `details` carries `requestedUrl`, `finalUrl`, `retrievedAt`, `contentType`,
  `downloadedBytes`, `redirectCount`, `title`, `sourceId`, `excerptCount`,
  `excerptOffset`, `nextOffset`, `extractionTruncated`, `extraction`, `status`,
  and `outputTruncated` — never a credential or raw body.
  Search additionally returns `find: { query, firstMatchOffset }`; unfiltered
  reads omit this field. The first matching offset refers to this response,
  not to matches before the requested offset. The search has no result cache,
  occurrence list, or stored cursor; it uses the same bounded fetch, extraction,
  source check, and excerpt segmentation as sequential reads.
  `downloadedBytes` counts the final response body, not headers or transfer framing.
  Redirect bodies are discarded, and URLs are normalized without fragments.
- **Failures.** Failures still throw, so Pi produces an error result with text
  and empty `details`. Failure text names
  the failed stage or limit and the final URL of the failed hop. If URL validation
  rejects a redirect, the URL identifies the last response, not the rejected
  target. Invalid initial URLs are not echoed. DNS and connection failures have
  no HTTP status unless a response arrived; known network error codes are retained
  without raw exception messages. Once headers arrive, failures carry the HTTP
  status code, its standard reason phrase, and the bounded media type without
  arbitrary header parameters. Extraction failures retain the same URL, status,
  and media type. Missing media types are explicit. A valid server `Retry-After`
  is reported as delay seconds or a canonical HTTP date; no reset time or retry
  recommendation is invented. Remote status phrases and error bodies are never
  returned.
- Page content is presented as untrusted evidence, not instructions. Excerpt
  references establish only the returned static text, not full-page coverage.

## web_search boundaries

- Requests use Node's built-in `fetch` against the fixed Brave Web Search HTTPS
  endpoint and reject redirects so the subscription token cannot be forwarded
  elsewhere. There is no arbitrary endpoint input or third-party client
  dependency.
- Each request is owned by the tool invocation, follows Pi's abort signal, and
  has a 20-second fallback timeout. The extension starts no process, watcher, or
  background loop, and it clears its request timer and abort listener when the
  call settles.
- Query length, result count, page offset, country, language, freshness, and enum
  values are schema-bounded. The client stops streaming decoded response bodies
  at 5 MiB. A fixed buffer also bounds retained allocation overhead when a response
  arrives in many small chunks. Result URLs must use HTTP(S) without userinfo
  credentials; other URLs are omitted.
- HTTP errors report the status code, standard reason phrase, fixed endpoint
  URL, media type, and local guidance for authentication, query, and quota/rate-limit
  failures. Status errors take precedence over body size or decoding errors:
  error bodies are discarded without reading them. Valid server `Retry-After`
  values are reported; absent or malformed values produce no retry hint. Search
  failures retain the thrown-error contract, with Pi-owned empty `details`.
  Missing configuration names `PI_BRAVE_API_KEY`. Transport failures retain known
  error codes, and timeout, cancellation, size, and JSON failures remain distinct.
  Remote error bodies, status phrases, and transport exception messages are not
  returned because they can reflect request credentials or instructions. Header
  diagnostics omit arbitrary parameters and redact the configured API key.
- Search strings are stripped of terminal and bidi controls before presentation.
  Individual fields and final output are bounded; final model-visible output
  never exceeds Pi's 50 KB / 2000-line tool-output truncation limits
  (`dist/core/tools/truncate.js`, exported as `DEFAULT_MAX_BYTES` /
  `DEFAULT_MAX_LINES`).
- Successful tool-result details contain only query and pagination metadata,
  not the API key or a duplicate raw response. Empty search results are successful
  results with explicit text and `resultCount: 0`, not HTTP or quota failures.
- Titles, snippets, and excerpts are identified to the agent as untrusted web
  content rather than instructions. Snippets locate candidate evidence; the tool
  guidance tells the agent to open primary sources before using a result for a
  load-bearing claim.

## Dependencies

The extension carries no extension-local package manifest. It imports the
harness package's dependencies: `htmlparser2` (declared in the repository root
`package.json` dependencies and used by `page-text.ts` for static HTML parsing)
plus Pi's `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`typebox` through the existing peer dependencies. DNS, HTTP/HTTPS, net, TLS,
crypto, timers, and text decoding use Node built-ins.

## Verification

```bash
node --test "extensions/brave/*.test.mts"
npm test
node scripts/extension-load-check.mts extensions/brave/index.ts
```

The focused tests cover configuration precedence and failures, request
construction, response normalization, HTTP error guidance, reflected-credential
non-disclosure, credential-bearing URL omission, fragmented UTF-8, exact response
bounds, cancellation, timeout cleanup, control-character handling,
output truncation, registration, entrypoint execution, URL and address policy,
static main/article/body extraction, excerpt references, page reading results,
status and final-URL diagnostics after redirects, server-only retry hints,
extraction failure metadata, unread error bodies, native HTTP parser errors,
multi-page reconstruction under varying budgets, Unicode and stable labels,
invalid continuation refusal before fetch, changed-source refusal, exact-end and
empty snapshots, extraction-cap honesty, and bounded response fixtures. Literal
search tests cover late evidence, exact case and Unicode, split and overlapping
matches, snapshot-index pagination, changing budgets, effective-query validation
before fetch, native schema normalization and diagnostics, no-match scope,
cancellation, and unchanged sequential reads. A quote-heavy fixture distinguishes
model-visible text bounds from larger JSON serialization. Registered
entrypoint tests follow model-visible sequential and search continuation
arguments through the native HTTP parser with synthetic sockets, then return
from search to sequential context. Link regressions cover relative/base/fragment
resolution, complete URLs, exclusion and label selection, malformed anchors,
Unicode across parser chunks, label and retention limits, distinct identities,
source-bound pagination, insufficient budgets, cancellation, and unchanged text.
Registered link tests use the native HTTP parser and controlled DNS to establish
source-only traffic, visible continuation, and unchanged private-open refusal.
Real-Harness durable tests cover the native contribution's registrations,
model guidance, replay classes, and a close and reopen for each class. The load check establishes Pi
loader acceptance; neither check establishes live-session activation or general
research time savings.
