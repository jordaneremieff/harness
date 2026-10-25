# Draft

Draft prevents slop in human-facing text. Its rule data and meter report hard
findings, scored findings, a score with a band, and a calibration line. It never
rewrites text. A clean report does not show that a text is good.

## Tool

Call `draft` with exactly one of `text` or `path`, and `kind` set to
`prose`, `commit`, or `diff`. Relative paths resolve against the conversation's
current directory. Prose files use their extension to select Markdown, HTML,
plain text, or source-comment extraction. Inline prose uses Markdown.

The tool reads regular files with UTF-8 text only. It rejects binary data, invalid UTF-8
and inputs over the character limit in `tool.ts`. It reports findings with
line numbers. Diff findings refer to added lines and carry new-file paths.

The ordinary tool's `promptSnippet` and `promptGuidelines` tell the model to
check only final text the automatic reply check does not see, after facts,
evidence and position are settled. This includes documents, commit messages,
pull request descriptions, tickets and other text that leaves the chat.
Agents do not call the tool on chat replies or status reports. The reply check
checks final chat replies automatically. After a reply-check repair, the agent
sends the repaired reply without another draft call. Notes, intermediate drafts
and work in progress stay outside the tool's scope. The native form supplies
the same guidance through a prompt section.

## Reply check

The ordinary `agent_before_settle` hook and native `GenerationTask.onYield`
hook analyse the final reply in process. Neither starts a subprocess.
The native check runs only when the active run includes a placed `pi.user`
input. The host reserves that input kind for operator requests and places agent
requests under application kinds. Draft reads only the Pi-owned distinction.
It joins placed submissions to their exact transcript entries, including entries
before a context summary. Queued inputs and passive notices do not decide
whether the current answer gets a check.

The hook requests one repair when:

- At least one hard finding exists.
- A reliable score reaches `notifyBand` or worse, in green, amber, red order.
- Scored findings reach `minScoredFindings` only when the score is not reliable.

A reliable green score does not request repair at the default amber threshold,
regardless of finding count. Reply analysis excludes spelling rules before
detection and scoring. Explicit tool calls still report spelling findings.

The message lists hard findings first, then scored findings, up to
`maxFindings`. It includes the score and calibration. It asks the model to
repair above the form, preserve claims and avoid a neighbouring tell.

The ordinary form clears its repair flag at `before_agent_start`. The native
form memoises each answer's decision and records the oldest placed submission
of the run that received a repair. Each run gets at most one automatic repair
pass, even after a passive notice or a context summary. The findings continuation
is not an input submission and does not enable checks on agent requests.
The native state document retains `checkpointWhen: () => false`.

Empty replies, aborted or failed ordinary runs, and disabled checks produce
no hook findings. The hook checks only the first `maxChars` characters.
An analysis failure produces one notice, not a clean result. The hook lets the
reply settle and stays silent until analysis succeeds again.

## Skill and rules

The extension contributes its own directory through `resources_discover` so
`/skill:draft` resolves to [SKILL.md](SKILL.md). The native contribution adds
that same directory through Pi's public services resource loader before the
host builds its skills prompt. No separate global skill route is needed.

Lexical rules ignore a short quoted mention when the complete quoted content
matches a term or multiword phrase. Matching straight or curly single and double
quotes qualify. Extra clause words and sentence punctuation keep a quoted use
in scope. Inline code already stays outside the prose view. These exclusions
do not suppress other rule groups.

[Rule data](data/rules.json) is the single rule source. The meter reads it
directly. Generate the references after a rule change:

```text
node extensions/draft/scripts/render-references.mts
node extensions/draft/scripts/render-references.mts --check
```

## Shell use

The CLI stays for commit-message and unified-diff checks from a shell outside
Pi. The hook and tool do not call it.

```text
node extensions/draft/scripts/meter.mts message.txt --kind commit
git diff --staged | node extensions/draft/scripts/meter.mts --diff
node extensions/draft/scripts/meter.mts --help
```

