/**
 * The JavaScript for Automation program run against a stand-in Apple Events
 * object model. These tests call the program's own request handling, so a reply
 * that the operations layer receives is produced by the code that osascript runs.
 * osascript invokes the script's `run` handler and prints its return value; the
 * sandbox appends the same call because it does not provide that host behaviour.
 */

import assert from "node:assert/strict";
import { it, describe as suite } from "node:test";
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
	/** An Apple Events error number that answers the operation's page script instead of a result. */
	scriptError?: number;
	/** An Apple Events error number that answers the trivial script that checks that the page answers. */
	probeError?: number;
	/** Answer URL and title reads of one tab by identifier; otherwise they fail as a closed tab does. */
	tabReads?: boolean;
	/** Bounds of each window by identifier, as Apple Events report them. */
	windowBounds?: Record<number, Rect>;
	/** The Accessibility view of the browser process and the file system around it. */
	ax?: AxModel;
	/** The pid of the frontmost application. */
	frontmost?: number;
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

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A QuickDraw rectangle descriptor: top, left, bottom, right as little-endian 16-bit integers. */
function qdrtDescriptor(rect: Rect): Descriptor {
	const bytes = Buffer.alloc(8);
	bytes.writeInt16LE(rect.y, 0);
	bytes.writeInt16LE(rect.x, 2);
	bytes.writeInt16LE(rect.y + rect.height, 4);
	bytes.writeInt16LE(rect.x + rect.width, 6);
	return describe("qdrt", { data: { base64EncodedStringWithOptions: () => ({ js: bytes.toString("base64") }) } });
}

/** One Accessibility element: attribute values, children, and what a press does. */
interface AxElement {
	attributes: Record<string, unknown>;
	press?: () => void;
}

interface AxModel {
	trusted?: boolean;
	/** Records each permission prompt. */
	prompts?: number[];
	windows: AxElement[];
	/** Paths that exist. */
	files: Set<string>;
	/** The folder of the last save that the browser's preferences name. */
	lastRoot?: string | null;
	/** Refuse to change the value of text fields. */
	frozenFields?: boolean;
	pressed?: string[];
}

const HOME = "/Users/test";

const axText = (value: string) => ({ js: value });
const axList = (items: unknown[]) => ({ count: items.length, objectAtIndex: (index: number) => items[index] });

function axElement(role: string, attributes: Record<string, unknown> = {}, children: AxElement[] = []): AxElement {
	return { attributes: { AXRole: axText(role), AXChildren: axList(children), ...attributes } };
}

function axFrame(rect: Rect): Record<string, unknown> {
	return {
		AXPosition: {
			description: { js: `<AXValue 0x1> {value = x:${rect.x}.000000 y:${rect.y}.000000 type = kAXValueCGPointType}` },
		},
		AXSize: {
			description: {
				js: `<AXValue 0x2> {value = w:${rect.width}.000000 h:${rect.height}.000000 type = kAXValueCGSizeType}`,
			},
		},
	};
}

