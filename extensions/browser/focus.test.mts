/**
 * The focus watch: the JXA program run against a stand-in of the macOS objects it uses
 * (frontmost application, activation notifications, standard input, window list, input
 * event timers), and the watcher that keeps one program per browser process and turns its
 * lines into the facts an operation reports.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { createFocusWatcher, FOCUS_PROGRAM, type FocusEvent, type FocusProcess } from "./focus.ts";

/* ---------------------------------------------------------------- program */

const BROWSER = 500;
const REX = 100;
const MAIL = 200;
const DOCK = 50;

interface Window {
	number: number;
	owner: number;
	layer?: number;
	name?: string;
	/** False for a window of a hidden application, a minimized window, or one on another desktop. */
	onScreen?: boolean;
	bounds: { X: number; Y: number; Width: number; Height: number };
}

const NAMES: Record<number, string> = { [BROWSER]: "Browser", [REX]: "Rex", [MAIL]: "Mail", [DOCK]: "Dock" };
const PAGE_WINDOW: Window = {
	number: 1,
	owner: BROWSER,
	name: "Page",
	bounds: { X: 0, Y: 0, Width: 900, Height: 700 },
};
const DIALOG: Window = {
	number: 2,
	owner: BROWSER,
	name: "127.0.0.1 says",
	bounds: { X: 200, Y: 100, Width: 448, Height: 144 },
};

type Observer = Record<string, (note: unknown) => void>;

class Mac {
	clock = 1_000_000;
	front: number;
	windows: Window[];
	sinceClick = 999;
	pointer = { x: 0, y: 0 };
	parent = 1234;
	honoured = true;
	readonly requests: number[] = [];
	readonly lines: FocusEvent[] = [];
	private activation: Observer | null = null;
	private input: Observer | null = null;
	private reading = false;
	private readonly pending: Array<{ at: number; run: () => void }> = [];

	constructor(front: number, windows: Window[]) {
		this.front = front;
		this.windows = windows;
	}

	app(pid: number) {
		const mac = this;
		return {
			isNil: () => false,
			processIdentifier: pid,
			terminated: false,
			localizedName: { isNil: () => false, js: NAMES[pid] ?? `app ${pid}` },
			activateWithOptions() {
				mac.requests.push(pid);
				if (mac.honoured) mac.later(20, () => mac.activate(pid));
				return true;
			},
		};
	}

	/** Makes `pid` the frontmost application and posts the activation notification. */
	activate(pid: number): void {
		this.front = pid;
		this.activation?.["activated:"]({ userInfo: { objectForKey: () => this.app(pid) } });
	}

	/** Delivers standard input to the program; an empty string is the end of input. */
	type(text: string): void {
		if (!this.reading || !this.input) throw new Error("the program is not reading its input");
		this.reading = false;
		const data = { isNil: () => false, length: text.length, text };
		const handle = this.handle;
		this.input["input:"]({ userInfo: { objectForKey: () => data }, object: handle });
	}

	readonly handle = (() => {
		const mac = this;
		return {
			get readInBackgroundAndNotify() {
				mac.reading = true;
				return undefined;
			},
		};
	})();

	observeActivation(observer: Observer): void {
		this.activation = observer;
	}

	observeInput(observer: Observer): void {
		this.input = observer;
	}

	later(ms: number, run: () => void): void {
		this.pending.push({ at: this.clock + ms, run });
	}

	advance(ms: number): void {
		const end = this.clock + ms;
		while (this.clock < end) {
			this.clock += 1;
			for (const item of this.pending.filter((entry) => entry.at <= this.clock)) {
				this.pending.splice(this.pending.indexOf(item), 1);
				item.run();
			}
		}
	}
}

interface Scenario {
	front: number;
	windows?: Window[];
	/** Timeline steps at milliseconds after the program starts. The program ends at end of input. */
	steps: Array<{ at: number; run: (mac: Mac) => void }>;
	honoured?: boolean;
}

