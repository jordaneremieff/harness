# Harness settings

`settings/index.ts` is the package-level configuration contract. It uses Node
builtins, performs no work at import time, and owns no Pi runtime or extension
state. Extensions import only this entrypoint, never settings internals or
another extension's declaration.

## Declare and read

An extension keeps a passive `extensions/<slice>/settings.ts` module with a named
`settings` export. It declares each field once with `defineSettings`. That module
and its pure validators must not import an extension entrypoint, register tools,
read configuration, or start runtime work. The checker imports this module, not
`index.ts`. Runtime entrypoints and helpers import that declaration and call
`readSettings` with the host's absolute `agentDir` and optional injected `env`.

```ts
import { join } from "node:path";
import {
  defineSettings, derivedDefault, numberSetting, pathSetting,
} from "../../settings/index.ts";

const dir = pathSetting({
  description: "Store directory.",
  default: derivedDefault("<agentDir>/store", [], ({ agentDir }) => join(agentDir, "store")),
});
export const settings = defineSettings("example", {
  dir,
  checkpointDir: pathSetting({
    description: "Checkpoint directory.",
    default: derivedDefault("<dir>/checkpoints", [dir], ({ get }) => join(get(dir), "checkpoints")),
  }),
  checkInMinutes: numberSetting({ description: "Check-in interval.", default: 0.5, min: 0 }),
});
```

In a runtime module:

```ts
import { readSettings } from "../../settings/index.ts";
import { settings } from "./settings.ts";
const snapshot = readSettings(settings, { agentDir: host.agentDir });
const interval: number = snapshot.values.checkInMinutes;
```

Helpers are `stringSetting`, `pathSetting`, `integerSetting`, `numberSetting`,
`booleanSetting`, `enumSetting(choices, options)`, and
`jsonSetting<T>(typeGuard)(options)`. Scalars infer their types without casts;
enums retain the choice union. A field without a default returns `T | undefined`.
JSON settings accept structured data through an extension-owned pure type guard.
Shared validation checks JSON safety first; extension validators own structure and
semantics, including model catalog checks outside this reader.

Options include `description`, `default`, `env`, `secret`, and optional pure
`validate(value)` for semantic scalar checks. Text options include `minLength` and
`maxLength`; numeric options include inclusive `min` and `max`. Integers are safe
integers, numbers are finite, and text rejects control/format characters and
unpaired surrogates. Text defaults to a maximum length of 4096. Path and secret
inputs default to a minimum length of one. `pathSetting({ absolute: true, ... })`
requires an absolute input; otherwise relative inputs resolve against `agentDir`.
Unset optional paths stay unset. Cross-field runtime invariants belong to their
owning extension, not a shared schema framework.

The default environment name is `PI_<SLICE>_<KEY>` in upper snake case. Use an
explicit `env` for an existing name that differs. `derivedDefault` is the single
runtime derivation mechanism. Its description is portable README text; its
resolver receives `agentDir` and typed `get(setting)` access to declared
nonsecret dependencies. Dependencies resolve from effective values regardless of
field order. Each setting reference identifies one field. Missing dependencies,
cycles, failed derivations, or invalid safe
defaults are declaration errors and throw without exception text from validators.

## Document and precedence

One optional strict UTF-8 JSON document has this shape:

```json
{
  "version": 1,
  "example": { "checkInMinutes": 0.25 }
}
```

The default is `<agentDir>/harness.json`. `PI_HARNESS_FILE` overrides its location;
absolute overrides are used directly, and relative overrides resolve against
`agentDir`. Neither document paths nor setting paths expand `~` or environment
variables. `agentDir` must be host-supplied and absolute. No cwd/project discovery,
includes, watchers, writes, aliases, migration, or other-document readers exist.
An invalid `PI_HARNESS_FILE` rejects that source, records an environment diagnostic,
and leaves environment/default settings usable without reading the default file.

Each field selects **present environment > document field > default**. Presence
includes an empty string. Invalid selected input returns the safe default, never
an underlying file value. Environment booleans accept `0`, `1`, `false`, and
`true`; document booleans require JSON booleans. Numeric environment values use
JSON number syntax, not hexadecimal or blank coercion. JSON environment overrides
contain a JSON value and use the same validator as the file field.

The reader bounds the actual read to `DOCUMENT_MAX_BYTES + 1`, rejects excess
bytes and nonregular sources with a nonblocking open, and closes its descriptor.
Invalid UTF-8, BOMs, malformed JSON, and unsupported versions produce a document
diagnostic plus usable environment/default values. A malformed owned section
produces a section diagnostic. Unknown keys in that section produce field
diagnostics; independently loaded slices do not validate other sections.
Structured input has bounded byte size, nesting, and visited nodes. Diagnostic
volume is bounded with an explicit coverage diagnostic.

