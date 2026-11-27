---
name: decompose
description: >
  Judge how a code project or a planned design is split into parts: where each
  requirement lives, what every part leans on, and which likely changes force
  edits across many parts. Use when asked to assess how well a codebase is put
  together, to review its architecture or module boundaries, how coupled,
  tangled or modular it is, where a change would spread, whether an outside
  project is sound to build on, to decompose a project, to compare two
  designs, or to check a design before building, including requests that name
  Axiomatic Design, a design matrix or Parnas's criteria. The agent builds a
  requirements grid and a change grid with evidence for every mark, orders and
  checks them with the bundled script, and reports where the split makes
  change costly, with repairs. Do not use for splitting a task into subtasks
  or work for agents, explaining or summarising a codebase without judging it,
  audits of Pi sessions (audit), review of one change, open-ended research
  (dig), or carrying out a refactor.
compatibility: The bundled script needs Node.js 22.19 or newer (direct TypeScript execution) and no packages. Reading commit history needs the git CLI and a repository with commits.
---

# Decompose

Judge how a project is split into parts with two grids that need each other.
The requirements grid shows where each thing the project does lives and what
that place leans on. The change grid shows which parts a likely change forces
you to edit. You build both with evidence for every mark. The bundled script
checks the evidence, puts the grids in order and measures them. You read them
and report where the split makes change costly, with a repair for each place.

The requirements grid adapts the design matrix of Axiomatic Design (N. P.
Suh). In his matrix a mark says that a design choice affects a requirement.
A design is uncoupled when the matrix is diagonal, decoupled when it is
triangular, and coupled otherwise. Here a mark says that a part owns a
requirement or is used by an owner, and the script calls the grid
`independent`, `layered` or `tangled` from the use between parts. The two
readings agree when each requirement has one owner and each part owns one
requirement. A requirement with several owners is coupled in his terms, and
the order does not count it.

The change grid is the test from D. L. Parnas, "On the Criteria To Be Used
in Decomposing Systems into Modules": list the changes that are likely, and
see which parts each one edits.

Neither grid is enough alone. A relies mark is a path along which a change
can travel. Whether it travels depends on what the relied part hides, and
only the change grid shows that. A grid can be in perfect order and still
make every likely change expensive.

This skill supplies a method of judgement. It produces no score, and it
changes nothing in the project it judges. It measures how far a change
spreads across parts, not how much work the change is inside one part.

## Terms

- A requirement is something a user of the project can observe it do.
- A part is a unit of the project as its code is organised, such as a
  package, a top-level directory or a module.
- A part hides a design decision when it keeps the decision to itself, so
  that the decision can change with no edit elsewhere.
- A shared decision is a design decision that several parts know, so that
  no part keeps it to itself, such as a file format, a schema, a protocol, a
  naming rule, a global or an order of calls.
- An owner of a requirement is a part that holds code written for that
  requirement alone.
- A requirement relies on a part when an owner's code for it directly uses
  that part, and on a shared decision when that code directly depends on it.
- A likely change is a change that the project's history, its open work or
  the outside things it follows make probable.
- The width of a change is the number of parts that it edits.

## 1. Frame what is judged

- Name the subject: the repository and revision, or the plan document, and
  the level of detail. Start with the top-level parts.
- Name the question that the judgement serves, such as building on the
  project, changing it, choosing between two designs, or checking a plan
  before work starts.
- Read what the project says about its own structure, such as an
  architecture document, contribution rules or decision records. Note each
  rule that shapes the split. A project can leave a decision without one
  home on purpose, for example to keep its parts free of a shared module.
- Keep the grids readable. Aim for 5 to 12 requirements and 4 to 15 parts.
  Choose the level at which the product's code divides into that many parts:
  packages or top-level directories in a large project, modules or files in
  a small one. When the question is about a larger set of peers, such as
  every plugin of a host, keep each peer as its own part and keep the rows
  few. Tests, documentation and build files are seldom parts. Say what you
  left out.
- Read the project and change nothing in it. Write the grid file and your
  notes in a scratch directory outside the project's tracked files unless
  the request names a place. Do not carry out a repair.