/** Runs the program until its input ends at `end` milliseconds; event times are relative to the start. */
function runProgram(scenario: Scenario, end = 3_000): Mac {
	const mac = new Mac(scenario.front, [...(scenario.windows ?? [])]);
	mac.honoured = scenario.honoured ?? true;
	const start = mac.clock;
	for (const step of scenario.steps) mac.later(step.at, () => step.run(mac));
	mac.later(end, () => mac.type(""));
	const dollar = Object.assign((value: string) => ({ dataUsingEncoding: () => value }), {
		NSFileHandle: {
			fileHandleWithStandardOutput: {
				writeData: (text: string) => mac.lines.push(JSON.parse(text) as FocusEvent),
			},
			fileHandleWithStandardInput: mac.handle,
		},
		NSString: { alloc: { initWithDataEncoding: (data: { text: string }) => ({ js: data.text }) } },
		NSUTF8StringEncoding: 4,
		NSWorkspaceDidActivateApplicationNotification: "didActivate",
		NSWorkspaceApplicationKey: "app",
		NSWorkspace: {
			sharedWorkspace: {
				get frontmostApplication() {
					return mac.app(mac.front);
				},
				notificationCenter: {
					addObserverSelectorNameObject: (observer: Observer) => mac.observeActivation(observer),
				},
			},
		},
		NSNotificationCenter: {
			defaultCenter: { addObserverSelectorNameObject: (observer: Observer) => mac.observeInput(observer) },
		},
		NSRunningApplication: {
			runningApplicationsWithBundleIdentifier: () => ({ count: 1, objectAtIndex: () => mac.app(DOCK) }),
		},
		NSRunLoop: { currentRunLoop: { runUntilDate: (seconds: number) => mac.advance(Math.round(seconds * 1000)) } },
		NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => seconds },
		NSEvent: {
			get mouseLocation() {
				return { x: mac.pointer.x, y: 1000 - mac.pointer.y };
			},
		},
		NSScreen: { screens: { objectAtIndex: () => ({ frame: { size: { height: 1000 } } }) } },
		CGWindowListCopyWindowInfo: (option: number) =>
			mac.windows
				.filter((window) => option !== 1 || window.onScreen !== false)
				.map((window) => ({
					kCGWindowNumber: window.number,
					kCGWindowOwnerPID: window.owner,
					kCGWindowLayer: window.layer ?? 0,
					kCGWindowName: window.name,
					kCGWindowAlpha: 1,
					kCGWindowIsOnscreen: window.onScreen !== false,
					kCGWindowBounds: window.bounds,
				})),
		kCGWindowListOptionAll: 0,
		kCGWindowListOptionOnScreenOnly: 1,
		kCGNullWindowID: 0,
		CGEventSourceSecondsSinceLastEventType: (source: number) => (source === 1 ? mac.sinceClick : 0),
		getppid: () => mac.parent,
	});
	const context = createContext({
		ObjC: {
			import: () => undefined,
			bindFunction: () => undefined,
			deepUnwrap: (value: unknown) => value,
			castRefToObject: (value: unknown) => value,
			registerSubclass: (spec: {
				name: string;
				methods: Record<string, { implementation: (note: unknown) => void }>;
			}) => {
				const instance: Observer = {};
				for (const [selector, method] of Object.entries(spec.methods)) instance[selector] = method.implementation;
				Object.assign(dollar, { [spec.name]: { alloc: { init: instance } } });
			},
		},
		$: dollar,
		Date: { now: () => mac.clock },
		JSON,
		Math,
		Number,
		String,
	});
	runInContext(`${FOCUS_PROGRAM}\nrun([${BROWSER}]);`, context);
	for (const line of mac.lines) line.at -= start;
	return mac;
}

const of = <T extends FocusEvent["type"]>(mac: Mac, type: T) =>
	mac.lines.filter((line): line is Extract<FocusEvent, { type: T }> => line.type === type);

