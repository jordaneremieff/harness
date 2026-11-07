/**
 * The JavaScript for Automation program run against a stand-in Apple Events
 * object model. These tests call the program's own request handling, so a reply
 * that the operations layer receives is produced by the code that osascript runs.
 * osascript invokes the script's `run` handler and prints its return value; the
 * sandbox appends the same call because it does not provide that host behaviour.
 */

import assert from "node:assert/strict";
import { it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { BROWSERS } from "./browsers.ts";
import { JXA_PROGRAM } from "./jxa.ts";
import { type BrowserDeps, browserEvaluate } from "./operations.ts";
import type { OsaReply, OsaRequest } from "./osa.ts";

const fcc = (text: string) =>
	((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) | (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;

const KEY = {
	want: fcc("want"),
	from: fcc("from"),
	selector: fcc("seld"),
	direct: fcc("----"),
	errorNumber: fcc("errn"),
	errorMessage: fcc("errs"),
};

const CODE = {
	cwin: fcc("cwin"),
	tab: fcc("CrTb"),
	property: fcc("prop"),
	id: fcc("ID  "),
	execute: fcc("ExJa"),
};

interface Descriptor {
	descriptorType: number;
	isNil: () => boolean;
	stringValue: { isNil: () => boolean; js?: string };
	int32Value: number;
	booleanValue: boolean;
	doubleValue: number;
	numberOfItems: number;
	descriptorAtIndex: (index: number) => Descriptor;
	data: { base64EncodedStringWithOptions: (options: number) => { js: string } };
	paramDescriptorForKeyword?: (keyword: number) => Descriptor;
	setDescriptorForKeyword?: (descriptor: Descriptor, keyword: number) => void;
	coerceToDescriptorType?: (type: number) => Descriptor;
	params?: Record<number, Descriptor>;
	__typeCode?: number;
	__spec?: boolean;
}

function nilDescriptor(): Descriptor {
	const descriptor: Descriptor = {
		descriptorType: fcc("null"),
		isNil: () => true,
		stringValue: { isNil: () => true },
		int32Value: 0,
		booleanValue: false,
		doubleValue: 0,
		numberOfItems: 0,
		descriptorAtIndex: () => nilDescriptor(),
		data: { base64EncodedStringWithOptions: () => ({ js: "" }) },
	};
	return descriptor;
}

function describe(type: string, extra: Partial<Descriptor> = {}): Descriptor {
	return {
		descriptorType: fcc(type),
		isNil: () => false,
		stringValue: { isNil: () => true },
		int32Value: 0,
		booleanValue: false,
		doubleValue: 0,
		numberOfItems: 0,
		descriptorAtIndex: () => nilDescriptor(),
		data: { base64EncodedStringWithOptions: () => ({ js: "" }) },
		...extra,
	};
}

function textDescriptor(value: string): Descriptor {
	return describe("TEXT", { stringValue: { isNil: () => false, js: value } });
}

function longDescriptor(value: number): Descriptor {
	return describe("long", { int32Value: value });
}

function listDescriptor(items: Descriptor[]): Descriptor {
	return describe("list", {
		numberOfItems: items.length,
		descriptorAtIndex: (index) => items[index - 1] ?? nilDescriptor(),
	});
}

function replyDescriptor(params: Record<number, Descriptor>): Descriptor {
	return {
		...describe("obj ", { params }),
		paramDescriptorForKeyword: (keyword) => params[keyword] ?? nilDescriptor(),
	};
}

interface Event {
	cls: number;
	id: number;
	direct: Descriptor | null;
	params: Record<number, Descriptor>;
	setParamDescriptorForKeyword: (descriptor: Descriptor, keyword: number) => void;
	sendEventWithOptionsTimeoutError: (mode: number, seconds: number, failure: Descriptor) => Descriptor;
}

interface JxaEvent {
	eventClass: number;
	eventId: number;
	property?: number;
	container?: "windows" | "tabs" | null;
}

const tabId = 42;

function errorReply(number: number, message: string): Descriptor {
	return replyDescriptor({ [KEY.errorNumber]: longDescriptor(number), [KEY.errorMessage]: textDescriptor(message) });
}

function valueReply(value: Descriptor): Descriptor {
	return replyDescriptor({ [KEY.direct]: value });
}

interface WindowModel {
	id: number;
	title: string;
	mode: string;
	minimized: boolean;
	visible: boolean;
	activeTabIndex: number;
	tabs: { id: number; url: string; title: string; loading: boolean }[];
}

const DEFAULT_WINDOWS: WindowModel[] = [
	{
		id: 1,
		title: "Window",
		mode: "normal",
		minimized: false,
		visible: true,
		activeTabIndex: 1,
		tabs: [{ id: tabId, url: "https://a.example/page", title: "Example", loading: false }],
	},
];

interface JxaOptions {
	/** The page script result for an execute request. */
	scriptResult?: string;
	events: JxaEvent[];
	/** Running process ids when every bundle uses the same list. */
	running?: number[];
	runningByBundle?: Record<string, number[]>;
	/** The bundle identifier that the running processes report. */
	bundleId?: string;
	installed?: boolean;
	automation?: number | ((target: { __bundleId?: string; __pid?: number }) => number);
	windows?: WindowModel[];
	/** Return one over-long window column on the first listing pass. */
	inconsistentFirstListing?: boolean;
}

function boolDescriptor(value: boolean): Descriptor {
	return describe("bool", { booleanValue: value });
}

function textList(values: string[]): Descriptor {
	return listDescriptor(values.map(textDescriptor));
}

function boolList(values: boolean[]): Descriptor {
	return listDescriptor(values.map(boolDescriptor));
}

function longList(values: number[]): Descriptor {
	return listDescriptor(values.map(longDescriptor));
}

function containerOf(from: Descriptor | undefined): "windows" | "tabs" | null {
	const want = from?.params?.[KEY.want]?.__typeCode;
	if (want === CODE.cwin) return "windows";
	if (want === CODE.tab) return "tabs";
	return null;
}

function runJxa(request: OsaRequest, options: JxaOptions): OsaReply {
	const windows = options.windows ?? DEFAULT_WINDOWS;
	let inconsistent = options.inconsistentFirstListing === true;

	const windowColumn = (property: number): Descriptor => {
		const readers: Record<number, () => Descriptor> = {
			[CODE.id]: () => valueReply(longList(windows.map((window) => window.id))),
			[fcc("pnam")]: () => {
				const titles = windows.map((window) => window.title);
				if (inconsistent) {
					inconsistent = false;
					return valueReply(textList([...titles, "unexpected"]));
				}
				return valueReply(textList(titles));
			},
			[fcc("mode")]: () => valueReply(textList(windows.map((window) => window.mode))),
			[fcc("pmnd")]: () => valueReply(boolList(windows.map((window) => window.minimized))),
			[fcc("pvis")]: () => valueReply(boolList(windows.map((window) => window.visible))),
			[fcc("pbnd")]: () => valueReply(listDescriptor(windows.map(() => nilDescriptor()))),
			[fcc("acTI")]: () => valueReply(longList(windows.map((window) => window.activeTabIndex))),
		};
		const reader = readers[property];
		return reader ? reader() : errorReply(-1728, "Can't get window column.");
	};

	const tabsColumn = (property: number): Descriptor => {
		if (property === CODE.id)
			return valueReply(
				listDescriptor(windows.map((window) => longList(window.tabs.map((tab) => tab.id)))),
			);
		if (property === fcc("URL "))
			return valueReply(
				listDescriptor(windows.map((window) => textList(window.tabs.map((tab) => tab.url)))),
			);
		if (property === fcc("pnam"))
			return valueReply(
				listDescriptor(windows.map((window) => textList(window.tabs.map((tab) => tab.title)))),
			);
		if (property === fcc("ldng"))
			return valueReply(
				listDescriptor(windows.map((window) => boolList(window.tabs.map((tab) => tab.loading)))),
			);
		return errorReply(-1728, "Can't get tab column.");
	};

	const answerGet = (direct: Descriptor): Descriptor => {
		const params = direct.params ?? {};
		const want = params[KEY.want]?.__typeCode;
		const property = params[KEY.selector]?.__typeCode;
		const from = params[KEY.from];
		const container = containerOf(from);
		// A by-identifier specifier selects one window or tab; these tests only model
		// the every-window reads. The remaining reads fail as a closed tab does.
		if (want !== CODE.property || property === undefined || container === null) {
			return errorReply(-1728, "Can't get tab.");
		}
		if (from?.params?.[KEY.selector]?.__typeCode === undefined) {
			return errorReply(-1728, "Can't get tab.");
		}
		return container === "windows" ? windowColumn(property) : tabsColumn(property);
	};

	const respond = (event: Event): Descriptor => {
		const container = event.direct ? containerOf(event.direct.params?.[KEY.from]) : null;
		options.events.push({
			eventClass: event.cls,
			eventId: event.id,
			...(event.id === fcc("getd") && event.direct
				? { property: event.direct.params?.[KEY.selector]?.__typeCode, container }
				: {}),
		});
		if (event.cls === fcc("CrSu") && event.id === CODE.execute)
			return valueReply(textDescriptor(options.scriptResult ?? ""));
		if (event.cls === fcc("core") && event.id === fcc("getd") && event.direct) return answerGet(event.direct);
		throw new Error(`unexpected Apple Event ${event.cls}/${event.id}`);
	};

	const descriptorWithTypeCode = (code: number) => ({ ...describe("type"), __typeCode: code });
	const descriptorWithString = (value: string) => textDescriptor(String(value));

	const D = {
		descriptorWithTypeCode,
		descriptorWithEnumCode: (code: number) => ({ ...describe("enum"), __enumCode: code }),
		descriptorWithString,
		descriptorWithDescriptorTypeData: (type: number, data: unknown) => ({
			...describe("DATA"),
			__typeCode: type,
			data,
		}),
		descriptorWithProcessIdentifier: (pid: number) => ({
			...describe("pid "),
			__pid: pid,
			aeDesc: { __pid: pid },
		}),
		descriptorWithBundleIdentifier: (bundleId: string) => ({
			...describe("bund"),
			__bundleId: bundleId,
			aeDesc: { __bundleId: bundleId },
		}),
		nullDescriptor: nilDescriptor(),
		get recordDescriptor(): Descriptor {
			const record: Descriptor = {
				...describe("reco"),
				params: {},
				setDescriptorForKeyword(descriptor: Descriptor, keyword: number) {
					record.params ??= {};
					record.params[keyword] = descriptor;
				},
				coerceToDescriptorType() {
					return { ...describe("obj "), __spec: true, params: record.params };
				},
			};
			return record;
		},
		appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(cls: number, id: number): Event {
			const event: Event = {
				cls,
				id,
				direct: null,
				params: {},
				setParamDescriptorForKeyword(descriptor: Descriptor, keyword: number) {
					if (keyword === KEY.direct) event.direct = descriptor;
					else event.params[keyword] = descriptor;
				},
				sendEventWithOptionsTimeoutError: () => respond(event),
			};
			return event;
		},
	};

	const runningFor = (bundleId: string) => options.runningByBundle?.[bundleId] ?? options.running ?? [5];
	const running = new Set(Object.values(options.runningByBundle ?? {}).flat().concat(options.running ?? [5]));
	const appBundleId = options.bundleId ?? request.bundleId ?? BROWSERS.chrome.bundleId;
	const app = (pid: number) => ({
		...describe("app "),
		isNil: () => false,
		terminated: false,
		hidden: false,
		active: false,
		processIdentifier: pid,
		bundleIdentifier: { isNil: () => false, js: appBundleId },
	});

	const dollar = Object.assign(
		(value?: unknown) => {
			if (value === undefined) return nilDescriptor();
			if (typeof value === "string")
				return { dataUsingEncoding: () => ({ base64EncodedStringWithOptions: () => ({ js: "" }) }) };
			return value;
		},
		{
			NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: { text: JSON.stringify(request) } } },
			NSString: { alloc: { initWithDataEncoding: (data: { text: string }) => ({ js: data.text }) } },
			NSRunningApplication: {
				runningApplicationWithProcessIdentifier: (pid: number) =>
					running.has(pid) ? app(pid) : nilDescriptor(),
				runningApplicationsWithBundleIdentifier: (bundleId: string) => {
					const pids = runningFor(bundleId);
					return {
						count: pids.length,
						objectAtIndex: (index: number) => app(pids[index]),
					};
				},
			},
			NSWorkspace: {
				sharedWorkspace: {
					URLForApplicationWithBundleIdentifier: (): Descriptor =>
						options.installed === false
							? nilDescriptor()
							: ({ ...describe("url "), path: { js: "/Applications/Test Browser.app" } } as Descriptor),
				},
			},
			NSBundle: {
				bundleWithPath: () => ({
					isNil: () => false,
					objectForInfoDictionaryKey: () => ({ isNil: () => false, js: "1.0" }),
				}),
			},
			AEDeterminePermissionToAutomateTarget: (target: { __bundleId?: string; __pid?: number }) =>
				typeof options.automation === "function" ? options.automation(target) : (options.automation ?? 0),
			NSUTF8StringEncoding: 4,
			NSASCIIStringEncoding: 1,
			NSAppleEventDescriptor: D,
		},
	);

	const context = createContext({
		ObjC: {
			import: () => undefined,
			bindFunction: () => undefined,
			deepUnwrap: (value: unknown) => value,
			castRefToObject: (value: unknown) => value,
		},
		$: dollar,
	});
	const output = runInContext(`${JXA_PROGRAM}\nrun();`, context);
	return JSON.parse(String(output)) as OsaReply;
}


function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const SETTLED_ENVELOPE = JSON.stringify({
	kind: "settled",
	page: { doc: "d1", url: "https://a.example/page", origin: "https://a.example", title: "Example" },
	outcome: { state: "fulfilled", awaited: false, valueType: "number", value: 2 },
});

it("keeps a successful execute result when the tab metadata reads fail", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(
		{ op: "execute", bundleId: BROWSERS.chrome.bundleId, pid: 5, tab: String(tabId), script: "1 + 1", seconds: 10 },
		{ scriptResult: SETTLED_ENVELOPE, events },
	);
	assert.equal(reply.ok, true, JSON.stringify(reply));
	if (!reply.ok) return;
	const value = obj(reply.value);
	assert.equal(value.result, SETTLED_ENVELOPE);
	assert.equal(value.url, null);
	assert.equal(value.title, null);
	assert.equal(value.window, "1");
	assert.equal(obj(value.metadataError).number, -1728);
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 1);
});

