/**
 * Keeps an agent's browser work from taking the keyboard of the person at the Mac.
 *
 * Chromium makes itself the active application for some events that an agent can cause:
 * Apple Events that set a tab URL or create a tab or window, JavaScript dialogs, print
 * preview, and a "Leave site?" prompt. A small JXA program watches one browser process
 * while an agent uses it. It gives the keyboard back to the application the person used
 * last only for an activation that it can attribute to the agent:
 *
 * - a browser window appeared within the last half second (a dialog, print preview, or
 *   pop-up window), or appears within 700 ms after the activation: a JavaScript dialog
 *   came on screen about 180 ms after Chromium 151 activated for it, and a "Leave site?"
 *   prompt follows the activation; or
 * - an operation armed the watch just before an Apple Event that activates the browser.
 *
 * Every other activation belongs to the person: a click on a browser window or the Dock,
 * the application switcher, a launcher, or a link opened from another application. The
 * watch leaves those alone, so the person can always switch to the browser. Keystrokes
 * typed in the few tens of milliseconds before a return can still reach the browser.
 *
 * The program also reports browser windows that appear, such as a Save sheet, a JavaScript
 * dialog, a print preview, or a permission prompt, because they wait for a person and do
 * not always take the keyboard.
 */

import { spawn } from "node:child_process";
import { Socket } from "node:net";

/**
 * Argument: the browser pid. Reads `arm <ms>` lines on standard input and writes one JSON
 * line per event to standard output. Ends at the end of its input, when its parent exits,
 * or when it is stopped.
 */
