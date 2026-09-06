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

## Configuration

The `web_search` subscription token comes from `PI_BRAVE_API_KEY` in the Pi
process environment. The extension reads no configuration file; the token never
sits inside the repository tree. An explicit key passed to the client options
overrides the variable for tests and programmatic callers. `web_read` requires
no key or configuration; it fetches only public pages with no credential.

## web_read boundaries

- **Input.** `url` must be a public HTTP(S) URL with no userinfo credentials and
  default ports only (80/443, whether explicit or implicit), bounded to 4096 characters. `max_bytes`
  is the excerpt byte budget: an integer 1000 through 24000, default 16000.
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
  ignores it receives no decompression fallback.
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
  yield the same labels; changed content yields a different source id. Labels
  identify the extracted snapshot, not anchors in the live page; the output says
  to cite the final URL plus labels. The header states the final URL, requested
  URL, retrieval time (ISO 8601), title, content type, extraction method and
  status, and the source id.
- **Truncation and honesty.** Output stays below Pi's 50 KB / 2000-line
  tool-output limits. When the excerpt byte/count budget or retained-text cap
  truncates content, `outputTruncated` is true and a note says the omitted
  content was not retained, so the result does not establish full-page coverage.
  `details` carries `requestedUrl`, `finalUrl`, `retrievedAt`, `contentType`,
  `downloadedBytes`, `redirectCount`, `title`, `sourceId`, `excerptCount`,
  `extraction`, `status`, and `outputTruncated` — never a credential or raw body.
  `downloadedBytes` counts the final response body, not headers or transfer framing.
  Redirect bodies are discarded, and URLs are normalized without fragments.
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
  at 5 MiB and accepts only HTTP(S) result URLs.
- Search strings are stripped of terminal and bidi controls before presentation.
  Individual fields and final output are bounded; final model-visible output
  never exceeds Pi's 50 KB / 2000-line tool-output truncation limits
  (`dist/core/tools/truncate.js`, exported as `DEFAULT_MAX_BYTES` /
  `DEFAULT_MAX_LINES`).
- Tool-result details contain only query and pagination metadata, not the API key
  or a duplicate raw response.
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
construction, response normalization, API errors, credential non-disclosure,
response bounds, cancellation, timeout cleanup, control-character handling,
output truncation, registration, entrypoint execution, URL and address policy,
static main/article/body extraction, excerpt references, and page reading
results.
