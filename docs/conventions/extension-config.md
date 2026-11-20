# Extension configuration contract

This package-level contract gives the operator one machine document for harness
configuration, per-field `PI_*` environment overrides, one inspection view, and
one generic editor, while every extension stays an independent slice. It defines
file, data, and event shapes, not shared code. Each participating slice
implements its own side in its own files. Do not create a shared runtime module,
import another slice, or copy another slice's implementation as a dependency.

The contract has two consumers. The registry is a read-only projection of the
publications below. The [config extension](../../extensions/config/README.md)
is the generic editor and the one writer of the machine document: it reads the
same publications, writes the document under the rules in [Writes](#writes),
and learns each owner's judgement of a proposed value from that owner's ordinary
publication. Owners implement only this contract; neither consumer needs code
in an owner, so either consumer can be removed without leaving code behind in
the owners. Owners keep the meaning of their settings: declarations, validation,
defaults, cross-field checks, and runtime application stay in the owning slice.

Public Pi settings, provider configuration, project trust, and MCP configuration
remain host-owned surfaces; consuming them does not create a harness
configuration format. Introduce no other extension-owned configuration-file
mechanism without amending this document first.

## Machine document

- Path: `<agentDir>/harness.json`, where the host supplies the absolute agent
  directory. `PI_HARNESS_FILE` selects another document; an absolute value is
  used directly and a relative value resolves against the agent directory.
  Neither the document path nor setting paths expand `~` or environment
  variables.
- Content: one strict UTF-8 JSON object of at most 131072 bytes with
  `"version": 1` and one object section per slice, keyed by the slice directory
  name. Example: `{ "version": 1, "policy": { "mode": "enforce" } }`.
- A slice reads only its own section and validates only its own keys. It never
  reads, validates, or writes another slice's section. Owners never write the
  document; the generic writer in [Writes](#writes) is the only writer.
- The document is machine-scoped. There is no project-scoped harness document.
- No project discovery, includes, watchers, live reload, migration, or reader
  for any retired document.
- A missing document is normal: source status `missing`, no diagnostic.
- An empty or invalid `PI_HARNESS_FILE`, a nonregular or oversized source, an
  unreadable file, invalid UTF-8, a byte-order mark, malformed JSON, or an
  envelope without `version: 1` produces one `document` diagnostic. Environment
  and default values stay usable. Read with a nonblocking open so a nonregular
  path cannot block the reader.
- A section that is present but not an object produces one `invalid` diagnostic
  for the section; its fields use environment and default values.

## Scope of settings

Settings tune an extension while Pi loads it. This contract defines no
extension-wide `enabled` key; to turn a whole extension off, stop loading it as
described in [Turn an extension off](../architecture.md#turn-an-extension-off).
The description of a setting that switches behaviour off or selects a mode
states what the setting gates and what stays available. That description
reaches the README table and the registry row, so an agent can answer from
either without reading the slice's source.

## Settings and resolution

Each setting has a lower-camelCase key, a `PI_*` environment name, a type, a
description, and an optional default. The environment name is
`PI_<SLICE>_<KEY>` in upper snake case, with each camelCase boundary written
as an underscore (for example `checkInMinutes` in slice `agent` is
`PI_AGENT_CHECK_IN_MINUTES`). Types are `string`, `path`, `integer`, `number`,
`boolean`, `enum`, and `json`.

A default is static or derived. A static default is the declaration's
`default` value. A slice computes a derived default from the agent directory,
a location relative to the slice's own files, or the effective values of the
slice's own nonsecret settings after their selection; for example, a
checkpoint directory follows an overridden store directory. `defaultText`
documents a derived default. A dependency cycle, a failed derivation, or a
default that fails the field's own validation is a declaration defect: the
read throws an error that names the field and carries no validator text.

Each field selects **present environment value > document field > default**.
Presence includes an empty string. Selected input that fails validation returns
the safe default, never a document value beneath an invalid environment value,
and produces an `invalid` diagnostic that names the rejected source.

- Environment booleans accept `0`, `1`, `false`, and `true`; document booleans
  require JSON booleans.
- Environment numbers use JSON number syntax; integers are safe integers;
  numbers are finite; declared `min` and `max` are inclusive.
- `json` environment values contain one JSON value; the owning slice's pure
  validator decides structure for both sources.
- A slice may add semantic checks to any field beyond its declared bounds, for
  example a nonblank token or a strictly positive number. A value that fails
  such a check is invalid input under the rule above: safe default, status
  `invalid`, and an `invalid` diagnostic that names the rejected source.
- Text rejects control and format characters and unpaired surrogates, with a
  default maximum length of 4096. Paths and secrets require at least one
  character. A relative path resolves against the agent directory; an
  `absolute` path setting rejects relative input. An unset optional path stays
  unset.
- An unknown key in the slice's own section produces an `unknown` diagnostic.
- Secrets are optional strings with no default and are environment-only. A
  document value for a secret is ignored and produces a `secret` diagnostic,
  even when an environment value wins. Never publish, log, or document a
  secret value.
- A slice applies its cross-field checks only to its publication: a violated
  check keeps the values, marks the affected records `invalid`, and adds one
  `relation` diagnostic per affected record. `readSettings` returns field-level
  results without relation diagnostics; owning runtime code still decides
  admission and throws its own domain error.
- `json` values are bounded before the owning validator runs: nesting depth at
  most 32, at most 10000 nodes, strings without NUL or unpaired surrogates and
  at most 131072 characters, object keys valid text of at most 4096
  characters, plain objects only, and a serialized size of at most 131072
  bytes. Environment input is also limited to 131072 bytes.
- A read keeps at most 256 diagnostics. Past that bound it adds one `coverage`
  diagnostic (field `coverage`, source `file`) instead of more entries.

Diagnostics have `field` (`<slice>.<key>`, `<slice>.<unknown key>` with the
unknown key portion truncated to at most 64 UTF-16 code units without splitting
a surrogate pair, `<slice>.<invalid-key>` for an unknown key with control or
format characters or an unpaired surrogate, `document`, `PI_HARNESS_FILE`, `<slice>` for a section that
is not an object, or `coverage`), `source` (`env`, `file`, or `default`),
`code`, and the fixed message for that code. Never copy raw input, parser
messages, or validator exception text into a diagnostic.

| Code | Message |
|---|---|
| `document` | Configuration document is invalid or unavailable. |
| `unknown` | Unknown setting in this section. |
| `secret` | Secret settings are environment-only; document input was rejected. |
| `invalid` | Selected input is invalid; the safe default is in effect. |
| `coverage` | Additional diagnostics were omitted at the diagnostic limit. |
| `relation` | Effective settings violate an owning cross-field constraint; values are unchanged. |

## Snapshot shape

A read returns one snapshot. Copy these shapes locally; names of local aliases
need not match.

```ts
type Origin = "env" | "file" | "default";
type SettingType = "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";
type Source = {
  path: string; // resolved document path
  status: "loaded" | "missing" | "invalid" | "unavailable";
  digest: string | null; // SHA-256 hex of the fully read bounded content, else null
  observedAt: string; // ISO time of the read
};
type SettingRecord = {
  name: string; // "<slice>.<key>"
  key: string;
  type: SettingType;
  description: string;
  env: string;
  secret: boolean;
  origin: Origin; // origin of the returned value
  status: "valid" | "unset" | "invalid";
  value?: unknown; // JSON value; absent for secrets and unset values
  secretState?: "set" | "unset"; // secrets only
};
type Diagnostic = { field: string; source: Origin; code: string; message: string };
type SettingsPublication = {
  version: 2;
  slice: string;
  declaration: Declaration; // the slice's plain `settings` export, copied
  source: Source;
  records: SettingRecord[]; // declaration order
  diagnostics: Diagnostic[];
};
```

The local snapshot adds the slice's typed `values`, which may hold an accepted
secret. `values` never leaves the slice. `declaration` is the plain data of the
[declaration](#declaration) below, so a consumer learns types, choices, bounds,
defaults, secrecy, and application timing from the owner without importing it.

## Declaration

Each configuration-reading slice owns `extensions/<slice>/settings.ts`. It
exports `settings`, a plain-data declaration, and the slice's own
`readSettings` and `publishSettings` functions. The module may also hold the
slice's validators and helpers. Importing the module performs no file,
environment, registration, or other runtime work; only constant construction
runs at import time. Runtime entrypoints and helpers of the slice import these
functions from the module; nothing outside the slice does, except the
repository check and conformance test described below.

```ts
export const settings = {
  slice: "policy",
  fields: {
    dir: {
      type: "path",
      env: "PI_POLICY_DIR",
      description: "Private directory for rules, approved data, and telemetry.",
      defaultText: "<agentDir>/policy",
      apply: "reload",
    },
    mode: {
      type: "enum",
      env: "PI_POLICY_MODE",
      choices: ["observe", "notice", "annotate", "enforce"],
      default: "observe",
      description: "Machine mode. observe records facts and candidate effects only; notice adds operator notices; annotate adds model guidance; enforce also applies approved denials and corrections. No mode unloads the extension. An ordinary --policy-mode flag overrides it for that session.",
      apply: "reload",
    },
  },
} as const;
type ReadOptions = { agentDir: string; env?: Readonly<Record<string, string | undefined>> };
export function readSettings(options: ReadOptions): Snapshot;
export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void;
```

Field entries carry `type`, `env` (always explicit and equal to the
`PI_<SLICE>_<KEY>` name above), `description`, `apply` (see
[Application timing](#application-timing)), and optionally `default` (a static
JSON value the reader uses), `defaultText` (README text for a default the slice
derives at run time), `secret`, `absolute`, `min`, `max`, `minLength`,
`maxLength`, and `choices`. A field has at most one of `default` and
`defaultText`. Semantic checks and derivations live in the slice's reader code,
not in the plain declaration. Without injected `env`, a read uses the current
`process.env`. A slice applies its own cross-field checks inside its
publication; `publishSettings` takes no validation callback.

## Application timing

`apply` states when a saved document change reaches the slice's running code.
It describes the slice's actual consumption sites; when sites differ, it names
the latest one.

| `apply` | Meaning |
|---|---|
| `use` | The slice reads the document again at each use. A saved change applies at the next use in every process that loads the slice, unless an environment value masks it there. |
| `reload` | The slice reads the value when Pi loads the extension: ordinary factory setup, which `/reload` and new, resumed, or forked sessions repeat, or Durable host creation. A saved change applies after a reload or a new session in ordinary Pi and in a new Durable host. |
| `restart` | The value is read once per process, for example at module load or by a separately started native application at launch. A saved change applies when that process starts again. |

This contract defines no live application operation. A `use` setting needs
none; an owner that needs one amends this contract first. A fresh publication
shows what the document now resolves to, not what a running consumer applied.

## Events

`harness:settings:publish` carries `SettingsPublication`.
`harness:settings:request` carries `{ version: 2 }`. These are process-local
payloads on `pi.events`. Only version `2` exists.

Publisher lifecycle, at factory setup (ordinary) or native host creation:

1. Subscribe to `harness:settings:request`.
2. On a request with `version === 2`, read fresh and emit the publication
   synchronously, during the request's delivery.
3. Emit one publication during setup as well.
4. Return the unsubscribe function; call it on `session_shutdown` or host close.

A publisher created without injected `env` reads the current `process.env` for
every publication, including `PI_HARNESS_FILE`; it keeps no copy of the
environment. The editor relies on this to obtain an owner's judgement of a
proposed document (see [Writes](#writes)).

A publication is a configuration snapshot, not proof that a running runtime
applied a value. It carries no execution capability, secret value, or local
`values`. A slice has one publisher; a reload recreates it. A publication holds
at most 128 records and 385 diagnostics and serializes to at most 262144
bytes.

The registry consumer keeps one collection per registry runtime: it
subscribes to `harness:settings:publish` before it emits its first request,
clears its previous publications and emits a new request for each query, and
unsubscribes when its runtime ends (`session_shutdown` or host close). The bus
delivers synchronously, so the query reads the responses that the request
produced. It validates each envelope, declaration, and record defensively,
ignores malformed publications and counts them, rejects any secret record that
carries a value, applies the publication bounds above and keeps at most 64
slices (counting further new slices as omitted), copies only the fields above,
and replaces each slice's previous publication. Coverage is the set of
responding publishers, never an inventory of absent ones. The registry never
writes.

## Writes

The config extension is the only writer of the machine document. Its tools,
its command, and its native application call one operation backend in the Pi
host process; nothing else writes. The writer:

- coordinates with other writers through `proper-lockfile` on the resolved
  document path with `realpath: false`, the lock protocol that Pi uses for its
  own settings files. It holds the lock for one read, check, and replacement,
  and reads the document again under the lock;
- identifies a revision by the SHA-256 of the document bytes. A change carries
  the value its author saw at its path; under the lock the writer compares it
  with the current value. A different current value is a conflict for that
  path, unless it already equals the requested value. Changes to other paths
  are kept;
- changes only the requested paths. Other sections, other keys, nested values,
  unknown keys, and the `version` envelope stay as they are. It never writes a
  default into the document: a reset removes the stored key so that normal
  resolution selects the value;
- refuses to write over a document that is invalid, unreadable, oversized, or
  not a regular file, and refuses a result larger than 131072 bytes. A missing
  document becomes `{ "version": 1, ... }`;
- replaces the document atomically with a temporary file in the target's
  directory, keeps its permission bits, replaces the target of a symbolic link
  rather than the link, and writes in place when the target has more than one
  hard link;
- refuses a value for a declared secret without sending it anywhere;
- obtains each owner's own judgement of the complete proposed document from
  that owner's ordinary publication: it writes the proposed document to a
  private file, and for one synchronous step names that file in
  `PI_HARNESS_FILE` and removes the environment names of the owner's fields,
  so the owner judges the stored values even where an environment value masks
  them in this process. It requests publications, restores the environment
  exactly, and requests publications again, so every consumer ends with
  publications of the real document. It accepts a judgement only from a
  publication whose source path is the proposed file, and refuses a change that
  produces a `file` diagnostic for a changed key or a `relation` diagnostic that
  the current document does not have;
- edits a section whose owner does not publish only as an explicit raw edit of
  bounded JSON, reported as not judged by an owner; and
- reads the document back after the replacement and reports the persisted
  revision.

A saved change is not an applied change. The writer reports the owner's
`apply` timing, any environment value that masks the saved value in its own
process, and the owner's fresh publication after the save.

## README table

Each declaring slice's README holds its configuration table between
`<!-- harness:settings:start -->` and `<!-- harness:settings:end -->`. The
repository check generates the rows from the plain declaration:

| Key | Environment | Type | Default | Applies | Constraints | Description |
|---|---|---|---|---|---|---|

Default text is `env-only` for a secret, `defaultText` when present, the JSON
form of `default` when present, and `unset` otherwise. Applies is `next use`,
`reload`, or `restart` for the `apply` values `use`, `reload`, and `restart`.
Constraints list `min`, `max`, `minLength`, `maxLength`, `absolute input`, and
the choices, or `none`. Do not hand-edit the rows.

## Verification

- `npm run check` fails a slice import that escapes the slice (only the
  documented evaluation interfaces in colocated suites and tests remain), a
  configuration `PI_*` read in slice runtime code that its `settings.ts` does
  not declare, a configuration read without a declaration, an invalid
  declaration export, and a README table that differs from the declaration.
  It checks literal specifiers through a TypeScript syntax-tree walk, including
  imports, exports, import-equals, require calls, dynamic imports, and import
  type nodes with strings or templates without substitutions. Call arguments
  may wrap the literal in parentheses, type assertions, `as`, `satisfies`,
  non-null assertions, or a single-element array. The check unwraps callees
  and takes the last operand of comma callees. It recognizes named
  `createRequire` imports from `node:module` or `module`, including renamed
  imports, identifiers initialized by those factories, and direct factory
  result calls. Package specifiers and same-slice paths retain the same rules.
  Specifiers obtained from variables, calls, concatenation, template
  substitutions, multi-element arrays, `new URL(...)`, `import.meta.resolve(...)`,
  or `require.resolve(...)` results remain a review boundary; the check does
  not evaluate expressions or trace arbitrary aliases.
  TypeScript syntactic diagnostics fail the check. The source walk rejects
  symbolic links without following them and rejects `.js`, `.mjs`, `.cjs`,
  `.cts`, `.jsx`, and `.tsx` files under `extensions/`. It skips hidden and
  `node_modules` directories, but rejects encountered symlinks before those
  skips, including hidden symlink entries.
  It imports each `settings.ts` and validates the `settings` export: slice name
  equal to the directory, valid keys, types, bounds, and choices, explicit and
  unique `PI_*` names, at most one of `default` and `defaultText`, secrets
  as strings without defaults, an `apply` value on every field, and each `env`
  equal to its `PI_<SLICE>_<KEY>` name. It does not reject reader or publisher
  bodies in the module. It imports
  each module, so it cannot prove that an import performs no work; review
  enforces that rule. Context inputs `PI_AGENT_DIR`, `PI_AGENT_SESSIONS_DIR`,
  `PI_MANAGED_INSTALL_ROOT`, `PI_CODING_AGENT_DIR` (Pi's own agent-directory
  override), `PI_SESSION_ID`, `PI_HARNESS_FILE`, `PI_CODEMODE_MAX_WORKERS`,
  `PI_OFFLINE` (Pi's own offline mode), `PI_PROGRAM_STATUS` (Pi's own
  terminal status reports), and `PI_*_TEST_*` are not settings.
- `scripts/settings-contract.test.mts`, part of `npm test`, discovers every
  `extensions/*/settings.ts` and runs its `readSettings` and `publishSettings`
  against the cases of this contract with temporary agent directories and a
  fake synchronous bus: defaults, document values, environment precedence,
  invalid input, rejection outside declared bounds and acceptance at each
  inclusive bound in each applicable source, absolute paths, unknown keys and
  their diagnostic limit, invalid-key placeholders, Unicode-safe unknown-key
  truncation with intact publication records and diagnostics, secrets,
  malformed and missing documents, a
  section that is not an object, relative and absolute `PI_HARNESS_FILE`, the
  publication handshake with its declaration, a publisher that follows a
  changed `process.env` `PI_HARNESS_FILE` at its next request, and unsubscribe.
- Slice-local tests cover slice-specific semantics: session flags, semantic
  checks, derived defaults with an overridden dependency, cross-field
  publication checks, and structured validators. No slice test imports another
  slice or asserts its private behavior.

## Operator-controlled application state

Policy definitions, proposals, approvals, and named tables/schemas are
application state in policy's private event log. The explicit policy surfaces
manage that state. Rules refer to approved binding names, not arbitrary files.
The machine document neither contains that state nor creates ambient file
discovery.
