# Extension configuration contract

This package-level contract gives the operator one machine document for harness
configuration, per-field `PI_*` environment overrides, and one inspection view,
while every extension stays an independent slice. It defines file, data, and
event shapes, not shared code. Each participating slice implements its own side
in its own files. Do not create a shared runtime module, import another slice,
or copy another slice's implementation as a dependency.

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
  reads, validates, or writes another slice's section.
- No project discovery, includes, watchers, writes, live reload, migration, or
  reader for any retired document.
- A missing document is normal: source status `missing`, no diagnostic.
- An empty or invalid `PI_HARNESS_FILE`, a nonregular or oversized source, an
  unreadable file, invalid UTF-8, a byte-order mark, malformed JSON, or an
  envelope without `version: 1` produces one `document` diagnostic. Environment
  and default values stay usable. Read with a nonblocking open so a nonregular
  path cannot block the reader.
- A section that is present but not an object produces one `invalid` diagnostic
  for the section; its fields use environment and default values.

## Settings and resolution

Each setting has a lower-camelCase key, a `PI_*` environment name, a type, a
description, and an optional default. The environment name is
`PI_<SLICE>_<KEY>` in upper snake case unless the slice declares an existing
name explicitly. Types are `string`, `path`, `integer`, `number`, `boolean`,
`enum`, and `json`.

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

Diagnostics have `field` (`<slice>.<key>`, `<slice>.<unknown key>` truncated
to 64 characters, `document`, `PI_HARNESS_FILE`, `<slice>` for a section that
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
  version: 1;
  slice: string;
  source: Source;
  records: SettingRecord[]; // declaration order
  diagnostics: Diagnostic[];
};
```

The local snapshot adds the slice's typed `values`, which may hold an accepted
secret. `values` never leaves the slice.

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
    },
    mode: {
      type: "enum",
      env: "PI_POLICY_MODE",
      choices: ["observe", "notice", "annotate", "enforce"],
      default: "observe",
      description: "Configured machine mode; an ordinary --policy-mode flag overrides it for that session.",
    },
  },
} as const;
export function readSettings(options: { agentDir: string; env?: Readonly<Record<string, string | undefined>> }): Snapshot;
export function publishSettings(bus: SettingsBus, options: { agentDir: string; env?: Readonly<Record<string, string | undefined>> }): () => void;
```

Field entries carry `type`, `env` (always explicit), `description`, and
optionally `default` (a static JSON value the reader uses), `defaultText`
(README text for a default the slice derives at run time), `secret`,
`absolute`, `min`, `max`, `minLength`, `maxLength`, and `choices`. A field has
at most one of `default` and `defaultText`. New environment names follow
`PI_<SLICE>_<KEY>` in upper snake case. Without injected `env`, a read uses the
current `process.env`. A slice publishes its own cross-field checks inside its
`publishSettings`; the function takes no validation callback.

## Inspection events

`harness:settings:publish` carries `SettingsPublication`.
`harness:settings:request` carries `{ version: 1 }`. These are process-local
payloads on `pi.events`. Only version `1` exists.

Publisher lifecycle, at factory setup (ordinary) or native host creation:

1. Subscribe to `harness:settings:request`.
2. On a request with `version === 1`, read fresh and emit the publication.
3. Emit one publication during setup as well.
4. Return the unsubscribe function; call it on `session_shutdown` or host close.

A publication is a configuration snapshot, not proof that a running runtime
applied a value. It carries no execution capability, secret value, or local
`values`. A slice has one publisher; a reload recreates it. A publication holds
at most 128 records and 385 diagnostics and serializes to at most 262144
bytes.

The registry consumer creates a fresh collection per query: it subscribes to
`harness:settings:publish`, then emits a request. It validates each envelope and
record defensively, ignores malformed publications and counts them, rejects any
secret record that carries a value, applies the publication bounds above and
keeps at most 64 slices (counting further new slices as omitted), copies only
the fields above, and replaces each slice's previous publication. Coverage is
the set of responding publishers, never an inventory of absent ones.

## README table

Each declaring slice's README holds its configuration table between
`<!-- harness:settings:start -->` and `<!-- harness:settings:end -->`. The
repository check generates the rows from the plain declaration:

| Key | Environment | Type | Default | Constraints | Description |
|---|---|---|---|---|---|

Default text is `env-only` for a secret, `defaultText` when present, the JSON
form of `default` when present, and `unset` otherwise. Constraints list `min`,
`max`, `minLength`, `maxLength`, `absolute input`, and the choices, or `none`.
Do not hand-edit the rows.

## Verification

- `npm run check` fails a slice import that escapes the slice (only the
  documented evaluation interfaces in colocated suites and tests remain), a
  configuration `PI_*` read in slice runtime code that its `settings.ts` does
  not declare, a configuration read without a declaration, an invalid
  declaration export, and a README table that differs from the declaration.
  It imports each `settings.ts` and validates the `settings` export: slice name
  equal to the directory, valid keys, types, bounds, and choices, explicit and
  unique `PI_*` names, at most one of `default` and `defaultText`, and secrets
  as strings without defaults. It does not reject reader or publisher bodies in
  the module. Context inputs `PI_AGENT_DIR`, `PI_AGENT_SESSIONS_DIR`,
  `PI_MANAGED_INSTALL_ROOT`, `PI_SESSION_ID`, `PI_HARNESS_FILE`, and
  `PI_*_TEST_*` are not settings.
- A repository conformance test runs every declaring slice's `readSettings` and
  `publishSettings` against the cases of this contract: defaults, document
  values, environment precedence, invalid input, unknown keys, secrets,
  malformed and missing documents, and the publication handshake.
- Slice-local tests cover slice-specific semantics, such as session flags,
  cross-field checks, and structured validators. No slice test imports another
  slice or asserts its private behavior.

## Operator-controlled application state

Policy definitions, proposals, approvals, and named tables/schemas are
application state in policy's private event log. The explicit policy surfaces
manage that state. Rules refer to approved binding names, not arbitrary files.
The machine document neither contains that state nor creates ambient file
discovery.