it("delivers a fulfilled evaluation value from the program's own reply", async () => {
	const events: JxaEvent[] = [];
	const deps: BrowserDeps = {
		run: async (request) => {
		return runJxa(request, { scriptResult: SETTLED_ENVELOPE, events });
		},
		readAccess: () => ({ chrome: "interact" }),
		platform: "darwin",
		processArgs: async () => null,
		capture: async () => Buffer.from(""),
		resize: async () => null,
		save: async () => undefined,
		now: () => Date.now(),
	};
	const result = await browserEvaluate(
		{ browser: "chrome", pid: 5, tab: String(tabId), origin: "https://a.example", expression: "1 + 1" },
		undefined,
		deps,
	);
	const report = obj(result.details.report);
	assert.equal(result.details.status, "fulfilled");
	assert.equal(result.isError, false);
	assert.equal(obj(report.execution).value, 2);
	assert.equal(obj(report.target).url, "https://a.example/page");
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 1);
});

const CHROME = BROWSERS.chrome.bundleId;
const BRAVE = BROWSERS.brave.bundleId;
const TESTING = BROWSERS["chrome-for-testing"].bundleId;

function okValue(reply: OsaReply): Record<string, unknown> {
	assert.equal(reply.ok, true, JSON.stringify(reply));
	return reply.ok ? obj(reply.value) : {};
}