export const FOCUS_PROGRAM = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('CGEventSourceSecondsSinceLastEventType', ['double', ['int', 'unsigned int']]);
ObjC.bindFunction('getppid', ['int', []]);
const out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(record) {
  record.at = Date.now();
  out.writeData($(JSON.stringify(record) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
function spin(seconds) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
}
function frontmost() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return app.isNil() ? null : app;
}
function pidOf(app) { return app ? Number(app.processIdentifier) : 0; }
function nameOf(app) { return app && !app.localizedName.isNil() ? app.localizedName.js : null; }
function windowList(option) {
  return ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(option, $.kCGNullWindowID))) || [];
}
function onScreen() {
  return windowList($.kCGWindowListOptionOnScreenOnly);
}
// The application windows on screen, front to back. Only layer 0 counts: menus, overlays,
// and the Dock lie above it, and the Dock's window spans the whole screen.
function appWindows() {
  return onScreen().filter(function (w) { return w.kCGWindowLayer === 0 && w.kCGWindowAlpha !== 0 && w.kCGWindowBounds; })
    .map(function (w) { return { owner: w.kCGWindowOwnerPID, b: w.kCGWindowBounds }; });
}
// The owner of the frontmost application window under the pointer when a mouse button went
// down within the last half second. Source state 1 counts hardware events only: a click that
// software posts is not the person's. The window order is the one recorded while the browser
// was not frontmost: Chromium raises its window before it activates, so a current read would
// put the browser under a click that landed in another application.
function clickedOwner() {
  const since = Math.min(
    $.CGEventSourceSecondsSinceLastEventType(1, 1),
    $.CGEventSourceSecondsSinceLastEventType(1, 3),
    $.CGEventSourceSecondsSinceLastEventType(1, 25));
  if (!(since < 0.5)) return null;
  const point = $.NSEvent.mouseLocation;
  const x = point.x;
  const y = $.NSScreen.screens.objectAtIndex(0).frame.size.height - point.y;
  for (const window of watch.order) {
    const b = window.b;
    if (x >= b.X && x < b.X + b.Width && y >= b.Y && y < b.Y + b.Height) return window.owner;
  }
  return null;
}
const watch = { pid: 0, order: [], home: null, taken: 0, cause: null, gaveUp: false, armedUntil: 0, pending: 0, seen: {}, started: false, input: '', ended: false };
// Records every window of the browser, on screen or not, when it is first listed, and reports
// each window created during the watch once it is on screen. True when such a window was created
// within the last recentMs. A window that existed at the start never counts, also when it comes
// on screen later, as hidden, minimized, and other-desktop windows do when the person returns.
function scan(recentMs) {
  const now = Date.now();
  let recent = false;
  for (const w of windowList($.kCGWindowListOptionAll)) {
    if (w.kCGWindowOwnerPID !== watch.pid || w.kCGWindowLayer !== 0) continue;
    let entry = watch.seen[w.kCGWindowNumber];
    if (entry === undefined) entry = watch.seen[w.kCGWindowNumber] = { created: watch.started ? now : 0, reported: !watch.started };
    if (entry.created === 0 || !w.kCGWindowIsOnscreen) continue;
    const b = w.kCGWindowBounds || {};
    // Status bubbles and similar strips do not wait for a person.
    if (!(b.Width >= 160 && b.Height >= 60)) continue;
    if (!entry.reported) {
      entry.reported = true;
      emit({ type: 'window', title: w.kCGWindowName ? String(w.kCGWindowName) : null, x: b.X, y: b.Y, width: b.Width, height: b.Height });
    }
    if (now - entry.created <= recentMs) recent = true;
  }
  return recent;
}
function giveBack(cause) {
  watch.pending = 0;
  watch.taken = Date.now();
  watch.cause = cause;
  // One return per armed operation: a second switch right after it is the person's.
  if (cause === 'dispatch') watch.armedUntil = 0;
  watch.home.activateWithOptions(0);
}
function leave(reason) {
  emit({ type: 'yielded', reason: reason });
  watch.pending = 0;
  watch.home = null;
}
// The browser became the active application while the person worked in another one.
function browserActivated() {
  if (watch.taken || watch.pending || watch.gaveUp || !watch.home || pidOf(watch.home) === watch.pid || watch.home.terminated) return;
  if (clickedOwner() === watch.pid) return leave('click');
  if (scan(500)) return giveBack('window');
  if (Date.now() < watch.armedUntil) return giveBack('dispatch');
  watch.pending = Date.now();
}
// A return that macOS refused is reported once; the watch tries again only after the browser loses the keyboard.
function settled(ok) {
  emit({ type: 'returned', to: nameOf(watch.home), heldMs: Date.now() - watch.taken, ok: ok, cause: watch.cause });
  watch.taken = 0;
  watch.gaveUp = !ok;
}
function command(line) {
  const arm = /^arm (\d+)$/.exec(line.trim());
  if (arm) watch.armedUntil = Date.now() + Number(arm[1]);
}
ObjC.registerSubclass({
  name: 'PiBrowserFocusWatch',
  methods: {
    'activated:': {
      types: ['void', ['id']],
      implementation: function (note) {
        const app = note.userInfo.objectForKey($.NSWorkspaceApplicationKey);
        if (app.isNil()) return;
        if (pidOf(app) === watch.pid) return browserActivated();
        if (watch.taken && watch.home && pidOf(app) === pidOf(watch.home)) return settled(true);
        watch.home = app;
        watch.gaveUp = false;
        watch.pending = 0;
      },
    },
    'input:': {
      types: ['void', ['id']],
      implementation: function (note) {
        const data = note.userInfo.objectForKey('NSFileHandleNotificationDataItem');
        if (data.isNil() || Number(data.length) === 0) {
          watch.ended = true;
          return;
        }
        watch.input += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
        for (let index = watch.input.indexOf('\n'); index >= 0; index = watch.input.indexOf('\n')) {
          command(watch.input.slice(0, index));
          watch.input = watch.input.slice(index + 1);
        }
        note.object.readInBackgroundAndNotify;
      },
    },
  },
});
function run(argv) {
  watch.pid = Number(argv[0]);
  watch.home = frontmost();
  watch.order = appWindows();
  const parent = $.getppid();
  scan(0);
  watch.started = true;
  const observer = $.PiBrowserFocusWatch.alloc.init;
  $.NSWorkspace.sharedWorkspace.notificationCenter.addObserverSelectorNameObject(
    observer, 'activated:', $.NSWorkspaceDidActivateApplicationNotification, $());
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(
    observer, 'input:', 'NSFileHandleReadCompletionNotification', input);
  input.readInBackgroundAndNotify;
  emit({ type: 'ready', home: nameOf(watch.home), browserActive: pidOf(watch.home) === watch.pid });
  while (!watch.ended && $.getppid() === parent) {
    spin(watch.pending || watch.taken ? 0.02 : 0.25);
    if (watch.taken) {
      // A return that never arrives is reported.
      if (Date.now() - watch.taken > 250) settled(pidOf(frontmost()) !== watch.pid);
    } else if (watch.pending) {
      if (pidOf(frontmost()) !== watch.pid) watch.pending = 0;
      else if (scan(500)) giveBack('window');
      else if (Date.now() - watch.pending > 700) leave('switch');
    } else if (pidOf(frontmost()) === watch.pid) {
      // A missed notification still leaves the browser frontmost.
      browserActivated();
    } else {
      watch.order = appWindows();
    }
    scan(0);
  }
  return '';
}
`;

/** One line of the watch program. `at` is epoch milliseconds. */
export type FocusEvent =
	| { type: "ready"; at: number; home: string | null; browserActive: boolean }
	| { type: "returned"; at: number; to: string | null; heldMs: number; ok: boolean; cause: "window" | "dispatch" }
	| { type: "yielded"; at: number; reason: "click" | "switch" }
	| { type: "window"; at: number; title: string | null; x: number; y: number; width: number; height: number };

/** What the watch observed, relative to the operation start. Absent when nothing happened. */
export interface FocusFacts {
	/** The browser took the keyboard for the agent's work; the watch gave it back to `returnedTo` after `heldMs`. */
	taken?: Array<{
		afterMs: number;
		heldMs: number;
		returnedTo: string | null;
		returned: boolean;
		cause: "window" | "dispatch";
	}>;
	/** The person switched to the browser (a click on one of its windows, or a switch with no agent cause); the watch left the keyboard there. */
	yielded?: "click" | "switch";
	/** Windows the browser showed: a Save sheet, JavaScript dialog, print preview, or prompt. */
	windows?: Array<{ afterMs: number; title: string | null; x: number; y: number; width: number; height: number }>;
	/** Events between the previous operation's result and this operation, for the same browser process. */
	earlier?: FocusFacts;
	/** Why the watch did not run during this operation. */
	unavailable?: string;
}

/** One operation's view of the watch of its browser process. */
export interface FocusWatch {
	/** Resolves when the program is ready; false when it did not start in time. Immediate after the first operation. */
	ready: Promise<boolean>;
	/** Marks the next `ms` milliseconds: an activation within them follows the operation's Apple Event. */
	arm(ms: number): void;
	/** Ends the operation's part of the watch and returns what it observed. The program keeps watching. */
	finish(): FocusFacts | null;
}

export type FocusWatcher = (pid: number, startedAt: number) => FocusWatch;

/** The running watch program: event lines in, commands out. */
export interface FocusProcess {
	onLine(listener: (line: string) => void): void;
	onExit(listener: (reason: string) => void): void;
	send(line: string): void;
	stop(): void;
}

export interface FocusOptions {
	/** How long a program keeps watching after the last operation on its browser process. */
	idleMs: number;
	/** Longest wait for a new program before the operation proceeds unwatched. */
	readyMs: number;
	now: () => number;
	spawnProgram: (pid: number) => FocusProcess;
}

function summarize(events: readonly FocusEvent[], since: number): FocusFacts | null {
	const facts: FocusFacts = {};
	const taken: NonNullable<FocusFacts["taken"]> = [];
	const windows: NonNullable<FocusFacts["windows"]> = [];
	for (const event of events) {
		const afterMs = Math.max(0, event.at - since);
		if (event.type === "returned")
			taken.push({ afterMs, heldMs: event.heldMs, returnedTo: event.to, returned: event.ok, cause: event.cause });
		else if (event.type === "yielded") facts.yielded = event.reason;
		else if (event.type === "window")
			windows.push({ afterMs, title: event.title, x: event.x, y: event.y, width: event.width, height: event.height });
	}
	if (taken.length) facts.taken = taken;
	if (windows.length) facts.windows = windows;
	return Object.keys(facts).length ? facts : null;
}

function parse(line: string): FocusEvent | null {
	try {
		const value = JSON.parse(line) as FocusEvent;
		return value && typeof value === "object" && typeof value.type === "string" && typeof value.at === "number"
			? value
			: null;
	} catch {
		return null;
	}
}

/** The longest list of unreported events a program keeps; older ones are dropped. */
const EVENT_LIMIT = 100;

interface Program {
	process: FocusProcess | null;
	ready: Promise<boolean>;
	started: boolean;
	exited: boolean;
	failure: string | null;
	events: FocusEvent[];
	/** Events at or before this time were reported with an operation. */
	reportedUntil: number;
	/** Operations in progress; the idle time starts when the last one finishes. */
	active: number;
	idle: ReturnType<typeof setTimeout> | null;
}

/**
 * Keeps one watch program per browser process while agents use it. The program starts
 * with the first act or evaluate on that process and stops `idleMs` after the last one,
 * so a dialog that page code opens between operations is still handled and reported once.
 */
export function createFocusWatcher(options: FocusOptions): FocusWatcher {
	const programs = new Map<number, Program>();

	const launch = (pid: number): Program => {
		let settle: (value: boolean) => void = () => {};
		const program: Program = {
			process: null,
			ready: new Promise<boolean>((resolve) => {
				settle = resolve;
			}),
			started: false,
			exited: false,
			failure: null,
			events: [],
			reportedUntil: options.now(),
			active: 0,
			idle: null,
		};
		try {
			program.process = options.spawnProgram(pid);
		} catch (error) {
			program.exited = true;
			program.failure = `The focus watch could not start: ${error instanceof Error ? error.message : String(error)}`;
			settle(false);
			return program;
		}
		const timer = setTimeout(() => {
			program.failure ??= `The focus watch did not start within ${options.readyMs} ms.`;
			settle(false);
		}, options.readyMs);
		timer.unref?.();
		program.process.onLine((line) => {
			const event = parse(line);
			if (!event) return;
			if (event.type === "ready") {
				program.started = true;
				clearTimeout(timer);
				settle(true);
				return;
			}
			program.events.push(event);
			if (program.events.length > EVENT_LIMIT) program.events.splice(0, program.events.length - EVENT_LIMIT);
		});
		program.process.onExit((reason) => {
			clearTimeout(timer);
			program.exited = true;
			if (!program.started) program.failure ??= reason;
			settle(false);
			if (programs.get(pid) === program) programs.delete(pid);
		});
		return program;
	};

	/** Takes the program's events of one operation and those since the previous report. */
	const report = (own: Program, startedAt: number, now: number): FocusFacts | null => {
		// Between operations a switch to the browser is the person's own business.
		const earlier = summarize(
			own.events.filter((event) => event.type !== "yielded" && event.at > own.reportedUntil && event.at < startedAt),
			own.reportedUntil,
		);
		const during = own.events.filter((event) => event.at >= startedAt && event.at <= now);
		const facts: FocusFacts = summarize(during, startedAt) ?? {};
		if (earlier) facts.earlier = earlier;
		if (!own.started && own.failure) facts.unavailable = own.failure;
		own.events = own.events.filter((event) => event.at > now);
		own.reportedUntil = Math.max(own.reportedUntil, now);
		return Object.keys(facts).length ? facts : null;
	};

	/** Ends one operation's use; the idle time starts when no operation uses the program. */
	const release = (pid: number, own: Program): void => {
		own.active = Math.max(0, own.active - 1);
		if (own.active > 0 || own.exited || programs.get(pid) !== own) return;
		own.idle = setTimeout(() => {
			if (programs.get(pid) === own) programs.delete(pid);
			own.process?.stop();
		}, options.idleMs);
		own.idle.unref?.();
	};

	return (pid, startedAt) => {
		let program = programs.get(pid);
		if (!program || program.exited) {
			program = launch(pid);
			if (!program.exited) programs.set(pid, program);
		}
		const own = program;
		own.active += 1;
		if (own.idle) {
			clearTimeout(own.idle);
			own.idle = null;
		}
		let finished: FocusFacts | null | undefined;
		return {
			ready: own.ready,
			arm: (ms) => {
				if (own.started && !own.exited) own.process?.send(`arm ${Math.max(0, Math.round(ms))}`);
			},
			finish: () => {
				if (finished === undefined) {
					finished = report(own, startedAt, options.now());
					release(pid, own);
				}
				return finished;
			},
		};
	};
}

/** The production watch program: `osascript` running {@link FOCUS_PROGRAM}. */
export function spawnFocusProgram(pid: number): FocusProcess {
	const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", FOCUS_PROGRAM, String(pid)], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	// The watch never keeps the Pi process alive; the program ends when its input closes.
	child.unref();
	for (const stream of [child.stdin, child.stdout]) if (stream instanceof Socket) stream.unref();
	child.stdin?.on("error", () => {});
	const lineListeners: Array<(line: string) => void> = [];
	const exitListeners: Array<(reason: string) => void> = [];
	let buffer = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		buffer += chunk;
		for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			for (const listener of lineListeners) listener(line);
		}
	});
	const exit = (reason: string) => {
		for (const listener of exitListeners.splice(0)) listener(reason);
	};
	child.on("error", (error) => exit(`The focus watch could not start: ${error.message}`));
	child.on("exit", (code, signal) =>
		exit(signal ? "The focus watch was stopped." : `The focus watch exited with status ${code}.`),
	);
	return {
		onLine: (listener) => lineListeners.push(listener),
		onExit: (listener) => exitListeners.push(listener),
		send: (line) => {
			if (child.exitCode === null && child.signalCode === null && child.stdin?.writable) child.stdin.write(`${line}\n`);
		},
		stop: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		},
	};
}