function axStandIn(model: AxModel | undefined): Record<string, unknown> {
	if (!model) return {};
	const attribute = (element: AxElement, name: { __string: string }) => element.attributes[name.__string];
	return {
		AXIsProcessTrusted: () => model.trusted !== false,
		AXIsProcessTrustedWithOptions: () => {
			model.prompts = [...(model.prompts ?? []), 1];
			return false;
		},
		AXUIElementCreateApplication: () => ({ attributes: { AXWindows: axList(model.windows) } }),
		AXUIElementSetMessagingTimeout: () => 0,
		AXUIElementCopyAttributeValue: (element: AxElement, name: { __string: string }, ref: unknown[]) => {
			const value = attribute(element, name);
			if (value === undefined) return -25205;
			ref[0] = value;
			return 0;
		},
		AXUIElementSetAttributeValue: (element: AxElement, name: { __string: string }, value: { __string: string }) => {
			if (!model.frozenFields) element.attributes[name.__string] = axText(value.__string);
			return 0;
		},
		AXUIElementPerformAction: (element: AxElement) => {
			const title = String((element.attributes.AXTitle as { js?: string } | undefined)?.js);
			model.pressed = [...(model.pressed ?? []), title];
			element.press?.();
			return 0;
		},
		NSFileManager: {
			defaultManager: {
				displayNameAtPath: (path: string) => ({ js: path.split("/").pop() }),
				fileExistsAtPath: (path: string) => model.files.has(path),
			},
		},
		NSHomeDirectory: () => ({ js: HOME }),
		CFPreferencesAppSynchronize: () => true,
		NSUserDefaults: {
			alloc: {
				initWithSuiteName: () => ({
					objectForKey: () => ({ isNil: () => model.lastRoot == null, root: model.lastRoot }),
				}),
			},
		},
		NSURL: {
			URLByResolvingBookmarkDataOptionsRelativeToURLBookmarkDataIsStaleError: (data: { root: string }) => ({
				isNil: () => false,
				path: { js: data.root },
			}),
		},
		NSRunLoop: { currentRunLoop: { runUntilDate: () => undefined } },
		NSDate: { dateWithTimeIntervalSinceNow: (seconds: number) => seconds },
	};
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
			return valueReply(listDescriptor(windows.map((window) => longList(window.tabs.map((tab) => tab.id)))));
		if (property === fcc("URL "))
			return valueReply(listDescriptor(windows.map((window) => textList(window.tabs.map((tab) => tab.url)))));
		if (property === fcc("pnam"))
			return valueReply(listDescriptor(windows.map((window) => textList(window.tabs.map((tab) => tab.title)))));
		if (property === fcc("ldng"))
			return valueReply(listDescriptor(windows.map((window) => boolList(window.tabs.map((tab) => tab.loading)))));
		return errorReply(-1728, "Can't get tab column.");
	};

	/** A property of one window or tab selected by identifier; null when the stand-in does not model it. */
	const answerById = (container: "windows" | "tabs", id: string, property: number): Descriptor | null => {
		if (container === "windows" && property === fcc("pbnd")) {
			const rect = options.windowBounds?.[Number(id)];
			return rect ? valueReply(qdrtDescriptor(rect)) : errorReply(-1728, "Can't get window.");
		}
		if (container !== "tabs" || !options.tabReads) return null;
		const tab = windows.flatMap((window) => window.tabs).find((item) => String(item.id) === id);
		if (tab && property === fcc("URL ")) return valueReply(textDescriptor(tab.url));
		if (tab && property === fcc("pnam")) return valueReply(textDescriptor(tab.title));
		return errorReply(-1728, "Can't get tab.");
	};

	const answerGet = (direct: Descriptor): Descriptor => {
		const params = direct.params ?? {};
		const want = params[KEY.want]?.__typeCode;
		const property = params[KEY.selector]?.__typeCode;
		const from = params[KEY.from];
		const container = containerOf(from);
		// The every-window reads answer columns; reads by identifier answer what the options model.
		// The remaining reads fail as a closed tab does.
		if (want !== CODE.property || property === undefined || container === null) {
			return errorReply(-1728, "Can't get tab.");
		}
		const byId = from?.params?.[KEY.selector]?.stringValue;
		const single = byId && !byId.isNil() ? answerById(container, String(byId.js), property) : null;
		if (single) return single;
		if (from?.params?.[KEY.selector]?.__typeCode === undefined) {
			return errorReply(-1728, "Can't get tab.");
		}
		return container === "windows" ? windowColumn(property) : tabsColumn(property);
	};

	const answerScript = (event: Event): Descriptor => {
		const probe = event.params[fcc("JvSc")]?.stringValue.js === "1";
		const error = probe ? options.probeError : options.scriptError;
		if (error !== undefined) return errorReply(error, "The command cannot be executed.");
		return valueReply(textDescriptor(probe ? "1" : (options.scriptResult ?? "")));
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
		if (event.cls === fcc("CrSu") && event.id === CODE.execute) return answerScript(event);
		if (event.cls === fcc("core") && event.id === fcc("setd")) return valueReply(nilDescriptor());
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
	const running = new Set(
		Object.values(options.runningByBundle ?? {})
			.flat()
			.concat(options.running ?? [5]),
	);
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
				return {
					__string: value,
					js: value,
					dataUsingEncoding: () => ({ base64EncodedStringWithOptions: () => ({ js: "" }) }),
				};
			return value;
		},
		{
			NSFileHandle: { fileHandleWithStandardInput: { readDataToEndOfFile: { text: JSON.stringify(request) } } },
			NSString: { alloc: { initWithDataEncoding: (data: { text: string }) => ({ js: data.text }) } },
			NSRunningApplication: {
				runningApplicationWithProcessIdentifier: (pid: number) => (running.has(pid) ? app(pid) : nilDescriptor()),
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
					frontmostApplication: app(options.frontmost ?? 99),
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
			...axStandIn(options.ax),
		},
	);

	const context = createContext({
		Ref: () => [],
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

it("returns a page envelope without reading the tab URL and title", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(
		{ op: "execute", bundleId: BROWSERS.chrome.bundleId, pid: 5, tab: String(tabId), script: "1 + 1", seconds: 10 },
		{ scriptResult: SETTLED_ENVELOPE, events, tabReads: true },
	);
	assert.equal(reply.ok, true, JSON.stringify(reply));
	if (!reply.ok) return;
	const value = obj(reply.value);
	assert.equal(value.result, SETTLED_ENVELOPE);
	assert.equal(value.url, null);
	assert.equal(value.window, "1");
	assert.equal(value.metadataError, null);
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 1);
	assert.equal(events.filter((event) => event.container === "tabs" && event.property !== CODE.id).length, 0);
});

