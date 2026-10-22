# Proof

Proof runs the `draft` skill's prose meter on the agent's final reply and
returns the findings to the agent once, so the agent repairs the reply before
it settles. It never rewrites text. It is the push route for the meter: the
skill holds the meter and its rules, and this extension delivers them to chat
replies.

## How it works

When a run is about to settle, the extension takes the text of the final
assistant message and sends it, capped at `maxChars`, to the meter on standard
input. It spawns `node <meterPath> --stdin --format json` with an argument
array and no shell. A time limit (`timeoutMs`) kills the process.

The extension sends findings when any of three conditions holds:

1. The report has at least one hard finding.
2. The number of scored findings is at least `minScoredFindings`. Short
   replies have no reliable score or band, so this count is their trigger.
3. The score is reliable and its band is `notifyBand` or worse. The order of
   bands is `green`, `amber`, `red`; the default `amber` notifies on amber
   and red.

It then appends one message to the session and asks for one more model
request. The message lists hard findings first, then scored findings (rule id,
line, short message, at most `maxFindings` in total), the score with its band
and calibration cohort line when the report has one, and one instruction:
repair the reply above the token level, keep every claim, do not swap one tell
for its neighbour, and do not narrate the repair. Otherwise it returns
nothing.

The extension skips a run without reply text, a run that was aborted or ended
in error, and a disabled extension (`enabled` is false).

## Forms and reach

| Form | Hook | Covers |
|---|---|---|
| Ordinary | `agent_before_settle` returns a hidden message and `continue: true` | Replies in ordinary primary sessions that load the extension. |
| Durable | `GenerationTask` `onYield` returns `{ continue: text }` | Final answers of Durable agents that load the contribution. |

Sessions where the extension is not loaded (sessions started before
activation, and runs with extensions disabled) are not covered.

## Loop guard

Each run gets at most one repair pass.

- Ordinary: a flag is set when a repair is sent and cleared on
  `before_agent_start`. The continuation that carries the repair does not pass
  through that event, so the repaired reply is not measured again.
- Durable: the hook skips an answer when the latest user message of the
  conversation is a findings message. A decision per answer is memoized on the
  task so a replay returns the same result.

## Consumed contract

The meter's command line and JSON report are defined in
`docs/conventions/prose-meter.md`. The extension copies only the members it
reads into its own types in `meter.ts` and imports nothing from the skill. It
requires `contract` to be `1`; exit codes 0 to 3 carry a report.

## When the meter does not run

A missing meter file, exit status 4 or any status outside 0 to 3, unparseable
output, an unknown `contract` value, or a time-out means the check did not run.
The extension never treats these as a clean result and never blocks the
reply. It appends one visible notice to the session that names the cause
(missing, failed, or timed out), lets the reply settle, and stays silent until
the meter works again.

## Configuration

Settings follow `docs/conventions/extension-config.md`: section `proof` in the
machine document, with a `PI_PROOF_*` environment override per field.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| enabled | `PI_PROOF_ENABLED` | boolean | true | none | Run the prose meter on final replies. |
| meterPath | `PI_PROOF_METER_PATH` | path | &lt;package root&gt;/skills/draft/scripts/meter.mts | none | Prose meter script, run with node. |
| timeoutMs | `PI_PROOF_TIMEOUT_MS` | integer | 5000 | min 100; max 60000 | Hard time limit for one meter run; the process is killed at the limit. |
| maxChars | `PI_PROOF_MAX_CHARS` | integer | 20000 | min 100; max 200000 | Longest reply prefix sent to the meter, in characters. |
| notifyBand | `PI_PROOF_NOTIFY_BAND` | enum | "amber" | green, amber, red | Lowest score band that sends findings to the agent when the score is reliable; this band and every worse band notify. Hard findings always notify. |
| minScoredFindings | `PI_PROOF_MIN_SCORED_FINDINGS` | integer | 2 | min 1; max 50 | Scored findings that send findings to the agent even when the score is not reliable. |
| maxFindings | `PI_PROOF_MAX_FINDINGS` | integer | 12 | min 1; max 50 | Most findings listed in one message to the agent. |
<!-- harness:settings:end -->

## Limits

- The extension proves that findings reached the model once. It does not prove
  that the model repaired the text; measure the repaired outcome separately.
- The meter file location is a setting. The default resolves from the package
  root and needs the `draft` skill in the same package.
- Long replies are measured up to `maxChars`; later text is not checked.
- Line numbers in findings refer to the measured text.
