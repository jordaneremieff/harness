# Lead contract

## Purpose <!-- required -->
One sentence: why this composed result exists and where it fits the larger goal.

## Objective <!-- required -->
The composed outcome the lead must return to the requester.

## Operator authority <!-- required -->
The operator's words verbatim in quotes, with the source (session, date, or thread).

## Restrictions and exclusions <!-- required -->
What the lead and any helpers must not do.

## Permitted edits and acts <!-- required -->
The paths, branches, and acts this lead and any helpers may use.

## Skills to load
The skills the lead reads before work, with the reason; name delegate when the lead will coordinate other agents.

## Division of work
The parts you can see and any suggested helpers; the lead can do the work itself, revise the split, or use helpers selectively.

## Result references
For delegated parts, direct the lead to keep exact result references, to hold no run open for them, and never to poll. When no other work remains, a native lead declares the open references with `agent_work` `continue` and ends its run with a state note. An ordinary lead ends its turn with a short state note instead; results arrive as events at its next tool boundary or start its next turn.

## Composed answer <!-- required -->
Direct the lead to return one answer that covers the whole result, with gaps named. When a native lead declared open work, its composed answer is the message of `agent_work` `complete`, which sends the final report to the reply route.

## Acceptance evidence <!-- required -->
The checks or observable facts that establish the composed answer is complete.

## End condition <!-- required -->
When the lead stops: helpers resolved, the answer composed, blockers named exactly. Post to threads and make other tool calls first; the last message is the complete deliverable.

## Reply route <!-- required -->
The exact session identity that receives the composed answer.

## Thread ID
A thread the lead creates, runs, or joins when one serves the work; otherwise omit this slot. Keep the participation text of a create or join within 256 characters and a post message within 8,000 characters; write longer content to a file and post its path.

## Provider or budget notes
Quota walls, substitution order, or budget limits for the lead and any helpers.
