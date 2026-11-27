# browser: already-open browser sessions on macOS

This extension lets an agent work in a browser tab that the operator has
already opened and signed in to. The operator names the browser and the tab
and gives an ordinary task. The agent lists the tabs, selects the named one,
reads the rendered page, performs authorised actions, waits for an observable
outcome, evaluates JavaScript when extraction is not enough, saves downloads
through the browser's Save dialog, and captures the live window. The operator
keeps working in other applications meanwhile: the agent's work does not keep
the keyboard (see [Keyboard focus](#keyboard-focus)).

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
| `browser_act` | `interact` | One action on an inspected element: `click`, `fill`, `select`, `check`, `uncheck`, `press`, `submit`, `focus`, `scroll`, or `navigate`, then an optional postcondition wait |
| `browser_evaluate` | `interact` | One JavaScript expression, with promise results awaited in the same call |
| `browser_save` | `interact` | Save or cancel the Save dialog that a download opened in the tab's window |

The extension offers tools for the access configured when it loads: none
without any configured browser, the three reading tools when every configured
browser has `inspect`, and all six when one has `interact`. A session that
never uses a browser therefore carries no browser tool declarations. Every
offered tool is deferred: it stays registered and callable from other tools, and
`tool_search` loads the ones the model needs. Enable discovery with
`"defaultTools": ["+codemode", "+tool_search"]` in Pi settings, or add the public
`createToolSearchExtension()` factory in an SDK host. Each call still checks the
access of the browser it names. After changing access, run `/reload` or start a
new session. Before setup, `registry {"kind":"setting", "search":"browser"}`
shows the `browser.access` setting.

`browser_act`, `browser_evaluate`, and `browser_save` run one at a time
(`executionMode: "sequential"`) in both the ordinary and Durable forms. In the
ordinary form every offered tool carries the shared model guidance, so loading
any one of them brings the full set; an identical guideline appears once
however many browser tools a request has active, and no browser guidance
appears while no browser tool is active. In the Durable form the `browser-guidance` prompt section names
the tools the request offers. Results are text: a headline, then a JSON report
on one line. Text and HTML views put the page content after the report, marked
as untrusted.
The capture result adds the image.

Browser cards follow the [emission grammar](../../docs/conventions/emissions.md)
across ordinary Pi, the agent dashboard, and the attached terminal. Tab cards
lead with availability or matching tabs. Inspection cards lead with page
content or matching elements and show the next call for a paged view in the
expanded card. Action cards distinguish dispatch, observation and the requested
condition; they show the length of filled or selected text, not its value.
Evaluation cards show the expression as call input and report its settlement
separately. Action and evaluation cards say when the browser took the keyboard
and which browser window, such as a Save sheet or a dialog, waits for a person.
Save cards show the saved path and size. Capture cards keep the native inline
image and distinguish a failed optional save from a failed capture.

## Setup

The operator controls five separate gates. The tools report which one is
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
5. **Accessibility** for the host application, for `browser_save` only.
   `requestPermission: true` on `browser_save` asks macOS to show its prompt;
   the operator enables the host in System Settings > Privacy & Security >
   Accessibility. Without it, `browser_save` refuses with
   `accessibility-not-granted`, and the agent asks the operator to answer the
   Save dialog.

## Selecting the subject

- `browser` is always explicit. No tool chooses a browser, falls back to
  another one, or starts one; a browser that is not running is reported as
  `not-running`.
- `pid` is required for `browser_inspect`, `browser_act`, `browser_evaluate`,
  `browser_save`, and `browser_capture`. Take it from the same `browser_tabs`
  call that reported `tab`; no tool chooses a process for a tab. `browser_tabs` takes
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
- `origin` (required for `browser_act` and `browser_evaluate`, optional for
  `browser_inspect` and `browser_capture`) is checked inside the page
  immediately before the operation. A tab that navigated elsewhere reports
  `origin-mismatch` and nothing runs. `browser_save` answers the Save dialog
  of the tab's window and takes no origin.
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

A JavaScript dialog, a print preview, or a "Leave site?" prompt blocks every
page script until a person answers it, and a script sent to a blocked page
runs when the page resumes. Before the first page script of an inspection,
action, navigation, or evaluation, the operation therefore runs a trivial
script with a two-second limit. A page that does not answer refuses with
`page-blocked`, and nothing of the operation reaches it; the agent tells the
operator what is open. Reads during a wait skip this check.

One JXA invocation serves a discovery request. Availability for every
supported application, and the windows and tabs of one named process, are each
gathered in one invocation with no separate inventory call. Availability reads
installation and running facts and checks Automation only for an application
that is configured and running; it never prompts. A named listing resolves the
explicit `pid`, or the only running process, and reports ambiguity rather than
choosing. It asks macOS for Automation permission only when the call sets
`requestPermission: true`. Without configured access it returns the static
installation and running facts and sends no Apple Event. An inconsistent
read-only column result is repeated once within the same invocation. `match`
filters tabs on their whole URL and title; the listing then cuts URLs after 300
characters and titles after 150, since the origin and the start identify a tab.

## Inspection

Inspection runs fixed extraction scripts maintained in `page.ts`. Values of
password, hidden, one-time-code, and payment fields are redacted, and the
`html` view replaces those values and token-like `meta` contents, including on
the selected element itself. Redaction does not guarantee that page markup
holds no secret. Views are bounded by `maxChars`, `limit`, and `offset`, and
report `nextOffset` for continuation.

Every element that inspection describes carries a `ref`: the elements in the
`elements` view, the focused element and open dialogs in `summary`, the
candidates of an ambiguous selector, and the element that a `browser_act` result
reports. A ref has the form `<document token>:<number>`; the token is the
`page.doc` of the document that issued it. The page world of that document
keeps the element itself with the identity that inspection reported: tag,
`role`, input or button `type`, accessible name, and link target. The name of a
field (input, textarea, select, or editable element) comes from its label,
`aria-label`, or placeholder, never from its value or content, so filling a
field keeps its ref. Inspecting the same unchanged element again returns the
same ref; an element whose identity changed receives a new ref, and its old ref
keeps the old identity. In the `elements` view and among ambiguous-selector
candidates, elements that share a name (one Archive button per row) also carry
`context`: up to 100 characters of text from the nearest ancestor that says
more than the name, such as the row, so the ref of the intended element can be
chosen from one inspection. A ref issued with a `context` also keeps that
context as part of what it names. Inspecting the same element again in a row
that now says something else returns a new ref, and the old ref keeps the old
row.

The page world keeps the newest 500 refs; a ref that inspection reports again
becomes the newest. Each inspection, action, and wait read first releases
elements that have left the page and keeps only their identity for the
refusal. A new document starts with no refs, so a navigation or reload ends every ref of the
previous document. Refs, like the other records, live in the isolated world and
are invisible to page scripts.

The `network` view and every `browser_act` result report HTTP statuses from
the page's Resource Timing entries. Status `0` or `null` means the browser did
not expose the status to the page (for example a cross-origin response without
timing permission). The tools do not invent a status they cannot observe.

## Actions and outcomes

`browser_act` takes the element as `ref`, from inspection, or as `selector`, a
CSS selector for deliberate low-level use; it refuses both together or neither.
A ref reaches only the element it names. Before anything runs, the page checks
that the ref belongs to the current document, that the document still holds
it, that the element is still in the page, and that its identity is unchanged.
Otherwise the action refuses with `blocked.reason: "stale-reference"` and one
`cause`:

| Cause | Meaning |
|---|---|
| `other-document` | The tab navigated or reloaded since the inspection, or the ref came from another tab. |
| `not-retained` | Newer inspections displaced the ref, or this document never issued it. |
| `detached` | The page removed or replaced the element. |
| `repurposed` | The element's role, name, type, or link target changed; `inspected` and `current` show both identities. |
| `context-changed` | The element is unchanged, but the text of the row around it is not, for example a list that recycles rows for other items; `inspected` and `current` show both contexts. |

The tool never looks for a replacement: a page with several matching controls,
such as one Archive button per row, would make that a guess. Inspect again and
choose the element from the fresh result. A selector, by contrast, is resolved
again when the action runs, so a positional selector from an earlier inspection
(`li:nth-of-type(2) > button`) reaches whatever element holds that position
now. A selector that matches several elements refuses with candidates, each
with a ref, unless `index` selects one. Hidden or disabled elements refuse in
both modes.

Page code can run between the action reply and the task that dispatches the
action. That task repeats the attachment and identity checks for a ref and,
when they fail, dispatches nothing: the page record reads `not-dispatched` with
the `cause`, the wait ends at that read, and the result status is
`stale-reference`.

The identity check covers the element itself. The context check covers its
surroundings only for a ref issued with a `context`, that is, an element whose
name another inspected element shared. The comparison leaves out the
element's own name, so a control that shows or hides itself in its row keeps
its ref. Any other change to the first 100 characters of the row text refuses
the ref, including text that the page updates on its own, such as a relative
time; inspect again to continue. A page that reuses an element with a unique
name for different content without changing the element's role, name, type,
or link target passes both checks; a `waitFor` condition that names the
intended outcome shows whether the action reached it.

The action is scheduled in a new page task, so a JavaScript dialog opened by a
page handler blocks later reads, not the dispatch. Each result keeps these
layers apart:

| Layer | Field | Meaning |
|---|---|---|
| Transport | `transport` | Whether Apple Events delivered the request and answered. |
| Dispatch | `dispatch.status` | `dispatched`, `failed`, `not-needed`, `unknown`, or `not-dispatched` (the request did not reach the page, or the page withheld an action whose referenced element changed). Dispatch is not a task result. |
| Application | `application` | Page identity, document replacement, navigation status, and HTTP statuses observed after the action. A 401 or 500 stays here; it is not a transport failure. |
| Observation | `observation` | Present when a read after the dispatch could not answer: `status: "failed"`, `phase: "read-after-dispatch"`, `kind`, and the reason. |
| Goal | `postcondition.status` | `verified` when every `waitFor` check held, `failed` when the wait ended without it, `unknown` without a condition, after cancellation, or when a read could not establish the outcome. |

Actions use DOM events created in the page (`isTrusted` is false). Pages that
accept only trusted input, file choosers, and implicit form submission by
pressing Enter do not respond to them; use `submit` for forms. `fill` refuses
password fields: the operator signs in through the browser. Without `waitFor`,
an action observes the page for `observeMs`: 300 ms for `fill`, `focus`, and
`scroll`, which change only the element, and 1000 ms for the others.

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

Each action, navigation, and evaluation script carries a deadline: the end of
the tool's wait for its reply. A page that a dialog held runs a waiting script
when a person closes the dialog; after the deadline the script does nothing
and reports `expired`, and an action records `not-dispatched` for a later read.
The action result describes the element as the page left it, so a filled
field shows its new value.

`navigate` checks the tab URL's origin through Apple Events, then lets the page
navigate itself: a page script checks the document's origin and calls
`location.assign` in the same request. Chromium makes itself the active
application when Apple Events set a tab URL, but not when the page navigates,
so this keeps the browser in the background. A page navigation counts as
started by the page: the request carries the page as its referrer, and a site
that limits cookies to same-site requests sees one. Apple Events set the URL
instead, after the focus watch is armed (see [Keyboard focus](#keyboard-focus)),
for a URL that is not `http` or `https`, for a document without an origin of
its own (a browser error page or a sandboxed document), and when page
JavaScript is unavailable (JavaScript from Apple Events is off, or developer
tools are disallowed). `dispatch.method` says which one ran, and
`dispatch.pageScript` says why page script did not. When page reads are
unavailable, `navigate` still navigates and reports `dispatch.status:
dispatched` with the unavailable observation and an unknown postcondition. A
`javascript:` URL is refused: Apple Events would run it in the page's own
world; use `browser_evaluate` to run code. The element actions and
`browser_evaluate` need page JavaScript; when it is unavailable they refuse
before anything runs.

An exception from the page-side action marks the tool result as an error. Its
receipt reports `dispatch-failed` unless cancellation or a failed observation
also accounts for the result. An unmet `waitFor` condition alone does not mark
the tool result as an error.

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
the oldest finished records while more than 32 remain. A `navigate` has no page
record; a lost reply leaves its dispatch `unknown`.

## Evaluation

`browser_evaluate` checks the expression's syntax locally, then runs it once in
the tab's main frame. A synchronous result arrives in the reply to the start
request. A promise result is awaited inside the same tool call; the tool polls
the page until it settles, the `timeoutMs` limit passes, the document changes,
the tab closes, the browser process exits, or the caller cancels. Each poll is
a further request, so statements go in a synchronous function,
`(() => { ...; return value; })()`, and an async function only when the code
awaits.
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
failure. The expression never runs again to recover a result. After a timeout
or a cancellation during the wait the tool sends one removal request. An
outcome that the start reply or a poll returned gets none, which saves a
request per call; its record leaves through expiry or the record limit. If a
removal request is lost, the record expires the same way: each new evaluation
in the document first
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

## Keyboard focus

The operator works in other applications while an agent uses the browser,
often by voice dictation that types wherever the keyboard is. Chromium makes
itself the active application, and so takes the keyboard, for some events an
agent can cause: Apple Events that set a tab URL or create a tab or window, a
JavaScript dialog, a print preview, and a "Leave site?" prompt. Keystrokes then
land in the browser: in a dialog, in a Save sheet's file name, or in the page.

`navigate` avoids the most common cause by letting the page navigate itself.
For the rest, `browser_act` and `browser_evaluate` watch the keyboard. The
first such call on a browser process starts a small JXA program, which
watches that process until two minutes after the last call on it, so a dialog
that page code opens between calls is handled too. The program gives the
keyboard back to the application the operator used last, a few tens of
milliseconds after the browser took it, but only for an activation that it can
attribute to the agent:

- a browser window created during the watch came on screen within the last
  half second (a dialog, print preview, or pop-up window), or one does within
  700 ms after the activation: with Chromium 151, a JavaScript dialog came on
  screen about 180 ms after the activation, and a "Leave site?" prompt also
  comes after it; or
- the activation follows an Apple Event that the operation marked just before
  it: 2 seconds for an Apple Events URL change, 400 ms for a page navigation,
  whose "Leave site?" prompt activates the browser before its window exists,
  and 300 ms for an action or an evaluation, so that a dialog the page opens at
  once returns at once instead of after the wait for its window. Each mark
  gives the keyboard back once. A dialog that opens later returns when its
  window appears: in a live check the browser held the keyboard for about
  210 ms before such a return.

Every other activation belongs to the operator: a click on a browser window or
the Dock, the application switcher, a launcher, or a link opened from another
application. The watch leaves the keyboard there, and returns it again only
after the operator moves to another application. A mouse click within half a
second before the activation, on a browser window in the window order from
before the browser raised its window, is the operator's switch even when an
agent cause coincides. A window that existed when
the watch started never counts, also when it comes back on screen from a
hidden application, a minimized window, or another desktop.

The result of the call reports what the watch saw in a `focus` field, and the
headline says it in words: `taken` lists each return (`afterMs`, `heldMs`,
`returnedTo`, `cause`), `windows` lists browser windows that appeared, such as
a Save sheet or a dialog that waits for a person, `yielded` says that the
operator switched to the browser during the call, and `earlier` holds the
returns and windows between the previous call and this one. A reported window
whose bounds equal those of a browser window in the scripting model is an
ordinary window, such as one the operator opened, and is left out; that check
lists the windows only when there is a window to report. `unavailable` says
why the watch did not run; the call still runs.

Limits: keystrokes typed in the interval before a return can still reach the
browser, and a menu open in the operator's application closes. The watch sees
applications, not windows: when the operator works in the same browser that
the agent uses, an Apple Events URL change, a "Leave site?" prompt, or a pop-up
that the agent's page opens makes the agent's window the key window, and the
keyboard follows it. Give agents their own browser or profile for long runs.
Chromium shows a JavaScript dialog of the agent's tab only once the tab's
window is the last active browser window. A browser window can also come to
the front without taking the keyboard, as Chromium's quit confirmation does;
the watch reports such a window but does not move it.

## Save dialogs

A download in a browser that asks where to save shows AppKit's Save panel as a
sheet on the tab's window. The sheet appears without making the browser active,
and the next result of `browser_act` or `browser_evaluate` reports it in
`focus.windows`. `browser_save` answers it through macOS Accessibility: it
finds the window of the selected tab by its bounds, sets the file name with an
attribute write instead of keystrokes, and presses the panel's Save or Cancel
button. No keystroke reaches the browser and the browser does not become the
active application, so the operator's typing never reaches the file name.

The tool answers only while the browser is not the active application: when
it is, the operator can be working in it or typing in that dialog, and the
tool refuses with `browser-in-use`. The panel shows its controls to
Accessibility only while its window is on screen; the dialog of a hidden or
minimized window refuses with `dialog-unreadable`. The panel reports no default
or cancel button attribute: the Save button carries the identifier `OKButton`,
and Cancel is the one other plain button beside it apart from New Folder. A
browser that does not answer Accessibility within two seconds fails the read.

`expectedName` names the file that the agent's download should suggest, such
as the download name of the link it clicked; the tool refuses a dialog that
suggests another name with `dialog-mismatch`, since that dialog can be the
operator's. A download panel hides the file extension unless the Mac shows all
extensions, so the comparison ignores an extension on either side.

`fileName` is a name without a folder; without it the panel's suggested name
stays. A name without an extension gets the download's extension. The file goes to the folder that the panel shows, and the agent moves it
afterwards when the task needs it elsewhere. When the folder that the panel's
folder menu names holds a file of that name, and the name has an extension,
the tool refuses with `file-exists` before the press and leaves the Save dialog open for another
name: the panel would ask whether to replace the file, and it shows that
question to Accessibility only in part. When the panel stays open after the
press anyway, the tool refuses with `save-question`; `cancel: true` still
closes it.

After the press the tool finds the saved file among the folders the panel can
show: the folder of the last save that the browser's preferences domain records
(`NSOSPLastRootDirectory`), the folders of the files the panel lists, and the
standard folders whose name the panel's folder menu shows. A folder that held
the name before the save is not a candidate, and a file counts only when its
change time is at or after the press: the browser renames or creates the file
there when the dialog closes, so an older file of the same name elsewhere does
not count. For a name without an extension, a name of the folder that adds one
extension also counts, and the result reports the name found. The tool then
waits up to `timeoutMs` (default 30 seconds) until the file exists and the
browser's partial file `<name>.crdownload` is gone, and reports the path and
size.
`saved-unlocated` and `download-unfinished` report a save whose file it did not
find or that did not finish in time; a browser that holds a download for a
person, as Chromium does for files it considers dangerous, ends the same way.
`cancel: true` presses Cancel instead.

Chromium lets a tab start one download without asking. A later download from
the same tab waits behind its prompt to download multiple files ("wants to:
Download multiple files") until a person answers it, or a navigation that the
browser starts resets the tab; a page navigation does not reset it. The focus
report shows the prompt as a window that waits for the operator, who can also
allow automatic downloads for the site.

`browser_save` needs `interact` access and Accessibility permission for the
host application (see [Setup](#setup)). Without permission it refuses with
`accessibility-not-granted`; the agent then stops and asks the operator to save
or cancel the file. To read a file that a page links to, `browser_evaluate` can
also fetch it with the page's session and return its content, which needs no
dialog.

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
guidance tells agents to use `browser_act`, `browser_evaluate`, and
`browser_save` only for changes the operator's task authorises and to ask before external-service
changes the task does not cover; routine authorised steps need no extra
confirmation. Operators can add policy rules for the tool names, for example to
require approval for `browser_evaluate`. Page content is untrusted data.

## Durable agents

The factory emits a `durable:contribution` named `browser` with the same six
tools, whose shared guidance comes from the `browser-guidance` prompt section
rather than from each tool. The tools are deferred, so the
section renders only the names the request offers; it is absent until
`tool_search` loads a browser tool. `browser_tabs`,
`browser_inspect`, and `browser_capture` declare `replay: "safe"` (a rerun
repeats a read; a `savePath` file is never overwritten). `browser_act`,
`browser_evaluate`, and `browser_save` declare `replay: "unsafe"`: an
interrupted call reaches the model as interrupted and never runs again. They
also declare `executionMode: "sequential"`, so a message that contains several
of these calls runs them one at a time. One focus watch program per browser
process serves every conversation of a Durable host.

## Configuration

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| access | `PI_BROWSER_ACCESS` | json | {} | reload | declared schema | Browsers the browser tools may address, as an object from browser key (chrome, brave, chrome-for-testing) to "inspect" or "interact". inspect allows tab listing, bounded inspection, and window capture; interact also allows browser_act and browser_evaluate. An unlisted browser receives no Apple Events; browser_tabs still reports its installation and running state. Access configures reach only and grants no task authority. |
<!-- harness:settings:end -->

## Files and checks

- `index.ts` registers the tools, publishes settings, and emits the Durable
  contribution; `durable.ts` is the native form.
- `capability.ts` holds schemas, model-facing text, and production
  dependencies (`osascript`, `screencapture`, `ps`, Pi's image resizer).
- `operations.ts` implements the six operations over injectable dependencies;
  `session.ts` builds discovery requests and maps Apple Events failures.
- `jxa.ts` is the JavaScript for Automation program, including the
  Accessibility answer of a Save dialog; `osa.ts` runs it with a deadline and
  cancellation.
- `focus.ts` is the focus watch: its JXA program and the watcher that keeps one
  program per browser process.
- `page.ts` builds the page-side scripts, including the element references.
- `page-fixture.mts` is the page stand-in for tests: a small DOM, the selectors
  and events the scripts use, and one isolated world per document.
- `settings.ts` reads `browser.access`.

```bash
node --test extensions/browser/*.test.mts
node scripts/extension-load-check.mts extensions/browser/index.ts
npm run typecheck && npm run lint && npm run check
```

The tests use fake Apple Events replies, run page scripts against a small
fake DOM in a Node sandbox, and run the JXA program against a stand-in
scripting object model, and the Save dialog answer and the focus watch program
against stand-ins of the Accessibility objects, the window list, and the
activation notifications; they do not contact a browser. The reference tests run
inspection and actions through `browserInspect` and `browserAct` over the page
stand-in, then reorder, replace, remove, relabel, and navigate the page.
Browser behaviour itself needs a live run against the selected application,
with its permissions granted.