it("reads the tab URL and title when the page script returns no envelope, and keeps read failures beside the result", () => {
	const read: JxaEvent[] = [];
	const answered = runJxa(
		{ op: "execute", bundleId: BROWSERS.chrome.bundleId, pid: 5, tab: String(tabId), script: "work()", seconds: 10 },
		{ scriptResult: "", events: read, tabReads: true },
	);
	assert.equal(answered.ok, true, JSON.stringify(answered));
	if (answered.ok) {
		assert.equal(obj(answered.value).url, "https://a.example/page");
		assert.equal(obj(answered.value).title, "Example");
	}
	const failed = runJxa(
		{ op: "execute", bundleId: BROWSERS.chrome.bundleId, pid: 5, tab: String(tabId), script: "work()", seconds: 10 },
		{ scriptResult: "not json", events: [] },
	);
	assert.equal(failed.ok, true, JSON.stringify(failed));
	if (!failed.ok) return;
	assert.equal(obj(failed.value).result, "not json");
	assert.equal(obj(failed.value).url, null);
	assert.equal(obj(obj(failed.value).metadataError).number, -1728);
});

const SET_URL = fcc("setd");

function navigate(script: string, options: Omit<JxaOptions, "tabReads">, op = "navigate"): OsaReply {
	return runJxa(navigateRequest(script, op), { ...options, tabReads: true });
}

function navigateRequest(script: string, op = "navigate"): OsaRequest {
	return {
		op,
		bundleId: BROWSERS.chrome.bundleId,
		pid: 5,
		tab: String(tabId),
		url: "https://a.example/next",
		expectOrigin: "https://a.example",
		script,
		seconds: 5,
		probeSeconds: 2,
	};
}

const PAGE_BEFORE = { doc: "d1", url: "https://a.example/page", origin: "https://a.example" };

it("lets the page navigate itself and never sets the URL in the navigate request", () => {
	for (const [kind, navigated] of [
		["navigating", true],
		["ready", false],
	] as const) {
		const events: JxaEvent[] = [];
		const reply = navigate("navigate", { scriptResult: JSON.stringify({ kind, page: PAGE_BEFORE }), events });
		assert.equal(reply.ok, true, JSON.stringify(reply));
		if (!reply.ok) return;
		const value = obj(reply.value);
		assert.equal(value.navigated, navigated);
		assert.equal(value.before, "https://a.example/page");
		assert.deepEqual(value.page, PAGE_BEFORE);
		assert.equal(value.pageError, null);
		// The trivial script that shows the page answers, then the navigation script.
		assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 2);
		assert.equal(events.filter((event) => event.eventId === SET_URL).length, 0);
	}
});

it("reports why page script could not navigate, so the caller sets the URL", () => {
	for (const [options, pageError] of [
		[{ probeError: 12, scriptError: 12 }, 12],
		[{ probeError: 13, scriptError: 13 }, 13],
		[{ scriptError: -10000 }, -10000],
		[{ scriptResult: "" }, null],
	] as const) {
		const reply = navigate("navigate", { ...options, events: [] });
		assert.equal(reply.ok, true, JSON.stringify(reply));
		if (!reply.ok) return;
		assert.equal(obj(reply.value).navigated, false);
		assert.equal(obj(reply.value).pageError, pageError);
	}
});

