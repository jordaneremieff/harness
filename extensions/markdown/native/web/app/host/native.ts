(() => {
	type Fields = Record<string, unknown>;
	const root = globalThis as unknown as {
		reader: ReaderNamespace;
		webkit?: { messageHandlers?: { reader?: { postMessage(message: ReaderHostMessage): unknown } } };
	};
	if (!root.reader) root.reader = {} as ReaderNamespace;
	const api = root.reader;
	const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
	const SOURCE = 2 * 1024 * 1024,
		META = 256 * 1024,
		BODY = 16 * 1024 * 1024,
		EDIT = 5 * 1024 * 1024;
	const encoder = new TextEncoder();
	function ensure(condition: unknown, message = "Malformed reader message."): asserts condition {
		if (!condition) throw new TypeError(message);
	}
	function object(value: unknown): Fields {
		ensure(value !== null && typeof value === "object" && !Array.isArray(value));
		return value as Fields;
	}
	function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
	}
	function number(value: unknown) {
		return typeof value === "number" && Number.isFinite(value);
	}
	function string(value: unknown, max = META, empty = false): value is string {
		return (
			typeof value === "string" && (empty || value.length > 0) && value.length <= max && !/[\uD800-\uDFFF]/u.test(value)
		);
	}
	function one(value: unknown, values: readonly unknown[]) {
		return values.includes(value);
	}
	function optional(value: unknown, test: (v: unknown) => boolean) {
		return value === undefined || test(value);
	}
	function bytes(value: unknown) {
		const encoded = JSON.stringify(value);
		ensure(typeof encoded === "string");
		return encoder.encode(encoded).length;
	}
	function groupLimit(message: Fields, bodyField?: string) {
		const metadata = { ...message };
		if (message.type === "document") {
			ensure(typeof message.source === "string");
			ensure(encoder.encode(message.source).length <= SOURCE, "Reader source exceeds its byte limit.");
			delete metadata.source;
		}
		if (bodyField && message[bodyField] !== undefined) {
			const value = message[bodyField];
			ensure(
				(bodyField === "html" && typeof value === "string" ? encoder.encode(value).length : bytes(value)) <= BODY,
				"Reader rendering exceeds its byte limit.",
			);
			delete metadata[bodyField];
		}
		if (message.type === "edits" || message.type === "agentApply") {
			ensure(bytes(message.edits) <= EDIT, "Reader edits exceed their byte limit.");
			delete metadata.edits;
		}
		ensure(bytes(metadata) <= META, "Reader metadata exceeds its byte limit.");
	}
	function envelope(value: unknown): ReaderHostMessage {
		const m = object(value);
		ensure(m.v === 1 && string(m.type, 80) && optional(m.id, (v) => string(v, 200)), "Unknown reader envelope.");
		return m as ReaderHostMessage;
	}
	function range(value: unknown, max = SOURCE) {
		const r = object(value);
		ensure(integer(r.start, max) && integer(r.end, max) && r.start <= r.end, "Invalid reader range.");
		return r as unknown as ReaderRange;
	}
	function edits(value: unknown) {
		ensure(Array.isArray(value) && value.length > 0 && value.length <= 1024, "Invalid reader edits.");
		let end = -1,
			start = -1;
		for (const valueEdit of value) {
			const e = object(valueEdit),
				r = range(e);
			ensure(string(e.text, SOURCE, true) && string(e.expected, SOURCE, true));
			ensure(e.expected.length === r.end - r.start && r.start >= end && r.start !== start, "Unordered reader edits.");
			end = r.end;
			start = r.start;
		}
	}
	const blockTypes = [
		"paragraph",
		"heading1",
		"heading2",
		"heading3",
		"heading4",
		"heading5",
		"heading6",
		"list",
		"quote",
		"code",
		"table",
		"rule",
		"html",
		"footnotes",
		"other",
	];
	function map(value: unknown, block: ReaderRange) {
		ensure(Array.isArray(value) && value.length <= SOURCE);
		let renderedEnd = 0;
		for (const item of value) {
			ensure(Array.isArray(item) && item.length === 4 && item.every((n) => integer(n, SOURCE)));
			const [r, n, s, m] = item as number[];
			ensure(r >= renderedEnd && s >= block.start && s + m <= block.end, "Invalid reader inline map.");
			renderedEnd = r + n;
		}
	}
	function block(value: unknown, max: number, complete: boolean) {
		const b = object(value),
			r = range(b, max);
		ensure(string(b.key, 200) && one(b.type, blockTypes));
		ensure(optional(b.html, (v) => string(v, BODY, true)) && (!complete || typeof b.html === "string"));
		if (b.map !== undefined) map(b.map, r);
		return b as unknown as ReaderBlock;
	}
	function blocks(value: unknown, max = SOURCE, complete = false) {
		ensure(Array.isArray(value) && value.length <= 100000);
		let end = 0;
		const keys = new Set<string>();
		for (const valueBlock of value) {
			const b = block(valueBlock, max, complete);
			ensure(b.start >= end && !keys.has(b.key), "Unordered reader blocks.");
			end = b.end;
			keys.add(b.key);
		}
	}
	function multiplier(value: unknown): value is number {
		return typeof value === "number" && Number.isFinite(value) && value > 0;
	}
	function sizeSteps(value: unknown) {
		return (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every((step, index) => multiplier(step) && (index === 0 || step > value[index - 1]))
		);
	}
	function settings(value: unknown, complete = false) {
		const s = object(value);
		if (complete)
			ensure(
				["textSize", "textSizeSteps", "codeWrap", "appearance", "outlineWidth", "outlineOpen"].every(
					(key) => s[key] !== undefined,
				),
			);
		ensure(optional(s.lock, (v) => one(v, ["reading", "writing"])) && (!complete || s.lock !== undefined));
		ensure(
			optional(s.textSize, multiplier) &&
				optional(s.textSizeSteps, sizeSteps) &&
				optional(s.codeWrap, (v) => typeof v === "boolean") &&
				optional(s.appearance, (v) => one(v, ["system", "light", "dark"])),
		);
		ensure(optional(s.outlineWidth, number) && optional(s.outlineOpen, (v) => typeof v === "boolean"));
	}
	function meta(value: unknown, complete: boolean) {
		const m = object(value);
		ensure((!complete && m.documentKey === undefined) || string(m.documentKey, 200));
		ensure(string(m.documentId, 200) && one(m.kind, ["response", "file", "published", "draft", "localFile"]));
		ensure(
			string(m.title, META, true) &&
				string(m.shortId, 200) &&
				(m.revision === null || integer(m.revision)) &&
				string(m.digest, 200) &&
				typeof m.capturedSource === "boolean",
		);
		ensure(Array.isArray(m.revisions));
		for (const row of m.revisions) {
			const r = object(row);
			ensure(integer(r.n) && string(r.createdAt, 100, true) && typeof r.current === "boolean");
		}
	}
	function documentMessage(m: Fields) {
		ensure(typeof m.source === "string" && string(m.source, SOURCE, true) && integer(m.generation));
		ensure(string(m.presentation, 200));
		meta(m.meta, true);
		settings(m.settings, true);
		blocks(m.blocks, m.source.length, true);
		ensure(one(m.chrome, ["pane", "window"]) && typeof m.live === "boolean");
		ensure(Array.isArray(m.headings));
		for (const item of m.headings) {
			const h = object(item);
			ensure(
				integer(h.level, 6) &&
					h.level > 0 &&
					string(h.text, META, true) &&
					string(h.anchor, 1000, true) &&
					integer(h.start, m.source.length),
			);
		}
		if (m.position !== undefined) {
			const p = object(m.position);
			ensure(integer(p.blockStart, m.source.length) && number(p.offsetY));
		}
	}
	function identity(m: Fields) {
		ensure(string(m.operationId, 200));
		ensure(optional(m.threadId, (v) => string(v, 200)));
	}
	function claim(m: Fields) {
		ensure(string(m.claimId, 200) && Array.isArray(m.ranges) && m.ranges.length <= 16 && number(m.expiresAt));
		ensure(optional(m.label, (v) => string(v, 80, true)));
		for (const item of m.ranges) range(item);
	}
	const formats = [
		"bold",
		"italic",
		"code",
		"link",
		"indent",
		"outdent",
		"heading",
		"bulletList",
		"numberedList",
		"taskList",
		"quote",
	];
	const pageCommands = [
		"back",
		"forward",
		"undo",
		"redo",
		"find",
		"findNext",
		"findPrevious",
		"replace",
		"zoomIn",
		"zoomOut",
		"zoomReset",
		"toggleOutline",
		"toggleLock",
		"askSelection",
		"askDocument",
		"copyMarkdown",
		"copyPassage",
		"open",
		"selectAll",
		"escape",
		"format",
		"applySettings",
		"showReview",
		"showDetails",
		"inspectImage",
		"showSource",
		"showLibrary",
		"imageZoom",
	];
	function nativeCommand(m: Fields) {
		ensure(one(m.name, pageCommands));
		const args = m.args === undefined ? {} : object(m.args);
		if (m.name === "format") formatArgs(args);
		if (m.name === "toggleLock") ensure(optional(args.lock, (v) => one(v, ["reading", "writing"])));
		if (m.name === "applySettings") settings(args);
		if (m.name === "imageZoom") ensure(one(args.mode, ["fit", "actual"]));
		if (m.name === "inspectImage") ensure(integer(args.index) && optional(args.zoom, (v) => one(v, ["fit", "actual"])));
	}
	function formatArgs(args: Fields) {
		ensure(one(args.command, formats));
		if (args.command === "heading") ensure(integer(args.level, 6));
	}
	function native(value: unknown) {
		const m = envelope(value);
		groupLimit(m, m.type === "document" ? "blocks" : undefined);
		ensure(Object.hasOwn(nativeValidators, m.type), "Unknown native message type.");
		const validate = nativeValidators[m.type];
		validate(m);
		return m;
	}
	const nativeValidators: Record<string, (m: Fields) => void> = {
		document: documentMessage,
		ack(m) {
			ensure(string(m.presentation, 200));
			ensure(integer(m.generation) && string(m.digest, 200) && one(m.recovery, ["retained", "pending"]));
			if (m.meta !== undefined) meta(m.meta, false);
		},
		refused(m) {
			ensure(string(m.presentation, 200));
			ensure(integer(m.generation) && string(m.reason, 2000));
		},
		agentApply(m) {
			identity(m);
			ensure(integer(m.baseGeneration));
			edits(m.edits);
		},
		claim,
		release(m) {
			ensure(string(m.claimId, 200));
		},
		promptState(m) {
			ensure(
				string(m.requestId, 200) &&
					string(m.threadId, 200) &&
					one(m.state, ["sending", "sent", "admitted", "working", "answered", "unanswered", "failed", "unknown"]) &&
					optional(m.detail, (v) => string(v, META, true)),
			);
		},
		connectionState(m) {
			ensure(string(m.detail, 8192));
		},
		saveState(m) {
			ensure(string(m.presentation, 200) && optional(m.revision, revision));
			ensure(
				one(m.state, ["saving", "saved", "retrying", "conflict"]) &&
					optional(m.detail, (v) => string(v, 8192, true)) &&
					optional(m.words, integer),
			);
		},
		command: nativeCommand,
		notice(m) {
			ensure(string(m.tone, 80) && string(m.text, 8192, true) && Array.isArray(m.actions));
			for (const item of m.actions) {
				const a = object(item);
				ensure(string(a.id, 200) && string(a.label, 1000));
			}
		},
		renderResult(m) {
			ensure(integer(m.generation));
			blocks(m.blocks);
		},
	};
	function state(m: Fields) {
		ensure(
			one(m.lock, ["reading", "writing"]) && one(m.overlay, [null, "review", "image", "details", "source", "library"]),
		);
		for (const key of ["canBack", "canForward", "canUndo", "canRedo", "hasSelection", "findOpen", "editingPending"])
			ensure(typeof m[key] === "boolean");
		if (m.held !== undefined) range(m.held);
		if (m.activeBlock !== undefined) range(m.activeBlock);
		const scroll = object(m.scroll);
		ensure(integer(scroll.blockStart) && number(scroll.offsetY));
		if (m.selection !== undefined) {
			const s = object(m.selection);
			range(s);
			ensure(string(s.text, META, true));
		}
		if (m.find !== undefined) {
			const f = object(m.find);
			ensure(string(f.query, META, true) && integer(f.count) && integer(f.index));
		}
	}
	const hostCommands = [
		"openLink",
		"copy",
		"returnFocus",
		"close",
		"export",
		"open",
		"showRevision",
		"showLatest",
		"reviewChanges",
		"inspectImage",
		"showOriginal",
		"details",
		"pickImage",
		"newDraft",
		"saveSettings",
		"chooseStore",
		"readClipboard",
	];
	function hostCommand(m: Fields) {
		ensure(one(m.name, hostCommands));
		const a = m.args === undefined ? {} : object(m.args);
		const test = hostCommandValidators[String(m.name)];
		if (test) test(a);
	}
	const hostCommandValidators: Record<string, (a: Fields) => void> = {
		openLink: (a) => ensure(string(a.href, META)),
		copy: (a) => ensure(string(a.text, META, true) && Object.keys(a).length === 1),
		export: (a) => ensure(one(a.format, ["archive", "sharing", "pdf"])),
		open: (a) => ensure(optional(a.ref, (v) => string(v, 8192))),
		showRevision: (a) => ensure(integer(a.n)),
		showLatest: (a) => ensure(Object.keys(a).length === 0),
		reviewChanges: (a) => ensure(one(a.against, ["previous", "base"]) || integer(a.against)),
		inspectImage: (a) => ensure(integer(a.index)),
		pickImage(a) {
			ensure(integer(a.generation));
			range(a.range);
		},
		saveSettings: (a) => settings(a.patch),
	};
	function query(m: Fields) {
		ensure(one(m.kind, ["review", "details", "image", "library", "markdown"]));
		if (m.kind === "review") ensure(one(m.against, ["previous", "base"]) || integer(m.against));
		if (m.kind === "image") ensure(integer(m.index));
		if (m.kind === "markdown") ensure(string(m.text, META, true));
		if (m.kind === "library")
			ensure(
				one(m.collection, ["drafts", "recent", "published"]) &&
					optional(m.query, (v) => string(v, 8192, true)) &&
					optional(m.cursor, (v) => string(v, 8192)) &&
					optional(m.match, (v) => one(v, ["title", "source"])),
			);
	}
	function revision(value: unknown) {
		return integer(value) && value > 0;
	}
	function annotation(m: Fields, nonblank = false) {
		ensure(optional(m.authoredRevision, revision));
		ensure(string(m.text, META, !nonblank) && (!nonblank || m.text.trim()));
		ensure(optional(m.quote, (v) => string(v, META, true)));
		if (m.quoteRange !== undefined) range(m.quoteRange);
	}
	function prompt(m: Fields) {
		ensure(string(m.documentKey, 200) && string(m.presentation, 200));
		ensure(string(m.requestId, 200) && string(m.threadId, 200) && integer(m.generation));
		if (m.annotations === undefined) {
			ensure(m.overall === undefined);
			return annotation(m);
		}
		ensure(m.authoredRevision === undefined || (m.overall !== undefined && revision(m.authoredRevision)));
		ensure(m.text === undefined && m.quote === undefined && m.quoteRange === undefined);
		// Native refuses an overall comment over 64 KiB of UTF-8 or of white space alone, U+0085 included.
		ensure(optional(m.overall, (v) => string(v) && /[^\s\u0085]/u.test(v) && encoder.encode(v).length <= 64 * 1024));
		ensure(Array.isArray(m.annotations) && m.annotations.length > 0 && m.annotations.length <= 50);
		for (const item of m.annotations) annotation(object(item), true);
	}
	const pageValidators: Record<string, (m: Fields) => void> = {
		ready(m) {
			ensure(string(m.version, 200));
			const caps = object(m.capabilities);
			ensure(Object.values(caps).every((v) => typeof v === "boolean"));
		},
		state,
		edits(m) {
			ensure(string(m.presentation, 200));
			ensure(
				integer(m.baseGeneration) &&
					m.generation === m.baseGeneration + 1 &&
					one(m.origin, ["person", "agent", "history"]),
			);
			ensure(optional(m.operationId, (v) => string(v, 200)));
			edits(m.edits);
		},
		agentRefused(m) {
			ensure(string(m.operationId, 200) && one(m.reason, ["held", "stale"]));
			if (m.range !== undefined) range(m.range);
		},
		render: (m) => ensure(integer(m.generation) && optional(m.full, (v) => typeof v === "boolean")),
		lock: (m) => ensure(one(m.lock, ["reading", "writing"]) && typeof m.copy === "boolean"),
		prompt,
		command: hostCommand,
		query,
		log: (m) => ensure(one(m.level, ["debug", "info", "warn", "error"]) && string(m.message, 8192, true)),
	};
	function page(value: unknown) {
		const m = envelope(value);
		groupLimit(m);
		ensure(Object.hasOwn(pageValidators, m.type), "Unknown page message type.");
		const validate = pageValidators[m.type];
		validate(m);
		return m;
	}
	function reviewSummary(value: unknown) {
		const s = object(value);
		ensure(
			integer(s.base) &&
				(s.target === null || integer(s.target)) &&
				optional(s.targetLabel, (v) => string(v, 8192, true)),
		);
		for (const field of ["changedRegions", "addedLines", "removedLines", "assetChanges"]) ensure(integer(s[field]));
		ensure(typeof s.partial === "boolean" && string(s.line, 8192, true));
	}
	function labelledRows(value: unknown) {
		ensure(Array.isArray(value));
		for (const row of value) {
			const r = object(row);
			ensure(string(r.label, 8192, true) && string(r.value, 8192, true));
		}
	}
	function store(value: unknown) {
		ensure(string(object(value).label, 8192));
	}
	function coverage(value: unknown) {
		const c = object(value);
		ensure(
			integer(c.searched) &&
				(c.total === null || integer(c.total)) &&
				typeof c.stopped === "boolean" &&
				optional(c.reason, (v) => string(v, 8192, true)),
		);
	}
	function libraryReply(m: Fields, fields: Fields) {
		ensure(Array.isArray(m.rows) && typeof m.limited === "boolean" && optional(m.cursor, (v) => string(v, 8192)));
		store(m.store);
		if (m.coverage !== undefined) coverage(m.coverage);
		if (fields.match === "source") ensure(m.coverage !== undefined);
		for (const row of m.rows) {
			const r = object(row);
			ensure(
				string(r.ref, 8192) &&
					string(r.kind, 80) &&
					string(r.title, 8192, true) &&
					string(r.subtitle, 8192, true) &&
					r.age !== undefined &&
					optional(r.excerpt, (v) => string(v, 8192, true)),
			);
		}
	}
	function queryReply(m: Fields, fields: Fields) {
		if (fields.kind === "markdown") {
			ensure(string(m.html, BODY, true));
			return;
		}
		if (fields.kind === "review") {
			ensure(string(m.html, BODY, true));
			reviewSummary(m.summary);
			return;
		}
		if (fields.kind === "details") {
			labelledRows(m.rows);
			ensure(Array.isArray(m.images));
			for (const image of m.images) {
				const r = object(image);
				ensure(integer(r.index) && string(r.state, 80) && optional(r.reason, (v) => string(v, 8192, true)));
			}
			return;
		}
		if (fields.kind === "image") {
			ensure(string(m.address, META) && number(m.width) && number(m.height));
			labelledRows(m.facts);
			return;
		}
		libraryReply(m, fields);
	}
	function replyBody(kind: string, fields: Fields) {
		if (kind === "render") return "blocks";
		if (kind === "query" && (fields.kind === "review" || fields.kind === "markdown")) return "html";
		if (kind === "command" && fields.name === "readClipboard") return "text";
		return undefined;
	}
	function imageReply(m: Fields) {
		if (m.cancelled) {
			ensure(m.cancelled === true);
			return;
		}
		ensure(integer(m.generation));
		edits(m.edits);
	}
	function commandReply(m: Fields, fields: Fields) {
		if (fields.name === "pickImage") imageReply(m);
		if (fields.name === "readClipboard")
			ensure(
				typeof m.text === "string" && encoder.encode(m.text).length <= SOURCE,
				"Clipboard text exceeds its byte limit.",
			);
		if (fields.name === "chooseStore") {
			ensure(typeof m.changed === "boolean");
			if (m.store !== undefined) store(m.store);
		}
	}
	function promptReply(m: Fields) {
		ensure(typeof m.accepted === "boolean" && optional(m.detail, (v) => string(v, 8192, true)));
		if (m.fresh !== undefined)
			ensure(m.fresh === true && !m.accepted && m.uncertain === undefined && string(m.detail, 8192));
		if (m.uncertain === undefined) ensure(m.retryable === undefined);
		else ensure(m.uncertain === true && !m.accepted && typeof m.retryable === "boolean");
	}
	function reply(value: unknown, id: string, kind: string, fields: Fields) {
		const m = envelope(value);
		ensure(m.type === "reply" && m.id === id && typeof m.ok === "boolean", "Unexpected reader reply.");
		groupLimit(m, replyBody(kind, fields));
		if (!m.ok) {
			ensure(string(m.error, 8192));
			throw new Error(m.error);
		}
		if (kind === "render") {
			ensure(integer(m.generation));
			blocks(m.blocks);
		}
		if (kind === "prompt") promptReply(m);
		if (kind === "query") queryReply(m, fields);
		if (kind === "command") commandReply(m, fields);
		return m;
	}
	api.bridge = { native, page, reply };
	let nextHost = 0;
	api.createNativeHost = (transport) => {
		const hostId = ++nextHost,
			handlers = new Map<string, Set<(message: unknown) => unknown>>();
		let sequence = 0,
			disposed = false;
		const capabilities: ReaderHostCapabilities = {
			menuBar: false,
			filePanels: true,
			returnFocus: true,
			windowChrome: "pane",
		};
		const post = (message: ReaderHostMessage) => {
			ensure(!disposed, "Reader host is disposed.");
			if (typeof transport === "function") return transport(message);
			if (transport) return transport.postMessage(message);
			const handler = root.webkit?.messageHandlers?.reader;
			ensure(handler, "Reader transport is unavailable.");
			return handler.postMessage(message);
		};
		function installCapabilities(message: ReaderHostMessage) {
			for (const allow of handlers.get("beforeDocument") ?? []) if (allow(message) === false) return false;
			capabilities.windowChrome = String(message.chrome);
			capabilities.menuBar = message.chrome === "window";
			capabilities.returnFocus = message.chrome === "pane";
			return true;
		}
		const receive = (value: unknown) => {
			if (disposed) return false;
			try {
				const message = native(value);
				if (message.type === "document" && !installCapabilities(message)) return false;
				for (const fn of handlers.get(message.type) ?? []) fn(message);
				return true;
			} catch (error) {
				console.warn(`[reader] ${asError(error).message}`);
				return false;
			}
		};
		const pending = new Set<(error: Error) => void>();
		const host: ReaderHost & { receive(message: unknown): boolean } = {
			capabilities,
			receive,
			on(type, handler) {
				let set = handlers.get(type);
				if (!set) {
					set = new Set();
					handlers.set(type, set);
				}
				set.add(handler);
				return () => set.delete(handler);
			},
			send(type, fields = {}) {
				const result = post(page({ ...fields, v: 1, type }));
				if (result && typeof (result as PromiseLike<unknown>).then === "function")
					void Promise.resolve(result).catch((error) => console.warn(`[reader] ${String(error)}`));
			},
			request(type, fields = {}) {
				const id = `reader-${hostId}-${++sequence}`;
				return new Promise((resolve, reject) => {
					const fail = (error: Error) => {
						pending.delete(fail);
						reject(error);
					};
					pending.add(fail);
					try {
						const value = post(page({ ...fields, v: 1, type, id }));
						Promise.resolve(value).then(
							(result) => {
								if (disposed) return;
								try {
									const validated = reply(result, id, type, fields);
									pending.delete(fail);
									resolve(validated);
								} catch (error) {
									fail(asError(error));
								}
							},
							(error) => fail(asError(error)),
						);
					} catch (error) {
						fail(asError(error));
					}
				});
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				handlers.clear();
				for (const fail of pending) fail(new Error("Reader host is disposed."));
				pending.clear();
				if (api.receive === receive) api.receive = () => false;
			},
		};
		api.receive = receive;
		return host;
	};
	api.receive = () => false;
})();
