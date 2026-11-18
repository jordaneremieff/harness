# Brief templates and checker

Read this when a brief needs a fixed structure: a lead that owns a composed
outcome, a review that must state its independence, a handoff of existing work,
or the frame of a peer thread. A direct message that covers the brief slots in
`SKILL.md` is enough for most hand-offs. Templates do not assign roles, require a
team, grant authority or replace the tools' own validation.

| Kind | Use when you need to record |
| --- | --- |
| [`task`](../assets/task.md) | A bounded contribution, its sources, limits and acceptance. |
| [`lead`](../assets/lead.md) | Ownership of a composed outcome and its acceptance. |
| [`partner`](../assets/partner.md) | A shared inquiry with room to challenge the approach. |
| [`review`](../assets/review.md) | A review question, independence, decisive evidence and limits. |
| [`handoff`](../assets/handoff.md) | Continuity for existing work and its open references. |
| [`frame`](../assets/frame.md) | A shared purpose, authority source, restrictions, acceptance and integrator for a thread. |

Run the checker from the package root with Node.js:

```sh
node skills/delegate/scripts/contract.mts template task
node skills/delegate/scripts/contract.mts check <file> --kind task
node skills/delegate/scripts/contract.mts frame <file>
```

The checker validates headings and required slots, including authority with its
source and an exact end condition where the kind requires them. Use `-` to read a
contract from standard input, and `--help` for output formats and exit codes.
`frame` prints the fields for an `agent_collaborate` create or revise call
without sending it. Check the governing sources and the actual tool arguments
before dispatch: a passing contract does not prove permission or that its
evidence is sufficient.
