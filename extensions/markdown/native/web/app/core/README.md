# Reader document and editor API

The page uses classic scripts, not ES modules. Each TypeScript file is an IIFE
that registers functions on `globalThis.reader`. Type declarations live in
`.d.ts` files and have no runtime output. The native build strips erasable
TypeScript syntax without a bundler. Node tests strip the same files with
`node:module.stripTypeScriptTypes` and execute them in a `vm` context.

Load these scripts in order, followed by the page's UI and entry script:

1. `app/host/native.js`
2. `app/core/exact.js`
3. `app/core/source-model.js`
4. `app/core/controller.js`
5. `app/core/render-html.js`
6. `app/editor/block-editor.js`

## Host and controller

```js
const host = reader.createNativeHost();
const controller = reader.createController(host);
const editor = reader.createEditor(controller, documentColumn, {
  scroll: scrollContainer,
});
host.send("ready", { version: "reader", capabilities: { lock: true, claims: true } });
```

`ReaderHost` is the only native boundary. It supplies `on(type, handler)`,
`send(type, fields)`, `request(type, fields)` and `dispose()`, plus host
capabilities. Only `host/native.ts` reads the WebKit transport. The host validates
envelopes, message fields and byte limits before delivery. `reader.receive(message)`
is the native entry. Source uses a 2 MiB raw UTF-8 limit. Document blocks and
matching render replies use a 16 MiB compact-JSON limit for the blocks field;
matching review replies use a 16 MiB raw UTF-8 limit for HTML. Edits lists in
`edits` and `agentApply` use a 5 MiB compact-JSON limit. The remaining metadata
uses a separate 256 KiB compact-JSON limit. Other messages use 256 KiB in total.
The controller does not own or dispose its host.

`createController(host, {document?, now?})` accepts an initial document for tests.
A host `document` replaces the source, history, claims, HTML cache and change
traces together. A late render from an earlier document or generation is ignored.
A render reply may omit HTML for previously sent keys, never for unknown keys.
The page never splits production Markdown into blocks: host blocks are authoritative.

- `controller.doc` holds the exact source and generation.
- `controller.blocks` holds the current host block ranges, types, HTML and inline maps.
- `setLock("reading" | "writing")` changes the person's edit lock.
- `change(edits, {blockId?, now?})` commits one person transaction in Writing.
- `undo()` and `redo()` follow the open block's person history, or the whole document when no block is open.
- `undoAgent(operationId)` selectively undoes an agent operation, or refuses an overlap without mutation.
- `nextHistory()` returns `{undo, redo}` descriptions with `origin`, `blockStart` and an agent `operationId` where available.
- `agentOperations` retains per-operation old/new text, mapped current ranges, `unread`, `conflicted` and an optional `threadId`.
- `markRead(operationId)` clears an operation's unread flag.
- `pickImage(range)` stages an image through the host and commits its edits as a person transaction. A changed generation discards the late result with a notice.
- `state(patch)` reports selection, find, overlay and scroll state to native with a trailing 100 ms throttle.
- `dispose()` removes controller subscriptions and timers.

An agent operation carries a `threadId` only when the host supplies one. An
operation ID is never a prompt or thread ID. Agent changes apply in both lock
states, except inside an open block. The block is held until it closes, including
while focus is elsewhere or a composition is active. `editor.releaseHold()`
closes the block for a notice's **Let it** action.

The host owns durable writes, recovery and captured-source copies. Unlocking a
captured source does not create a draft. Its first accepted edit creates the copy;
an acknowledgement supplies the copy metadata. The original payload remains exact.

## Events

`controller.on(name, handler)` returns an unsubscribe function. Callbacks run
synchronously. The UI owns notices, overlays, prompts, key routing and decoration.

| Event | Value |
| --- | --- |
| `document`, `blocks`, `lock` | Document payload, block list, edit lock |
| `selection` | `{text, start, end, anchor, focus}` in exact-source offsets, or null |
| `active`, `hold` | Open block identity/range, held range or null |
| `state`, `settings`, `ack`, `refused` | Host state and acknowledgements |
| `beforeChange`, `change`, `agentChange` | Exact change, generations, origin, operation identity and optional thread identity |
| `beforeBlocks`, `view` | Before a block patch, and after the DOM patch |
| `claims`, `agentOperations`, `history` | Current claims, retained changes and next history descriptions |
| `command`, `link`, `notice`, `error` | UI command, link card target, notice or error |

## Block editing and source coordinates

`createEditor(controller, root, {scroll?, plainSource?})` owns only the document
column. The UI supplies styles and the scroll container. `plainSource` selects
flat source spans when native input annotations require them; it does not select
a different document model.

