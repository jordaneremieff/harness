---
title: "Live Substrate Exposure"
index: "An in-place edit targets a substrate that processes load at launch → change an isolated copy and switch only when old and new versions cannot meet incompatibly."
---

# Heuristic: Live Substrate Exposure

## Recognition

This heuristic fires before an in-place change to a substrate that processes load when they start or reload, while such processes run or can start during the change.

A live substrate is code, configuration, a schema, or a shared script that consumers load from its current location. A consumer that starts mid-change loads whatever the substrate holds at that moment. A consumer that keeps what it loaded stays on the old version until it restarts.

Cues:

- The edit target is the location that running systems load at start: an active checkout, a deployed configuration, a shared library path.
- Processes start on their own schedule: idle hosts relaunch, workers start per task, services reload on change, or other people start sessions.
- The change spans several files or several saves, so intermediate states exist.
- The change alters a contract between parts that load at different times, such as a message format or a version number.
- The editor sees no failure, because the broken load happens in another process.

No other active effort is required. The editor's own next process start is also a consumer.

## Move

1. **Map the load relationship.** Name who loads the substrate, when, and whether they keep what they loaded.
2. **Change an isolated copy.** Use a separate checkout, branch, staging directory, or configuration file that no live consumer loads. If a test starts the new version against state that live consumers also use, give the test its own copy of that state.
3. **Make the transition safe before the switch.** Consumers that keep the old version will meet parts that load the new one. Before the switch, establish one of these:
   - The new version stays compatible with consumers of the old version, and a check against an old consumer confirms it.
   - Each consumer of the old version stops at a point its owner agrees to, without loss of work, and restarts only after the switch.
   - Consumers of the old version keep reaching the old version until they finish, and only new starts reach the new version.

   If none of these holds, do not switch. A version check that refuses a mismatched pair prevents harm but stops work. It is a backstop, not a safe transition.
4. **Replace the live version in one step.** Switch only after the copy passes its checks. Keep the last good version available.
5. **If consumers already loaded a bad state, restore first.** Return the live substrate to its last good version, then continue the work in the copy. Do not continue in place to reach a good state faster.

## Negotiation

| Condition | Response |
|---|---|
| No consumer runs or can start during the change | Edit in place. |
| The change is one atomic write of a complete, checked file and keeps the contract | An in-place change is enough. |
| The substrate reloads on each save | Treat each save as a release; work in a copy, or apply the change as one atomic write. |
| Urgent containment of a live fault | Make the smallest change in place, then move the follow-up work to a copy. |

## Why This Works

In-place editing assumes the editor is the only reader between saves. Load-time consumers break that assumption. Each start during the edit window loads an intermediate state, and consumers that keep what they loaded diverge from the ones that start later. The failure appears in another process, often in another effort, so the editor gets no signal.

Isolation replaces many unplanned intermediate states with one planned switch. Deciding before that switch how old and new versions meet keeps version skew away from running consumers. A refusal between mismatched versions only reports the skew after it reaches them.

## When NOT to Apply

- No process loads the target while the change is in progress, and none can start.
- An existing deployment mechanism already isolates the change and switches it in one step.
- The work only reads the live substrate, for example to diagnose it.
- The operator directs an in-place change and accepts its exposure.

## Relationship to Pillars

- **[Concurrent Work Discovery](heuristic-concurrent-work-discovery.md):** fires when other activity on a shared substrate is unknown, and resolves it through discovery and coordination. That discovery finds the owners whose consumers a transition affects. It treats existing isolation as a reason not to apply and does not say how to change a substrate that processes load. This heuristic decides that, including when no other effort is active.
- **[Failure Cost Calibration](heuristic-failure-cost-calibration.md):** protects the editor's own state against loss; this heuristic protects the consumers of the edited substrate.
- **[Phantom Stewardship](heuristic-phantom-stewardship.md):** a half-edited live substrate becomes mid-operation state for the next worker who meets it.
- **[Harness Over Architecture](heuristic-harness-over-architecture.md):** isolate at the lowest sufficient layer, such as a second checkout, before building deployment infrastructure.

## Summary

Before changing a substrate that processes load at launch, change an isolated copy. Switch it in one checked step, and only after consumers of the old version are confirmed compatible, stopped at an agreed point, or kept on the old version until they finish.
