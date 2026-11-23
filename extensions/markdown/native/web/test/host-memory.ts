(() => {
	type Fields = Record<string, unknown>;
	const api = (globalThis as unknown as { reader: ReaderNamespace }).reader;
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	api.createMemoryHost = (input, render) => {
		api.bridge.native({ ...input, v: 1, type: "document" });
		let payload = clone(input),
			disposed = false,
			draft: ReaderDocument | undefined;
		let retained = clone(payload);
		let delivery = 0;
		const mirror: ReaderMirror = {
			originalSource: input.source,
			source: input.source,
			generation: input.generation,
			meta: clone(input.meta),
		};
		const handlers = new Map<string, Set<(message: unknown) => unknown>>(),
			responders = new Map<string, (fields: Fields) => unknown>();
		const messages: ReaderHostMessage[] = [],
			sent: ReaderHostMessage[] = [],
			inbound: ReaderHostMessage[] = [];
		const capabilities: ReaderHostCapabilities = {
			menuBar: input.chrome === "window",
			filePanels: true,
			returnFocus: input.chrome === "pane",
			windowChrome: String(input.chrome),
		};
		const emit = (type: string, fields: Fields = {}) => {
			if (disposed) return false;
			let message: ReaderHostMessage;
			try {
				message = api.bridge.native({ ...fields, v: 1, type });
			} catch {
				return false;
			}
			if (type === "document" && !allowsDocument(message)) return false;
			acceptInbound(message);
			messages.push(message);
			inbound.push(message);
			for (const handler of handlers.get(type) ?? []) handler(message);
			return true;
		};
		function allowsDocument(message: ReaderHostMessage) {
			for (const allow of handlers.get("beforeDocument") ?? []) if (allow(message) === false) return false;
			return true;
		}
		function acceptInbound(message: ReaderHostMessage) {
			if (message.type === "document") acceptDocument(message as unknown as ReaderDocument);
			if (message.type === "command" && message.name === "applySettings") storeSettings(message.args as Fields);
		}
		function acceptCommand(message: ReaderHostMessage) {
			if (message.name === "saveSettings") storeSettings((message.args as Fields).patch as Fields);
		}
		function acceptDocument(document: ReaderDocument) {
			payload = clone(document);
			mirror.source = document.source;
			mirror.generation = document.generation;
			mirror.meta = clone(document.meta);
			retained = clone(document);
		}
		function storeSettings(patch: Fields) {
			payload.settings = { ...payload.settings, ...clone(patch) };
			retained.settings = clone(payload.settings);
			if (draft) draft.settings = clone(payload.settings);
		}
		function snapshot(): ReaderDocument {
			return { ...clone(payload), source: mirror.source, generation: mirror.generation, meta: clone(mirror.meta) };
		}
		function install() {
			emit("document", { ...snapshot(), presentation: `memory-view-${++delivery}` });
		}
		function refuse(presentation: string, generation: number, reason: string) {
			emit("refused", { presentation, generation, reason });
			if (presentation === payload.presentation) install();
		}
		function copyMeta() {
			if (!mirror.meta.capturedSource) return false;
			mirror.meta = {
				...mirror.meta,
				kind: "draft",
				documentId: "memory-copy",
				documentKey: "memory-copy-key",
				shortId: "copy",
				copyOf: mirror.meta.documentId,
				capturedSource: false,
			};
			return true;
		}
		function matching(edits: ReaderEdit[]) {
			return edits.every((e) => e.end <= mirror.source.length && mirror.source.slice(e.start, e.end) === e.expected);
		}
		function commitMirror(source: string, generation: number) {
			const copied = copyMeta();
			mirror.source = source;
			mirror.generation = generation;
			payload = { ...payload, source, generation, meta: mirror.meta };
			retained = { ...payload };
			if (input.meta.capturedSource) draft = { ...payload };
			emit("ack", {
				presentation: payload.presentation,
				generation,
				digest: `memory-${generation}`,
				...(copied ? { meta: clone(mirror.meta) } : {}),
				recovery: "retained",
			});
		}
		function mirrorEdit(m: ReaderHostMessage) {
			const presentation = m.presentation as string,
				generation = m.generation as number;
			if (presentation !== payload.presentation) {
				refuse(presentation, generation, "presentation");
				return;
			}
			if (m.baseGeneration !== mirror.generation) {
				refuse(presentation, generation, "generation");
				return;
			}
			const edits = m.edits as ReaderEdit[];
			if (!matching(edits)) {
				refuse(presentation, generation, "expected");
				return;
			}
			let next = "",
				cursor = 0;
			for (const e of edits) {
				next += mirror.source.slice(cursor, e.start) + e.text;
				cursor = e.end;
			}
			next += mirror.source.slice(cursor);
			if (new TextEncoder().encode(next).length > 2 * 1024 * 1024) {
				refuse(presentation, generation, "size");
				return;
			}
			commitMirror(next, m.generation as number);
		}
		function send(type: string, fields: Fields = {}) {
			if (disposed) throw new Error("Memory host is disposed.");
			const message = api.bridge.page({ ...fields, v: 1, type });
			sent.push(message);
			messages.push(message);
			if (type === "edits") mirrorEdit(message);
			else if (type === "ready") install();
			else if (type === "lock") payload.settings.lock = fields.lock as "reading" | "writing";
			else if (type === "command") acceptCommand(message);
		}
		async function request(type: string, fields: Fields = {}) {
			if (disposed) throw new Error("Memory host is disposed.");
			const id = `memory-${messages.length}`;
			const message = api.bridge.page({ ...fields, v: 1, type, id });
			messages.push(message);
			sent.push(message);
			const response = await responseFor(type, fields);
			return api.bridge.reply({ v: 1, type: "reply", id, ok: true, ...response }, id, type, fields);
		}
		function responseFor(type: string, fields: Fields): Fields | Promise<Fields> {
			const custom = responders.get(type);
			if (custom) return Promise.resolve(custom(fields)).then((value) => value as Fields);
			switch (type) {
				case "render":
					payload.blocks = render(mirror.source, mirror.generation);
					return { generation: mirror.generation, blocks: clone(payload.blocks) };
				case "prompt":
					return { accepted: true };
				case "command":
					if (fields.name === "chooseStore") return { changed: false, store: { label: "Fixture" } };
					return fields.name === "pickImage" ? { cancelled: true } : {};
				case "query":
					return queryResponse(fields);
				default:
					throw new Error("Unsupported memory request.");
			}
		}
		function reviewResponse(): Fields {
			return {
				summary: {
					base: 1,
					target: payload.meta.kind === "draft" ? null : payload.meta.revision,
					targetLabel: payload.meta.title,
					changedRegions: 0,
					addedLines: 0,
					removedLines: 0,
					assetChanges: 0,
					partial: false,
					line: "No changes.",
				},
				html: "<p>No changes.</p>",
			};
		}
		function queryResponse(fields: Fields): Fields {
			if (fields.kind === "review") return reviewResponse();
			if (fields.kind === "details") return { rows: [{ label: "Document", value: "Fixture" }], images: [] };
			if (fields.kind === "image")
				return {
					address: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E',
					facts: [],
					width: 1,
					height: 1,
				};
			return {
				rows: [],
				limited: false,
				store: { label: "Fixture" },
				...(fields.match === "source" ? { coverage: { searched: 0, total: 0, stopped: false } } : {}),
			};
		}
		const host: ReaderMemoryHost = {
			capabilities,
			send,
			request,
			emit,
			messages,
			sent,
			inbound,
			mirror,
			get document() {
				return snapshot();
			},
			get source() {
				return mirror.source;
			},
			get generation() {
				return mirror.generation;
			},
			get draft() {
				return draft;
			},
			on(type, handler) {
				let set = handlers.get(type);
				if (!set) {
					set = new Set();
					handlers.set(type, set);
				}
				set.add(handler);
				return () => set.delete(handler);
			},
			recovery() {
				return clone(retained);
			},
			respond(type, handler) {
				responders.set(type, handler);
			},
			dispose() {
				disposed = true;
				handlers.clear();
				responders.clear();
			},
		};
		return host;
	};
})();
