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
	((text.charCodeAt(0) << 24) |
		(text.charCodeAt(1) << 16) |
		(text.charCodeAt(2) << 8) |
		text.charCodeAt(3)) >>>
	0;

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
	return describe("list", { numberOfItems: items.length, descriptorAtIndex: (index) => items[index - 1] ?? nilDescriptor() });
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
}

const tabId = 42;

function errorReply(number: number, message: string): Descriptor {
	return replyDescriptor({ [KEY.errorNumber]: longDescriptor(number), [KEY.errorMessage]: textDescriptor(message) });
}

function valueReply(value: Descriptor): Descriptor {
	return replyDescriptor({ [KEY.direct]: value });
}

/** Answers the window and tab id reads that locate() sends before the page script. */
function readReply(direct: Descriptor): Descriptor {
	const params = direct.params ?? {};
	const isIdRead = params[KEY.want]?.__typeCode === CODE.property && params[KEY.selector]?.__typeCode === CODE.id;
	if (isIdRead) {
		const fromWant = params[KEY.from]?.params?.[KEY.want]?.__typeCode;
		if (fromWant === CODE.cwin) return valueReply(listDescriptor([longDescriptor(1)]));
		if (fromWant === CODE.tab) return valueReply(listDescriptor([listDescriptor([longDescriptor(tabId)])]));
	}
	// Every other read in these tests is the tab URL or title, which fails once the tab is gone.
	return errorReply(-1728, "Can't get tab.");
}

function runJxa(request: OsaRequest, options: { scriptResult: string; events: JxaEvent[] }): OsaReply {
	const respond = (event: Event): Descriptor => {
		options.events.push({ eventClass: event.cls, eventId: event.id });
		if (event.cls === fcc("CrSu") && event.id === CODE.execute) return valueReply(textDescriptor(options.scriptResult));
		if (event.cls === fcc("core") && event.id === fcc("getd") && event.direct) return readReply(event.direct);
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
				runningApplicationWithProcessIdentifier: (pid: number) => ({
					...describe("app "),
					isNil: () => false,
					terminated: false,
					hidden: false,
					active: false,
					processIdentifier: pid,
					bundleIdentifier: { isNil: () => false, js: BROWSERS.chrome.bundleId },
				}),
			},
			AEDeterminePermissionToAutomateTarget: () => 0,
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
			if (request.op === "inventory")
				return {
					ok: true,
					value: { installed: null, instances: [{ pid: 5, hidden: false, active: true }] },
				};
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
