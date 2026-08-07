# Heuristic: Phantom Stewardship

## Recognition

This heuristic fires when:

1. You encounter pre-existing dirty state in a shared mutable substrate: uncommitted files, partial documentation, an unfinished migration, or an unowned draft.
2. You did not author the changes and feel a pull to leave them untouched out of respect for an assumed steward.
3. The presumed author may no longer be reachable with their original context and intent.
4. Repeated deferral would leave the substrate progressively harder to interpret.

The tell is simple: if asked who will return to own this state and how they can be reached, the answer is only an expired execution context, anonymous process, or historical trace.

## Move

1. **Verify absence.** Check the coordination signals actually available: active processes, locks, recent writes, open operations, durable handovers, or operator knowledge. A stale modification time is evidence of inactivity, not proof of absence. A process-name search that finds nothing is also not proof unless that mechanism is known to represent all live authors.
2. **Read lineage from the substrate.** Inspect the diff, file history, adjacent artifacts, tests, and durable notes. Infer intent only as far as the evidence supports.
3. **Classify the state.** Distinguish a coherent end state from a transient mid-operation snapshot.
4. **Reconcile within authority.** If coherent and in scope, validate and land it. If it is unrelated but safe, preserve it without claiming authorship. If authorization is missing, leave a precise handoff rather than an indefinite warning.
5. **Attribute honestly.** Record what was pre-existing, what you changed, and what you verified. Do not invent an author or imply that you produced work you merely reconciled.
6. **Make the substrate self-describing.** Leave the next worker a clean state or a durable explanation of the remaining operation.

## Classification Checks

### Evidence of a Coherent End State

- Changes form one understandable objective.
- No conflict markers, locks, or incomplete generated artifacts remain.
- Validation can run against the state as written.
- The diff does not expose secrets or transient credentials.
- Adjacent history and documentation support the inferred intent.

### Evidence of a Mid-Operation Snapshot

- A merge, rebase, migration, generation, encryption, or deployment operation is visibly incomplete.
- Temporary plaintext, lock files, conflict markers, or half-written state is present.
- The next safe step depends on intent that cannot be reconstructed.
- Landing the state would corrupt history or publish sensitive material.

Do not "clean up" a mid-operation snapshot by guessing. Secure hazardous material, preserve evidence, and escalate with a concrete account.

## Negotiation

| Condition | Response |
|---|---|
| A live author is confirmed | Coordinate or defer. The stewardship is real. |
| Return continuity is durable and imminent | Preserve the state and leave a concise note. |
| The state is coherent, validated, and within scope | Reconcile and land it with honest attribution. |
| The state is coherent but unrelated | Avoid opportunistic changes; preserve or separate it according to repository policy. |
| The state is hazardous | Secure first. Do not commit secrets, transient credentials, or corrupt intermediate state. |
| Intent cannot be reconstructed | Escalate with the evidence inspected and the exact ambiguity. |
| Repository policy forbids touching others' changes | Follow policy and create a durable handoff; this heuristic grants no permission override. |

## Why This Works

Human collaboration norms assume authors persist: they return with memory and can be asked. Ephemeral execution contexts do not always satisfy that premise. Applying the norm without checking can convert respect into abandonment, leaving every later worker less able to identify ownership or intent.

The load-bearing move is verification. The heuristic does not say that every absent-looking author is gone, or that every dirty tree should be committed. It says to test return continuity, then use substrate evidence and explicit authority to choose between coordination, reconciliation, preservation, and escalation.

## When NOT to Apply

- Another author is live or has a reliable return path.
- The state is part of an active coordinated operation.
- Repository policy or operator direction requires deferral.
- The changes are outside your authority or cannot be validated.
- Sensitive or transient material is present and safe remediation is unclear.

## Relationship to Pillars

- **Coordination Phantom:** both test whether a collaboration convention's human precondition holds.
- **Governing Context:** durable handovers preserve the frame needed to evaluate unfinished work.
- **Survival Selection:** substrate lineage shows what has endured beyond one author's context.
- **Committed Contribution:** honest attribution and explicit uncertainty replace vague deference.
- **Investigation Persistence:** available evidence should be inspected before escalating ownership ambiguity.

## Summary

When shared state appears orphaned, verify whether a steward is actually reachable, reconstruct only what the substrate supports, distinguish coherent state from hazardous mid-operation state, and reconcile or hand off with honest attribution.
