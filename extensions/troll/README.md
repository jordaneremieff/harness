# Troll

`/troll` opens a troll in a floating pane over the tab of the Pi pane where you typed it. The troll is
an ordinary Pi session whose one job is to make the strongest truthful case against another
session's answer, submit that case in the target session as your message, and read the answer when
it arrives.

```text
/troll
/troll this is overbuilt; press on why a new store is needed
/troll 0190f3a2-7c1e-7d5a-9a51-2f4b8c6d1e30 the benchmark does not measure the claim
/troll the editor sidebar session, draft only
```

- Without words, the troll challenges the latest answer of the session where you typed `/troll`.
- Words after `/troll` are your instruction to the troll, in any form: what to push on, how hard,
  which session to target and how to deliver. A session ID anywhere in the words names the target.
  Otherwise the troll infers the target from your words, or takes the session where you typed
  `/troll`. If it cannot find the target, it says so in its pane and stops.
- By default the troll submits each message in the target session as your own message, with no
  clipboard step. Ask for another process in the instruction, for example a draft only, a
  clipboard copy, a message in the troll's own voice, or an answer in the troll pane.
- After a submission, the troll waits. When the target's run ends, its answer comes back to the
  troll, which decides whether a gap that matters remains. It submits at most three rounds after
  each message of yours in the troll pane, and stops early on agreement, a decline, a real
  boundary, an interrupted run or input of yours in the target during the run. Then it reports
  what the target said, what it did, what the evidence establishes and what remains unknown.

Talk to the troll in its pane at any time; your message there also permits further rounds. Quit
the troll session to close the pane. Press Escape in the target to interrupt its run; the troll
then stops submitting until you write in its pane.

## Configuration

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|
| model | `PI_TROLL_MODEL` | string | unset | next use | minLength 1; maxLength 200 | Model of the troll session, in the form pi --model accepts, such as provider/id. Unset starts the troll on Pi's default model. |
| thinkingLevel | `PI_TROLL_THINKING_LEVEL` | enum | unset | next use | off, minimal, low, medium, high, xhigh, max | Thinking level of the troll session. Unset uses Pi's default thinking level. Pi clamps the level to the model's capabilities. |
| width | `PI_TROLL_WIDTH` | number | 0.34 | next use | min 0.1; max 0.9 | Width of the troll pane as a fraction of the tab's width. |
| height | `PI_TROLL_HEIGHT` | number | unset | next use | min 0.1; max 0.9 | Height of the troll pane as a fraction of the tab's height. Unset makes the pane square: its height follows its width and the tab's shape on screen. |
| left | `PI_TROLL_LEFT` | number | 0.01 | next use | min 0; max 0.1 | Gap between the tab's left edge and the troll pane, as a fraction of the tab's width. |
| top | `PI_TROLL_TOP` | number | 0.016 | next use | min 0; max 0.1 | Gap between the tab's top edge and the troll pane, as a fraction of the tab's height. |
<!-- harness:settings:end -->

The defaults draw a square about a third of the tab's width, just inside its top-left corner. Rex
computes the square from the invoking terminal's size on screen. The pane uses the Rex app's
terminal font size: Rex changes font size only through app actions, which another program can
perform only while the app's Remote Control setting is on, so the troll leaves the font as it is.

## Opening the pane

`/troll` works in an ordinary interactive Pi session in a Rex pane. It finds the first `pi`
program on `PATH` and asks the Rex extension's [terminal-pane adapter](../../docs/conventions/terminal-pane.md#float-over-the-invoking-tab)
to start it in a floating pane over the invoking pane's tab, without taking focus. The program runs
through your login shell with its interactive startup files, so the troll session has the commands
and environment of your own terminals. Its arguments are:

```text
pi --troll <origin session ID> [--model <model>] [--thinking <level>] --name Troll -- <opening message>
```

The opening message names the origin session and quotes your instruction; it holds at most 8 KB. One
creation attempt is the maximum. A result whose effect is uncertain is reported and never retried.

The `--troll` flag marks the session as a troll. Only a troll session adds the troll's instructions
to its system prompt and registers the `troll_submit` tool.

## Submission and answers

Every ordinary interactive Pi session that loads this extension listens on a local socket,
`<agentDir>/troll/<session ID>.<process ID>.sock`, in a directory that only your account can open.
A troll submits one message per connection:

- The receiving session checks that the request names its own session, that it is idle with no
  queued messages, and that no earlier troll message still runs. It then submits the exact text
  through Pi's own user-message path, which starts its run as if you had typed it; it never types
  keys into a pane and never touches the editor. Otherwise it refuses and submits nothing.
- The session answers `submitted` once a run starts with the troll's exact message, and shows a
  notice that the troll pane submitted the message. If no such run has started after six seconds, it
  answers `waiting`. If none has started a minute later, it reports that, takes troll messages again,
  and the troll reads the target's history before it submits again, because Pi can still start the
  message late.
- The connection stays open until the run ends. The session then sends the last public answer after
  the message, up to 64 KB, whether the run was interrupted, and how many other messages you added
  during the run. If the message is not in its history after the run, the session reports that it
  did not run it. The troll brings the result into its session as a `troll-reply` message that starts
  its turn.
- If the target closes or restarts before its run ends, or the connection breaks, the troll receives
  a notice instead. The troll records each round before it sends it, so if the troll session itself
  restarts while it waits, its new instance reports the rounds whose answers will not arrive.

The troll role is recorded in the troll's session, so a troll session that you resume later stays a
troll.

A troll finds the target's socket among those of running processes. When more than one process runs
the target session, the troll uses the pane where you typed `/troll` if that pane runs the target,
and otherwise refuses, because it cannot tell which pane you mean. `troll_submit` refuses a fourth
round since your last message in the troll pane, and any round after a reply that did not end with
a clean answer or that reports your input in the target. A session that started before this
extension became active has no socket, and the troll reports that it cannot reach it. Each session
start removes the sockets of processes that no longer run.