it("refuses a page of another origin with its own identity, a blocked page, and a timed-out script", () => {
	const mismatch = navigate("navigate", {
		scriptResult: JSON.stringify({ kind: "origin-mismatch", page: { ...PAGE_BEFORE, origin: "https://b.example" } }),
		events: [],
	});
	assert.equal(mismatch.ok, false);
	if (!mismatch.ok) {
		assert.equal(mismatch.error.code, "origin-mismatch");
		assert.equal(obj(obj(mismatch.error.extra).page).origin, "https://b.example");
	}
	const blocked = navigate("navigate", { probeError: -1712, events: [] });
	assert.equal(blocked.ok, false);
	if (!blocked.ok) assert.equal(blocked.error.code, "page-blocked");
	const timeout = navigate("navigate", { scriptError: -1712, events: [] });
	assert.equal(timeout.ok, false);
	if (!timeout.ok) assert.equal(timeout.error.number, -1712);
});

it("sets the URL through Apple Events in setURL after checking the tab origin", () => {
	const events: JxaEvent[] = [];
	const reply = navigate("", { events }, "setURL");
	assert.equal(reply.ok, true, JSON.stringify(reply));
	if (reply.ok) assert.equal(obj(reply.value).before, "https://a.example/page");
	assert.equal(events.filter((event) => event.eventId === SET_URL).length, 1);
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 0);
	const other: JxaEvent[] = [];
	const refused = runJxa(
		{ ...navigateRequest("", "setURL"), expectOrigin: "https://b.example" },
		{ events: other, tabReads: true },
	);
	assert.equal(refused.ok, false);
	if (!refused.ok) assert.equal(refused.error.code, "origin-mismatch");
	assert.equal(other.filter((event) => event.eventId === SET_URL).length, 0);
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
		fileStat: async () => null,
		listFolder: async () => [],
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
	// One trivial script that shows the page answers, then the expression; no poll or removal request.
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 2);
});

it("refuses a page that does not answer a trivial script before sending the operation's script", () => {
	const events: JxaEvent[] = [];
	const reply = runJxa(
		{
			op: "execute",
			bundleId: BROWSERS.chrome.bundleId,
			pid: 5,
			tab: String(tabId),
			script: "work()",
			seconds: 15,
			probeSeconds: 2,
		},
		{ probeError: -1712, events },
	);
	assert.equal(reply.ok, false);
	if (!reply.ok) assert.equal(reply.error.code, "page-blocked");
	assert.equal(events.filter((event) => event.eventId === CODE.execute).length, 1);
	const navigation: JxaEvent[] = [];
	const refused = navigate("navigate", { probeError: -1712, events: navigation });
	assert.equal(refused.ok, false);
	assert.equal(navigation.filter((event) => event.eventId === CODE.execute).length, 1);
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
	assert.equal(events.filter((event) => event.property === CODE.id && event.container === "windows").length, 1);
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
	assert.equal(retried.filter((event) => event.property === CODE.id && event.container === "windows").length, 2);
	const once: JxaEvent[] = [];
	okValue(runJxa(tabsRequest({ pid: 5 }), { events: once }));
	assert.equal(once.filter((event) => event.property === CODE.id && event.container === "windows").length, 1);
});

/* ---------------------------------------------------------------- Save dialog */

const WINDOW_RECT = { x: 40, y: 60, width: 900, height: 700 };

