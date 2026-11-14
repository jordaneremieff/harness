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

## What a report describes

A report describes the terminal's session model: where the pane sits in its
window's layout and which content that model stacks above it. It says nothing
about what one Mac client shows at a given moment. A pane in a window that a
client does not show, such as a tab in the background, still has a report with
its geometry; whether the pane is on screen is the program's own observation of
the screen. A producer leaves out content that its model marks as not drawn,
where the model has such a mark.

## Offer

A terminal integration offers the information by setting the environment
variable `PI_PANE_STACKING` in the environment of a pane program that it
starts. The value is a JSON array of 1 to 16 strings: the argument vector of a
command, with an absolute executable path first. A missing, empty or invalid
value means that no information is offered.

The integration sets the variable only for panes whose stacking it can report
from the terminal application's own layout model, and only when the command
can run where the pane program runs: on the same host, with the executable and
every file that the command names present when the pane is created. Otherwise
it starts the pane program exactly as without the offer. It does not infer
stacking from pixels or from accessibility data.

The offer names files, so it stays usable only while they exist. A program
that cannot start the command continues without the information.

## Command

The program starts the command at most once, without a shell, with the pane's
environment, standard input connected to a pipe and standard output connected
to a pipe. The command reads no input. It exits when its standard input reaches
end of file, so it never outlives the program. The program closes the pipe or
ends the command when it stops using the information.

While its standard input stays open, the command keeps reporting through
interruptions of its own connection to the terminal application: it connects
again and writes a fresh report once it has one.

The command writes UTF-8 lines to standard output. Each line holds one JSON
object of at most 16 KiB. It writes a line when it starts and again whenever the
reported stacking changes:

```json
{"version":1,"pane":[0.5,0,0.5,1],"above":[[0.55,0.3,0.3,0.3]]}
```

- `pane` is the area that the pane occupies in its window's layout.
- `above` lists at most 64 areas of other content of the same window that the
  layout model stacks over the pane, such as floating panes in front of it or
  another pane that fills the window. An empty list means nothing of the
  window lies over the pane.
- Every area is `[x, y, width, height]` in fractions of the window's layout
  area: origin at the top left, y downwards, each value from 0 to 1.

When the pane is in no window's layout, for example while it is detached from
every window, the command writes `{"version":1,"pane":null}`.

## Consumer rules

- Ignore a line that is not valid JSON, exceeds the size limit, has another
  `version`, or holds values outside the stated ranges. Keep the last valid
  report.
- Treat the areas as positions in the terminal application's layout model, not
  as screen pixels. Use them to decide which content lies above the pane, and
  take where that content is drawn from the program's own view of the screen.
  An area for which the screen shows no matching content makes no hole.
- If the command cannot start, exits, or reports nothing valid, continue
  without the information and use the program's own fallback.
- The information never authorises an action on the terminal application.
