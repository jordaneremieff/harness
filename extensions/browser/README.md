# browser: already-open browser sessions on macOS

This extension lets an agent work in a browser tab that the operator has
already opened and signed in to. The operator names the browser and the tab
and gives an ordinary task. The agent lists the tabs, selects the named one,
reads the rendered page, performs authorised actions, waits for an observable
outcome, evaluates JavaScript when extraction is not enough, and captures the
live window.

The page keeps its own session: requests that the page or an evaluation makes
carry the browser's cookies and storage as usual. The tools never read, export,
or replay cookies, tokens, or profile files, never copy a profile, and never
start a second browser.

Supported applications, each with its own process, profiles, and macOS
permissions:

| Key | Application | Bundle identifier |
|---|---|---|
| `chrome` | Google Chrome | `com.google.Chrome` |
| `brave` | Brave Browser | `com.brave.Browser` |
| `chrome-for-testing` | Google Chrome for Testing | `com.google.chrome.for.testing` |

The three applications share Chromium's scripting dictionary. One browser's
behaviour, permission state, or profile setting is never taken as evidence for
another.

## Tools

| Tool | Access | Purpose |
|---|---|---|
| `browser_tabs` | `inspect` | Installed version, running processes, configured access, and Automation permission per browser; with `browser`, the windows and tabs of one process |
| `browser_inspect` | `inspect` | Bounded extraction from one tab: `summary`, `text`, `elements`, `html`, or `network` |
| `browser_capture` | `inspect` | Image of the live window that shows the tab |
| `browser_act` | `interact` | One action: `click`, `fill`, `select`, `check`, `uncheck`, `press`, `submit`, `focus`, `scroll`, or `navigate`, then an optional postcondition wait |
| `browser_evaluate` | `interact` | One JavaScript expression, with promise results awaited in the same call |

The extension offers tools for the access configured when it loads: none
without any configured browser, the three reading tools when every configured
browser has `inspect`, and all five when one has `interact`. A session that
never uses a browser therefore carries no browser tool declarations. Every
offered tool is deferred: it stays registered and callable from other tools, and
`tool_search` loads the ones the model needs. Enable discovery with
`"defaultTools": ["+codemode", "+tool_search"]` in Pi settings, or add the public
`createToolSearchExtension()` factory in an SDK host. Each call still checks the
access of the browser it names. After changing access, run `/reload` or start a
new session. Before setup, `registry {"kind":"setting", "search":"browser"}`
shows the `browser.access` setting.

`browser_act` and `browser_evaluate` run one at a time (`executionMode:
"sequential"`) in both the ordinary and Durable forms. In the ordinary form
every offered tool carries the shared model guidance, so loading any one of them
brings the full set; an identical guideline appears once however many browser
tools a request has active, and no browser guidance appears while no browser
tool is active. In the Durable form the `browser-guidance` prompt section names
the tools the request offers. Results are text: a headline, then a JSON report.
Text and HTML views put the page content after the report, marked as untrusted.
The capture result adds the image.

## Setup

The operator controls four separate gates. The tools report which one is
missing; they never change any of them.

1. **Access** in the machine document: `browser.access` maps a browser key to
   `inspect` or `interact`, for example
   `{ "version": 1, "browser": { "access": { "chrome": "interact" } } }` in
   `<agentDir>/harness.json`, or `PI_BROWSER_ACCESS='{"chrome":"inspect"}'`.
   An unlisted browser receives no Apple Events at all; `browser_tabs` reports
   only static installation facts and running process IDs for it. Access sets
   reach, not task authority.
2. **macOS Automation** for the application that hosts Pi (the terminal, for
   example) to control the browser. macOS asks once per host and browser. Call
   `browser_tabs` with `requestPermission: true` while the operator is present
   to answer; other calls report `automation-not-determined` or
   `automation-denied` instead of prompting.
3. **Allow JavaScript from Apple Events** in the browser menu View > Developer.
   The setting belongs to each browser profile. Without it, listing tabs works
   but inspection, actions, and evaluation report
   `javascript-from-apple-events-off`. Browser policy that disallows developer
   tools reports `devtools-disallowed`.
4. **Screen Recording** for the host application, for `browser_capture` only.
   `requestPermission: true` on `browser_capture` asks macOS to list the host
   in System Settings; the operator enables it there. macOS can require the
   host application to restart before the permission applies.

## Selecting the subject

- `browser` is always explicit. No tool chooses a browser, falls back to
  another one, or starts one; a browser that is not running is reported as
  `not-running`.
