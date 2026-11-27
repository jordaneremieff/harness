# Worked example: one program split two ways

This example applies the method to the program in D. L. Parnas, "On the
Criteria To Be Used in Decomposing Systems into Modules" (Communications of
the ACM, December 1972). The paper describes one small program and two ways
to split it into modules. Both grid files below are in plan mode, because
their evidence is the paper's text and not code.

## Contents

- [The program](#the-program)
- [First split: one part for each step of the processing](#first-split-one-part-for-each-step-of-the-processing)
- [Second split: one part for each decision to hide](#second-split-one-part-for-each-decision-to-hide)
- [What the two grids show](#what-the-two-grids-show)

## The program

The program makes a KWIC index. It accepts an ordered set of lines. It forms
every circular shift of every line, which means that it moves the first word
to the end, again and again. It prints all the shifts in alphabetical order.

Five requirements follow from that statement. They name no module, so both
splits are judged against the same rows. In so small a program they still
resemble the steps of the processing, which is why the first split looks
natural.

| Id | Requirement |
|---|---|
| R1 | Accept an ordered set of lines of words |
| R2 | List every circular shift of every line |
| R3 | List the shifts in alphabetical order |
| R4 | Print the listing |
| R5 | Turn the input into the listing in one run |

The paper lists five design decisions that are likely to change, and adds a
sixth in hindsight. They are the rows of both change grids.

| Id | Likely change |
|---|---|
| C1 | The input format changes |
| C2 | The lines are no longer all held in core |
| C3 | Characters are no longer packed four to a word |
| C4 | The shifts are stored as such or computed on demand, not indexed |
| C5 | The shifts are sorted on demand or in part, not once |
| C6 | The shifts are produced in alphabetical order, so no separate sort runs |

## First split: one part for each step of the processing

Input reads the lines and stores them in core. Circular Shift builds an index
of the shifts over that store. Alphabetizing sorts the index. Output prints
from the sorted index and the store. Master Control starts the four in turn.

Apart from Master Control, no part calls another. Each part works on the
arrays that earlier steps left in core. The coupling therefore does not show
in the calls. It sits in three decisions that the parts know and no part
owns, and the grid file records them under `decisions`.

```json
{
  "subject": "KWIC index (Parnas 1972), modularization 1: one part for each processing step",
  "mode": "plan",
  "parts": [
    { "id": "input", "name": "Input", "hides": "the format of the input" },
    { "id": "circular-shift", "name": "Circular Shift", "hides": null },
    { "id": "alphabetizing", "name": "Alphabetizing", "hides": "which sorting method is used" },
    { "id": "output", "name": "Output", "hides": "the layout of the printed listing" },
    {
      "id": "master-control",
      "name": "Master Control",
      "hides": "the order in which the steps run"
    }
  ],
  "decisions": [
    {
      "id": "line-format",
      "name": "How the lines are held in core",
      "knownBy": {
        "input": "Module 1 stores the lines in core, four characters to a word, with an index of line starts",
        "circular-shift": "Module 2 builds its index from addresses in the array made by module 1",
        "alphabetizing": "Module 3 takes the arrays produced by modules 1 and 2 as input",
        "output": "Module 4 uses the arrays produced by module 3 and module 1",
        "master-control": "Changeability: the second change results in changes in every module; module 5 may handle space allocation"
      }
    },
    {
      "id": "shift-index",
      "name": "How the circular shifts are recorded",
      "knownBy": {
        "circular-shift": "Module 2 leaves pairs of original line number and starting address in core",
        "alphabetizing": "Module 3 reads the array of module 2 and produces one in the same format",
        "output": "Module 4 reads the array of module 3, which has the format of module 2"
      }
    },
    {
      "id": "sorted-once",
      "name": "That all shifts are sorted once, before output starts",
      "knownBy": {
        "alphabetizing": "Module 3 produces the complete array in alphabetical order",
        "output": "Changeability: the output module expects the index to be complete before it begins"
      }
    }
  ],
  "requirements": [
    {
      "id": "R1",
      "text": "Accept an ordered set of lines of words",
      "source": "Problem statement: the system accepts an ordered set of lines",
      "owners": { "input": "Module 1 reads the data lines from the input medium" },
      "relies": { "line-format": "Module 1 stores what it reads in the layout that the other modules read" }
    },
    {
      "id": "R2",
      "text": "List every circular shift of every line",
      "source": "Problem statement: any line may be circularly shifted",
      "owners": { "circular-shift": "Module 2 prepares an index of every circular shift" },
      "relies": {
        "line-format": "Module 2 reads the array made by module 1",
        "shift-index": "Module 2 writes the index that modules 3 and 4 read"
      }
    },
    {
      "id": "R3",
      "text": "List the shifts in alphabetical order",
      "source": "Problem statement: the listing is in alphabetical order",
      "owners": { "alphabetizing": "Module 3 lists the circular shifts alphabetically" },
      "relies": {
        "line-format": "Module 3 compares characters in the array made by module 1",
        "shift-index": "Module 3 reads and writes arrays in the format of module 2",
        "sorted-once": "Module 3 finishes the whole ordering before module 4 starts"
      }
    },
    {
      "id": "R4",
      "text": "Print the listing",
      "source": "Problem statement: the system outputs a listing of all circular shifts",
      "owners": { "output": "Module 4 produces a formatted listing of all the circular shifts" },
      "relies": {
        "line-format": "Module 4 reads characters from the array made by module 1",
        "shift-index": "Module 4 reads the array of module 3 in the format of module 2",
        "sorted-once": "Module 4 expects the complete ordered index"
      }
    },
    {
      "id": "R5",
      "text": "Turn the input into the listing in one run",
      "source": "Problem statement: lines go in and the listing comes out",
      "owners": { "master-control": "Module 5 controls the sequencing among the other four modules" },
      "relies": {
        "input": "Module 5 starts module 1",
        "circular-shift": "Module 5 starts module 2 after module 1 completes",
        "alphabetizing": "Module 5 starts module 3",
        "output": "Module 5 starts module 4",
        "line-format": "Module 5 may handle space allocation for the lines in core"
      }
    }
  ],
  "changes": [
    {
      "id": "C1",
      "text": "The input format changes",
      "source": "Changeability, item 1",
      "edits": { "input": "The first change is confined to one module in both decompositions" }
    },
    {
      "id": "C2",
      "text": "The lines are no longer all held in core",
      "source": "Changeability, item 2",
      "edits": {
        "input": "The second change results in changes in every module",
        "circular-shift": "The second change results in changes in every module",
        "alphabetizing": "The second change results in changes in every module",
        "output": "The second change results in changes in every module",
        "master-control": "The second change results in changes in every module"
      }
    },
    {
      "id": "C3",
      "text": "Characters are no longer packed four to a word",
      "source": "Changeability, item 3",
      "edits": {
        "input": "The same is true of the third change: every module",
        "circular-shift": "The same is true of the third change: every module",
        "alphabetizing": "The same is true of the third change: every module",
        "output": "The same is true of the third change: every module",
        "master-control": "The same is true of the third change: every module"
      }
    },
    {
      "id": "C4",
      "text": "The shifts are stored as such or computed on demand, not indexed",
      "source": "Changeability, item 4",
      "edits": {
        "circular-shift": "Module 2 makes the index",
        "alphabetizing": "The alphabetizer will also know of the change",
        "output": "The output routines will also know of the change"
      }
    },
    {
      "id": "C5",
      "text": "The shifts are sorted on demand or in part, not once",
      "source": "Changeability, item 5",
      "edits": {
        "alphabetizing": "Module 3 does the sorting",
        "output": "The output module expects the index to be complete before it begins"
      }
    },
    {
      "id": "C6",
      "text": "The shifts are produced in alphabetical order, so no separate sort runs",
      "source": "Improvement in Circular Shift Module",
      "edits": {
        "circular-shift": "Reasoned from module 2: it would build its index in alphabetical order",
        "alphabetizing": "Reasoned from module 3: its sorting step becomes empty"
      }
    }
  ]
}
```

`assess` prints this for the first split.

```text
Subject: KWIC index (Parnas 1972), modularization 1: one part for each processing step (5 parts, 3 decisions, 5 requirements, 6 declared changes)
Evidence: Plan mode; repository checks do not apply.
Order: layered
Layer 0: line-format (shared), shift-index (shared), sorted-once (shared)
Layer 1: input, circular-shift, alphabetizing, output
Layer 2: master-control

| Requirement | shared: line-format | shared: shift-index | shared: sorted-once | input | circular-shift | alphabetizing | output | master-control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1: Accept an ordered set of lines of words | x |  |  | O |  |  |  |  |
| R2: List every circular shift of every line | x | x |  |  | O |  |  |  |
| R3: List the shifts in alphabetical order | x | x | x |  |  | O |  |  |
| R4: Print the listing | x | x | x |  |  |  | O |  |
| R5: Turn the input into the listing in one run | x |  |  | x | x | x | x | O |

| Node | Name | Layer | Used by | Leaned on by | Owns | Edited by | Hides |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shared: line-format | How the lines are held in core | 0 | alphabetizing, circular-shift, input, master-control, output | 5: alphabetizing, circular-shift, input, master-control, output |  |  |  |
| shared: shift-index | How the circular shifts are recorded | 0 | alphabetizing, circular-shift, output | 4: alphabetizing, circular-shift, master-control, output |  |  |  |
| shared: sorted-once | That all shifts are sorted once, before output starts | 0 | alphabetizing, output | 3: alphabetizing, master-control, output |  |  |  |
| input | Input | 1 | master-control | 1: master-control | R1 | C1, C2, C3 | the format of the input |
| circular-shift | Circular Shift | 1 | master-control | 1: master-control | R2 | C2, C3, C4, C6 |  |
| alphabetizing | Alphabetizing | 1 | master-control | 1: master-control | R3 | C2, C3, C4, C5, C6 | which sorting method is used |
| output | Output | 1 | master-control | 1: master-control | R4 | C2, C3, C4, C5 | the layout of the printed listing |
| master-control | Master Control | 2 |  | 0 | R5 | C2, C3 | the order in which the steps run |

| Change | input | circular-shift | alphabetizing | output | master-control | Width |
| --- | --- | --- | --- | --- | --- | --- |
| C2: The lines are no longer all held in core | E | E | E | E | E | 5 of 5 |
| C3: Characters are no longer packed four to a word | E | E | E | E | E | 5 of 5 |
| decision line-format: How the lines are held in core | E | E | E | E | E | 5 of 5 |
| C4: The shifts are stored as such or computed on demand, not indexed |  | E | E | E |  | 3 of 5 |
| decision shift-index: How the circular shifts are recorded |  | E | E | E |  | 3 of 5 |
| C5: The shifts are sorted on demand or in part, not once |  |  | E | E |  | 2 of 5 |
| C6: The shifts are produced in alphabetical order, so no separate sort runs |  | E | E |  |  | 2 of 5 |
| decision sorted-once: That all shifts are sorted once, before output starts |  |  | E | E |  | 2 of 5 |
| C1: The input format changes | E |  |  |  |  | 1 of 5 |

Requirements legend: O owns the requirement, x is relied on by an owner, Ox both, ? not settled.
Changes legend: E edit reasoned from the code, H edit also seen in the named commits, ! changed by the named commits but not marked, ? not settled. A decision row is a change to that shared decision.

Candidates to verify:
shared-decision line-format: known by 5 of 5 parts (alphabetizing, circular-shift, input, master-control, output), owned by none
shared-decision shift-index: known by 3 of 5 parts (alphabetizing, circular-shift, output), owned by none
shared-decision sorted-once: known by 2 of 5 parts (alphabetizing, output), owned by none
wide-change C2: edits 5 of 5 parts (alphabetizing, circular-shift, input, master-control, output)
wide-change C3: edits 5 of 5 parts (alphabetizing, circular-shift, input, master-control, output)
wide-change C4: edits 3 of 5 parts (alphabetizing, circular-shift, output)
no-secret circular-shift: states no hidden decision
```

Read it in the order that step 7 of the skill sets out.

- The order is `layered`, and apart from Master Control no part calls
  another. Judged by its order alone, this split looks sound.
- The base holds three shared decisions and no part. Every part leans on
  `line-format`.
- The change grid shows the cost. C2 and C3 edit five of five parts, C4 edits
  three, and C5 and C6 edit two each. Only C1 stays inside one part.
- Circular Shift states no secret. It is a step in the processing, not a
  place where a decision lives.

## Second split: one part for each decision to hide

Line Storage holds the lines and answers questions about them through
operations such as `CHAR`, `SETCHAR` and `WORDS`. Input reads the lines and
calls Line Storage to keep them. Circular Shifter offers the same kind of
operations for shifts, such as `CSCHAR`, so that its callers cannot tell
whether shifts are indexed, stored or computed. Alphabetizer offers `ALPH`
and `ITH`, where `ITH(i)` names the shift that comes at place `i` in the
order. Output prints. Master Control starts the others in turn.

Every part now states a secret, and no decision is left without an owner, so
the file has no `decisions`.

```json
{
  "subject": "KWIC index (Parnas 1972), modularization 2: one part for each decision to hide",
  "mode": "plan",
  "parts": [
    {
      "id": "line-storage",
      "name": "Line Storage",
      "hides": "how the lines are held: in core or not, packed or not"
    },
    { "id": "input", "name": "Input", "hides": "the format of the input" },
    {
      "id": "circular-shifter",
      "name": "Circular Shifter",
      "hides": "how the shifts are kept: indexed, stored or computed on demand"
    },
    { "id": "alphabetizer", "name": "Alphabetizer", "hides": "when and how the shifts are sorted" },
    { "id": "output", "name": "Output", "hides": "the layout of the printed listing" },
    {
      "id": "master-control",
      "name": "Master Control",
      "hides": "the order in which the other parts are started"
    }
  ],
  "requirements": [
    {
      "id": "R1",
      "text": "Accept an ordered set of lines of words",
      "source": "Problem statement: the system accepts an ordered set of lines",
      "owners": { "input": "Module 2 reads the original lines from the input media" },
      "relies": { "line-storage": "Module 2 calls the line storage module to have the lines stored" }
    },
    {
      "id": "R2",
      "text": "List every circular shift of every line",
      "source": "Problem statement: any line may be circularly shifted",
      "owners": {
        "circular-shifter": "Module 3 gives the impression of a line holder that contains all the circular shifts"
      },
      "relies": { "line-storage": "Hierarchical structure: Circular Shifter requires line storage" }
    },
    {
      "id": "R3",
      "text": "List the shifts in alphabetical order",
      "source": "Problem statement: the listing is in alphabetical order",
      "owners": {
        "alphabetizer": "Module 4: ITH(i) gives the shift that comes at place i in the alphabetical order"
      },
      "relies": { "circular-shifter": "Hierarchical structure: Alphabetizer requires Circular Shifter" }
    },
    {
      "id": "R4",
      "text": "Print the listing",
      "source": "Problem statement: the system outputs a listing of all circular shifts",
      "owners": { "output": "Module 5 gives the desired printing of the circular shifts" },
      "relies": {
        "circular-shifter": "Hierarchical structure: Output requires Circular Shifter",
        "alphabetizer": "Reasoned from module 4: Output needs ITH to print the shifts in order"
      }
    },
    {
      "id": "R5",
      "text": "Turn the input into the listing in one run",
      "source": "Problem statement: lines go in and the listing comes out",
      "owners": {
        "master-control": "Module 6 is similar in function to Master Control in the first modularization"
      },
      "relies": {
        "input": "Reasoned from module 6: it starts Input",
        "circular-shifter": "Reasoned from module 3: CSSETUP must be called before the other functions",
        "alphabetizer": "Reasoned from module 4: ALPH must be called before ITH",
        "output": "Reasoned from module 6: it starts Output"
      }
    }
  ],
  "changes": [
    {
      "id": "C1",
      "text": "The input format changes",
      "source": "Changeability, item 1",
      "edits": { "input": "The first change is confined to one module in both decompositions" }
    },
    {
      "id": "C2",
      "text": "The lines are no longer all held in core",
      "source": "Changeability, item 2",
      "edits": {
        "line-storage": "Knowledge of the exact way that the lines are stored is hidden from all but module 1"
      }
    },
    {
      "id": "C3",
      "text": "Characters are no longer packed four to a word",
      "source": "Changeability, item 3",
      "edits": { "line-storage": "Any change in the manner of storage can be confined to that module" }
    },
    {
      "id": "C4",
      "text": "The shifts are stored as such or computed on demand, not indexed",
      "source": "Changeability, item 4",
      "edits": {
        "circular-shifter": "The fourth change is confined to the circular shift module in the second decomposition"
      }
    },
    {
      "id": "C5",
      "text": "The shifts are sorted on demand or in part, not once",
      "source": "Changeability, item 5",
      "edits": {
        "alphabetizer": "A user of the alphabetizer cannot detect when the alphabetization is done; no other module need be changed"
      }
    },
    {
      "id": "C6",
      "text": "The shifts are produced in alphabetical order, so no separate sort runs",
      "source": "Improvement in Circular Shift Module",
      "edits": {
        "circular-shifter": "The definition of module 3 prescribes the order of the shifts, so the definition changes",
        "alphabetizer": "ALPH becomes empty and ITH returns its argument"
      }
    }
  ]
}
```

`assess` prints this for the second split.

```text
Subject: KWIC index (Parnas 1972), modularization 2: one part for each decision to hide (6 parts, 0 decisions, 5 requirements, 6 declared changes)
Evidence: Plan mode; repository checks do not apply.
Order: layered
Layer 0: line-storage
Layer 1: circular-shifter, input
Layer 2: alphabetizer
Layer 3: output
Layer 4: master-control

| Requirement | line-storage | circular-shifter | input | alphabetizer | output | master-control |
| --- | --- | --- | --- | --- | --- | --- |
| R2: List every circular shift of every line | x | O |  |  |  |  |
| R1: Accept an ordered set of lines of words | x |  | O |  |  |  |
| R3: List the shifts in alphabetical order |  | x |  | O |  |  |
| R4: Print the listing |  | x |  | x | O |  |
| R5: Turn the input into the listing in one run |  | x | x | x | x | O |

| Node | Name | Layer | Used by | Leaned on by | Owns | Edited by | Hides |
| --- | --- | --- | --- | --- | --- | --- | --- |
| line-storage | Line Storage | 0 | circular-shifter, input | 5: alphabetizer, circular-shifter, input, master-control, output |  | C2, C3 | how the lines are held: in core or not, packed or not |
| circular-shifter | Circular Shifter | 1 | alphabetizer, master-control, output | 3: alphabetizer, master-control, output | R2 | C4, C6 | how the shifts are kept: indexed, stored or computed on demand |
| input | Input | 1 | master-control | 1: master-control | R1 | C1 | the format of the input |
| alphabetizer | Alphabetizer | 2 | master-control, output | 2: master-control, output | R3 | C5, C6 | when and how the shifts are sorted |
| output | Output | 3 | master-control | 1: master-control | R4 |  | the layout of the printed listing |
| master-control | Master Control | 4 |  | 0 | R5 |  | the order in which the other parts are started |

| Change | line-storage | circular-shifter | input | alphabetizer | output | master-control | Width |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C6: The shifts are produced in alphabetical order, so no separate sort runs |  | E |  | E |  |  | 2 of 6 |
| C1: The input format changes |  |  | E |  |  |  | 1 of 6 |
| C2: The lines are no longer all held in core | E |  |  |  |  |  | 1 of 6 |
| C3: Characters are no longer packed four to a word | E |  |  |  |  |  | 1 of 6 |
| C4: The shifts are stored as such or computed on demand, not indexed |  | E |  |  |  |  | 1 of 6 |
| C5: The shifts are sorted on demand or in part, not once |  |  |  | E |  |  | 1 of 6 |

Requirements legend: O owns the requirement, x is relied on by an owner, Ox both, ? not settled.
Changes legend: E edit reasoned from the code, H edit also seen in the named commits, ! changed by the named commits but not marked, ? not settled. A decision row is a change to that shared decision.

Candidates to verify:
none
```

- The order is `layered` again, and the chain of use is longer than in the
  first split. Input and Circular Shifter use Line Storage directly, and the
  other three parts reach it through them.
- The grid records no shared decision, and the candidate list is empty.
- C1 to C5 edit one part each. Line Storage takes two of them, C2 and C3, and
  both stop at its operations. A base part can change often and stay sound,
  as long as its changes stay inside it.
- C6 edits two parts. The paper adds this change in hindsight. The
  definition of Circular Shifter fixes the order of the shifts, which rules
  out a program that produces them in alphabetical order. Parnas calls that
  a design error of the second split.

## What the two grids show

Both splits are layered. The order of the requirements grid does not tell
them apart, and the second split has the deeper chain. The difference is what
sits at the base. In the first split the base is knowledge that every part
holds and no part owns, so a change to it reaches every part. In the second
split the base is a part that keeps that knowledge behind its operations, so
the same change stays inside it.

That is why the skill reads the two grids together. The requirements grid
shows what leans on what. The change grid shows whether the things that are
leaned on are the things that change. Parnas draws the same line in the
paper: "hierarchical structure and 'clean' decomposition are two desirable
but independent properties of a system structure."

A grid answers only the changes that you put to it. The first five changes
make the second split look perfect. The sixth shows a decision that its
Circular Shifter gives away. The list of likely changes therefore decides
what a judgement can find, and it needs evidence as much as the marks do.

The repair that turns the first split into the second is the first one in
the skill's list: give each shared decision one home behind named operations.

| Shared decision in the first split | Home in the second split | Operations that hide it |
|---|---|---|
| `line-format` | Line Storage | `CHAR`, `SETCHAR`, `WORDS` |
| `shift-index` | Circular Shifter | `CSSETUP`, `CSCHAR` |
| `sorted-once` | Alphabetizer | `ALPH`, `ITH` |

Marks whose evidence starts with "Reasoned from" are not stated in the paper.
They follow from its descriptions of the modules.