For a design that is not built yet, set `"mode": "plan"`. Evidence is then
free text that points into the plan, the parts are the ones the plan
proposes, and there is no history to read. Take the requirements from what
the plan says its users get, before you read how it splits the work. To
compare two designs, write one grid file for each with the same requirements
and the same changes.

**Complete when:** the subject, revision, level, question and scratch
location fit in a few lines.

## 2. Write the requirements before you read the code

Write the rows from what a user sees: the README and other documentation,
command help, the public interface, examples and the names of tests. Do this
before you open the source tree. Rows taken from the code repeat the way the
code is cut, and the grid then confirms itself. Keep the rows in your notes.
They enter the grid file in step 4.

- Each row states one thing a user can observe and records where you found
  it.
- A row stays true if every internal is replaced.
- A row never names a part. "The cache module indexes records" is the job of
  a part. "A search returns every matching record" is a requirement. If you
  can state a row only by naming a module, you took it from the code. Go
  back to the documentation.
- Include what the project promises across its features, such as one look
  for every result or one place for every setting. Such a row shows whether
  a promise has a home.
- A quality such as speed is not a row. If it is likely to change what the
  project must do, it belongs in the change grid.

**Complete when:** every row has a source outside the implementation and no
row names a part.

## 3. Name the parts and what each hides

Start the grid file (format below) with `subject`, `mode` and `parts`. Take
the parts as the code is organised and give each its path prefixes. State in
one line the main decision each part hides: what can change inside it with
no edit elsewhere. Write `null` when you cannot state one. Do not invent
one. A part without a secret is often a step in the processing, not a place
where a decision lives. Correct these lines when step 4 shows otherwise.

Then read the history. It needs only the parts:

```bash
node <skill-dir>/scripts/grid.mts history <grid.json> --repo <project>
```

Check the window line first. When the commit limit cut the history short,
raise `--max-commits`, or say that the numbers cover recent work only.

The output shows how many commits changed each part, which parts changed
together, the widest commits, and which changed files belong to no part. It
also names each path of yours that matched nothing. Add or widen parts until
what stays unmapped lies outside the product's code or is explained. A part
may also list paths that its code had earlier in the history. Leave a former
file unmapped when it mixed several of today's parts. When the project has
more peer parts than a grid can show and the question does not need each of
them, let this output choose: keep the parts that change most and that
change together, group or leave out the quiet ones, and say so.

Read the subjects of the widest commits. Some are mechanical, such as a
reformat of the whole tree or a new licence header, and tie parts together
that share no decision. Set aside each commit whose subject shows an edit
applied across the tree without regard to what the parts do: list its id
under `skip` in the grid file and run the command again. Leave the other
commits in. The output lists what it skipped.

The command also sets aside every commit that touches more files than its
bulk limit, and lists the largest. A migration that had to edit many parts
is evidence, not noise. When that list holds such commits, raise `--bulk`
and skip the mechanical ones by id.

Keep the output for steps 5 and 6. When the project has no usable history,
such as a new repository, say so and continue without it. For a shallow
clone the window line says that older history is not present. Deepen the
clone when it is yours to change, or say that the numbers cover recent work
only.

**Complete when:** every part has paths and a secret or `null`, and you hold
the history output with its window and mapping coverage, or the reason there
is none.

## 4. Mark owners and reliance

For each requirement find the code that delivers it. Start from the entry
point that a user touches and follow direct uses. Search; do not read every
file.

- A part is an owner when it holds code written for this requirement alone,
  code that you could delete if the requirement were dropped. The evidence
  is a path and line inside that part.
- A part is relied on when an owner's code for this requirement uses it
  directly. The evidence is the place of use, a path and line inside that
  owner. Give a list of places when several owners use the same part. One
  owner can rely on another owner of the same row.
- Code that serves several requirements does not make its part an owner of
  any of them. Each of those requirements relies on that part.
- Use is any way in which the owner's code needs the other part to be
  there: a call, an import, a program that it runs, a file that the other
  part writes, or a reference that it was handed, such as a parent object or
  a callback. Use can run against the direction of the imports.
