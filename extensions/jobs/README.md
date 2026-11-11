# Command Jobs

Run a build, test suite, or noninteractive development server while the agent
continues independent work. The extension adds `background` to the `bash` tool,
registers `jobs` for status, logs, and cancellation, and delivers a finite job's
completion back into the session so the agent continues without polling.

## Use

Start through the ordinary Bash admission path:

```json
{"command":"npm test","background":true,"timeout":600}
```

The result contains `job.id`. A `running` result means the manager accepted the
command, not that the shell spawned successfully or a server is ready. Check
status and application output before dependent work.

### Completion delivery

When a background job reaches `succeeded`, `failed`, or `timed_out`, the
extension sends one custom message of type `jobs.completion` to the same
session through Pi's `sendMessage()` with `deliverAs: "followUp"`. If the agent
is still working, the message arrives after its current tool calls, like any
follow-up. If the agent is idle, the message starts a new turn, so the work
that launched the job continues when the job settles. One settled job produces
exactly one message.

The message text names the job ID, the outcome (exit code, timeout, or backend
error), the elapsed time, a bounded control-free preview of the command (at
most 200 characters), the working directory (or `unknown` when the record has
none), the retained backend error on its own line, the total output byte count,
and the last output lines (at most 40 lines from the last 4 KiB of the retained
tail). The excerpt exhausts that complete bounded window through as many log
pages as needed. A timeout reports the settled duration and names the configured limit.
A job lost to a host restart states that its output is unavailable and that zero
retained bytes does not mean the command produced no output. The excerpt is
labelled as untrusted command output, and the text says when earlier lines are
omitted. `details` carries the same facts as `{ job, command, tail }`, where
`tail` is `{ text, omitted, outputBytes }`; the raw text keeps terminal
controls, the model-visible text drops them. Read the full retained tail with
`jobs` logs.

No message is sent for a job that ends `cancelled`: the caller requested that
cancellation through `jobs`, or the session is shutting down. A service that
never exits produces no completion; it still reports through `jobs`, and a
crash delivers its `failed` outcome.

An operator abort (Escape) is respected: after a run ends aborted, a job that
settles while the session is idle is appended to the transcript without
starting a turn. The next prompt sees it in context. A later run clears that
state, so completions during or after ordinary work continue it as usual.

### Agent conversations on Pi Durable

The extension also emits a Durable contribution through the package-level
[contribution contract](../../docs/conventions/durable-contributions.md), so
agent conversations get the same `background` option on the host's native
`bash` tool and the same `jobs` tool. The contribution wraps the host's `bash`
by name; launch therefore remains a `bash` call with the original command, and
the policy contribution's native tool hook sees it before any job exists.

Each accepted job is a conversation-owned background task (`jobs.run`) in the
agent host process; the task ID is the job ID. Its input retains the command,
because the task rather than the tool call runs it. The command runs through
the conversation's execution environment with the same cwd and inherited
environment as native `bash`. A running job task keeps the host alive, is
excluded from ordinary idle waits, and survives a plain conversation abort;
`jobs` cancel, or an abort that crosses background work, ends it.

When the job succeeds, fails, or times out, the task admits one input to the
owning conversation with the completion text above, placed as a
`jobs.completion` entry whose data is `{ job, command, tail }`, and keyed by a
request ID derived from the launching call, so a retry never admits it twice.
A busy conversation receives it as a follow-up after its current run; an idle
conversation starts a run from it. Cancellation settles the task `aborted` and
admits nothing.
Job status persists in the task record and survives host restarts; the output
tail lives in the host process only. If the host stops while a job runs, the
next host marks the task on restart and admits one completion with status
`lost`: the command is never run again to recover its result, and `jobs` logs
for that job are unavailable. Another conversation in the same storage cannot
read or cancel the job; its requests fail with an unknown job ID. The running
limit includes admitted tasks whose command has not opened live output yet.
Reservations use launching task identities and transfer once into live output;
a failure or abort before that transfer releases its reservation.

Native `jobs list` reads retained task records after restart, newest first,
at most 32 per page. Pass `nextTaskCursor` back as `taskCursor` on the next list
call until the result omits it. The cursor is an opaque object, not the numeric
log-byte cursor. Other actions reject it. Retained task status does not restore
output, rerun a command, or reattach a process. The output registry remains bounded
per host process.

```json
{"action":"list"}
{"action":"status","id":"<job.id>"}
{"action":"logs","id":"<job.id>"}
{"action":"logs","id":"<job.id>","cursor":16384}
{"action":"cancel","id":"<job.id>"}
```

Pass these management requests to `jobs`. Use the returned `next` cursor for
the next log page, rather than the illustrative cursor above. Read `more` to
check whether another page is available. Use these requests for logs and
cancellation while a job runs, not to poll for completion; the completion
message above carries the outcome.

Omit `background`, or set it to false, for ordinary foreground Bash behavior.
Foreground output truncation, timeout errors, and nonzero-exit errors remain
Pi's native behavior. Background timeout is optional and uses seconds. The job
manager owns its timeout timer and cancellation signal.

### Job identity