- `open(key, {x, y})` maps a viewport click through the native inline map before activation and preserves the clicked line's viewport height.
- `open(key, displayOffset)` opens at an LF-display UTF-16 offset.
- `open(key, point, {oneOff:true, selection:{start,end}})` selects an exact-source range and returns to Reading when the block closes.
- `close()` or `releaseHold()` renders the block again. Composition defers closure.
- `selection()` maps both rendered or source endpoints to the exact source. An uncovered map endpoint returns null.
- `replaceSelection(text)` replaces a rendered selection across blocks as one edit and one Undo step.
- `format(command)` accepts `bold`, `italic`, `code`, `link`, `indent`, `outdent`, `bulletList`, `numberedList`, `taskList`, `quote` or `{command:"heading", level:0..6}`.
- `toggleTask(key, taskIndex)` changes one task mark only in Writing.
- `dispose()` removes DOM listeners and controller subscriptions.

Production inline maps are native cmark segments
`[renderedStart, renderedLength, sourceStart, sourceLength]`. Unequal segments
are atomic and snap to their edges. Unknown endpoints refuse destructive edits.
Cosmetic inline tokenisation never selects source coordinates or changes bytes.
It retains every Markdown character, including unsupported or incomplete syntax.

The open block displays LF. Its line map preserves untouched CR, LF and CRLF.
Inserted breaks use the dominant ending. A CR/LF seam edit widens over only the
adjacent touched break. Expected-text checks stage every history inverse before
source or generation changes.

The editor intercepts Enter, multiline paste and WebKit history input. No
application DOM write occurs inside composition. Outside composition, matching
flat span structure survives ordinary typing; structural restyling restores
both selection endpoints and direction. Disjoint agent edits leave active DOM
nodes untouched. The viewport anchor compensates changes above the visible area.

## DOM and styles

The editor sets `[data-role="document"]` on its root. Each block has
`data-block`, `data-start`, `data-end`, and `data-type`. The open block alone has
`data-role="block-editor"`, `contenteditable="plaintext-only"`, `role="textbox"`
and `aria-multiline="true"`.

Span classes are `plain`, `mark`, `prefix`, `bold`, `italic`, `code`, `link` and
`strike`; emphasis classes combine for nesting. The UI owns colours and mark
font size. The editor owns hanging-prefix geometry. Mark/prefix CSS uses 0.86em
and accessible contrast. Do not use `content-visibility:auto` on document blocks.
Mark UI controls inside document blocks with `data-reader-control` so they do not
enter the text index. A control that shows content, such as the rendered view of a
code block, also carries `data-reader-view`; the context menu treats it as its block. Controls that preserve the document caret prevent focus
on pointer down.

`reader.setRenderedHTML(element, html)` is the single cmark Trusted Types sink.
Pass only HTML from host document, review or `markdown` query replies. It shares one
policy per document. Never pass Markdown source, prompt text or arbitrary markup.

## Find and highlights

`editor.index()` returns each visible block's text plus a function that creates
DOM ranges for text offsets. The active block contributes its displayed source.
`editor.find(query)` returns `{key,start,end,ranges}` for literal, case-insensitive
matches. Offsets here refer to that block's indexed text, not the exact source.
`editor.highlight(name, ranges)` sets a CSS Custom Highlight without DOM or
selection changes. Refresh highlights after `view`, `change` or `document`.

## Verification

Run the colocated Node tests through `npm test`. `test/stage-webcheck.mts` stages
the editor regression page and the same type-stripped scripts into an explicit
output directory. `test/editor-steps.json` drives the offscreen WebKit runner.
The fixture renderer is deliberately small and never ships in the app. The
isolated editor page flushes its frame queue explicitly, without a visible-window
clock. Its timings cover synchronous input and forced layout with the memory
host, not native transport, frame pacing or key-to-paint.

`test/stage-product.mts <UI web directory> <output directory>` stages the real
UI shell and styles with the same core and editor. It injects boot deferral and a
memory-host fixture; it does not duplicate the shell. The UI entry script exposes
`reader.boot(host?)` and skips its native auto-boot when `readerDeferBoot` is true.
The fixture exposes `{host,controller,editor,ui,payload}` as `readerProduct` for
offscreen interaction checks.

Offscreen events do not establish native input-method, spelling, dictation,
VoiceOver or key-to-paint behaviour. Those require the actual pane's native trial.
Keyboard selection across block edges and very large single-block editing remain
separate from the mouse-based cross-block selection path.