describe("focus watch program", () => {
	it("gives the keyboard back when a browser window appeared just before the browser took it", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 300, run: (m) => m.windows.push(DIALOG) },
				{ at: 310, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(mac.requests, [REX]);
		assert.equal(mac.front, REX);
		assert.deepEqual(
			of(mac, "returned").map(({ to, heldMs, ok, cause }) => ({ to, heldMs, ok, cause })),
			[{ to: "Rex", heldMs: 20, ok: true, cause: "window" }],
		);
		assert.deepEqual(
			of(mac, "window").map((line) => line.title),
			["127.0.0.1 says"],
		);
	});

	it("waits for a dialog that comes on screen after the activation, as a JavaScript dialog does", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 300, run: (m) => m.activate(BROWSER) },
				{ at: 490, run: (m) => m.windows.push(DIALOG) },
			],
		});
		assert.deepEqual(mac.requests, [REX]);
		assert.equal(of(mac, "returned")[0]?.cause, "window");
	});

	it("gives the keyboard back once for an activation within an armed interval", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 100, run: (m) => m.type("arm 1500\n") },
				{ at: 300, run: (m) => m.activate(BROWSER) },
				{ at: 800, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(mac.requests, [REX]);
		assert.equal(of(mac, "returned")[0]?.cause, "dispatch");
		assert.deepEqual(
			of(mac, "yielded").map((line) => line.reason),
			["switch"],
		);
		assert.equal(mac.front, BROWSER);
	});

	it("leaves the keyboard with the browser when the person switches to it with no agent cause", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 100, run: (m) => m.type("arm 200\n") },
				{ at: 600, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(mac.requests, []);
		assert.equal(mac.front, BROWSER);
		assert.deepEqual(
			of(mac, "yielded").map((line) => line.reason),
			["switch"],
		);
	});

	it("leaves the keyboard with the browser when its existing windows come back on screen with the switch", () => {
		const hidden = { ...DIALOG, onScreen: false };
		const mac = runProgram({
			front: REX,
			windows: [{ ...PAGE_WINDOW, onScreen: false }, hidden],
			steps: [
				{
					at: 400,
					run: (m) => {
						for (const window of m.windows) window.onScreen = true;
						m.activate(BROWSER);
					},
				},
			],
		});
		assert.deepEqual(mac.requests, []);
		assert.deepEqual(
			of(mac, "yielded").map((line) => line.reason),
			["switch"],
		);
		assert.equal(of(mac, "window").length, 0);
	});

	it("reports a window created off screen once it comes on screen", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 200, run: (m) => m.windows.push({ ...DIALOG, onScreen: false }) },
				{
					at: 600,
					run: (m) => {
						const dialog = m.windows.find((window) => window.number === DIALOG.number);
						if (dialog) dialog.onScreen = true;
					},
				},
			],
		});
		assert.deepEqual(
			of(mac, "window").map((line) => line.title),
			["127.0.0.1 says"],
		);
	});

	it("leaves the keyboard with the browser after a click on a browser window, even with a new window", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 100, run: (m) => m.type("arm 1500\n") },
				{
					at: 300,
					run: (m) => {
						m.windows.push(DIALOG);
						m.sinceClick = 0.1;
						m.pointer = { x: 50, y: 50 };
						m.activate(BROWSER);
					},
				},
			],
		});
		assert.deepEqual(mac.requests, []);
		assert.deepEqual(
			of(mac, "yielded").map((line) => line.reason),
			["click"],
		);
	});

	it("judges a click by the window order before the browser raised its window", () => {
		const terminal: Window = { number: 8, owner: REX, bounds: { X: 0, Y: 0, Width: 1800, Height: 1000 } };
		const mac = runProgram({
			front: REX,
			windows: [terminal, PAGE_WINDOW],
			steps: [
				{
					at: 300,
					run: (m) => {
						// Chromium orders its window front, then activates.
						m.windows = [PAGE_WINDOW, DIALOG, terminal];
						m.sinceClick = 0.1;
						m.pointer = { x: 50, y: 50 };
						m.activate(BROWSER);
					},
				},
			],
		});
		assert.deepEqual(mac.requests, [REX]);
		assert.equal(of(mac, "yielded").length, 0);
	});

	it("returns the keyboard after a click in another application, under the Dock's screen-wide window", () => {
		const mac = runProgram({
			front: REX,
			windows: [
				{ number: 9, owner: DOCK, layer: 20, bounds: { X: 0, Y: 0, Width: 1800, Height: 1125 } },
				{ number: 8, owner: REX, bounds: { X: 0, Y: 0, Width: 1800, Height: 1000 } },
				PAGE_WINDOW,
			],
			steps: [
				{
					at: 300,
					run: (m) => {
						m.windows.push(DIALOG);
						m.sinceClick = 0.1;
						m.pointer = { x: 1500, y: 900 };
						m.activate(BROWSER);
					},
				},
			],
		});
		assert.deepEqual(mac.requests, [REX]);
		assert.equal(of(mac, "returned")[0]?.cause, "window");
	});

	it("resumes after the person returns to another application, and returns the keyboard there", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 200, run: (m) => m.activate(BROWSER) },
				{ at: 700, run: (m) => m.activate(MAIL) },
				{ at: 1_000, run: (m) => m.windows.push(DIALOG) },
				{ at: 1_005, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(mac.requests, [MAIL]);
		assert.equal(mac.front, MAIL);
		assert.equal(of(mac, "returned")[0]?.to, "Mail");
	});

	it("reports a refused return once and tries again only after the browser lost the keyboard", () => {
		const mac = runProgram({
			front: REX,
			honoured: false,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 200, run: (m) => m.windows.push(DIALOG) },
				{ at: 205, run: (m) => m.activate(BROWSER) },
				{ at: 900, run: (m) => m.windows.push({ ...DIALOG, number: 3 }) },
				{ at: 905, run: (m) => m.activate(BROWSER) },
				{
					at: 1_400,
					run: (m) => {
						m.honoured = true;
						m.activate(MAIL);
					},
				},
				{ at: 1_800, run: (m) => m.windows.push({ ...DIALOG, number: 4 }) },
				{ at: 1_805, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(
			of(mac, "returned").map((line) => [line.to, line.ok]),
			[
				["Rex", false],
				["Mail", true],
			],
		);
		assert.deepEqual(mac.requests, [REX, MAIL]);
	});

	it("does nothing while the person works in the browser itself", () => {
		const mac = runProgram({
			front: BROWSER,
			windows: [PAGE_WINDOW],
			steps: [
				{ at: 300, run: (m) => m.windows.push(DIALOG) },
				{ at: 305, run: (m) => m.activate(BROWSER) },
			],
		});
		assert.deepEqual(mac.requests, []);
		assert.equal(of(mac, "returned").length, 0);
	});

	it("reports windows the browser shows, but not strips, other applications' windows, or windows it already had", () => {
		const mac = runProgram({
			front: REX,
			windows: [PAGE_WINDOW],
			steps: [
				{
					at: 400,
					run: (m) => {
						m.windows.push(
							{ number: 5, owner: BROWSER, name: "Save", bounds: { X: 10, Y: 30, Width: 880, Height: 448 } },
							{ number: 6, owner: BROWSER, bounds: { X: 0, Y: 680, Width: 148, Height: 22 } },
							{ number: 7, owner: MAIL, name: "Draft", bounds: PAGE_WINDOW.bounds },
						);
					},
				},
			],
		});
		assert.deepEqual(
			of(mac, "window").map((line) => [line.title, line.width, line.height]),
			[["Save", 880, 448]],
		);
		assert.deepEqual(mac.requests, []);
	});

	it("ends at the end of its input or when its parent process exits", () => {
		const atEnd = runProgram({ front: REX, steps: [] }, 400);
		assert.ok(atEnd.clock - 1_000_000 < 1_000, `ran ${atEnd.clock - 1_000_000} ms`);
		const orphan = runProgram(
			{
				front: REX,
				steps: [
					{
						at: 300,
						run: (m) => {
							m.parent = 1;
						},
					},
				],
			},
			60_000,
		);
		assert.ok(orphan.clock - 1_000_000 < 1_000, `ran ${orphan.clock - 1_000_000} ms`);
	});
});