function items(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map((item) => obj(item)) : [];
}

function tabsRequest(overrides: Record<string, unknown> = {}): OsaRequest {
	return {
		op: "tabs",
		bundleId: CHROME,
		inspectAllowed: true,
		requestPermission: false,
		...overrides,
	};
}

it("reports availability for every application in one reply without an Apple Event", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(
		{
			op: "availability",
			queries: [
				{ browser: "chrome", bundleId: CHROME, checkAutomation: true },
				{ browser: "brave", bundleId: BRAVE, checkAutomation: true },
				{ browser: "chrome-for-testing", bundleId: TESTING, checkAutomation: false },
			],
		},
		{ events, runningByBundle: { [CHROME]: [1], [BRAVE]: [], [TESTING]: [2] } },
	);
	const browsers = items(okValue(reply).browsers);
	assert.deepEqual(
		browsers.map((entry) => entry.browser),
		["chrome", "brave", "chrome-for-testing"],
	);
	assert.deepEqual(
		browsers.map((entry) => entry.automation),
		["granted", "not-checked", "not-checked"],
	);
	assert.equal(items(browsers[0].instances).length, 1);
	assert.equal(items(browsers[1].instances).length, 0);
	assert.equal(events.length, 0, "availability sends no Apple Event to a browser");
});

