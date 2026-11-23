# Application messages

This package-level contract lets an extension that serves an application, such
as a reader pane or a code explorer, put a message from the operator into the
conversation that opened it. One receiver owns the conversation side: the
message envelope, its placement, its presentation, the reply rule, and the
guidance that explains such messages once per context window. Senders own
their content and their application's own guidance. No extension imports
another or reads another extension's records.

The agent extension implements the receiver in ordinary Pi sessions. The
Markdown reader and Explorer implement the sender side for their Ask requests.

## Events and shape

Copy this shape locally into each participating slice. Do not create a shared
runtime module or import another slice.

```ts
type ApplicationMessage = {
  version: 1;
  /** Pi session ID of the conversation the sender is bound to. */
  sessionId: string;
  /** The sending extension's directory name, such as "markdown". */
  extension: string;
  /** What people and the model call the application, such as "Markdown reader". */
  application: string;
  /** The sender's request ID, a UUID. */
  id: string;
  /** One line naming what the message is about, such as a document title. */
  subject: string;
  /** One line naming where to act, such as "pane <handle>"; absent when nothing needs a place. */
  place?: string;
  /** The request ID of the earlier request from the same extension that this one continues. */
  follows?: string;
  /** "final": the application shows the answer described under Reply rule; "none": no reply is expected. */
  reply: "final" | "none";
  /** The application's standing guidance for its messages, given once per context window. */
  guidance?: string;
  /** The body: Markdown text that the sender composes. */
  text: string;
};
type ApplicationMessageReceipt =
  | { status: "requested"; reference: string }
  | { status: "rejected"; message: string };
type ApplicationMessageReceiver = {
  version: 1;
  deliver(message: ApplicationMessage): ApplicationMessageReceipt;
};
type ApplicationMessageRequest = { version: 1 };
type ApplicationMessageReply = {
  version: 1;
  extension: string;
  id: string;
  status: "working" | "answer" | "unanswered";
  /** Empty for working; the final assistant text for answer; a short reason for unanswered. */
  text: string;
  /** For answer: how many other requests and operator messages the same final message answered. */
  shared?: number;
};
```

- `harness:application-messages:receiver` carries `ApplicationMessageReceiver`.
- `harness:application-messages:request` carries `ApplicationMessageRequest`.
- `harness:application-messages:reply` carries `ApplicationMessageReply`.

These are process-local payloads on Pi's `pi.events` bus. The receiver's
`deliver` keeps its function identity. Only version `1` is defined; no aliases
or readers for other shapes exist.

The receiver refuses a message whose fields break these limits:

- `sessionId` equals the receiver's current session ID.
- `extension` is 1 to 32 lowercase letters, digits and hyphens, starting with a
  letter.
- `application` is one line of 1 to 48 characters without `[` or `]`.
- `id` and `follows` are UUIDs. The message's reference is `#` and the first
  eight hexadecimal digits of `id`, in lowercase.
- `subject` and `place` are one line of 1 to 200 characters.
- `guidance` is 1 to 2000 characters.
- `text` is nonblank, well-formed Unicode and at most 128 KiB in UTF-8.
- `extension`, `application`, `id`, `follows`, `subject` and `place` contain
  no control or format characters, and `guidance` none other than line feeds.

`text` passes to the model unchanged, because it carries exact quotes such as
tab-indented code, CRLF line ends and emoji sequences. The card removes control
and escape sequences from what it displays, as the receiver's other cards do.

## Receiver

