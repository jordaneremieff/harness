# Research and Reuse Protocol

Use this protocol before creating a new skill, substantially redesigning one,
or overhauling its activation description. Its purpose is to establish whether
the capability already exists and what current standards and field evidence
can teach the authoring process.

The unit of evidence is the inspected source file, not the search result.
Indexes, snippets, rankings, and install counts help choose what to inspect;
they do not verify that a skill exists or is suitable.

## Contents

- [1. Scope the search](#1-scope-the-search)
- [2. Check authoritative guidance](#2-check-authoritative-guidance)
- [3. Map local overlap](#3-map-local-overlap)
- [4. Discover open-source skills](#4-discover-open-source-skills)
- [5. Inspect candidates directly](#5-inspect-candidates-directly)
- [6. Check domain state of the art](#6-check-domain-state-of-the-art)
- [7. Produce a research brief](#7-produce-a-research-brief)
- [8. Revisit the decision](#8-revisit-the-decision)

## 1. Scope the search

Write down the capability in operator language, task terms, and likely file or
tool names. Include synonyms and near-miss categories. Record the intended
client or portability target, because a perfect skill for another agent may
still need adaptation.

Classify the effort:

- **New capability:** research standards, domain state of the art, local
  overlap, and open-source skills.
- **Substantial redesign:** research the same sources and compare them with
  the current skill and its observed failures.
- **Description overhaul:** prioritize trigger evidence and descriptions, but
  still inspect the full body of candidate skills before borrowing structure.
- **Small repair:** check the relevant standard clause and target client
  behavior; a broad ecosystem sweep is usually unnecessary.

## 2. Check authoritative guidance

Fetch or read the current Agent Skills specification and the relevant
skill-creation guidance before drafting. For Pi work, read Pi's installed
skill documentation as well, because it deliberately deviates from the
official parent-directory-name rule and adds `disable-model-invocation`.

Separate three layers in notes:

1. **Portable standard:** valid across Agent Skills clients.
2. **Client support:** Pi or another client's documented behavior.
3. **Community pattern:** useful practice that is not required.

When community guidance conflicts with the official standard, follow the
standard for portability and record the trade-off. Do not freeze volatile
versioned APIs into a skill unless the skill's purpose is that specific
version; instead, instruct future runs to inspect current truth sources.

## 3. Map local overlap

Inspect the target repository's skill catalog, README, `skills/` tree,
package manifest, project skill directories, and any global skill locations
the operator authorizes. Read candidate descriptions and the actual
`SKILL.md` files for semantically adjacent capabilities.

Classify each meaningful candidate as one of:

- **Adopt:** it already serves the intended task and audience.
- **Extend:** it has the right boundary but lacks a required workflow,
  verification gate, or integration.
- **Compose:** it can be called alongside an existing skill, command, or
  runtime capability; a new skill may only need routing.
- **Create:** a distinct, coherent gap remains.

Do not invent a numeric overlap threshold. The boundary test is whether a
future trigger can select one skill without ambiguity and whether the body
would remain one coherent unit. Name conflicts and description collisions are
also overlap evidence even when the bodies differ.

## 4. Discover open-source skills

Use at least two complementary surfaces when network access and the intended
audience allow it:

- a semantic skills index such as skills.sh;
- source repositories through GitHub search or known vendor/community
  collections.

Useful starting queries include:

```text
site:skills.sh <capability or user-language terms>
"SKILL.md" "<capability>" site:github.com
repo:anthropics/skills <capability>
repo:openai/skills <capability>
repo:obra/superpowers <capability>
```

For skill-authoring patterns, inspect high-signal exemplars such as:

- `anthropics/skills/skills/skill-creator` for iterative evals and human
  review;
- `openai/skills/skills/.system/skill-creator` for resource planning and
  degrees of freedom;
- `obra/superpowers/skills/writing-skills` for baseline failure and pressure
  testing;
- other domain-specific official skills before generic community imitations.

Vendor collections are preferred exemplars because they are maintained for a
real client. Popularity can surface candidates, but it is not evidence that
the skill is secure, current, portable, or suitable for the operator's task.

## 5. Inspect candidates directly

Follow each promising result to the repository and read the actual
`SKILL.md`. Inspect relevant `scripts/`, `references/`, `assets/`, license,
and repository activity. Check dates, maintainers, security posture, required
secrets, network calls, destructive operations, and client-specific fields.
Prefer fresh primary sources over copied mirrors.

Extract only transferable structure and principles:

- description shape and trigger coverage;
- section boundaries and progressive disclosure;
- completion criteria and validation loops;
- scripts that should exist because agents repeatedly rewrite them;
- explicit boundaries and failure handling.

Do not copy prose, prompts, examples, identifiers, or project-specific
commands. If a candidate has no clear license or carries surprising behavior,
use it only as negative or structural evidence and flag the risk.

## 6. Check domain state of the art

A skill teaches the current way to perform a domain task, so existing skills
are not enough. Consult the domain's primary truth sources: official docs,
specifications, changelogs, reference implementations, pinned repository
files, or current API references. Verify version-sensitive behavior against
the installed or pinned dependency where possible.

Keep SOTA notes separate from authoring notes:

- SOTA sources define what should be true in the domain.
- Open-source skills reveal reusable authoring structures and observed
  activation patterns.

A stale official skill is worse evidence than a current domain document. A
clever community pattern is worse evidence than the official specification
when the two conflict.

## 7. Produce a research brief

Before drafting, present a compact brief with these fields:

```markdown
### Skill research brief

- Capability and audience:
- Target clients/locations:
- Queries and surfaces checked:
- Local candidates inspected:
- External candidates inspected:
- Primary/SOTA sources checked:
- Direct matches:
- Useful partial matches:
- Patterns to adopt:
- Patterns rejected and why:
- Remaining gap:
- Recommendation: adopt | extend | compose | create
- Network/client limitations:
```

For a positive claim, cite the inspected source. For a negative claim, state
the searched universe precisely: "I found no direct match in the target
repository, authorized local skills, skills.sh queries, and GitHub queries
listed above." Do not claim that no skill exists anywhere.

If network access fails, mark the affected source classes as unverified and
use local/offline sources only after telling the operator. Do not silently
substitute model memory for research.

## 8. Revisit the decision

The brief must be able to end in not creating a skill. If adoption or
composition is sufficient, stop and explain that outcome. If extension is
right, preserve the existing name and public trigger unless there is an
explicit rename migration plan. If creation is right, carry only the
justified structural lessons into the next design gate.