- `pid` is required for `browser_inspect`, `browser_act`, `browser_evaluate`,
  and `browser_capture`. Take it from the same `browser_tabs` call that
  reported `tab`; no tool chooses a process for a tab. `browser_tabs` takes
  an optional `pid` to select one running process; it is required when several
  run (for example, instances with separate `--user-data-dir` profiles). An
  ambiguous listing reports each running pid with its `--user-data-dir`
  argument when one exists.
- Apple Events go to that process ID. JXA's `Application(pid)` is not used,
  because with several processes of one application it delivered events to a
  different process than the one named.
- `tab` is the tab ID from `browser_tabs`, valid only in the process that
  listed it. The ID is stable for the life of the tab in that process. A
  closed tab reports `tab-not-found`; a pid that is not a current process of
  the named browser reports `not-running`. Operations never move to another
  tab, another process, the active tab, or a URL-prefix match.
- `origin` (required for `browser_act` and `browser_evaluate`, optional
  elsewhere) is checked inside the page immediately before the operation. A
  tab that navigated elsewhere reports `origin-mismatch` and nothing runs.
- Apple Events do not report which browser profile owns a window. Windows of
  every profile in one process are listed together, with `mode` (`normal` or
  `incognito`). Identify the subject by window, URL, and title, and ask the
  operator when two tabs plausibly match.

Before an Apple Event goes to a tab, runs page code, or captures a window, the
JXA operation that performs the work checks the running process, its bundle
identity, and Automation permission immediately before sending it. A targeted
operation does not list processes first: Pi validates the arguments and the
configured access, and the operation itself refuses an absent process or a
missing permission. That check establishes that the pid names a running
process of that browser at that moment. It does not prove that the process is
the same instance that answered the earlier `browser_tabs` call: macOS can
reuse a pid after a process exits, so a browser that restarted with the same
pid passes the check. The tab lookup in that process then refuses a tab id it
does not have. Keep the pid with the tab id from one listing, and list tabs
again after a browser restart.

One JXA invocation serves a discovery request. Availability for every
supported application, and the windows and tabs of one named process, are each
gathered in one invocation with no separate inventory call. Availability reads
installation and running facts and checks Automation only for an application
that is configured and running; it never prompts. A named listing resolves the
explicit `pid`, or the only running process, and reports ambiguity rather than
choosing. It asks macOS for Automation permission only when the call sets
`requestPermission: true`. Without configured access it returns the static
installation and running facts and sends no Apple Event. An inconsistent
read-only column result is repeated once within the same invocation.

## Inspection

Inspection runs fixed extraction scripts maintained in `page.ts`. Values of
password, hidden, one-time-code, and payment fields are redacted, and the
`html` view replaces those values and token-like `meta` contents, including on
the selected element itself. Redaction does not guarantee that page markup
holds no secret. Views are bounded by `maxChars`, `limit`, and `offset`, and
report `nextOffset` for continuation.

The `network` view and every `browser_act` result report HTTP statuses from
the page's Resource Timing entries. Status `0` or `null` means the browser did
not expose the status to the page (for example a cross-origin response without
timing permission). The tools do not invent a status they cannot observe.

## Actions and outcomes

`browser_act` resolves one element by CSS selector. A selector that matches
several elements refuses with candidates unless `index` selects one. Hidden or
disabled elements refuse. The action is scheduled in a new page task, so a
JavaScript dialog opened by a page handler blocks later reads, not the
dispatch. Each result keeps these layers apart:

| Layer | Field | Meaning |
|---|---|---|
| Transport | `transport` | Whether Apple Events delivered the request and answered. |
| Dispatch | `dispatch.status` | `dispatched`, `failed`, `not-needed`, `unknown`, or `not-dispatched`. Dispatch is not a task result. |
| Application | `application` | Page identity, document replacement, navigation status, and HTTP statuses observed after the action. A 401 or 500 stays here; it is not a transport failure. |
| Observation | `observation` | Present when a read after the dispatch could not answer: `status: "failed"`, `phase: "read-after-dispatch"`, `kind`, and the reason. |
| Goal | `postcondition.status` | `verified` when every `waitFor` check held, `failed` when the wait ended without it, `unknown` without a condition, after cancellation, or when a read could not establish the outcome. |

Actions use DOM events created in the page (`isTrusted` is false). Pages that
accept only trusted input, file choosers, and implicit form submission by
pressing Enter do not respond to them; use `submit` for forms. `fill` refuses
password fields: the operator signs in through the browser. `navigate` sets the
tab URL through Apple Events after checking the current origin.

