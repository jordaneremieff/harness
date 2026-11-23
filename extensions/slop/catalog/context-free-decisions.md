---
id: context-free-decisions
title: Decisions without the context to make them
domain: prose
applies: ["reply", "document"]
prompt: false
---

# Decisions without the context to make them

## Recognition

The text asks the reader to choose, or offers a menu of options, built on facts that only the writer has seen. A variant tells the reader to go and read a file or a log instead of showing the part that the decision needs. The options carry internal names, and nothing says what each one changes for the reader.

## Cost

The reader cannot decide. They have to ask what the options mean, or open the sources and redo the writer's work. A choice made without the facts is a guess that the writer then treats as approval.

## Repair

Show the facts the decision needs in the message itself, recommend one option when the evidence supports it, and say what each option changes in plain words. Offer a menu only for a real tradeoff that the reader must decide.

## Examples

Slop:

```reply
Two paths: A keeps the dual reader, B goes strict. See the notes file for details. Which do you want?
```

Better:

```reply
Old settings files still use the previous key name. I recommend reading only the new name and renaming the key in your two settings files, which I can do now. The other choice keeps code that reads both names, and nothing else uses it.
```
