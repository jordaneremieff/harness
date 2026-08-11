# harness

My personal setup for [Pi](https://github.com/earendil-works/pi).

Extension development uses dedicated persistent worktrees. See
[the extension worktree convention](docs/conventions/extension-worktrees.md).

## Shared resources across machines

This repository is the source of truth for the resources each machine loads
into Pi:

- **Skills and extensions** ship through the Pi package manifest (`pi` key in
  `package.json`). Register a clone with `pi install /path/to/harness`; Pi
  loads the resources from the clone in place, so a `git pull` updates them.
- **Core context file**: `instructions/core.md` is the machine-independent
  base `AGENTS.md`. Pi packages cannot carry context files, so each machine
  installs it as the global context file by symlink:

  ```bash
  ln -sfn /path/to/harness/instructions/core.md ~/.pi/agent/AGENTS.md
  ```

- **Machine-local rules** stay out of this repository. Put them in
  `~/AGENTS.md`, which Pi's ancestor walk loads for any session under the
  home directory, or in workspace and project `AGENTS.md` files. The core's
  precedence order ranks these local files above itself.

Prompt templates can ship the same way through a `pi.prompts` manifest entry;
only prompts free of machine-specific paths and model rosters belong in the
repository.

Released under the MIT license. Feel free to copy anything useful or fork it for your own setup. I do not provide support or accept unsolicited contributions.