- In a row with several owners, settle for each pair of owners whether one
  uses the other, in either direction. Search each owner for a reference to
  the other that it stores, such as a parent that it was handed.
- Record direct use only. The script works out what is indirect.
- List a part under `unknown` when you could not settle its cell. Do not
  guess a mark, and do not leave a doubt unrecorded.

Mark what the code does, not what the documentation promises. In a project
with one part for each technical layer, most requirements have several
owners. Record that as it is. It is a fact about the split, and the change
grid shows what it costs.

When the code shows a behaviour that users rely on and no row covers it,
find it in the documentation, add the row with that source, and say in the
report that you added it late.

**Complete when:** every row has at least one owner with evidence, every
other cell is a mark with evidence, a blank that you inspected, or an entry
in `unknown`, and each pair of owners in one row is settled in both
directions.

## 5. Find the decisions that several parts know

Imports and calls show only part of the coupling. Look for knowledge that
several parts hold, so that no part keeps it to itself:

- a file format, record layout, schema or message that several parts read or
  write field by field;
- names that work as a contract, such as environment variables,
  configuration keys, event names, paths and identifiers;
- a constant, rule or piece of code that is copied in several parts;
- a written convention that each part must implement for itself;
- an outside interface that several parts call directly, so that a new
  version of it edits each caller;
- an order of calls or a state that parts assume of each other;
- a global or a shared object that several parts change.

Two leads find most of them. The first is the same rule, literal or field
name found by search in several parts. Search for the fields and values that
the requirements turn on, and compare how each part reads them.

The second lead is a pair of parts that the history shows changing together
with no relies mark between them. Run `history` again now that the grid file
has its requirements. The pair table gains a column that says whether a
relies mark or a shared decision in the grid explains each pair. Start with
the pairs marked `not explained`, and read the commits behind a pair before
you trust it:

```bash
node <skill-dir>/scripts/grid.mts history <grid.json> --repo <project> --pair <a>,<b>
```

Version bumps and mechanical edits touch many parts without coupling them.
The column compares a pair with the grid as it is now. It does not say what
those commits were about.

Record each shared decision under `decisions` with `knownBy` evidence in
every part that knows it. Add it to `relies` in each row whose owner knows
it and depends on it. A part that reaches the decision only through another
part relies on that part, not on the decision. A decision that only one part
knows is that part's secret and belongs in its `hides`.

For each shared decision, read the commits behind the pairs of its knowers
that changed together most. They show whether the decision is what those
parts changed together, and how often. Keep that for the report. A decision
that did not change in the window is a risk, not yet a cost.

**Complete when:** you have read the commits behind every pair in the
printed table that has no relies mark, whether the table calls it `not
explained` or explains it by a shared decision alone. Reading means the
subjects that `--pair` lists, and the commit itself where its subject does
not settle what it changed. Each such pair is explained by a mark that those
commits support, or is noted as unexplained. Each shared decision has a note
of how often the history shows it changing.

## 6. Write the likely changes

Draw 5 to 10 changes from evidence, not from imagination:

- kinds of change that recur in the history. Read the subjects of the widest
  commits and of the recent log;
- open issues, roadmap items and notes in the code about planned work;
- outside things that the project must follow, such as an API, a format, a
  platform or a library that it wraps.

Each change needs a source that makes it likely. A decision does not become
likely to change because several parts know it. The script adds a row for
each shared decision by itself, so declare a change to a shared decision
only when the history or the open work shows one.

For each change mark the parts that must be edited, with evidence in each
part, and list the parts you could not settle under `unknown`. Where the
history holds an instance of the change, name its commits. The script then
compares your marks with what those commits changed.

**Complete when:** every change has a source, and every change drawn from the
history names at least one commit.

## 7. Run the check and read the grids

```bash
node <skill-dir>/scripts/grid.mts assess <grid.json> --repo <project>
```

Leave out `--repo` in plan mode. Correct every validation error by making the
file match the code. Never remove a true mark to pass the check. The script
confirms that each evidence path exists and lies in the right part. Whether
the line supports the mark stays your judgement.

Read the output in this order:

