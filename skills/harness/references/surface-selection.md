# Pi harness surface selection

Use this reference when the requested artifact is open, ambiguous, spans resource types, or uses a generic word such as “tool,” “command,” “plugin,” or “integration.” Resolve version-sensitive details against the active Pi installation before implementation.

## Topology

Pi exposes several different layers. They compose, but they are not peers.

### Package resources

A Pi package can distribute:

- **Extensions** — TypeScript modules loaded by Pi.
- **Agent Skills** — on-demand procedural capability packages.
- **Prompt templates** — user-invoked Markdown prompt expansion.
- **Themes** — terminal color definitions.

A package is a distribution boundary around resources. It is not the runtime behavior itself.

### Extension-owned surfaces

An extension can register or control:

- model-callable custom tools;
- user-invoked slash commands;
- lifecycle and tool events;
- custom providers and model behavior;
- TUI components and rendering;
- flags, shortcuts, messages, and resource discovery; and
- in-session state and process ownership.

A custom tool, command, provider, or UI is therefore usually an extension-owned surface, not an alternative to an extension.

### Programmatic integration

- **SDK:** embed Pi in a Node.js application through programmatic APIs.
- **RPC mode:** control Pi through a language-neutral JSONL protocol over standard input and output.
- **JSON event mode:** consume structured print-mode events without an interactive terminal.

These modes integrate with Pi from another process. They do not become package resources merely because a package ships the caller.

### Configuration surfaces

Settings, model entries, context files, and package filters configure existing Pi behavior. A custom provider that implements an API or OAuth flow remains extension code even when settings select it.

### Adjacent surfaces

A standalone CLI or script is not a Pi package resource. Use one when the operation must work outside a Pi session. Add a thin extension wrapper only when the model or operator also needs a native Pi tool or command.

Repository instructions govern behavior that must remain active for all work in that repository. They are not a substitute for a detailed on-demand method.

## Decision table

| Required outcome | Primary surface |
|---|---|
| Reusable reasoning procedure or domain workflow | Agent Skill |
| Explicit slash shortcut that expands a prompt | Prompt template |
| Model-callable operation with structured parameters | Extension that registers a custom tool |
| User-invoked operation with Pi context | Extension that registers a command |
| Event interception, lifecycle behavior, state, or custom rendering | Extension |
| Custom inference API, authentication, or provider catalog behavior | Extension that registers a provider |
| Visual color palette only | Theme |
| Node application embeds and controls Pi | SDK consumer |
| Non-Node or protocol-level external controller | RPC mode |
| Structured event output from a print run | JSON event mode |
| Operation must work without Pi | Standalone CLI or script |
| Distribution of one or more Pi resources | Pi package, in addition to the primary surface |
| Stable repository-wide behavioral law | Repository instructions |

## Selection procedure

1. State the observable outcome without implementation nouns.
2. Decide whether the capability runs inside a Pi session, outside it, or only in model reasoning.
3. Decide who invokes it: the model, the operator, Pi lifecycle, or another process.
4. Decide whether it needs executable behavior, passive instructions, prompt expansion, visual data, or configuration.
5. Select the primary capability surface from the table.
6. Add a package only when distribution is part of the requirement.
7. Name any composition explicitly, such as “standalone CLI plus an extension-owned custom tool.”
8. Read the current installed Pi document and nearest shipped example for the selected surface.

## Common classification errors

- Treating every requested “tool” as a custom tool before checking whether the need is procedural guidance or an external CLI.
- Treating tools, commands, and providers as independent of the extension that registers them.
- Treating a package as the implementation instead of the distribution container.
- Choosing a prompt template for behavior that must activate without operator invocation.
- Choosing an Agent Skill for deterministic interception, enforcement, state, or UI.
- Choosing an extension for a workflow that needs no runtime code.
- Binding a generic CLI to Pi when other callers must use it independently.

## Current truth sources

Start with the installed Pi documentation index. Then read the selected surface document completely and inspect the nearest shipped example. Typical documents include `extensions.md`, `skills.md`, `prompt-templates.md`, `themes.md`, `packages.md`, `sdk.md`, `rpc.md`, `json.md`, `models.md`, `custom-provider.md`, and `settings.md`.