/** A browser window with a save panel whose buttons change the window as AppKit does. */
function saveWindow(
	options: {
		suggested?: string;
		where?: string;
		rows?: string[];
		question?: boolean;
		rect?: Rect;
		sheet?: boolean;
	} = {},
) {
	const children: AxElement[] = [];
	const sheetChildren: AxElement[] = [];
	const window: AxElement = {
		attributes: {
			AXRole: axText("AXWindow"),
			...axFrame(options.rect ?? WINDOW_RECT),
			get AXChildren() {
				return axList(children);
			},
		},
	};
	const close = () => children.splice(0);
	const nameField = axElement("AXTextField", {
		AXIdentifier: axText("saveAsNameTextField"),
		AXValue: axText(options.suggested ?? "report.csv"),
	});
	const rows = (options.rows ?? []).map((path) =>
		axElement("AXTextField", { AXURL: { filePathURL: { path: { js: path } } } }),
	);
	const save: AxElement = axElement("AXButton", { AXTitle: axText("Save"), AXIdentifier: axText("OKButton") });
	const cancel: AxElement = axElement("AXButton", { AXTitle: axText("Cancel") });
	const newFolder: AxElement = axElement("AXButton", {
		AXTitle: axText("New Folder"),
		AXIdentifier: axText("NewFolderButton"),
	});
	cancel.press = close;
	save.press = () => {
		if (!options.question) return close();
		const answer = axElement("AXButton", { AXTitle: axText("Cancel") });
		const question: AxElement = axElement("AXSheet", { AXCancelButton: answer }, [
			axElement("AXStaticText", { AXValue: axText("“new.csv” already exists. Do you want to replace it?") }),
			answer,
		]);
		answer.press = () => sheetChildren.splice(sheetChildren.indexOf(question), 1);
		sheetChildren.push(question);
	};
	// Like AppKit's save panel, the sheet has no default or cancel button attribute.
	const sheet: AxElement = {
		attributes: {
			AXRole: axText("AXSheet"),
			AXIdentifier: axText("save-panel"),
			get AXChildren() {
				return axList(sheetChildren);
			},
		},
	};
	sheetChildren.push(
		axElement("AXGroup", {}, [nameField]),
		axElement("AXPopUpButton", { AXIdentifier: axText("where popup"), AXValue: axText(options.where ?? "Downloads") }),
		axElement("AXScrollArea", {}, [axElement("AXList", {}, rows)]),
		axElement("AXGroup", {}, [newFolder, cancel, save]),
	);
	if (options.sheet !== false) children.push(sheet);
	return { window, nameField, children };
}

function saveRequest(extra: Record<string, unknown> = {}): OsaRequest {
	return {
		op: "saveDialog",
		bundleId: BROWSERS.chrome.bundleId,
		pid: 5,
		tab: String(tabId),
		name: null,
		cancel: false,
		requestPermission: false,
		...extra,
	};
}

function runSave(request: OsaRequest, ax: AxModel, frontmost?: number): OsaReply {
	return runJxa(request, { events: [], windowBounds: { 1: WINDOW_RECT }, ax, frontmost });
}

