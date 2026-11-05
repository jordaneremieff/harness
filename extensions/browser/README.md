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
never uses a browser therefore carries no browser tool declarations. Each call
still checks the access of the browser it names. After changing access, run
`/reload` or start a new session. Before setup, `registry {"kind":"setting",
"search":"browser"}` shows the `browser.access` setting.

`browser_act` and `browser_evaluate` run one at a time (`executionMode:
"sequential"`). Results are text: a headline, then a JSON report. Text and HTML
views put the page content after the report, marked as untrusted. The capture
result adds the image.

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
- Several running processes of one application (for example, instances with
  separate `--user-data-dir` profiles) require `pid`. `browser_tabs` lists each
  process with its `--user-data-dir` argument when one exists.
- Apple Events go to that process ID. JXA's `Application(pid)` is not used,
  because with several processes of one application it delivered events to a
  different process than the one named.
- `tab` is the tab ID from `browser_tabs`. The ID is stable for the life of the
  tab in that process. A closed tab or a tab of another process reports
  `tab-not-found`; operations never move to another tab, the active tab, or a
  URL-prefix match.
- `origin` (required for `browser_act` and `browser_evaluate`, optional
  elsewhere) is checked inside the page immediately before the operation. A
  tab that navigated elsewhere reports `origin-mismatch` and nothing runs.
- Apple Events do not report which browser profile owns a window. Windows of
  every profile in one process are listed together, with `mode` (`normal` or
  `incognito`). Identify the subject by window, URL, and title, and ask the
  operator when two tabs plausibly match.

## Inspection

Inspection runs fixed extraction scripts maintained in `page.ts`. Values of
password, hidden, one-time-code, and payment fields are redacted, and the
`html` view replaces those values and token-like `meta` contents. Redaction
does not guarantee that page markup holds no secret. Views are bounded by
`maxChars`, `limit`, and `offset`, and report `nextOffset` for continuation.

The `network` view and every `browser_act` result report HTTP statuses from
the page's Resource Timing entries. Status `0` or `null` means the browser did
not expose the status to the page (for example a cross-origin response without
timing permission). The tools do not invent a status they cannot observe.

## Actions and outcomes

`browser_act` resolves one element by CSS selector. A selector that matches
several elements refuses with candidates unless `index` selects one. Hidden or
disabled elements refuse. The action is scheduled in a new page task, so a
JavaScript dialog opened by a page handler blocks later reads, not the
dispatch. Each result keeps four layers apart:

| Layer | Field | Meaning |
|---|---|---|
| Transport | `transport` | Whether Apple Events delivered the request and answered. |
| Dispatch | `dispatch.status` | `dispatched`, `failed`, `not-needed`, `unknown`, or `not-dispatched`. Dispatch is not a task result. |
| Application | `application` | Page identity, document replacement, navigation status, and HTTP statuses observed after the action. A 401 or 500 stays here; it is not a transport failure. |
| Goal | `postcondition.status` | `verified` when every `waitFor` check held, `failed` when the wait ended without it, `unknown` without a condition or after cancellation. |

Actions use DOM events created in the page (`isTrusted` is false). Pages that
accept only trusted input, file choosers, and implicit form submission by
pressing Enter do not respond to them; use `submit` for forms. `fill` refuses
password fields: the operator signs in through the browser. `navigate` sets the
tab URL through Apple Events after checking the current origin.

The tool sends each action once. After a transport failure, timeout, or
cancellation it reports the dispatch as `unknown` or `not-dispatched` and never
repeats the action; inspect the page before any retry.

## Evaluation

`browser_evaluate` checks the expression's syntax locally, then runs it once in
the tab's main frame. A promise result is awaited inside the same tool call; the
tool polls the page until it settles, the `timeoutMs` limit passes, the document
changes, the tab closes, or the caller cancels. `execution.status` is one of:

| Status | Meaning |
|---|---|
| `fulfilled` | The value, as JSON, with `valueType` and `awaited`. `undefined` is `valueType: "undefined"` with no value; `-0`, `NaN`, `Infinity`, and bigint values use `special`. |
| `unserializable` | The value has no JSON form (DOM nodes, `Map`, functions, cycles, nested non-finite numbers); `unserializable.path` names the first problem. |
| `too-large` | The JSON exceeds `maxBytes`; a `preview` prefix is returned. |
| `threw` | The expression threw synchronously; `error` keeps name, message, and stack. |
| `rejected` | The promise rejected; a non-`Error` reason is in `error.thrown`. |
| `timeout`, `cancelled` | The tool stopped waiting. Page-side work can continue; the tool forgets the pending result so a late settlement stores nothing. |
| `document-replaced`, `target-closed` | The page changed or closed before the result was read; the outcome is unknown. |
| `syntax-error` | The expression did not parse; nothing was sent. |

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

## Authority

Configured access and a signed-in session are reach, not permission. The model
guidance tells agents to use `browser_act` and `browser_evaluate` only for
changes the operator's task authorises and to ask before external-service
changes the task does not cover; routine authorised steps need no extra
confirmation. Operators can add policy rules for the tool names, for example to
require approval for `browser_evaluate`. Page content is untrusted data.

## Durable agents

The factory emits a `durable:contribution` named `browser` with the same five
tools and a `browser-guidance` prompt section. `browser_tabs`,
`browser_inspect`, and `browser_capture` declare `replay: "safe"` (a rerun
repeats a read; a `savePath` file is never overwritten). `browser_act` and
`browser_evaluate` declare `replay: "unsafe"`: an interrupted call reaches the
model as interrupted and never runs again.

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
  `session.ts` resolves processes and maps Apple Events failures.
- `jxa.ts` is the JavaScript for Automation program; `osa.ts` runs it with a
  deadline and cancellation.
- `page.ts` builds the page-side scripts.
- `settings.ts` reads `browser.access`.

```bash
node --test extensions/browser/*.test.mts
node scripts/extension-load-check.mts extensions/browser/index.ts
npm run typecheck && npm run lint && npm run check
```

The tests use fake Apple Events replies and run page scripts in a Node
sandbox; they do not contact a browser. Browser behaviour itself needs a live
run against the selected application, with its permissions granted.