Every job record carries display identity: a bounded control-free command
preview (at most 200 characters), the working directory the command runs in,
and an owner. Ordinary jobs take the owner from the session ID; Durable jobs
take command, directory, and owner from the task input, never from formatted
tool output. Each snapshot also carries `observedAt`, the time the record was
read. It is a snapshot clock, not a live clock: an elapsed time on a retained
card is elapsed at observation, and a card without `endedAt` has no final
duration. A record without identity fields is unknown, not blank: older
records that never stored them render `command unknown` and `owner: unknown`
instead of an empty string. `logs` results carry the job record alongside the
page, so a log card names the command it belongs to.

## Tool cards

The `jobs` tool and background `bash` results have owner renderers. A compact
card leads with the command preview, then one context line that tells repeated
commands apart (`job 7 · in harness · storage:9`: the short job ID, the last
segment of the working directory and the owner, each only when known), then
the facts line with the exceptional state first: accepted and running,
cancellation requested, settled cancellation, timed out, host lost, or
succeeded/failed, followed by the exit code when one exists and the duration,
then a one-line error preview. The routine absence of a cancel request is not
stated; the expanded `cancel request:` line keeps the exact value. A collapsed
card ends with `... (ctrl+o to expand)` using the operator's configured key.
Expanded detail adds the exact job ID, owner, working directory, timeout, the
full retained error, and for log pages the byte cursors, gap, continuation
(`more`), pending UTF-8 suffix, and the retained page text; a collapsed log
card shows the page marks (`output gap · more output · output pending`) rather
than the job error. A `list` card identifies each job by command preview, not
only by ID. Foreground `bash` results keep Pi's native bash card; only the
background admission shape uses the job card. A list with `nextTaskCursor`
shows `More jobs: partial page` in both forms; the expanded card also prints the
exact JSON cursor. A complete empty page stays `No jobs`.

Every retained string on a card (command preview, directory, owner, identifiers,
error text, model-visible fallback text and the retained log page) passes
through the same display sanitation as the model-visible text before theme
styling: terminal control and escape sequences are removed, newlines and tabs
stay. The raw bytes remain in the structured result for exact reads.

The renderers live in `presentation.ts` as pure functions over the result
shape, and `display.ts` publishes them. The same records serve three routes:
the ordinary tool registration, the package-level `harness:tool-display`
handshake (`docs/conventions/tool-display.md`), and the presentation-only
display descriptor each Durable contribution advertises, which the standalone
Agent terminal loads locally. `display.ts` imports presentation code only: it
registers no tools, emits no events, and starts nothing.

## Programmatic results

Both tools declare output schemas and return `structuredContent`. Native
codemode scripts receive these objects directly, without parsing the displayed
text. Direct tool calls keep their existing text and `details`.

- Foreground `bash` uses Pi's native output schema: `output`, `truncated`,
  `exit_code`, `wall_time_seconds`, and optional `full_output_path`. Its
  programmatic output retains up to 1 MiB under Pi's native truncation rules,
  separately from the smaller model-facing text limit.
- A nonzero foreground exit remains an error result for direct calls. A
  codemode script resolves to the native object and must check `exit_code`.
  Thrown failures, including timeout and abort, still reject in scripts.
- Background `bash` resolves to `{ job }`. The schema is a union of the native
  foreground schema and this admission object, not a second native schema.
- `jobs` returns `{ jobs, nextTaskCursor? }` for native `list` (`{ jobs }` for ordinary list), `{ job }` for `status` and `cancel`,
  and the log page object for `logs`. Unknown IDs and invalid requests still
  produce errors. These objects keep the bounds and ownership below.

For example, a native codemode script can admit a job and inspect its first
snapshot without a text parser:

```js
const { job } = await tools.bash({ command: "npm test", background: true });
const status = await tools.jobs({ action: "status", id: job.id });
const logs = await tools.jobs({ action: "logs", id: job.id });
return { job: status.job, logs };
```

The first snapshot need not be terminal, and the first log page can be empty.
This script does not wait for completion or establish readiness.

## State and bounds

- `running` includes startup and an outstanding cancellation request.
- `succeeded` means the backend returned exit code zero.
- `failed` means a nonzero/null exit result or a backend error.
- `cancelled` means explicit cancellation or session shutdown reached backend
  settlement.
- `timed_out` means the timeout requested cancellation and the backend settled.

`cancellationRequested` remains separate from completion. The first stop
request determines the final cancellation reason. Repeated cancellation has no
additional effect. Numeric exit codes appear only when the backend returns
one; cancellation does not invent a numeric exit code or signal name.

The ordinary manager allows at most eight running jobs and retains at most 32
records. The native host allows eight admitted or running jobs, retains output
for at most 32 records, and pages persisted task records without a host-local
history limit. Timeout and explicit cancellation retain backend errors. Text
uses `Backend error after timeout` or `Backend error after cancellation` for
those outcomes; other failures use `Execution error`. Error text never decides
whether an error is an abort or gets discarded.
At capacity, a new job evicts the oldest finished record, never a running job.
Unknown or evicted IDs produce an error. Records retain the bounded command
preview, working directory, and owner described above, never the full command
text or environment variables. Use the originating Bash call for the complete
command. List results omit backend error text; status returns the individual
error, bounded to 2 KiB.