it("lists windows and tabs in one reply after fresh process checks", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ pid: 5 }), { events });
	const value = okValue(reply);
	assert.equal(value.kind, "ok");
	assert.equal(value.pid, 5);
	const windows = items(value.windows);
	assert.equal(windows.length, 1);
	assert.equal(windows[0].id, "1");
	assert.equal(items(windows[0].tabs)[0].id, String(tabId));
	assert.equal(
		events.filter((event) => event.property === CODE.id && event.container === "windows").length,
		1,
	);
});

it("returns static facts and sends no Apple Event when access is absent", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ inspectAllowed: false }), { events });
	const value = okValue(reply);
	assert.equal(value.kind, "blocked");
	assert.equal(obj(value.blocked).reason, "access-missing");
	assert.equal(items(obj(value.inventory).instances).length, 1);
	assert.equal(events.length, 0, "no Apple Event reaches a browser without access");
});

it("returns inventory and sends no Apple Event for a pid that is not running", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ pid: 99 }), { events });
	const value = okValue(reply);
	assert.equal(value.kind, "blocked");
	assert.equal(obj(value.blocked).reason, "not-running");
	assert.equal(value.pid, 99);
	assert.equal(events.length, 0, "no Apple Event reaches an exited process");
});

it("returns inventory and sends no Apple Event for a pid of another application", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ pid: 5 }), { events, bundleId: BRAVE });
	const value = okValue(reply);
	assert.equal(value.kind, "blocked");
	assert.equal(obj(value.blocked).reason, "pid-mismatch");
	assert.equal(events.length, 0, "no Apple Event reaches a process of another application");
});

