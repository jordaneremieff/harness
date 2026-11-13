# Pane stacking contract

This package-level contract lets a program that shows its own Mac window over
its terminal pane learn which content of the terminal window lies above that
pane. The terminal integration that creates the pane offers the information
through a fixed subprocess interface. The program uses it to leave that content
visible and clickable. Neither side imports, names or depends on the other.

The terminal application owns its layout and its stacking order. The program
owns its window, its placement over the pane and its use of the information.
The contract carries geometry only. It is not a control channel, and the
program never acts on the terminal application through it.

## Offer

A terminal integration offers the information by setting the environment
variable `PI_PANE_STACKING` in the environment of a pane program that it
starts. The value is a JSON array of 1 to 16 strings: the argument vector of a
command, with an absolute executable path first. A missing, empty or invalid
value means that no information is offered.

The integration sets the variable only for panes whose stacking it can report
from the terminal application's own layout model. It does not infer stacking
from pixels or from accessibility data.

## Command

The program starts the command at most once, without a shell, with the pane's
environment, standard input connected to a pipe and standard output connected
to a pipe. The command reads no input. It exits when its standard input reaches
end of file, so it never outlives the program. The program closes the pipe or
ends the command when it stops using the information.

The command writes UTF-8 lines to standard output. Each line holds one JSON
object of at most 16 KiB. It writes a line when it starts and again whenever the
reported stacking changes:

```json
{"version":1,"pane":[0.5,0,0.5,1],"above":[[0.55,0.3,0.3,0.3]]}
```

- `pane` is the area that the pane occupies in its window.
- `above` lists at most 64 areas of other content of the same window that the
  terminal application draws over the pane, such as floating panes in front of
  it or another pane that fills the window. An empty list means nothing of the
  window lies over the pane.
- Every area is `[x, y, width, height]` in fractions of the window's layout
  area: origin at the top left, y downwards, each value from 0 to 1.

When the pane is not part of a shown layout, for example while it is detached
from every window, the command writes `{"version":1,"pane":null}`.

## Consumer rules

- Ignore a line that is not valid JSON, exceeds the size limit, has another
  `version`, or holds values outside the stated ranges. Keep the last valid
  report.
- Treat the areas as approximate positions in the terminal application's
  layout model, not as screen pixels. Use them to decide which content lies
  above the pane; take exact screen geometry from the program's own view of the
  screen.
- If the command cannot start, exits, or reports nothing valid, continue
  without the information and use the program's own fallback.
- The information never authorises an action on the terminal application.