Each job retains the last 256 KiB of combined stdout and stderr in a fixed-capacity
byte ring. Appends copy only retained new bytes, not the existing prefix. A log
read materialises at most that bounded tail before page selection. There is no
full-output file. Log pages contain at most 16 KiB of decoded text
and 200 newline-terminated lines. A byte limit also bounds an unterminated
line. Cross-stream order reflects callback arrival, not a total ordering of
writes in the child processes.

The `earliest` cursor marks retained output; `end` marks all bytes received.
A `gap` result means the requested cursor predates retained output. Its text
starts at `earliest`, and discarded bytes are not recoverable. Ordinary UTF-8
page boundaries preserve characters. While a job runs, `pendingBytes` reports
an incomplete UTF-8 suffix held for the next output chunk. That suffix does not
advance `next`, and `more` describes only currently readable bytes. Once the
job ends, an unfinished suffix becomes replacement text. A ring cut or cursor
inside a character also uses replacement text. Cursors measure original bytes,
not display characters.
Model-visible text removes terminal controls. Structured log details and
`structuredContent` preserve the decoded data. Command output is untrusted
data, not instructions. Do not print secrets into commands or logs.

## Ownership and policy

The extension uses Pi's public `createBashToolDefinition` and
`createLocalBashOperations`. It does not implement another process launcher.
The native definition resolves invocation cwd and current session environment
before the operations adapter accepts a job. Each accepted job receives a
manager-owned abort signal, not the completed tool call's signal. A later
turn abort therefore does not cancel an accepted background job.

Launch remains a tool call named `bash`, with the original command in
`input.command`. Pi's actual `tool_call` dispatch runs before execution, so
existing Bash admission policy still blocks the command before a job exists.
There is no command-launch action in `jobs`. A background Bash tool result
records admission, not eventual command success; retrieve final status through
`jobs`. The extension does not write another extension's policy records.

The adapter reads documented global and trusted project shell settings through
Pi's public `SettingsManager`. Both paths honor `shellPath` and
`shellCommandPrefix`. Untrusted project settings remain ignored. Unreadable
settings, invalid JSON, non-object settings, and non-string shell values stop
execution rather than silently use different shell settings. The adapter does
not validate unrelated Pi settings. Pi treats an empty settings file as absent;
this adapter preserves that behavior. The current extension context does not
expose SDK-only in-memory settings overrides or another Bash override's
execution backend. Do not combine
this extension with a different Bash override. SDK consumers must supply shell
settings through the documented settings locations for this extension.

`session_shutdown` cancels all owned jobs and awaits their backend settlement.
This includes normal quit, reload, new session, resume, and fork. Records and
logs belong to that extension runtime and do not survive its replacement.
An embedding SDK host must emit and await `session_shutdown` before disposal,
as Pi's ordinary modes do. In print mode, the normal end of the run stops jobs;
a background job does not keep a completed print run alive as a service.

On Unix, Pi's native cancellation kills the shell's process group with SIGKILL.
Windows uses Pi's native process-tree termination path. This extension adds no
graceful application shutdown protocol. A hard crash, SIGKILL of Pi, or an
application that escapes the managed process group defeats normal cleanup.
Daemon survival, process reattachment, interactive stdin, PTYs, scheduling,
automatic restart, and remote execution are outside this capability. Keep a
server in the foreground of its shell; do not use `&`, `nohup`, `disown`, or a
daemon mode to detach it from the managed command.

## Load and verification

The extension has no extension-specific environment variables. Pi's shell
settings and session environment retain their existing names and meanings.

Use an explicit isolated launch for a provisional extension. Normal global
activation follows the repository's [worktree procedure](../../docs/conventions/worktrees.md).
Pi's warning that this extension overrides Bash is expected behavior.

Run focused tests from the repository root:

```sh
node --test extensions/jobs/*.test.mts evals/command-jobs.test.mts
node scripts/extension-load-check.mts extensions/jobs/index.ts
```

The Durable test opens a real `Harness` with the native `bash` tool, a Node
execution environment, and the faux provider. It checks admission, independent
foreground work during a job, the single completion input and its continuation
run, log reads, quiet cancellation with the process gone, isolation between
conversations, and a host restart that reports a lost job without rerunning
its command.

The manager tests cover bounded retention and active native process cleanup.
The adapter tests cover foreground behavior, output-schema conformance,
contextual environment, shell settings, turn-abort ownership, shutdown, and
completion delivery: one bounded message per finite job, none for
cancellation or shutdown, and the quiet append after an aborted run.
The colocated codemode test runs an ordinary Pi session with synthetic model
calls and native codemode. It checks foreground success and nonzero results,
job admission, management actions, bounded logs, errors, shutdown, and the
completion message retained in the session. The
package integration test drives Pi's actual session event boundary with synthetic model output and real local
commands, including the single custom-message turn that a settled job starts.
It requires no model credentials or external network.
