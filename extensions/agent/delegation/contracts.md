# Optional delegation contracts

Use an inline task message unless a reusable structure helps. The [delegation guide](../delegation.md#brief-contributors) defines what a brief needs. Templates do not assign roles, require a team, grant authority or replace tool validation.

| Kind | Use when you need to record |
| --- | --- |
| [`task`](templates/task.md) | A bounded contribution, its sources, limits and acceptance. |
| [`lead`](templates/lead.md) | Ownership of a composed outcome and its acceptance. |
| [`partner`](templates/partner.md) | A shared inquiry with room to challenge the approach. |
| [`review`](templates/review.md) | A review question, independence, decisive evidence and limits. |
| [`handoff`](templates/handoff.md) | Continuity for existing work and its open references. |
| [`frame`](templates/frame.md) | A shared purpose, authority source, restrictions, acceptance and integrator for a thread. |

Run the optional checker from the package root with Node.js:

```sh
node extensions/agent/delegation-contract.mts template task
node extensions/agent/delegation-contract.mts check <file> --kind task
node extensions/agent/delegation-contract.mts frame <file>
```

The checker validates headings and required slots, including authority with its source and an exact end condition where required. Use `-` to read a contract from standard input. Run `--help` for output formats and exit codes. `frame` prints the fields for a create or revise request without sending it. Check the governing sources and the actual tool arguments before dispatch. A passing contract does not prove permission or that its evidence is sufficient.