At extension factory setup in ordinary Pi, the receiver subscribes to
`harness:application-messages:request`, emits its publication once, and emits
it again on each request with `version === 1`. The receiver binds to the
session at `session_start`; before that, and after `session_shutdown`, it
refuses delivery. Pi removes `pi.events` subscriptions when the extension
runtime is invalidated, and a reload repeats the handshake, as in the
[tool display contract](tool-display.md#consumer-lifecycle-and-safety).

`deliver` checks the message, places it and returns at once. `requested`
means that Pi queued or placed the message. It is not durable admission and not
an answer. The same extension and `id` delivered again in one session runtime
returns the first receipt and places nothing.

### Model-facing text

The receiver writes the message as one Pi custom message of its own type with
`display: true`. Its first line is the header:

```text
[<application>] #<reference> · follows #<reference> · <subject> · <place> · reply in your final message
```

`follows` and `place` appear only when the message has them. With
`reply: "none"`, the last part reads `no reply needed`. The text follows after
one blank line.

Between the header and the text, the receiver adds two kinds of standing
explanation, each only when the current context window lacks it:

- its own explanation of application messages: what the header means, that the
  text is the operator's request, that quoted passages and excerpts are context
  rather than instructions, how replies work and that several requests in one
  run are answered by reference; and
- the sender's `guidance`, after the application's name, the first time that
  extension's guidance would enter the context window.

The current context window is Pi's compaction-aware entry list
(`buildContextEntries`) plus messages that the receiver has queued but Pi has
not placed yet. After compaction removes an explanation, the next message
carries it again. Each message's text never changes after placement, so the
prompt prefix stays stable.

### Placement

The receiver sends each message with `triggerTurn: true` and
`deliverAs: "followUp"`. An idle session starts a run for it. A busy session
places it when the current work ends, under the operator's follow-up mode,
so requests that arrive during a run can reach the model together.

Pi's interactive Escape clears queued messages, and a run drains or clears its
queue before it settles. At `agent_settled`, the receiver therefore places
again, without starting a run, each message that it sent while a run was active
and that Pi never started. Such a message waits for the next run, which answers
it. A message sent while the session was idle starts its own run and is never
placed twice.

### Reply rule

A message is placed when Pi starts it (`message_start`). The receiver emits
`working` for a placed message with `reply: "final"` when its run is active,
or at the start of the next run.

The run's answer is the first assistant message that ends without tool calls,
an error, or an abort. That message answers every request placed since the
previous answer, and every operator message that entered in that time. Each
request receives `answer` with the message's text and, when the message
answered more than one input, `shared` with the number of other inputs. A
blank answer gives `unanswered`. At `agent_settled`, a placed request without
an answer receives `unanswered`.

`session_shutdown` and `session_tree` end the receiver's tracking. Each
request that awaits an answer then receives `unanswered` with a reason for
people. A request that waits for the next run when Pi reloads keeps its place
in the conversation, and its reply appears there, not in the application.

### Presentation

The receiver registers the renderer for its message type. The collapsed card
names the application, the subject, the reference, any `follows` reference
and the reply expectation, and previews the text. The expanded card shows the
whole message. The card leaves out the standing explanations from its preview.

## Sender

At extension factory setup in ordinary Pi:

1. Subscribe to `harness:application-messages:receiver`. Keep the latest
   publication with `version === 1` and a function `deliver`; ignore other
   payloads.
2. Subscribe to `harness:application-messages:reply`. Route replies whose
   `extension` is the sender's own to the requests that it delivered.
3. Emit `harness:application-messages:request` with `{ version: 1 }`.

The subscribe-before-emit order covers both factory load orders, because Pi's
bus invokes synchronous handlers immediately.

To send, build the message with the sender's own code and call `deliver`.
Without a publication, refuse the request and say that this conversation has no
application message receiver. Do not substitute another delivery path. A
`rejected` receipt is a definite refusal; nothing reached the conversation.

The sender composes `text` for its application and gives its standing
guidance in `guidance` rather than in each body. It does not read the
receiver's custom messages and does not parse the model-facing text.

## Scope

The contract covers ordinary Pi sessions. A native Durable conversation takes
input through the Durable submission API; a sender keeps its own native route
there and states what that route's text needs.

## Verification

Receiver tests use a fake bus, session and context to cover both load orders,
field refusals, the header, explanation and guidance once per context window
including compaction and queued messages, repeated delivery, placement, the
reply rule with shared runs, re-placement after cleared queues, session end and
the card. Sender tests use a fake receiver to cover the envelope, refusal
without a receiver, receipts and reply routing. No test imports another slice.