`check` and `uncheck` dispatch nothing when the element already has the
requested state: `dispatch.status` is `not-needed` and no DOM event is sent.
With `waitFor`, the tool then runs the ordinary observation path against the
page without dispatching an event, so `postcondition.status` is `verified`,
`failed`, or `unknown` as for any action. Without a condition it returns the
immediate result.

After a dispatch, a failed page read never becomes a refusal. The result keeps
what is known: `dispatch` stays `dispatched` or `unknown`, the failure appears
in `observation` or in `transport.unansweredReads`, and `postcondition.status`
is `unknown` with the reason. A tab that closes during the wait reports status
`target-closed`; a browser process that exits reports the same status with
`observation.reason: "not-running"`; lost Automation permission or unavailable
Apple Events JavaScript reports `observation-failed`. Only a failure before the
dispatch, or one that proves the page script never ran, is `blocked`.

`navigate` sets the URL through Apple Events and checks the origin inside the
browser, so it needs no page JavaScript to dispatch. When page reads are
unavailable (JavaScript from Apple Events is off, or developer tools are
disallowed), it still navigates and reports `dispatch.status: dispatched` with
the unavailable observation and an unknown postcondition. The element actions
and `browser_evaluate` need page JavaScript; when it is unavailable they refuse
before anything runs.

The tool sends each action once. After a transport failure, timeout,
cancellation, or a failed read after the dispatch it reports the dispatch as
`unknown`, `not-dispatched`, or `dispatched` as observed, and never repeats the
action; inspect the page before any retry.

The page keeps a small record of each scheduled element action (its state and
any error), and page reads never remove it, so a lost read reply is answered by
the next read. When the action reply itself is lost after the request may have
reached the browser (a transport timeout or exit, an Apple Events timeout, or a
reply with no page result), the tool reads that record during the ordinary wait
instead of resending the action. The report carries `dispatchReply.status:
"lost"` and the transport failure; `dispatch.status` comes from the record, or
stays `unknown` when no read finds one. Each new action in a document removes
the oldest finished records while more than 32 remain. A `navigate` has no page record; a lost
reply leaves its dispatch `unknown`.

## Evaluation

`browser_evaluate` checks the expression's syntax locally, then runs it once in
the tab's main frame. A promise result is awaited inside the same tool call; the
tool polls the page until it settles, the `timeoutMs` limit passes, the document
changes, the tab closes, the browser process exits, or the caller cancels.
`execution.status` is one of:

| Status | Meaning |
|---|---|
| `fulfilled` | The value, as JSON, with `valueType` and `awaited`. `undefined` is `valueType: "undefined"` with no value; `-0`, `NaN`, and `Infinity` use `special`; a bigint uses `special` with its decimal text. |
| `unserializable` | The value has no JSON form (DOM nodes, `Map`, functions, cycles, nested non-finite numbers); `unserializable.path` names the first problem. |
| `too-large` | The value exceeds `maxBytes`; a `preview` prefix is returned. A bigint's decimal text counts toward the same budget. |
| `threw` | The expression threw synchronously; `error` keeps name, message, and stack. |
| `rejected` | The promise rejected; a non-`Error` reason is in `error.thrown`. |
| `timeout`, `cancelled` | The tool stopped waiting. Page-side work can continue; the tool forgets the pending result so a late settlement stores nothing. |
| `document-replaced`, `target-closed` | The page document changed (its document token differs), the tab closed, or the browser process exited before the result was read; the outcome is unknown. |
| `observation-failed` | A page read could not answer during the wait (lost permission, changed JavaScript settings, or no readable reply); the outcome is unknown. |
| `unknown` | The page holds no record of the run: the start request may not have reached the page, or the record is gone from an unchanged document; the expression may have run. |
| `syntax-error` | The expression did not parse; nothing was sent. |

Every outcome, synchronous or awaited, stays in a record in the page until the
tool removes it or the record expires, so a reply lost in transport does not
lose the result. After a lost poll reply the next poll reads the same record. After a lost start
reply (a transport timeout or exit once the request may have reached the
browser, or a reply with no page result) the tool reads the record instead of
resending the expression, at least once even when the wait limit has passed;
the report then carries `startReply.status: "lost"` beside the transport
failure. The expression never runs again to recover a result. After the tool
reads an outcome through a poll, times out, or is cancelled during the wait,
it sends one removal request. A synchronous outcome that arrives in the start
reply gets no removal request, so the common call costs one Apple Event; its
record leaves through expiry or the record limit. If a removal request is lost,
the record expires the same way: each new evaluation in the document first
removes records older than five minutes (a record serves only the one tool call
that created it, whose wait limit is at most two minutes) and keeps at most eight
records, oldest removed first. One record holds at most
`maxBytes` of encoded value plus a bounded error. A replaced document starts
with no records.