/* ---------------------------------------------------------------- watcher */

class FakeProgram implements FocusProcess {
	stopped = false;
	readonly sent: string[] = [];
	private lines: Array<(line: string) => void> = [];
	private exits: Array<(reason: string) => void> = [];
	onLine(listener: (line: string) => void): void {
		this.lines.push(listener);
	}
	onExit(listener: (reason: string) => void): void {
		this.exits.push(listener);
	}
	send(line: string): void {
		this.sent.push(line);
	}
	stop(): void {
		this.stopped = true;
	}
	emit(event: Record<string, unknown>): void {
		for (const listener of this.lines) listener(JSON.stringify(event));
	}
	exit(reason: string): void {
		for (const listener of this.exits) listener(reason);
	}
}

function watcher(options: { readyMs?: number; idleMs?: number; spawn?: () => FakeProgram } = {}) {
	const programs: FakeProgram[] = [];
	let now = 10_000;
	const watch = createFocusWatcher({
		idleMs: options.idleMs ?? 60_000,
		readyMs: options.readyMs ?? 1_000,
		now: () => now,
		spawnProgram: () => {
			const program = options.spawn ? options.spawn() : new FakeProgram();
			programs.push(program);
			return program;
		},
	});
	return {
		watch,
		programs,
		setNow: (value: number) => {
			now = value;
		},
	};
}

