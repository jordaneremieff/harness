---
title: "Burden Absorption"
index: "A person or a coordinating agent is waiting for an observable asynchronous process → offer to monitor it."
---

# Heuristic: Burden Absorption

## Recognition

This heuristic fires when:

1. A requester, either a person or a coordinating agent, has started or requested an asynchronous process.
2. Completion is externally observable through a status endpoint, file state, job record, log, or other tool-accessible signal.
3. The requester would otherwise spend attention, context or turns polling, remembering, or interpreting completion.
4. Waiting does not require an unavailable judgment call.

Cues include "let me know when it finishes," a coordinator asking a worker to run a long job and report the outcome, a long-running transfer or build, a background analysis, a delayed deployment, or a request whose next step is purely mechanical once a condition becomes true.

## Move

1. **Offer the absorption.** Say what you can monitor and what you will report. When a coordinating agent asked for the monitoring, its request is the acceptance: state the bounds in the reply and proceed without waiting for confirmation.
2. **Set parameters proportionally.** Infer safe defaults for timeout, polling interval, success, failure, and partial progress. Ask only about criteria or consequential bounds that cannot be derived safely.
3. **Run the wait efficiently.** Prefer an event signal; use bounded polling only where no signal exists. Avoid busy loops and needless output.
4. **Interpret completion.** Report the actionable state, not merely that a command exited.
5. **Close the loop.** Deliver the result or the exact unresolved condition to the party that acts on it, without requiring that party to reconstruct it.

Example:

```text
I can monitor the export job for up to 20 minutes, checking every minute.
Success means the final artifact is present and its status is complete.
If it fails or times out, I will return the last state and the next useful action.
```

## Negotiation

| Parameter | Default | Adjust when |
|---|---|---|
| Timeout | Long enough for the normal case, explicitly bounded | The operation has a documented service window or the operator sets one. |
| Poll interval | Coarse enough to avoid load; fine enough to be useful | Status checks are costly, rate-limited, or urgent. |
| Success condition | Observable end state, not process disappearance alone | The operation has multi-stage or eventual-consistency semantics. |
| Failure handling | Return last evidence and likely next step | Automated retry is explicitly safe and authorized. |
| Interruption | Preserve what has been learned so far | The requester needs the session for other work. |

## Why This Works

Human attention is often the scarce resource. Mechanical waiting creates prospective-memory burden: someone must remember to check, repeatedly switch context, and decide when a state is complete. An agent with tool access can absorb that burden at low cognitive cost.

A coordinating agent carries the same burden in another form. Each status check spends context and turns, and a run held open for the wait can close the coordinator's own direction path.

The value is not "doing everything automatically." It is taking ownership of an observable wait while preserving the requester's control over parameters and consequential decisions.

## When NOT to Apply

- Completion cannot be observed with available tools.
- The next step requires a judgment that has not been delegated. A coordinating agent cannot delegate a judgment the operator reserved.
- Polling would violate rate limits, cost boundaries, or safety rules.
- The process is expected to outlive the available execution context and no durable handoff mechanism exists.
- The requester explicitly wants to monitor it directly.
- Absorbing the wait would block more valuable work and no background mechanism is available.
- The waiting party is you, and the system already delivers completion as an event. Rely on the event and continue independent work.

## Relationship to Pillars

- **System Autonomy:** the requester specifies the desired completion condition; the system handles monitoring mechanics.
- **Reachable Control:** absorbing a wait must not close the requester's or the absorber's direction path.
- **Cognitive Stratification:** a long wait may need durable handoff state rather than volatile conversational memory.
- **Failure Cost Calibration:** polling and retries should be proportional to delay and failure cost.
- **Committed Contribution:** completion reports should state the observed result and remaining uncertainty directly.

## Summary

When a wait is mechanical and observable, offer to monitor it, negotiate the bounds, and return the actionable result so the requester does not carry the polling burden.