it("reports several running processes instead of choosing one", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest(), { events, running: [5, 6] });
	const value = okValue(reply);
	assert.equal(value.kind, "ambiguous-process");
	assert.deepEqual(
		items(value.instances).map((item) => item.pid),
		[5, 6],
	);
	assert.equal(events.length, 0);
});

it("asks for Automation permission only when requested", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ pid: 5, requestPermission: true }), { events });
	const value = okValue(reply);
	assert.equal(value.kind, "ok");
	assert.equal(value.automation, "granted");
	assert.ok(events.length > 0, "an authorised request reads the windows");
});

it("reports a refused permission request without reading windows", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(tabsRequest({ pid: 5, requestPermission: true }), { events, automation: -1743 });
	const value = okValue(reply);
	assert.equal(value.kind, "blocked");
	assert.equal(obj(value.blocked).reason, "automation-denied");
	assert.equal(value.automation, "denied");
	assert.equal(events.length, 0, "no Apple Event is sent without Automation permission");
});

it("repeats one inconsistent window listing and no more", () => {
	const retried: JxaEvent[] = [];
	const first = okValue(runJxa(tabsRequest({ pid: 5 }), { events: retried, inconsistentFirstListing: true }));
	assert.equal(first.kind, "ok");
	assert.equal(
		retried.filter((event) => event.property === CODE.id && event.container === "windows").length,
		2,
	);
	const once: JxaEvent[] = [];
	okValue(runJxa(tabsRequest({ pid: 5 }), { events: once }));
	assert.equal(
		once.filter((event) => event.property === CODE.id && event.container === "windows").length,
		1,
	);
});