Use `--format json` for the report below. Standard output carries the report;
standard error carries input diagnostics. Exit codes are 0 for no hard
findings and no reliable score gate, 1 for hard findings, 2 for a reliable
score gate, 3 for both, and 4 for usage or input errors. Hard findings do not
feed the score. Short text gets findings but no reliable band.

## Configuration

Settings follow [the configuration contract](../../docs/conventions/extension-config.md):
one `draft` section in `<agentDir>/harness.json`, with per-field environment
overrides. These settings control the reply hook, not explicit tool calls.

<!-- harness:settings:start -->
| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|
| enabled | `PI_DRAFT_ENABLED` | boolean | true | none | Run the prose meter on final replies. |
| maxChars | `PI_DRAFT_MAX_CHARS` | integer | 20000 | min 100; max 200000 | Longest reply prefix sent to the meter, in characters. |
| notifyBand | `PI_DRAFT_NOTIFY_BAND` | enum | "amber" | green, amber, red | Lowest reliable score band that requests reply repair, regardless of finding count. This band and worse bands notify. Hard findings always notify. Spelling is excluded. |
| minScoredFindings | `PI_DRAFT_MIN_SCORED_FINDINGS` | integer | 2 | min 1; max 50 | Minimum scored findings that request reply repair only when the score is not reliable. Spelling is excluded. |
| maxFindings | `PI_DRAFT_MAX_FINDINGS` | integer | 12 | min 1; max 50 | Most findings listed in one message to the agent. |
<!-- harness:settings:end -->

## Checks

```text
node --test extensions/draft/*.test.mts
node extensions/draft/scripts/render-references.mts --check
node skills/harness/scripts/validate-skill.mts extensions/draft
node scripts/extension-load-check.mts extensions/draft/index.ts
npm run lint
npm run typecheck
npm run check
```

## Report shape

The CLI JSON report and the in-process meter use this shape. The tool renders
the same report as text. Calibration describes a limited cohort, not a
population guarantee. Read [calibration](references/calibration.md) before
relying on a score.

```ts
interface MeterReport {
  /** Bumped on any breaking change to this shape. */
  contract: 1;
  meterVersion: string;
  input: {
    kind: "md" | "html" | "text" | "ts" | "js" | "commit" | "diff";
    words: number;
    sentences: number;
    lines: number;
    target?: string;
  };
  /** Absolute rule violations, ordered by position. Listed findings are capped per rule. */
  hard: Finding[];
  /** Weighted tells, ordered by position. Listed findings are capped per rule. */
  scored: Finding[];
  score: {
    /** 0 to 100. */
    sq: number;
    /** Null when the text is too short for a reliable band. */
    band: "green" | "amber" | "red" | null;
    reliable: boolean;
    threshold: number;
    components: {
      lexical: ScoreComponent;
      geometry: ScoreComponent;
      epistemic: ScoreComponent;
      laundering: ScoreComponent;
    };
  };
  calibration: {
    cohort: string | null;
    n: number;
    date: string | null;
    status: "uncalibrated" | "calibrated-on-model-written-benchmark";
  };
  omitted: {
    /** Findings counted but not listed because of the per-rule cap. */
    hard: number;
    scored: number;
    perRuleCap: number;
    byRule: Record<string, number>;
    /** Diff mode only: files that hold no prose the meter reads. */
    skippedFiles: string[];
  };
}

interface Finding {
  /** Rule id from the rule data, such as `punctuation.em-dash`. */
  rule: string;
  severity: "hard" | "scored";
  /** One-based. Absent when a finding has no location. */
  line?: number;
  column?: number;
  text: string;
  message: string;
  /** Diff mode only: the file path, or `(commit message)`. */
  file?: string;
}

interface ScoreComponent {
  /** 0 to 1. */
  value: number;
  metrics: Record<string, number | null>;
}
```