suite("Save dialog through Accessibility", () => {
	it("saves under the given name and names the folders that can hold the file, the folder of this save first", () => {
		const { window, nameField } = saveWindow({ rows: [`${HOME}/Downloads/old.zip`] });
		const ax: AxModel = {
			windows: [window],
			files: new Set([`${HOME}/Downloads`, `${HOME}/Exports`]),
			lastRoot: `${HOME}/Exports`,
		};
		const before = Date.now();
		const reply = runSave(saveRequest({ name: "new.csv" }), ax);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		if (!reply.ok) return;
		const { pressedAt, ...value } = obj(reply.value);
		assert.ok(typeof pressedAt === "number" && pressedAt >= before && pressedAt <= Date.now());
		assert.deepEqual(value, {
			action: "saved",
			name: "new.csv",
			window: "1",
			suggestedName: "report.csv",
			folderName: "Downloads",
			candidates: [
				{ folder: `${HOME}/Exports`, existed: false },
				{ folder: `${HOME}/Downloads`, existed: false },
			],
		});
		assert.deepEqual(nameField.attributes.AXValue, { js: "new.csv" });
		assert.deepEqual(ax.pressed, ["Save"]);
		assert.equal(window.attributes.AXChildren && (window.attributes.AXChildren as { count: number }).count, 0);
	});

	it("refuses before the press a name that exists in the folder the dialog shows", () => {
		const { window, children } = saveWindow();
		const ax: AxModel = { windows: [window], files: new Set([`${HOME}/Downloads`, `${HOME}/Downloads/report.csv`]) };
		const reply = runSave(saveRequest(), ax);
		assert.equal(reply.ok ? "" : reply.error.code, "file-exists");
		assert.equal(ax.pressed, undefined);
		assert.equal(children.length, 1, "the Save dialog stays open for another name");
	});

	it("leaves out a folder that held the name before the save when the dialog shows another folder", () => {
		const { window } = saveWindow({ where: "Exports" });
		const ax: AxModel = {
			windows: [window],
			files: new Set([`${HOME}/Downloads`, `${HOME}/Downloads/report.csv`, `${HOME}/Exports`]),
			lastRoot: `${HOME}/Exports`,
		};
		const reply = runSave(saveRequest(), ax);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		if (reply.ok) assert.deepEqual(obj(reply.value).candidates, [{ folder: `${HOME}/Exports`, existed: false }]);
	});

	it("cancels the dialog", () => {
		const { window } = saveWindow();
		const ax: AxModel = { windows: [window], files: new Set() };
		const reply = runSave(saveRequest({ cancel: true }), ax);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		if (reply.ok) assert.equal(obj(reply.value).action, "cancelled");
		assert.deepEqual(ax.pressed, ["Cancel"]);
	});

	it("answers the panel's own replace question Cancel and reports it, leaving the dialog open", () => {
		const { window, children } = saveWindow({ question: true });
		const ax: AxModel = { windows: [window], files: new Set([`${HOME}/Downloads`]) };
		const reply = runSave(saveRequest({ name: "new.csv" }), ax);
		assert.equal(reply.ok, false);
		if (!reply.ok) {
			assert.equal(reply.error.code, "save-question");
			assert.match(reply.error.message, /already exists\. Do you want to replace it\? The tool answered Cancel/);
		}
		assert.deepEqual(ax.pressed, ["Save", "Cancel"]);
		assert.equal(children.length, 1, "the Save dialog stays open");
	});

	it("refuses without Accessibility permission and asks macOS only when the call requests it", () => {
		for (const [requestPermission, prompts] of [
			[false, 0],
			[true, 1],
		] as const) {
			const ax: AxModel = { trusted: false, windows: [saveWindow().window], files: new Set() };
			const reply = runSave(saveRequest({ requestPermission }), ax);
			assert.equal(reply.ok, false);
			if (!reply.ok) assert.equal(reply.error.code, "accessibility-not-granted");
			assert.equal(ax.prompts?.length ?? 0, prompts);
			assert.equal(ax.pressed, undefined);
		}
	});

	it("checks a name only when it has an extension, since the panel can hide the download's extension", () => {
		const { window } = saveWindow({ suggested: "report" });
		const ax: AxModel = { windows: [window], files: new Set([`${HOME}/Downloads`, `${HOME}/Downloads/report.csv`]) };
		const reply = runSave(saveRequest(), ax);
		assert.equal(reply.ok, true, JSON.stringify(reply));
		assert.deepEqual(ax.pressed, ["Save"]);
	});

	it("refuses a dialog that suggests another name than the expected one, ignoring a hidden extension", () => {
		const other = runSave(saveRequest({ expect: "invoice.pdf" }), { windows: [saveWindow().window], files: new Set() });
		assert.equal(other.ok ? "" : other.error.code, "dialog-mismatch");
		const hidden: AxModel = { windows: [saveWindow({ suggested: "report" }).window], files: new Set() };
		const same = runSave(saveRequest({ expect: "report.csv" }), hidden);
		assert.equal(same.ok, true, JSON.stringify(same));
		assert.deepEqual(hidden.pressed, ["Save"]);
	});

	it("leaves the dialog to the operator while the browser is the active application", () => {
		const ax: AxModel = { windows: [saveWindow().window], files: new Set() };
		const reply = runSave(saveRequest({ name: "new.csv" }), ax, 5);
		assert.equal(reply.ok ? "" : reply.error.code, "browser-in-use");
		assert.equal(ax.pressed, undefined);
	});

	it("refuses a dialog that shows no buttons to Accessibility, as a hidden window's dialog does", () => {
		const { window, children } = saveWindow();
		const sheet = children[0];
		sheet.attributes = { ...sheet.attributes, AXChildren: axList([]) };
		const reply = runSave(saveRequest(), { windows: [window], files: new Set() });
		assert.equal(reply.ok ? "" : reply.error.code, "dialog-unreadable");
	});

	it("refuses when no window has the tab's bounds, when the window shows no Save dialog, or when the name is not taken", () => {
		const moved = runSave(saveRequest(), {
			windows: [saveWindow({ rect: { ...WINDOW_RECT, x: 41 } }).window],
			files: new Set(),
		});
		assert.equal(moved.ok ? "" : moved.error.code, "window-not-matched");
		const none = runSave(saveRequest(), { windows: [saveWindow({ sheet: false }).window], files: new Set() });
		assert.equal(none.ok ? "" : none.error.code, "no-save-dialog");
		const frozen: AxModel = { windows: [saveWindow().window], files: new Set(), frozenFields: true };
		const refused = runSave(saveRequest({ name: "new.csv" }), frozen);
		assert.equal(refused.ok ? "" : refused.error.code, "name-not-set");
		assert.equal(frozen.pressed, undefined);
	});
});