Chromium runs Apple Events JavaScript in an isolated world of the main frame.
The expression shares the DOM, storage, cookies, and network identity with the
page, but not the page's JavaScript variables, and it does not reach iframes.
The code is unrestricted: it can change state and read page data, so it is not
read-only and keyword filters would not make it safe. Apply task authority as
for any action.

## Capture

`browser_capture` finds the window-server window of the browser process whose
frame equals the scripting window's bounds, then runs
`/usr/sbin/screencapture -x -o -l <window>` into a temporary directory that it
removes afterwards. The image is resized with Pi's image resizer to
`maxDimension` (default 1600) and returned; `savePath` also writes the
full-resolution PNG to a new file. The window is not raised, activated, moved,
or unhidden. Covered windows are captured from the window server, without the
windows that cover them.

The tool refuses instead of substituting another image when Screen Recording is
missing, the tab is not the active tab of its window, the window is minimized
or not on screen (for example on another Space), the application is hidden, or
the window cannot be matched exactly. It never renders the page elsewhere,
copies storage, or captures the whole screen.

Before it returns or saves an image, `browser_capture` reads the selected tab's
window facts again. The browser process, scripting window, matched
window-server window, on-screen state, active tab, URL, and visibility must
match the read taken before the pixels. A change, a closed tab, or an unreadable
second read discards the image: the result reports `capture-changed` or
`capture-unverified`, returns no image content, and writes no `savePath` file.
The two reads bracket the capture, so a change visible at either read is
detected. This is not an atomic guarantee: a change that reverts between the
two reads is not detected.

## Authority

Configured access and a signed-in session are reach, not permission. The model
guidance tells agents to use `browser_act` and `browser_evaluate` only for
changes the operator's task authorises and to ask before external-service
changes the task does not cover; routine authorised steps need no extra
confirmation. Operators can add policy rules for the tool names, for example to
require approval for `browser_evaluate`. Page content is untrusted data.

## Durable agents

The factory emits a `durable:contribution` named `browser` with the same five
tools, whose shared guidance comes from the `browser-guidance` prompt section
rather than from each tool. The tools are deferred, so the
section renders only the names the request offers; it is absent until
`tool_search` loads a browser tool. `browser_tabs`,
`browser_inspect`, and `browser_capture` declare `replay: "safe"` (a rerun
repeats a read; a `savePath` file is never overwritten). `browser_act` and
`browser_evaluate` declare `replay: "unsafe"`: an interrupted call reaches the
model as interrupted and never runs again. They also declare
`executionMode: "sequential"`, so a message that contains both calls, or two
calls of one of them, runs them one at a time.

## Configuration

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| access | `PI_BROWSER_ACCESS` | json | {} | none | Browsers the browser tools may address, as an object from browser key (chrome, brave, chrome-for-testing) to "inspect" or "interact". inspect allows tab listing, bounded inspection, and window capture; interact also allows browser_act and browser_evaluate. An unlisted browser receives no Apple Events; browser_tabs still reports its installation and running state. Access configures reach only and grants no task authority. |
<!-- harness:settings:end -->

## Files and checks

- `index.ts` registers the tools, publishes settings, and emits the Durable
  contribution; `durable.ts` is the native form.
- `capability.ts` holds schemas, model-facing text, and production
  dependencies (`osascript`, `screencapture`, `ps`, Pi's image resizer).
- `operations.ts` implements the five operations over injectable dependencies;
  `session.ts` builds discovery requests and maps Apple Events failures.
- `jxa.ts` is the JavaScript for Automation program; `osa.ts` runs it with a
  deadline and cancellation.
- `page.ts` builds the page-side scripts.
- `settings.ts` reads `browser.access`.

```bash
node --test extensions/browser/*.test.mts
node scripts/extension-load-check.mts extensions/browser/index.ts
npm run typecheck && npm run lint && npm run check
```

The tests use fake Apple Events replies, run page scripts against a small
fake DOM in a Node sandbox, and run the JXA program against a stand-in
scripting object model; they do not contact a browser. Browser behaviour itself needs a live
run against the selected application, with its permissions granted.
