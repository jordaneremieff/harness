# brave: bounded general web search

This extension gives the agent one intent-level Brave Search tool without an extension-local SDK, package manifest, lockfile, or `node_modules` tree.

## Surface

| Surface | Kind | Purpose |
|---|---|---|
| `web_search` | tool | Search the public web with optional country, language, freshness, SafeSearch, spellcheck, extra excerpts, and pagination controls. |

One tool covers the observed general-search job. Specialized news, image, video, local, and summarizer tools are not registered without a demonstrated need, which keeps the model-facing schema and maintenance surface small.

## Configuration

The subscription token comes from `PI_BRAVE_API_KEY` in the Pi process
environment. The extension reads no configuration file; the token never sits
inside the repository tree. An explicit key passed to the client options
overrides the variable for tests and programmatic callers.

## Request and output boundaries

- Requests use Node's built-in `fetch` against the fixed Brave Web Search HTTPS endpoint and reject redirects so the subscription token cannot be forwarded elsewhere. There is no arbitrary endpoint input or third-party client dependency.
- Each request is owned by the tool invocation, follows Pi's abort signal, and has a 20-second fallback timeout. The extension starts no process, watcher, or background loop, and it clears its request timer and abort listener when the call settles.
- Query length, result count, page offset, country, language, freshness, and enum values are schema-bounded. The client stops streaming decoded response bodies at 5 MiB and accepts only HTTP(S) result URLs.
- Search strings are stripped of terminal and bidi controls before presentation. Individual fields and final output are bounded; final model-visible output never exceeds Pi's 50 KB / 2000-line tool-output truncation limits (dist/core/tools/truncate.js, exported as DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES).
- Tool-result details contain only query and pagination metadata, not the API key or a duplicate raw response.
- Titles, snippets, and excerpts are identified to the agent as untrusted web content rather than instructions. Snippets locate candidate evidence; the tool guidance tells the agent to open primary sources before using a result for a load-bearing claim.

## Dependencies

There are no extension-local npm dependencies. Pi supplies `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` through the package's existing peer dependencies; HTTP, configuration reads, aborts, and timers use Node built-ins.

## Verification

```bash
node --test "extensions/brave/*.test.mts"
npm test
pi -e . --mode rpc --no-session --offline
```

The focused tests cover configuration precedence and failures, request construction, response normalization, API errors, credential non-disclosure, response bounds, cancellation, timeout cleanup, control-character handling, output truncation, registration, and entrypoint execution.
