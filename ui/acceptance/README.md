# Browser acceptance

This directory contains a dependency-free Brave Chrome DevTools Protocol (CDP)
driver and a browser smoke command. It uses Node's built-in WebSocket and starts
Brave with a fresh temporary profile. Readiness comes from the DevTools URL on
stderr, not an HTTP probe or delay. Shutdown removes the profile after the owned
browser exits. Browser profiles do not share launch cookies.

Run the colocated deterministic tests:

```sh
node --test ui/acceptance/*.test.mts
```

After the backend and browser build are ready, use its newly issued launch URL:

```sh
node ui/acceptance/smoke.mts --url '<launch URL>' --out '<capture directory>'
```

The default run inspects the current workspace without model prompts. It changes
view selection and opens menus. An empty workspace produces a launch capture and
reports unavailable primary checks. The launch fragment is removed by the app;
the smoke report does not record it.

For an isolated deterministic backend, explicitly enable fixture mode:

```sh
node ui/acceptance/smoke.mts --url '<launch URL>' --out '<capture directory>' \
  --fake --cwd '<disposable project>' --prompt '<fixture trigger>' \
  --dialog-prompt '<fixture dialog trigger>'
```

The backend's executable `ui/rpc/fake-pi.mts` emits text, thinking, tool output,
and a confirmation dialog for ordinary prompts. The default smoke prompt contains
`no-dialog` and settles without that dialog. Use `--dialog-prompt 'acceptance
dialog'` for the separate fixture dialog path.

`--session '<saved fixture session>'` requests explicit resume instead of a new
fixture session. Before every input, the smoke command requires the selected
primary's reported model provider to be `acceptance-fixture`. `--fake` alone is
not sufficient. Never use fixture mode against a real provider. Dialog automation
cancels the fixture request; it does not approve trust or permission requests.

The command writes PNG captures and `report.json` to the supplied directory.
Every check has its own passed, failed, or unavailable state and browser/fixture/
real scope. The report includes exact synthetic primary input JSON and public
error replies, but never launch capabilities or cookie headers. A failed check produces a nonzero exit status. Unavailable checks do
not count as passes. The report retains the cached roster scan baseline, including
its explicit omitted-row count. The default run does not accept the complete desktop path.

The smoke path covers launch, explicit fixture project/session open, multiline
primary draft, backend acknowledgment, tool/thinking display, optional fixture
dialog cancellation, retained agent selection, refresh, a browser-only event
transport disconnect, model/thinking menu availability, applied fixture
model/thinking controls, fixture compaction events, compact layout geometry,
the terminal handoff explanation, and outgoing fixture writer exit. Fixture checks reject empty joined-tool result
headers, false unconfirmed-send feedback after admission, and provisional
exit errors after a completed fixture handoff.
Transport disconnect closes only browser
EventSource instances and invokes the app's error path; it does not interrupt
backend or native execution. It does not inject a replay gap or uncertain send.

The report separates remaining real boundaries: Safari and foreground display,
real model/tool/extension execution, native agent inputs and abort, uncertain
admission and replay/mismatch injection, applied session controls, visual contrast,
terminal resume identity, and sole-writer ownership. Fixture success does not
replace these trials. Cross-process warm stream p95 remains unmeasured without
backend timestamp accounting. Browser performance measures, long tasks, and a
single input-to-animation-frame sample are diagnostic observations, not a full
performance budget result.

## Driver API

`launchBrave({executable?,port?,timeoutMs?})` returns `{cdp,page,version,profile,close}`.
The default debug port is `0`, so Brave chooses an available local port. The
endpoint must be an explicit `127.0.0.1` WebSocket address.

- `cdp.send(method,params?,{sessionId?,timeoutMs?,signal?})` correlates responses.
- `cdp.waitForEvent(method,predicate?,options?)` registers a cancellable event wait.
- `page.navigate(url)` registers the lifecycle wait before navigation dispatch.
- `page.evaluate(expression,timeoutMs?)` awaits promises and returns JSON values.
- `page.waitFor(expression,timeoutMs?)` observes DOM mutations, with no polling.
- `page.viewport(width,height)` sets CSS viewport dimensions.
- `page.screenshot(path)` writes a viewport PNG.
- `page.timing(expression)` measures browser-local execution through the next
  animation frame. It does not prove physical display paint timing.

Always call `close()` in `finally`. Timeouts are failure deadlines, not readiness
delays. No driver function imports frontend, backend, or private harness code.