1. Read the order first. `independent` means that no requirement relies on
   another part. `layered` means that use runs one way. `tangled` means that
   parts use each other in a loop. A loop makes it hard to use, test or
   remove one of its parts without the others. How hard depends on how much
   passes through it, so rank a loop by the changes that it widens. The
   order rests on the marks that you recorded. Report "no loop among the
   recorded marks", not "no loop".
2. Look at the base next: each node on layer 0 and each node that many
   parts lean on. `Used by` counts direct use. `Leaned on by` adds every
   part that reaches the node through other parts, so it is an upper limit
   on what a change there can disturb. A base part is sound when its changes
   stay inside it, however often it changes. Find the changes that crossed
   its edge: the `With other parts` column in the per-part table of
   `history`, and the changes under `Edited by` in the node table that are
   wider than one part. Run `history` again if the grid changed since
   step 5. A shared decision at the base has no edge that stops a change.
   Use what step 5 found about how often it changed.
3. Read each column that starts with `shared:` as knowledge without a home.
   Its row in the change grid shows how many parts one change to it edits.
4. Read the change rows from the top, because they are sorted by width. A
   row that edits many parts names a decision that the split does not hide.
5. Settle each disagreement with the history. `!` marks a part that the
   named commits changed and you did not mark. Either your mark is missing
   or a coupling exists that you did not find. Find out which. `H` and `!`
   count any file of the part, tests and documentation included, so read
   what the commit changed there.
6. Read the `Homes:` lines. A requirement with several owners is coupled in
   Suh's terms: a change to it edits each owner. When most requirements have
   several owners, the parts follow something other than the requirements,
   such as one part for each technical layer. That is a cost of the split,
   not an error in your grid. Check that the change grid shows it.

The candidate list holds leads. Confirm each one in the code, dismiss it
with a reason, or leave it open and say what would settle it.

Go one level deeper only where a finding points inside a part: a base part
whose changes cross its edge, or a part that the widest changes edit. Make a
second grid file for the inside of that part. When its inside does not
divide by path, as with several classes in one file, write that grid in plan
mode and cite the lines in its evidence.

**Complete when:** the grid file passes `assess`, and every candidate is
confirmed, dismissed or left open with a reason.

## 8. Report

Write for the person who asked. Use plain words, and keep the terms of the
grids beside the grids. Report in this order.

1. Give the answer to the question from step 1 in two to four sentences:
   what is sound, where the split makes change costly, and what to do about
   it.
2. List the findings, at most five, ranked by what they cost. Each one
   states what is coupled, the evidence with paths and lines, the changes it
   widens with their widths, and how likely those changes are: what the
   history, the open work or the outside world shows, with the window. Then
   it gives a repair, the widths that you project after the repair, and what
   that projection assumes. When a width comes from commits, say how many of
   its parts changed product code and how many changed only tests or
   documents. A wide change that never happens costs nothing. A sound split
   has few findings or none. Do not pad the list.
3. Say what is sound: the likely changes that stay inside one part and the
   secrets that hold. Say so when one of them is still a large change inside
   its part. For a base part whose changes stay inside it, name the parts
   that use it, because they need a check when it changes.
4. Show the grids: the script's tables as printed, with their legends. Above
   them, state in one or two sentences the order, what sits at the base and
   whether its changes stay inside it. Show the grids of a deeper level only
   when a finding rests on them.
5. State the coverage and the limits: what you read, the history window, the
   commits set aside, the cells left unknown and the level at which you
   stopped.

Make each repair specific to the finding:

- give a shared decision one home, behind operations that you name;
- hold a base part still behind an interface that does not show its insides;
- break a loop by moving what both sides need below them;
- split a part that hides two decisions, or merge parts that hide one.

Check each repair against the rules you noted in step 1 and against the
history. When the project left a decision without a home on purpose, or
tried your repair and removed it, say so and report the cost that the choice
accepts. Then offer a repair that fits the rule: make the shared decision
smaller, move it into something that every part already depends on, or add
a check that finds every place that must change. Propose a change to the
rule itself only with the cost on both sides.

