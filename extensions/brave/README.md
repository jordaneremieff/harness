# brave: bounded general web search and public-page reading

This extension gives the agent public-page reading and web search without an extension-local SDK, package manifest, lockfile, or
`node_modules` tree.

## Surface

| Surface | Kind | Purpose |
|---|---|---|
| `web_read` | tool | Read one public HTTP(S) page as bounded static text with the final URL, retrieval time, and snapshot excerpt references. |
| `web_search` | tool | Search the public web with optional country, language, freshness, SafeSearch, spellcheck, extra excerpts, and pagination controls. |

`web_read` registers first, then `web_search`. The reader covers the observed
job of opening a public primary page as evidence; the search tool covers
discovery. No other browser, image, video, news, or local tool is registered
without a demonstrated need, which keeps the model-facing schema and
maintenance surface small.

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

## Configuration

The `web_search` subscription token comes from `PI_BRAVE_API_KEY` in the Pi
process environment. The extension reads no configuration file; the token never
sits inside the repository tree. An explicit key passed to the client options
overrides the variable for tests and programmatic callers. `web_read` requires
no key or configuration; it fetches only public pages with no credential.

## web_read boundaries

- **Input.** `url` must be a public HTTP(S) URL with no userinfo credentials and
  default ports only (80/443, whether explicit or implicit), bounded to 4096 characters. `max_bytes`
  is the per-response excerpt byte budget: an integer 1000 through 24000, default 16000.
  `excerpt_offset` is a zero-based excerpt index, default 0, bounded to 131072
  (the retained-text limit bounds the possible excerpt count). Every nonzero
  offset requires `expected_source_id`, exactly 16 lowercase hex characters.
  A supplied source ID is checked even at offset zero. Malformed continuation
  inputs are refused before network access. Use the returned `nextOffset`;
  offsets beyond the retained excerpt count are refused, while an exact-end
  offset returns no excerpts and `nextOffset: null`.
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
  yield the same labels independent of response budgets and offsets. Excerpts
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
- **Pagination and extraction limits.** Each response stays below Pi's 50 KB /
  2000-line tool-output limits and returns at most 160 excerpts within its byte
  budget. `nextOffset` identifies the first unreturned excerpt, or is `null` at
  the end of retained text. `extractionTruncated` separately reports the
  retained-text cap. Text beyond that cap is unavailable through continuation;
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
empty snapshots, extraction-cap honesty, and complete response bounds. A
registered-entrypoint test follows model-visible continuation arguments through
the native HTTP parser with synthetic sockets. The load check establishes Pi
loader acceptance; neither check establishes live-session activation or general
research time savings.
