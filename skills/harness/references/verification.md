# Verification by claim

Use this reference before reporting completion or when deciding what check to
run next.

## Build a claim ledger

For each consequential claim, record:

- the claim in observable terms;
- the lowest evidence layer that can reach it;
- the check/setup actually run;
- result and relevant output;
- remaining gap and next stronger check for material in-scope claims, if any.

A failing check is evidence about that layer and setup. Keep it visible; do not
collapse distinct failures into a single pass percentage.

## Evidence layers

| Claim | Evidence that can reach it | Common overclaim |
|---|---|---|
| Pure storage/transformation works | Focused unit tests and edge cases | “The harness surface works live” |
| Skill structure is portable | Structural validation plus resolved resource links | “The skill activates correctly” |
| Skill discovery works | Pi discovery from the intended package, global, project, settings, or CLI source | “Valid frontmatter proves Pi loaded it” |
| Skill activation is selective | Repeated realistic positive and near-miss prompts | “The description sounds specific” |
| Skill output improves the task | Comparable task runs plus operator review, unless explicitly waived | “The skill was read, so it helped” |
| Prompt or theme data is valid | Format/schema checks plus Pi discovery or live readback | “The file exists, so Pi accepts it” |
| Registration uses the current public shape | Matching docs/declarations plus compile or controlled load | “It is discoverable when installed” |
| Event ordering or awaiting behaves as assumed | Dispatcher source for the active version plus integration reproduction when consequential | “A mocked callback proves shutdown” |
| Cancellation and cleanup work | Tests with active work, failure, repeat stop, and session shutdown; process-tree observation when applicable | “Calling abort proves work stopped” |
| TUI component logic works | Renderer/component tests | “Terminal focus, resize, and input are proven” |
| Interactive TUI behavior works | Recorded live/PTY interaction at relevant sizes/keys | “A snapshot is a live rendering proof” |
| RPC/headless behavior works | RPC/SDK/non-TTY drive with protocol/output assertions | “No thrown unit test proves useful output” |
| Required files ship | Archive listing | “The installed copy is discovered” |
| Installed discovery works | Isolated unpack/install and Pi discovery with no checkout override | “Manifest text proves loading” |
| Runtime outcome occurred | Direct observation tied to setup and identifiers | “Code, docs, or invocation count proves outcome” |
| Capability is useful | Outcome evidence under known conditions and operator judgment | “Passing tests or use count proves utility” |

## Efficient verification sequence

1. Run or inspect the narrow pre-existing checks that define the current
   boundary.
2. Add focused tests for the changed pure logic and adapters; preserve fixed
   assertions rather than weakening them.
3. Run the affected suite after final source and test edits.
4. Inspect package metadata and archive contents when delivery is in scope.
5. Use isolated Pi discovery, SDK/RPC, shutdown, or PTY checks only for claims
   those layers uniquely establish.
6. Update existing or explicitly required README/operator guidance and
   provenance before optional exploratory checks; do not add governance files
   to repositories that do not require them.
7. Report unperformed live layers explicitly.

Stop escalating when the operator's actual claim is reached. Conversely, do not
substitute many cheap checks for the one runtime layer a claim requires.

## Failure and boundary cases

Exercise the applicable cases: invalid input, empty state, malformed persisted
records, missing resources, duplicate start/stop, partial startup, active
cancellation, timeout, process failure, no UI, RPC transport, narrow terminal,
package relocation, and upgrade from existing state. For asynchronous logic,
use controlled promises and mocked dependencies so tests own resolution,
rejection, cancellation, and late results. Select cases by risk and the
requested capability; this is not a requirement to test every row every time.

For network, credential, filesystem, or subprocess behavior, use synthetic data
and temporary/isolated roots. Bound output and time. Do not use real secrets or
private incidents to make a test realistic.

## Completion report

State:

- checks and exact results;
- source/declaration paths used for version-sensitive claims;
- which claims each result establishes;
- which package, live Pi, RPC, PTY, privacy, or outcome checks were not run;
- the narrowest next check for each material open claim still inside the
  working contract.

Use “tests pass,” “archive contains,” “controlled run observed,” or “operator
reported” rather than one undifferentiated “verified.”