When the effect of a repair is not obvious, copy the grid file, apply the
repair to the copy and run `assess` on the copy without `--repo`. Leave the
copy in code mode. Without `--repo` the script checks only that each
citation lies in the right part, so a mark may cite a path that does not
exist yet. Remove the shared decision that gets a home, mark the edits that
each change then needs, and give a new part a proposed path. The change
rows of the copy show the effect. They are your projection, not a
measurement, because the script checks nothing in the copy against the
code.

Name a commit by what it changed, with its short id beside it.

Keep these out of the report: a single score or grade, a mark without
evidence, praise or blame for a layered grid without the facts about its
base, and history numbers without their window.

**Complete when:** every finding cites evidence that the reader can open and
says how likely its changes are, every repair states its projected effect on
the change grid and what that rests on, and the limits are stated.

## The grid file

One JSON object. `decisions` and `changes` may be empty at first.

```json
{
  "subject": "billing-tool at 4f2a91c, top-level directories",
  "mode": "code",
  "skip": ["9e8d7c6"],
  "parts": [
    { "id": "import", "name": "Import", "paths": ["src/import/"], "hides": "which input formats are accepted" },
    { "id": "store", "name": "Store", "paths": ["src/store/"], "hides": "how records are laid out on disk" },
    { "id": "report", "name": "Report", "paths": ["src/report/"], "hides": null }
  ],
  "decisions": [
    {
      "id": "record-fields",
      "name": "Field names of a record",
      "knownBy": { "import": "src/import/read.ts:14", "report": "src/report/table.ts:40" }
    }
  ],
  "requirements": [
    {
      "id": "R1",
      "text": "Import records from a CSV file",
      "source": "README.md, section Usage",
      "owners": { "import": "src/import/read.ts:1" },
      "relies": { "store": "src/import/read.ts:22 calls save()", "record-fields": "src/import/read.ts:14" },
      "unknown": []
    },
    {
      "id": "R2",
      "text": "Print the totals of a month",
      "source": "README.md, section Reports",
      "owners": { "report": "src/report/month.ts:1", "store": "src/store/totals.ts:5 query written for this report" },
      "relies": {
        "store": ["src/report/month.ts:12 calls monthTotals()", "src/report/month.ts:30 calls monthCount()"],
        "record-fields": "src/report/table.ts:40"
      }
    }
  ],
  "changes": [
    {
      "id": "C1",
      "text": "A record gains a field",
      "source": "history: three commits in 2025 added fields",
      "edits": { "store": "src/store/record.ts:8-21", "report": "src/report/table.ts:40" },
      "commits": ["a1b2c3d"],
      "unknown": ["import"]
    }
  ]
}
```

- Ids of parts and decisions use lower-case letters, digits and dashes, and
  are unique across both lists.
- A path prefix that ends in `/` covers a directory. Any other prefix names
  one file. A file belongs to the part with the longest matching prefix.
- `skip` lists the commits that `history` sets aside as mechanical.
- Evidence in code mode is `path[:lines][ note]`, relative to the project
  root. `lines` is a line, a range, or several joined by commas without
  spaces, as in `src/store/record.ts:8-21,40`. A path that contains a space
  needs a line number after it. Owner, `edits` and `knownBy` evidence lies
  inside the marked part.
- `relies` holds direct use only. Its value is one place of use or a list of
  them. Each place lies inside an owner of the row, and that owner is the
  part that relies. An owner can be relied on by another owner, as `store`
  is in R2.
- A shared decision needs at least two knowers. An owner that relies on a
  decision is one of its knowers.
- In plan mode `paths` may be absent and evidence is free text. In a row
  with several owners, start each relies entry with the id of the owner that
  relies, as in `"store": "report: calls monthTotals()"`.

Run the script with `--help` for its options, which include the history
window, the bulk limit, commits to skip and JSON output.

## Worked example

Read [example.md](references/example.md) when the method is new to you, when
a grid is hard to read, or when you need a complete grid file to copy from.
It judges one program split two ways and shows why the order of a grid alone
does not tell a good split from a bad one. Its contents list leads to each
grid file, the output of the script for it, and the reading of both.