`snapshot.values` contains local typed effective values. Public `records` contain
name, type, description, environment name, effective value, origin, and status.
Origins describe returned values; diagnostics name rejected sources. Status is
`valid`, `unset`, or `invalid`. An invalid optional field differs from an unset
one even if both return `undefined`. Document failures remain separate diagnostics.
`source` supplies the resolved path, observation time, document status, and SHA-256
digest of fully read bounded content where available. Oversized/nonregular/missing
sources have no digest. This is read/admission evidence, not runtime application
evidence. An extension needs no second document reader for its receipts.

Secrets are optional strings with no default and are environment-only. A document
secret produces a diagnostic even when environment input wins. `values` is local
and contains an accepted secret; never serialize it. Public records show only
`secretState: "set" | "unset"`, never bytes. Diagnostics use fixed messages, not
raw input, JSON parser messages, or validator exception text. Generated README
rows display `env-only`, never secret values.

## Publication and collection

The structural `SettingsBus` matches public `pi.events` without importing Pi.
`publishSettings(bus, settings, options)` subscribes before its initial publication
and returns an unsubscribe function. Call that cleanup when the owner ends.

`PublishOptions<F>` adds an optional pure `validate(snapshot)` callback to the
reader options. It returns an array of affected declared field keys for owning
cross-field constraints. The callback receives a copy of the typed snapshot on
each publication. Shared code preserves values and origins, marks those records
`invalid`, and adds fixed `relation` diagnostics. It accepts no custom messages or
replacement values. Owning runtime validation still decides admission and throws
its domain error where appropriate.

- `harness:settings:publish`: `SettingsPublication`, version 1, with slice,
  source, redacted records, and all bounded diagnostics.
- `harness:settings:request`: `{ version: 1 }`.

Requests trigger a fresh synchronous `readSettings`; they do not reload the owning
extension's runtime. An environment object supplied by the caller remains that
object. Without injection, each read uses current `process.env`. Publications are
configuration snapshots, **not proof that a running runtime applied new values**.

`collectSettings(bus)` subscribes before its initial request. Both ordinary load
orders work without a timer. It returns `snapshots()` for copied checked
publications, `refresh()` to clear stale collection and request new snapshots, and
idempotent `dispose()` to unsubscribe and clear retained data. A fresh collector
or refresh reports only responding publishers, not an inventory of absent ones.
`coverage()` returns `status`, accepted `slices`, `malformed` publication count,
and `omitted` publication count. Counters reset on refresh and saturate at the
safe integer limit. `available` means request emission succeeded, not that every
expected publisher responded. `unavailable` means emission threw; refresh still
throws to its caller. `disposed` means the collector ended. Coverage contains no
rejected bytes, untrusted sender messages, or inferred absent-slice inventory.
Over-limit new slices count as omitted; existing accepted slices still update.

Latest valid publication replaces a slice snapshot. A slice has one publisher;
duplicate owners violate the contract. Reload recreates owners and repeats the
handshake. No removed publisher is retained after refresh.

`settingsPublication(snapshot)` selects public fields and strips local values,
secret values, exception text, and extra capabilities. `parseSettingsPublication`
checks and copies public envelopes defensively; it rejects malformed, oversized,
or secret-bearing records. It copies no execution functions. Bounds are exported
as `PUBLICATION_MAX_BYTES`, `SETTINGS_MAX_FIELDS`, and `SETTINGS_MAX_SLICES`.
Publishers and collectors each own a fixed subscription, with no global registry,
interval, or process-wide cache. Published nonsecret JSON is visible configuration;
do not declare secret data inside a nonsecret structured field.

## README projection and repository gate

`settingsReadme(settings)` generates a stable configuration table between
`<!-- harness:settings:start -->` and `<!-- harness:settings:end -->` markers.
Paste that projection into the owning README; do not hand-edit its rows.
`checkSettingsReadme` compares the marked projection byte-for-byte and rejects
missing or duplicate markers. Descriptions/default descriptions are declaration
metadata, not machine-derived values.

`npm run check` mechanically discovers passive `settings.ts` declarations,
compares their README projections, requires a `readSettings` consumer, and rejects
direct configuration environment reads in declared slices. Its lexical check
covers `process.env.PI_*`, injected `env.PI_*`, literal bracket access, and ordinary
parenthesized environment selection. It does not claim AST alias/dataflow analysis.
Context variables `PI_AGENT_DIR`, `PI_AGENT_SESSIONS_DIR`,
`PI_MANAGED_INSTALL_ROOT`, `PI_SESSION_ID`, and `PI_*_TEST_*` are excluded.
Tests, evaluation suites, explicit `fixtures/` or `test-fixtures/` directories,
and `*-fixture.ts`/`*-fixture.mts` support modules are excluded from configuration
read checks, not from slice isolation. Undeclared consumers currently retain
owning README environment-name checks; declaration adoption is not complete.

See [extension configuration](../docs/conventions/extension-config.md) for the
configuration ownership boundary and [tool display](../docs/conventions/tool-display.md)
for the independent display-only bus contract.

Run `node --test settings/*.test.mts scripts/check-slices.test.mts` for focused
behavior and gate tests. The ordinary full suite also includes settings tests.