const READY = { type: "ready", at: 10_010, home: "Rex", browserActive: false };

describe("focus watcher", () => {
	it("reports what the program saw during the operation, relative to its start, and arms the program", async () => {
		const { watch, programs, setNow } = watcher();
		const run = watch(BROWSER, 10_000);
		programs[0].emit(READY);
		assert.equal(await run.ready, true);
		run.arm(600);
		assert.deepEqual(programs[0].sent, ["arm 600"]);
		programs[0].emit({ type: "window", at: 10_290, title: "127.0.0.1 says", x: 200, y: 100, width: 448, height: 144 });
		programs[0].emit({ type: "returned", at: 10_300, to: "Rex", heldMs: 31, ok: true, cause: "window" });
		setNow(10_500);
		assert.deepEqual(run.finish(), {
			taken: [{ afterMs: 300, heldMs: 31, returnedTo: "Rex", returned: true, cause: "window" }],
			windows: [{ afterMs: 290, title: "127.0.0.1 says", x: 200, y: 100, width: 448, height: 144 }],
		});
		assert.equal(run.finish(), run.finish());
	});

	it("keeps one program per browser process across operations and reports events between them once", async () => {
		const { watch, programs, setNow } = watcher();
		const first = watch(BROWSER, 10_000);
		programs[0].emit(READY);
		await first.ready;
		setNow(11_000);
		assert.equal(first.finish(), null);
		programs[0].emit({ type: "window", at: 11_400, title: "Save", x: 10, y: 30, width: 880, height: 448 });
		programs[0].emit({ type: "yielded", at: 11_500, reason: "switch" });
		const second = watch(BROWSER, 12_000);
		assert.equal(programs.length, 1);
		assert.equal(await second.ready, true);
		setNow(12_300);
		assert.deepEqual(second.finish(), {
			earlier: { windows: [{ afterMs: 400, title: "Save", x: 10, y: 30, width: 880, height: 448 }] },
		});
		const third = watch(BROWSER, 13_000);
		setNow(13_100);
		assert.equal(third.finish(), null);
		const other = watch(BROWSER + 1, 13_200);
		assert.equal(programs.length, 2);
		other.finish();
	});

	it("stops a program after the idle time and starts a new one for the next operation", async () => {
		const { watch, programs } = watcher({ idleMs: 20 });
		const first = watch(BROWSER, 10_000);
		programs[0].emit(READY);
		await first.ready;
		first.finish();
		assert.equal(programs[0].stopped, false);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(programs[0].stopped, true);
		watch(BROWSER, 10_100);
		assert.equal(programs.length, 2);
	});

	it("does not stop a program while an operation uses it, also when operations overlap", async () => {
		const { watch, programs } = watcher({ idleMs: 20 });
		const first = watch(BROWSER, 10_000);
		programs[0].emit(READY);
		await first.ready;
		const second = watch(BROWSER, 10_050);
		first.finish();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(programs[0].stopped, false);
		second.finish();
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(programs[0].stopped, true);
	});

	it("lets the operation proceed unwatched when the program does not start in time or exits, and starts a new one later", async () => {
		const slow = watcher({ readyMs: 10 });
		const late = slow.watch(BROWSER, 10_000);
		assert.equal(await late.ready, false);
		late.arm(600);
		assert.deepEqual(slow.programs[0].sent, []);
		assert.match(String(late.finish()?.unavailable), /did not start within 10 ms/);

		const failing = watcher();
		const exited = failing.watch(BROWSER, 10_000);
		failing.programs[0].exit("The focus watch exited with status 1.");
		assert.equal(await exited.ready, false);
		assert.deepEqual(exited.finish(), { unavailable: "The focus watch exited with status 1." });
		failing.watch(BROWSER, 10_100);
		assert.equal(failing.programs.length, 2);

		const broken = watcher({
			spawn: () => {
				throw new Error("spawn failed");
			},
		});
		const none = broken.watch(BROWSER, 10_000);
		assert.equal(await none.ready, false);
		assert.match(String(none.finish()?.unavailable), /spawn failed/);
	});
});
