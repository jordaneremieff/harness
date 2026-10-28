# Harness surface for orchestrators and workers

The harness surfaces an orchestrator or its workers use. Each entry names
its purpose and where to read more. Availability differs per session:
confirm a tool, skill, or prompt with the `registry` tool (`search` for a
purpose, `kind` and `name` for one resource) before you rely on it or name
it in a contract.

## Contents

- Extensions
- Skills
- Prompts
- Choosing for a worker

## Extensions

| Extension | Purpose | Tools or commands | Read more |
|---|---|---|---|
| agent | Durable agent sessions, delegation, waits, threads, intent, profiles | `agent_*` tools, `/agent` | `extensions/agent/README.md` |
| registry | Look up session tools, skills, prompts, models, settings, and context usage | `registry` | `extensions/registry/README.md` |
| memory | Durable operator knowledge: preferences, decisions, verified lessons | `memory_search`, `memory_read`, `memory_write`, `memory_edit` | `extensions/memory/README.md` |
| history | Exact earlier entries of the current session | `history_search`, `history_read` | `extensions/history/README.md` |
| stash | Handovers that survive a session change | `stash_write`, `stash_list`, `stash_read`, `/stash` | `extensions/stash/README.md` |
| pillars | Design doctrine for judgment moments | `pillars` | `extensions/pillars/README.md` |
| policy | Operator-approved rules on tool choice and arguments | `policy_rules`, `policy_propose` | `extensions/policy/README.md` |
| jobs | Background builds, test suites, and servers while the agent works | `bash` with `background`, `jobs` | `extensions/jobs/README.md` |
| brave | Public web search and bounded page reads | `web_search`, `web_read` | `extensions/brave/README.md` |
| clipboard | macOS clipboard and its history | `clipboard_*` | `extensions/clipboard/README.md` |
| evo | Directed harness improvement through full agent sessions | `/evo` | `extensions/evo/README.md` |
| statusline | Two-line session footer for long sessions | none | `extensions/statusline/README.md` |

Codemode is a Pi capability, not a harness extension. It runs JavaScript
that calls other tools in one step; see `references/codemode.md`.

## Skills

| Skill | Use for | Read more |
|---|---|---|
| dig | One evidence question or unknown root cause; frames, delegates, checks, synthesizes | `skills/dig/SKILL.md` |
| prime | Orientation before a task, then wait | `skills/prime/SKILL.md` |
| audit | Evidence checks of Pi session and harness activity | `skills/audit/SKILL.md` |
| harness | Adding, changing, or removing a harness surface | `skills/harness/SKILL.md` |
| github | Read-only GitHub evidence | `skills/github/SKILL.md` |
| troll | Press a claim at full strength on the operator's cue | `skills/troll/SKILL.md` |

Route an evidence question inside an orchestrated effort to a worker that
loads dig, rather than running dig's method in the orchestrator.

## Prompts

Harness prompt templates in `prompts/`:

| Prompt | Purpose |
|---|---|
| `/drift` | Reconstruct the operator's original intent without advancing the task |
| `/recap` | Explain what the agents did and what it means in plain words |
| `/seed` | Put a quick brief for another session on the clipboard |
| `/tldr` | Summarize the current discussion in a few sentences |

The operator can install further prompt templates in the agent directory.
Find them with `registry` `kind: "prompt"`; do not assume one exists.

## Choosing for a worker

- **Research or diagnosis:** name dig in the contract and the web tools when
  external sources matter.
- **Implementation:** name the repository's own instructions and its check
  commands; name jobs for long suites.
- **Review:** name the sources the verdict must reach and pillars for design
  judgment.
- **Continuity:** name stash for handovers and memory for durable lessons.
- **Coordination:** name delegate in the Skills to load slot for a lead or
  partner that will run its own team.
