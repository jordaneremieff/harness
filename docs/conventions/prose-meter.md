# Prose meter contract

The prose meter finds slop tells in prose and reports them. It never rewrites
text. This document is the package-level contract for its command line and its
JSON report. The `draft` skill owns the producer. Other slices consume the
report through this contract and never import the skill.

The contract is structural. No slice imports another slice, the skill scripts,
or a shared module to satisfy it. A consumer copies the members it reads from
the [Shape](#shape) block and updates that copy when the block changes.

## Consumers

- The `draft` skill. Agents run the command by hand on chat drafts, documents,
  tickets, commit messages and pull request text.
- The `extensions/draft` extension. It spawns the command with a reply on
  standard input and reads the JSON report. Its tests run against a fixture
  script that implements this contract, not against the skill.

The meter location is a setting of the consumer, never a hardcoded sibling
path.

## Invocation

```text
node skills/draft/scripts/meter.mts [target] [options]
```

| Flag | Meaning |
|---|---|
| `target` | One file path. No target, or `-`, reads standard input. More than one target is a usage error. |
| `--stdin` | Read standard input. A file target is a usage error. |
| `--diff` | Read a unified diff from the target or standard input. Only added lines are checked. Findings carry new-file line numbers. |
| `--kind KIND` | `auto` (default), `md`, `html`, `text`, `ts`, `js`, `commit`. `auto` picks by file extension; standard input is `md`. `commit` also applies the mechanical commit checks. |
| `--format FORMAT` | `text` (default) or `json`. |
| `--threshold N` | Score gate, from 0 to 100. The default comes from the rule data. |
| `--strict` | Use the green band edge as the threshold. |
| `--strict-semicolons` | Report a single prose semicolon as a hard finding. |
| `--spelling au\|off` | Australian spelling check. Default `au`. |
| `--times 12h\|off` | Flag 24-hour and UTC times in prose. Default `off`. |
| `--rules PATH` | Use another rule data file. It must pass the schema. |
| `-v`, `-q` | More or less text output. They do not change the JSON report. |
| `--help`, `--version` | Print usage or versions and exit 0. |

Standard input is read to the end, decoded as UTF-8 and limited in size. A
terminal with nothing piped is a usage error: the command never waits for
interactive input. Data goes to standard output. Diagnostics go to standard
error. Text output honours `NO_COLOR` and plain pipes.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No hard findings, and the score is below the threshold or not reliable. |
| 1 | Hard findings are present and the score gate is not hit. |
| 2 | The reliable score is at or above the threshold and there are no hard findings. |
| 3 | Hard findings are present and the reliable score is at or above the threshold. |
| 4 | Usage or input error: bad flag, missing file, directory, not UTF-8, binary, too large, or invalid rule data. |

Hard findings never feed the score. The score gate applies only when
`score.reliable` is true. A clean result is a floor, not acceptance.

## Shape

This block is the JSON report that `--format json` prints.

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
    status: "uncalibrated" | "calibrated";
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

## Ownership rules

- Nobody imports anybody. The skill implements the command. A consumer
  spawns it and validates the output against its own copy of the shape.
- A consumer treats an unknown `contract` value, unparseable output, an exit
  code outside the table, or a timeout as "the meter did not run", and says so.
  It never treats those cases as a clean result.
- The skill's conformance test runs the real meter and checks its JSON against
  a validator written from the shape block.

## Versioning

`contract` is an integer. Any breaking change to the flags, exit codes or the
shape bumps it: removing or renaming a member, changing a member type, or
changing the meaning of an exit code. Adding an optional member or a rule id
does not. A producer never emits two contract versions at once.
